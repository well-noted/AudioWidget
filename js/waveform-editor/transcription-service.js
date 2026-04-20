/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/transcription-service.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

/**
 * Transcription Service Module
 * 
 * Handles audio transcription via OpenAI Whisper API, including MP3 slicing,
 * API calls, and optional LLM editing of transcriptions.
 */

var mp3Parser = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/mp3-parser.js");
var wavEncoder = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/wav-encoder.js");

/**
 * Transcription Service class
 * @param {object} wiki - TiddlyWiki instance for config lookup
 */
function TranscriptionService(wiki) {
    this.wiki = wiki;
}

/**
 * Get configuration value from tiddler
 * @param {string} tiddlerTitle - Config tiddler title
 * @param {string} defaultValue - Default value if not found
 * @returns {string}
 */
TranscriptionService.prototype._getConfig = function(tiddlerTitle, defaultValue) {
    if (!this.wiki) return defaultValue;
    var text = this.wiki.getTiddlerText(tiddlerTitle, '');
    return text.trim() || defaultValue;
};

/**
 * Get API key
 * @returns {string}
 */
TranscriptionService.prototype.getApiKey = function() {
    return this._getConfig('$:/plugins/NoteStreams/AudioSuite/configuration/transcriptions/api-key', '');
};

/**
 * Get API endpoint
 * @returns {string}
 */
TranscriptionService.prototype.getEndpoint = function() {
    return this._getConfig(
        '$:/plugins/NoteStreams/AudioSuite/configuration/transcriptions/endpoint',
        'https://api.openai.com/v1/audio/transcriptions'
    );
};

/**
 * Get transcription model
 * @returns {string}
 */
TranscriptionService.prototype.getModel = function() {
    return this._getConfig(
        '$:/plugins/NoteStreams/AudioSuite/configuration/transcriptions/model',
        'whisper-1'
    );
};

/**
 * Get language hint
 * @returns {string}
 */
TranscriptionService.prototype.getLanguage = function() {
    return this._getConfig('$:/plugins/NoteStreams/AudioSuite/configuration/transcriptions/language', '');
};

/**
 * Get prompt hint
 * @returns {string}
 */
TranscriptionService.prototype.getPrompt = function() {
    return this._getConfig('$:/plugins/NoteStreams/AudioSuite/configuration/transcriptions/prompt', '');
};

/**
 * Check if LLM editor is enabled
 * @returns {boolean}
 */
TranscriptionService.prototype.isEditorEnabled = function() {
    var val = this._getConfig('$:/plugins/NoteStreams/AudioSuite/configuration/transcriptions/editor-enabled', 'no');
    return val.toLowerCase() === 'yes';
};

/**
 * Get editor endpoint
 * @returns {string}
 */
TranscriptionService.prototype.getEditorEndpoint = function() {
    return this._getConfig(
        '$:/plugins/NoteStreams/AudioSuite/configuration/transcriptions/editor-endpoint',
        'https://api.openai.com/v1/chat/completions'
    );
};

/**
 * Get editor model
 * @returns {string}
 */
TranscriptionService.prototype.getEditorModel = function() {
    return this._getConfig(
        '$:/plugins/NoteStreams/AudioSuite/configuration/transcriptions/editor-model',
        'gpt-4o-mini'
    );
};

/**
 * Get editor prompt
 * @returns {string}
 */
TranscriptionService.prototype.getEditorPrompt = function() {
    return this._getConfig(
        '$:/plugins/NoteStreams/AudioSuite/configuration/transcriptions/editor-prompt',
        'Please clean up and format this transcription. Fix obvious errors, add punctuation, and format into paragraphs. Return only the edited text.'
    );
};

/**
 * Slice MP3 data for a time range
 * @param {ArrayBuffer} arrayBuffer - Full MP3 data
 * @param {object} mp3Info - Parsed MP3 info
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @returns {ArrayBuffer} Sliced MP3 data
 */
TranscriptionService.prototype.sliceMp3 = function(arrayBuffer, mp3Info, startTime, endTime) {
    if (!arrayBuffer || !mp3Info) return null;
    
    var startByte, endByte;
    
    if (mp3Info.isVBR && mp3Info.tocEntries && mp3Info.totalBytes) {
        startByte = mp3Parser.xingSeekByte(mp3Info, startTime);
        endByte = mp3Parser.xingSeekByte(mp3Info, endTime);
    } else {
        var range = mp3Parser.estimateByteRangeByFrameScan(arrayBuffer, startTime, endTime);
        startByte = range.startByte;
        endByte = range.endByte;
    }
    
    return arrayBuffer.slice(startByte, endByte);
};

/**
 * Create audio blob for transcription
 * @param {ArrayBuffer|AudioBuffer} audio - Source audio
 * @param {object} options - Options including mp3Info, startTime, endTime
 * @returns {Promise<Blob>}
 */
TranscriptionService.prototype.createAudioBlob = function(audio, options) {
    options = options || {};
    
    // If we have ArrayBuffer (MP3) and mp3Info, slice it
    if (audio instanceof ArrayBuffer && options.mp3Info) {
        var sliced = this.sliceMp3(audio, options.mp3Info, options.startTime || 0, options.endTime || options.duration || 0);
        if (sliced) {
            return Promise.resolve(new Blob([sliced], { type: 'audio/mpeg' }));
        }
    }
    
    // If we have AudioBuffer, encode to WAV
    if (audio && audio.numberOfChannels !== undefined) {
        var startTime = options.startTime || 0;
        var endTime = options.endTime || audio.duration;
        return wavEncoder.encodeRegionToWavBlob(audio, startTime, endTime);
    }
    
    return Promise.reject(new Error('Unsupported audio format'));
};

/**
 * Transcribe audio blob via API
 * @param {Blob} audioBlob - Audio data
 * @param {string} [filename='audio.mp3'] - Filename for upload
 * @returns {Promise<string>} Transcribed text
 */
TranscriptionService.prototype.transcribe = function(audioBlob, filename) {
    var self = this;
    var apiKey = this.getApiKey();
    
    if (!apiKey) {
        return Promise.reject(new Error('No API key configured for transcription'));
    }
    
    var endpoint = this.getEndpoint();
    var model = this.getModel();
    var language = this.getLanguage();
    var prompt = this.getPrompt();
    
    var formData = new FormData();
    formData.append('file', audioBlob, filename || 'audio.mp3');
    formData.append('model', model);
    
    if (language) {
        formData.append('language', language);
    }
    if (prompt) {
        formData.append('prompt', prompt);
    }
    
    return fetch(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + apiKey
        },
        body: formData
    })
    .then(function(response) {
        if (!response.ok) {
            return response.text().then(function(text) {
                throw new Error('Transcription API error: ' + response.status + ' - ' + text);
            });
        }
        return response.json();
    })
    .then(function(data) {
        var text = data.text || '';
        
        // Optionally run through LLM editor
        if (self.isEditorEnabled() && text) {
            return self.editTranscription(text);
        }
        
        return text;
    });
};

/**
 * Edit transcription via LLM
 * @param {string} text - Raw transcription
 * @returns {Promise<string>} Edited transcription
 */
TranscriptionService.prototype.editTranscription = function(text) {
    var apiKey = this.getApiKey();
    var endpoint = this.getEditorEndpoint();
    var model = this.getEditorModel();
    var systemPrompt = this.getEditorPrompt();
    
    if (!apiKey) {
        return Promise.resolve(text);
    }
    
    return fetch(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            temperature: 0.3
        })
    })
    .then(function(response) {
        if (!response.ok) {
            console.warn('Editor API error, returning original text');
            return text;
        }
        return response.json();
    })
    .then(function(data) {
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return data.choices[0].message.content || text;
        }
        return text;
    })
    .catch(function(err) {
        console.warn('Editor error, returning original text:', err);
        return text;
    });
};

/**
 * Full transcription flow - create blob and transcribe
 * @param {ArrayBuffer|AudioBuffer} audio - Source audio
 * @param {object} options - Options (startTime, endTime, mp3Info, etc)
 * @returns {Promise<string>} Transcribed text
 */
TranscriptionService.prototype.transcribeRegion = function(audio, options) {
    var self = this;
    options = options || {};
    
    var filename = options.mp3Info ? 'audio.mp3' : 'audio.wav';
    
    return this.createAudioBlob(audio, options)
        .then(function(blob) {
            return self.transcribe(blob, filename);
        });
};

// Exports
exports.TranscriptionService = TranscriptionService;

})();
