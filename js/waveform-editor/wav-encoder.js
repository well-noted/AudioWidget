/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/wav-encoder.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

/**
 * WAV Encoding Module
 * 
 * Provides functions to encode AudioBuffer regions to WAV format,
 * using Web Workers when available for better performance.
 */

// Helper: write ASCII string into DataView
function writeString(view, offset, string) {
    for (var i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

/**
 * Convert an AudioBuffer region to a mono 16-bit PCM WAV Blob (synchronous)
 */
function audioBufferToWavBlob(audioBuffer, startSec, endSec) {
    var sampleRate = audioBuffer.sampleRate;
    var startSample = Math.max(0, Math.floor(startSec * sampleRate));
    var endSample = Math.min(audioBuffer.length, Math.ceil(endSec * sampleRate));
    var numSamples = endSample - startSample;
    if (numSamples <= 0) return null;

    var channels = audioBuffer.numberOfChannels || 1;
    var mono = new Float32Array(numSamples);
    for (var ch = 0; ch < channels; ch++) {
        var channelData = audioBuffer.getChannelData(ch);
        for (var i = 0; i < numSamples; i++) {
            mono[i] += channelData[startSample + i];
        }
    }
    if (channels > 1) {
        for (var i2 = 0; i2 < numSamples; i2++) mono[i2] /= channels;
    }

    // Downsample to 16kHz if source is higher
    var targetRate = Math.min(sampleRate, 16000);
    var outputSamples;
    if (targetRate < sampleRate) {
        var ratio = sampleRate / targetRate;
        var outputLength = Math.floor(numSamples / ratio);
        outputSamples = new Float32Array(outputLength);
        for (var oi = 0; oi < outputLength; oi++) {
            var srcIdx = Math.floor(oi * ratio);
            outputSamples[oi] = mono[Math.min(srcIdx, numSamples - 1)];
        }
    } else {
        targetRate = sampleRate;
        outputSamples = mono;
    }

    var numOutputSamples = outputSamples.length;
    var bytesPerSample = 2;
    var numChannels = 1;
    var dataSize = numOutputSamples * bytesPerSample * numChannels;
    var headerSize = 44;
    var buffer = new ArrayBuffer(headerSize + dataSize);
    var view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');

    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, bytesPerSample * 8, true);

    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    var offset = 44;
    for (var si = 0; si < numOutputSamples; si++) {
        var s = Math.max(-1, Math.min(1, outputSamples[si]));
        var val = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(offset, val, true);
        offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

// Inline Web Worker script for WAV encoding
var _wavWorkerScript = "self.onmessage = function(e) {\n" +
"  try {\n" +
"    var data = e.data;\n" +
"    if (!data || data.cmd !== 'encode') {\n" +
"      self.postMessage({ error: 'invalid command' });\n" +
"      return;\n" +
"    }\n" +
"    var channelsBuffers = data.channels || [];\n" +
"    var channels = [];\n" +
"    for (var i = 0; i < channelsBuffers.length; i++) {\n" +
"      channels.push(new Float32Array(channelsBuffers[i]));\n" +
"    }\n" +
"    var sampleRate = data.sampleRate || 44100;\n" +
"    var numSamples = channels.length ? channels[0].length : 0;\n" +
"    var mono = new Float32Array(numSamples);\n" +
"    for (var c = 0; c < channels.length; c++) {\n" +
"      var cd = channels[c];\n" +
"      for (var i = 0; i < numSamples; i++) mono[i] += cd[i];\n" +
"    }\n" +
"    if (channels.length > 1) {\n" +
"      for (var i = 0; i < numSamples; i++) mono[i] /= channels.length;\n" +
"    }\n" +
"    var targetRate = Math.min(sampleRate, 16000);\n" +
"    var outputSamples;\n" +
"    if (targetRate < sampleRate) {\n" +
"      var ratio = sampleRate / targetRate;\n" +
"      var outLen = Math.floor(numSamples / ratio);\n" +
"      outputSamples = new Float32Array(outLen);\n" +
"      for (var oi = 0; oi < outLen; oi++) {\n" +
"        var srcIdx = Math.floor(oi * ratio);\n" +
"        outputSamples[oi] = mono[Math.min(srcIdx, numSamples - 1)];\n" +
"      }\n" +
"    } else {\n" +
"      targetRate = sampleRate;\n" +
"      outputSamples = mono;\n" +
"    }\n" +
"    var numOutputSamples = outputSamples.length;\n" +
"    var bytesPerSample = 2;\n" +
"    var numChannels = 1;\n" +
"    var dataSize = numOutputSamples * bytesPerSample * numChannels;\n" +
"    var headerSize = 44;\n" +
"    var buffer = new ArrayBuffer(headerSize + dataSize);\n" +
"    var view = new DataView(buffer);\n" +
"    function writeString(view, offset, string) {\n" +
"      for (var i = 0; i < string.length; i++) {\n" +
"        view.setUint8(offset + i, string.charCodeAt(i));\n" +
"      }\n" +
"    }\n" +
"    writeString(view, 0, 'RIFF');\n" +
"    view.setUint32(4, 36 + dataSize, true);\n" +
"    writeString(view, 8, 'WAVE');\n" +
"    writeString(view, 12, 'fmt ');\n" +
"    view.setUint32(16, 16, true);\n" +
"    view.setUint16(20, 1, true);\n" +
"    view.setUint16(22, numChannels, true);\n" +
"    view.setUint32(24, targetRate, true);\n" +
"    view.setUint32(28, targetRate * numChannels * bytesPerSample, true);\n" +
"    view.setUint16(32, numChannels * bytesPerSample, true);\n" +
"    view.setUint16(34, bytesPerSample * 8, true);\n" +
"    writeString(view, 36, 'data');\n" +
"    view.setUint32(40, dataSize, true);\n" +
"    var offset = 44;\n" +
"    for (var si = 0; si < numOutputSamples; si++) {\n" +
"      var s = Math.max(-1, Math.min(1, outputSamples[si]));\n" +
"      var val = s < 0 ? s * 0x8000 : s * 0x7FFF;\n" +
"      view.setInt16(offset, val, true);\n" +
"      offset += 2;\n" +
"    }\n" +
"    self.postMessage({ buffer: buffer }, [buffer]);\n" +
"  } catch (err) {\n" +
"    self.postMessage({ error: err && err.message ? err.message : String(err) });\n" +
"  }\n" +
"};";

/**
 * Encode region using Web Worker if available, else fall back to synchronous encoder
 * @returns {Promise<Blob|null>}
 */
function encodeRegionToWavBlob(audioBuffer, startSec, endSec) {
    return new Promise(function(resolve, reject) {
        try {
            var sampleRate = audioBuffer.sampleRate;
            var startSample = Math.max(0, Math.floor(startSec * sampleRate));
            var endSample = Math.min(audioBuffer.length, Math.ceil(endSec * sampleRate));
            var numSamples = endSample - startSample;
            if (numSamples <= 0) return resolve(null);

            var channels = audioBuffer.numberOfChannels || 1;
            var slices = [];
            for (var ch = 0; ch < channels; ch++) {
                var chData = audioBuffer.getChannelData(ch).subarray(startSample, endSample);
                var copy = new Float32Array(chData.length);
                copy.set(chData);
                slices.push(copy.buffer);
            }

            if (typeof Worker !== 'undefined') {
                try {
                    var blob = new Blob([_wavWorkerScript], { type: 'application/javascript' });
                    var url = URL.createObjectURL(blob);
                    var worker = new Worker(url);
                    var timeout = setTimeout(function(){
                        try { worker.terminate(); } catch(e) {}
                        try { URL.revokeObjectURL(url); } catch(e) {}
                        // Graceful fallback to synchronous encoding
                        try {
                            var fallback = audioBufferToWavBlob(audioBuffer, startSec, endSec);
                            resolve(fallback);
                        } catch(e2) {
                            reject(new Error('WAV encode timed out and sync fallback failed: ' + (e2.message || e2)));
                        }
                    }, 30000);
                    
                    worker.onmessage = function(ev) {
                        clearTimeout(timeout);
                        if (ev.data && ev.data.error) {
                            try{ worker.terminate(); }catch(e){}
                            try { URL.revokeObjectURL(url); } catch(e) {}
                            return reject(new Error(ev.data.error));
                        }
                        var ab = ev.data && ev.data.buffer;
                        try{ worker.terminate(); }catch(e){}
                        try { URL.revokeObjectURL(url); } catch(e) {}
                        if (ab) {
                            try {
                                var outBlob = new Blob([ab], { type: 'audio/wav' });
                                resolve(outBlob);
                            } catch(e) { return reject(e); }
                        } else {
                            // Worker returned no buffer — fall back to sync
                            try {
                                var fallback = audioBufferToWavBlob(audioBuffer, startSec, endSec);
                                resolve(fallback);
                            } catch(e2) {
                                resolve(null);
                            }
                        }
                    };
                    
                    worker.onerror = function(err) {
                        clearTimeout(timeout);
                        try { worker.terminate(); } catch(e) {}
                        try { URL.revokeObjectURL(url); } catch(e) {}
                        // Graceful fallback to synchronous encoding
                        try {
                            var fallback = audioBufferToWavBlob(audioBuffer, startSec, endSec);
                            resolve(fallback);
                        } catch(e2) {
                            reject(err || new Error('Worker error, sync fallback also failed'));
                        }
                    };
                    
                    worker.postMessage({ cmd: 'encode', channels: slices, sampleRate: sampleRate }, slices);
                    return;
                } catch(e) {
                    // fall back to synchronous below
                }
            }

            // Fallback: synchronous encoding
            var syncBlob = audioBufferToWavBlob(audioBuffer, startSec, endSec);
            resolve(syncBlob);
        } catch (e) { reject(e); }
    });
}

// Exports
exports.audioBufferToWavBlob = audioBufferToWavBlob;
exports.encodeRegionToWavBlob = encodeRegionToWavBlob;

})();
