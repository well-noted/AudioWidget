/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/audio-loader.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

/**
 * Audio Loader Module
 * 
 * Handles loading and decoding audio from various sources (URLs, data URIs,
 * inline base64 tiddlers). Manages caching and deduplication of concurrent
 * requests.
 */

var audioCache = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/audio-cache.js");
var peaksGenerator = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/peaks-generator.js");

/**
 * Convert a data URI to an ArrayBuffer
 * @param {string} dataUri - The data URI
 * @returns {Promise<ArrayBuffer>}
 */
function dataUriToArrayBuffer(dataUri) {
    try {
        var comma = dataUri.indexOf(',');
        var header = dataUri.substring(0, comma);
        var isBase64 = header.indexOf(';base64') !== -1;
        var data = dataUri.substring(comma + 1);
        
        if (isBase64) {
            // Use fetch on the full data URI which lets the browser decode base64
            // into an ArrayBuffer efficiently and asynchronously.
            return fetch(dataUri).then(function(resp) { return resp.arrayBuffer(); });
        }
        
        // percent-encoded: decode synchronously but return a Promise for consistency
        var decoded = decodeURIComponent(data);
        var u8 = new Uint8Array(decoded.length);
        for (var j = 0; j < decoded.length; j++) u8[j] = decoded.charCodeAt(j);
        return Promise.resolve(u8.buffer);
    } catch (e) {
        return Promise.reject(e);
    }
}

/**
 * Decode an ArrayBuffer to an AudioBuffer and cache results
 * @param {ArrayBuffer} arrayBuffer - The audio data
 * @param {string} cacheKey - Key for caching
 * @param {object} options - Optional callbacks: onDuration, onPeaks, onBuffer
 * @returns {Promise}
 */
function decodeArrayBuffer(arrayBuffer, cacheKey, options) {
    options = options || {};
    
    return new Promise(function(resolve, reject) {
        if (!audioCache.hasAudioContext()) {
            return reject(new Error('WebAudio not available'));
        }
        
        try {
            var audioCtx = audioCache.getSharedAudioContext();
            if (!audioCtx) {
                audioCtx = new audioCache.AudioContextCtor();
            }

            var decodePromise;
            try {
                var maybePromise = audioCtx.decodeAudioData(arrayBuffer);
                if (maybePromise && typeof maybePromise.then === 'function') {
                    decodePromise = maybePromise;
                } else {
                    decodePromise = new Promise(function(res, rej) {
                        audioCtx.decodeAudioData(arrayBuffer, res, rej);
                    });
                }
            } catch(eDecode) {
                decodePromise = new Promise(function(res, rej) {
                    try { audioCtx.decodeAudioData(arrayBuffer, res, rej); } catch(e) { rej(e); }
                });
            }

            decodePromise.then(function(decoded) {
                try {
                    // Store decoded buffer and metadata
                    audioCache.updateCachedWaveform(cacheKey, {
                        duration: decoded.duration,
                        sampleRate: decoded.sampleRate,
                        audioBuffer: decoded,
                        mode: 'decoded'
                    });

                    // Callback with duration
                    if (options.onDuration) {
                        options.onDuration(decoded.duration);
                    }
                    
                    // Callback with buffer
                    if (options.onBuffer) {
                        options.onBuffer(decoded);
                    }

                    // Resolve early so UI can continue
                    resolve(decoded);

                    // Compute peaks asynchronously
                    peaksGenerator.computePeaksAsync(decoded, 2000).then(function(peaks) {
                        audioCache.updateCachedWaveform(cacheKey, { peaks: peaks });
                        if (options.onPeaks) {
                            options.onPeaks(peaks);
                        }
                    });

                } catch(e) {
                    audioCache.updateCachedWaveform(cacheKey, { decodeError: e && e.message ? e.message : String(e) });
                    reject(e);
                }
            }).catch(function(err) { reject(err); });
        } catch(e) { reject(e); }
    });
}

/**
 * Fetch audio from a URL with deduplication of concurrent requests
 * @param {string} url - The URL to fetch
 * @param {object} options - Optional callbacks
 * @returns {Promise}
 */
function fetchAudio(url, options) {
    options = options || {};
    
    if (!url) return Promise.reject(new Error('no src'));
    
    // Deduplicate concurrent requests
    var existingPromise = audioCache.getFetchPromise(url);
    if (existingPromise) {
        return existingPromise;
    }
    
    var promise = new Promise(function(resolve, reject) {
        // Use AbortController for timeout
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var signal = controller ? controller.signal : undefined;
        var fetchTimeout = 60000;
        var timeoutId = null;
        
        if (controller) {
            timeoutId = setTimeout(function() {
                try { controller.abort(); } catch(e) {}
            }, fetchTimeout);
        }

        fetch(url, signal ? { signal: signal } : undefined).then(function(resp) {
            if (timeoutId) try { clearTimeout(timeoutId); } catch(e) {}
            
            if (!resp.ok) throw new Error('fetch response not ok: ' + resp.status);
            
            var contentType = (resp.headers && resp.headers.get) ? 
                (resp.headers.get('content-type') || 'application/octet-stream') : 
                'application/octet-stream';
            
            return resp.arrayBuffer().then(function(ab) { 
                return { ab: ab, contentType: contentType }; 
            });
        }).then(function(result) {
            // Store original ArrayBuffer (copy before decode - decodeAudioData detaches)
            audioCache.updateCachedWaveform(url, {
                originalArrayBuffer: result.ab.slice(0),
                originalContentType: result.contentType
            });
            
            return decodeArrayBuffer(result.ab, url, options);
        }).then(function() { 
            resolve(); 
        }).catch(function(err) {
            // Try XHR fallback
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                xhr.responseType = 'arraybuffer';
                xhr.onload = function() {
                    if (xhr.status && xhr.status >= 200 && xhr.status < 300) {
                        try {
                            audioCache.updateCachedWaveform(url, {
                                originalArrayBuffer: xhr.response.slice(0),
                                originalContentType: xhr.getResponseHeader('content-type') || 'application/octet-stream'
                            });
                            decodeArrayBuffer(xhr.response, url, options).then(function() { 
                                resolve(); 
                            }).catch(function(e) { reject(e); });
                        } catch(e) { reject(e); }
                    } else if (xhr.status === 0 && xhr.response) {
                        // file:// may yield status 0 but response present
                        audioCache.updateCachedWaveform(url, {
                            originalArrayBuffer: xhr.response.slice(0),
                            originalContentType: xhr.getResponseHeader('content-type') || 'application/octet-stream'
                        });
                        decodeArrayBuffer(xhr.response, url, options).then(function() { 
                            resolve(); 
                        }).catch(function(e) { reject(e); });
                    } else {
                        reject(new Error('XHR failed with status ' + xhr.status));
                    }
                };
                xhr.onerror = function(e) { reject(new Error('XHR network error')); };
                xhr.send();
            } catch(e) { reject(e); }
        });
    });
    
    // Store in-flight promise
    audioCache.setFetchPromise(url, promise);
    
    // Cleanup when finished
    promise.then(
        function() { audioCache.clearFetchPromise(url); },
        function() { audioCache.clearFetchPromise(url); }
    );
    
    return promise;
}

/**
 * Metadata-only fallback using Audio element
 * @param {string} url - The URL to load
 * @returns {Promise<{duration: number}>}
 */
function loadMetadataOnly(url) {
    return new Promise(function(resolve, reject) {
        if (!url) return reject(new Error('no src'));
        
        try {
            var audio = new Audio();
            audio.preload = 'metadata';
            audio.src = url;
            
            var onMeta = function() {
                try { audio.removeEventListener('loadedmetadata', onMeta, false); } catch(e) {}
                var duration = (typeof audio.duration === 'number' && !isNaN(audio.duration)) ? audio.duration : 0;
                resolve({ duration: duration, audio: audio });
            };
            
            var onErr = function() {
                try { audio.removeEventListener('loadedmetadata', onMeta, false); } catch(e) {}
                try { audio.removeEventListener('error', onErr, false); } catch(e) {}
                reject(new Error('Audio element error'));
            };
            
            audio.addEventListener('loadedmetadata', onMeta, false);
            audio.addEventListener('error', onErr, false);
            
            // Timeout fallback
            setTimeout(function() {
                if (typeof audio.duration === 'number' && !isNaN(audio.duration)) {
                    try { audio.removeEventListener('loadedmetadata', onMeta, false); } catch(e) {}
                    try { audio.removeEventListener('error', onErr, false); } catch(e) {}
                    resolve({ duration: audio.duration, audio: audio });
                }
            }, 4000);
        } catch(e) { reject(e); }
    });
}

// Exports
exports.dataUriToArrayBuffer = dataUriToArrayBuffer;
exports.decodeArrayBuffer = decodeArrayBuffer;
exports.fetchAudio = fetchAudio;
exports.loadMetadataOnly = loadMetadataOnly;

})();
