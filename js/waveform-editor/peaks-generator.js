/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/peaks-generator.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

/**
 * Peaks Generator Module
 * 
 * Computes peak amplitude data from decoded AudioBuffers for waveform visualization.
 * Uses Web Workers when available for non-blocking computation.
 */

// Inline Web Worker script for computing peaks from channel Float32Array buffers
var _peakWorkerScript = "self.onmessage = function(e) {\n" +
"  try {\n" +
"    var data = e.data || {};\n" +
"    if (data.cmd !== 'peaks') { self.postMessage({ error: 'invalid command' }); return; }\n" +
"    var channelsBuffers = data.channels || [];\n" +
"    var channels = [];\n" +
"    for (var i = 0; i < channelsBuffers.length; i++) { channels.push(new Float32Array(channelsBuffers[i])); }\n" +
"    var length = data.length || (channels[0] ? channels[0].length : 0);\n" +
"    var desired = data.desired || 2000;\n" +
"    var blockSize = Math.max(1, Math.floor(length / desired));\n" +
"    var peakCount = Math.ceil(length / blockSize);\n" +
"    var peaks = new Float32Array(peakCount);\n" +
"    for (var pi = 0; pi < peakCount; pi++) {\n" +
"      var i0 = pi * blockSize;\n" +
"      var i1 = Math.min(length, i0 + blockSize);\n" +
"      var mx = 0;\n" +
"      for (var j = i0; j < i1; j++) {\n" +
"        for (var c = 0; c < channels.length; c++) {\n" +
"          var v = Math.abs(channels[c][j]); if (v > mx) mx = v;\n" +
"        }\n" +
"      }\n" +
"      peaks[pi] = mx;\n" +
"    }\n" +
"    self.postMessage({ peaks: peaks.buffer }, [peaks.buffer]);\n" +
"  } catch(err) { self.postMessage({ error: (err && err.message) ? err.message : String(err) }); }\n" +
"};";

/**
 * Compute peaks synchronously (chunked to avoid blocking for too long)
 * @param {AudioBuffer} decoded - The decoded AudioBuffer
 * @param {number} desired - Desired number of peak samples
 * @param {function} onProgress - Optional callback(peaks) called when complete
 */
function computePeaksSync(decoded, desired, onProgress) {
    try {
        var channels = decoded.numberOfChannels || 1;
        var len = decoded.length;
        var blockSize = Math.max(1, Math.floor(len / desired));
        var peaks = new Float32Array(Math.ceil(len / blockSize));
        var channelData = [];
        
        for (var c = 0; c < channels; c++) {
            channelData.push(decoded.getChannelData(c));
        }
        
        var totalPeaks = peaks.length;
        var peakIndex = 0;
        var chunkPeaks = 200;

        function processChunk() {
            var endPeak = Math.min(totalPeaks, peakIndex + chunkPeaks);
            for (var pi = peakIndex; pi < endPeak; pi++) {
                var i = pi * blockSize;
                var mx = 0;
                var end = Math.min(i + blockSize, len);
                for (var j = i; j < end; j++) {
                    for (var c2 = 0; c2 < channels; c2++) {
                        var val = Math.abs(channelData[c2][j]);
                        if (val > mx) mx = val;
                    }
                }
                peaks[pi] = mx;
            }
            peakIndex = endPeak;
            if (peakIndex < totalPeaks) {
                if (typeof requestIdleCallback === 'function') {
                    requestIdleCallback(processChunk);
                } else {
                    setTimeout(processChunk, 8);
                }
            } else {
                if (onProgress) onProgress(peaks);
            }
        }
        
        processChunk();
        return peaks;
    } catch(e) {
        if (onProgress) onProgress(null);
        return null;
    }
}

/**
 * Compute peaks asynchronously using Web Worker if available
 * @param {AudioBuffer} decoded - The decoded AudioBuffer
 * @param {number} desired - Desired number of peak samples (default 2000)
 * @returns {Promise<Float32Array|null>}
 */
function computePeaksAsync(decoded, desired) {
    return new Promise(function(resolve) {
        desired = desired || 2000;
        var channels = decoded.numberOfChannels || 1;
        var len = decoded.length;

        // Try Web Worker first
        try {
            if (typeof Worker !== 'undefined') {
                // Copy channel data into transferable ArrayBuffers
                var transfers = [];
                for (var cc = 0; cc < channels; cc++) {
                    var src = decoded.getChannelData(cc);
                    var copy = new Float32Array(src.length);
                    copy.set(src);
                    transfers.push(copy.buffer);
                }

                var blob = new Blob([_peakWorkerScript], { type: 'application/javascript' });
                var url = URL.createObjectURL(blob);
                var worker = new Worker(url);
                var finished = false;
                var timeoutId = setTimeout(function() {
                    try { worker.terminate(); } catch(e) {}
                    try { URL.revokeObjectURL(url); } catch(e) {}
                    if (!finished) {
                        // Fallback to sync
                        computePeaksSync(decoded, desired, resolve);
                    }
                }, 60000);

                worker.onmessage = function(ev) {
                    finished = true;
                    try { clearTimeout(timeoutId); } catch(e) {}
                    try { URL.revokeObjectURL(url); } catch(e) {}
                    try {
                        if (ev.data && ev.data.peaks) {
                            var peaksAB = ev.data.peaks;
                            var peaksArr = new Float32Array(peaksAB);
                            resolve(peaksArr);
                        } else if (ev.data && ev.data.error) {
                            computePeaksSync(decoded, desired, resolve);
                        } else {
                            computePeaksSync(decoded, desired, resolve);
                        }
                    } catch(e) { 
                        computePeaksSync(decoded, desired, resolve); 
                    }
                    try { worker.terminate(); } catch(e) {}
                };

                worker.onerror = function(err) {
                    try { clearTimeout(timeoutId); } catch(e) {}
                    try { URL.revokeObjectURL(url); } catch(e) {}
                    try { worker.terminate(); } catch(e) {}
                    computePeaksSync(decoded, desired, resolve);
                };

                // Post channel buffers as transferables
                worker.postMessage({ cmd: 'peaks', channels: transfers, length: len, desired: desired }, transfers);
                return;
            }
        } catch(e) { /* ignore and fallback */ }

        // Fallback to sync computation
        computePeaksSync(decoded, desired, resolve);
    });
}

// Exports
exports.computePeaksSync = computePeaksSync;
exports.computePeaksAsync = computePeaksAsync;

})();
