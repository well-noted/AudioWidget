/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/playback-manager.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

/**
 * Playback Manager Module
 * 
 * Handles audio playback including region play, listen mode, scrubbing,
 * and playhead position tracking.
 */

var audioCache = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/audio-cache.js");
var mp3Parser = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/mp3-parser.js");

/**
 * Playback Manager class
 * @param {object} options - Configuration options
 */
function PlaybackManager(options) {
    this.onPlayheadUpdate = options.onPlayheadUpdate || function() {};
    this.onPlaybackEnd = options.onPlaybackEnd || function() {};
    this.onPlaybackStart = options.onPlaybackStart || function() {};
    
    this._sourceNode = null;
    this._gainNode = null;
    this._isPlaying = false;
    this._playbackMode = null; // 'region', 'listen', 'scrub'
    this._startTime = 0;
    this._endTime = 0;
    this._currentTime = 0;
    this._rafId = null;
    this._audioCtxStartTime = 0;
    this._playStartOffset = 0;
    
    // For MP3 streaming playback
    this._mediaElement = null;
    this._mp3Info = null;
    this._arrayBuffer = null;
}

/**
 * Get or create shared audio context
 * @returns {AudioContext}
 */
PlaybackManager.prototype._getAudioContext = function() {
    return audioCache.getSharedAudioContext();
};

/**
 * Play a region of the audio buffer
 * @param {AudioBuffer} buffer - Decoded audio buffer
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @param {number} [volume=1] - Playback volume (0-1)
 */
PlaybackManager.prototype.playRegion = function(buffer, startTime, endTime, volume) {
    var self = this;
    this.stop();
    
    if (!buffer || startTime >= endTime) return;
    
    var ctx = this._getAudioContext();
    if (!ctx) return;
    
    // Resume if suspended
    if (ctx.state === 'suspended') {
        ctx.resume();
    }
    
    this._sourceNode = ctx.createBufferSource();
    this._sourceNode.buffer = buffer;
    
    this._gainNode = ctx.createGain();
    this._gainNode.gain.value = (volume !== undefined) ? volume : 1;
    
    this._sourceNode.connect(this._gainNode);
    this._gainNode.connect(ctx.destination);
    
    this._isPlaying = true;
    this._playbackMode = 'region';
    this._startTime = startTime;
    this._endTime = endTime;
    this._currentTime = startTime;
    this._audioCtxStartTime = ctx.currentTime;
    this._playStartOffset = startTime;
    
    var duration = endTime - startTime;
    this._sourceNode.start(0, startTime, duration);
    
    this._sourceNode.onended = function() {
        self._handlePlaybackEnd();
    };
    
    this.onPlaybackStart('region', startTime, endTime);
    this._startPlayheadTracking();
};

/**
 * Play in listen mode (preview from a specific time)
 * @param {AudioBuffer} buffer - Decoded audio buffer
 * @param {number} fromTime - Start time in seconds
 * @param {number} [duration=3] - Duration to play
 * @param {number} [volume=1] - Volume
 */
PlaybackManager.prototype.playListen = function(buffer, fromTime, duration, volume) {
    var self = this;
    this.stop();
    
    if (!buffer) return;
    
    duration = duration || 3;
    var endTime = Math.min(buffer.duration, fromTime + duration);
    
    var ctx = this._getAudioContext();
    if (!ctx) return;
    
    if (ctx.state === 'suspended') {
        ctx.resume();
    }
    
    this._sourceNode = ctx.createBufferSource();
    this._sourceNode.buffer = buffer;
    
    this._gainNode = ctx.createGain();
    this._gainNode.gain.value = (volume !== undefined) ? volume : 1;
    
    this._sourceNode.connect(this._gainNode);
    this._gainNode.connect(ctx.destination);
    
    this._isPlaying = true;
    this._playbackMode = 'listen';
    this._startTime = fromTime;
    this._endTime = endTime;
    this._currentTime = fromTime;
    this._audioCtxStartTime = ctx.currentTime;
    this._playStartOffset = fromTime;
    
    this._sourceNode.start(0, fromTime, duration);
    
    this._sourceNode.onended = function() {
        self._handlePlaybackEnd();
    };
    
    this.onPlaybackStart('listen', fromTime, endTime);
    this._startPlayheadTracking();
};

/**
 * Play for scrubbing (short snippet for preview)
 * @param {AudioBuffer} buffer - Decoded audio buffer
 * @param {number} time - Center time for scrub preview
 * @param {number} [snippetDuration=0.15] - Snippet duration
 * @param {number} [volume=1] - Volume
 */
PlaybackManager.prototype.playScrub = function(buffer, time, snippetDuration, volume) {
    this.stop();
    
    if (!buffer) return;
    
    snippetDuration = snippetDuration || 0.15;
    var halfDur = snippetDuration / 2;
    var startTime = Math.max(0, time - halfDur);
    var endTime = Math.min(buffer.duration, time + halfDur);
    
    var ctx = this._getAudioContext();
    if (!ctx) return;
    
    if (ctx.state === 'suspended') {
        ctx.resume();
    }
    
    this._sourceNode = ctx.createBufferSource();
    this._sourceNode.buffer = buffer;
    
    this._gainNode = ctx.createGain();
    this._gainNode.gain.value = (volume !== undefined) ? volume : 1;
    
    this._sourceNode.connect(this._gainNode);
    this._gainNode.connect(ctx.destination);
    
    this._isPlaying = true;
    this._playbackMode = 'scrub';
    this._startTime = startTime;
    this._endTime = endTime;
    this._currentTime = time;
    
    this._sourceNode.start(0, startTime, endTime - startTime);
    
    // Scrub doesn't track playhead - too short
    var self = this;
    this._sourceNode.onended = function() {
        self._handlePlaybackEnd();
    };
};

/**
 * Play MP3 from byte range (streaming for large files)
 * @param {ArrayBuffer} arrayBuffer - Full MP3 data
 * @param {object} mp3Info - Parsed MP3 info
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 */
PlaybackManager.prototype.playMp3Region = function(arrayBuffer, mp3Info, startTime, endTime) {
    var self = this;
    this.stop();
    
    if (!arrayBuffer || !mp3Info) return;
    
    // Calculate byte range
    var startByte, endByte;
    if (mp3Info.isVBR && mp3Info.tocEntries && mp3Info.totalBytes) {
        startByte = mp3Parser.xingSeekByte(mp3Info, startTime);
        endByte = mp3Parser.xingSeekByte(mp3Info, endTime);
    } else {
        var range = mp3Parser.estimateByteRangeByFrameScan(arrayBuffer, startTime, endTime);
        startByte = range.startByte;
        endByte = range.endByte;
    }
    
    // Slice MP3 data
    var slicedBuffer = arrayBuffer.slice(startByte, endByte);
    
    // Create blob and play via HTMLAudioElement
    var blob = new Blob([slicedBuffer], { type: 'audio/mpeg' });
    var url = URL.createObjectURL(blob);
    
    this._mediaElement = new Audio();
    this._mediaElement.src = url;
    this._mediaElement.volume = 1;
    
    this._isPlaying = true;
    this._playbackMode = 'mp3-region';
    this._startTime = startTime;
    this._endTime = endTime;
    
    this._mediaElement.onended = function() {
        URL.revokeObjectURL(url);
        self._handlePlaybackEnd();
    };
    
    this._mediaElement.onerror = function() {
        URL.revokeObjectURL(url);
        self._handlePlaybackEnd();
    };
    
    this._mediaElement.play().catch(function() {
        URL.revokeObjectURL(url);
        self._handlePlaybackEnd();
    });
    
    this.onPlaybackStart('mp3-region', startTime, endTime);
};

/**
 * Stop any current playback
 */
PlaybackManager.prototype.stop = function() {
    if (this._rafId) {
        cancelAnimationFrame(this._rafId);
        this._rafId = null;
    }
    
    if (this._sourceNode) {
        try {
            this._sourceNode.stop();
            this._sourceNode.disconnect();
        } catch(e) {}
        this._sourceNode = null;
    }
    
    if (this._gainNode) {
        try {
            this._gainNode.disconnect();
        } catch(e) {}
        this._gainNode = null;
    }
    
    if (this._mediaElement) {
        try {
            this._mediaElement.pause();
            this._mediaElement.src = '';
        } catch(e) {}
        this._mediaElement = null;
    }
    
    var wasPlaying = this._isPlaying;
    var mode = this._playbackMode;
    
    this._isPlaying = false;
    this._playbackMode = null;
    
    if (wasPlaying) {
        this.onPlaybackEnd(mode);
    }
};

/**
 * Check if currently playing
 * @returns {boolean}
 */
PlaybackManager.prototype.isPlaying = function() {
    return this._isPlaying;
};

/**
 * Get current playback mode
 * @returns {string|null}
 */
PlaybackManager.prototype.getPlaybackMode = function() {
    return this._playbackMode;
};

/**
 * Get current playhead time
 * @returns {number}
 */
PlaybackManager.prototype.getCurrentTime = function() {
    return this._currentTime;
};

/**
 * Set playback volume
 * @param {number} volume - Volume level (0-1)
 */
PlaybackManager.prototype.setVolume = function(volume) {
    if (this._gainNode) {
        this._gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
    if (this._mediaElement) {
        this._mediaElement.volume = Math.max(0, Math.min(1, volume));
    }
};

/**
 * Handle playback end
 * @private
 */
PlaybackManager.prototype._handlePlaybackEnd = function() {
    var mode = this._playbackMode;
    this._isPlaying = false;
    this._playbackMode = null;
    
    if (this._rafId) {
        cancelAnimationFrame(this._rafId);
        this._rafId = null;
    }
    
    this.onPlaybackEnd(mode);
};

/**
 * Start playhead tracking animation
 * @private
 */
PlaybackManager.prototype._startPlayheadTracking = function() {
    var self = this;
    var ctx = this._getAudioContext();
    if (!ctx) return;
    
    function tick() {
        if (!self._isPlaying) return;
        
        var elapsed = ctx.currentTime - self._audioCtxStartTime;
        self._currentTime = self._playStartOffset + elapsed;
        
        if (self._currentTime >= self._endTime) {
            self._currentTime = self._endTime;
        }
        
        self.onPlayheadUpdate(self._currentTime, self._playbackMode);
        
        if (self._isPlaying && self._currentTime < self._endTime) {
            self._rafId = requestAnimationFrame(tick);
        }
    }
    
    this._rafId = requestAnimationFrame(tick);
};

/**
 * Cleanup resources
 */
PlaybackManager.prototype.destroy = function() {
    this.stop();
};

// Exports
exports.PlaybackManager = PlaybackManager;

})();
