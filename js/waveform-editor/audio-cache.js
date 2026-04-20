/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/audio-cache.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

/**
 * Audio Cache Module
 * 
 * Manages caching of decoded audio buffers, peaks data, and view state
 * to avoid redundant decoding and maintain state across widget lifecycle.
 */

// Module-level cache for decoded audio & peaks
var waveformCache = Object.create(null);

// In-flight fetch promises to deduplicate concurrent requests for same URL
var waveformFetchPromises = Object.create(null);

// Per-tiddler view state (survives widget destroy/recreate)
var viewStateCache = Object.create(null);

// Simple undo stack cache per-tiddler
var undoStackCache = Object.create(null);

// AudioContext constructor reference
var AudioContextCtor = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;

// Shared/reused AudioContext to avoid creation overhead on every decode
var _sharedAudioContext = null;

/**
 * Get or create a shared AudioContext
 */
function getSharedAudioContext() {
    if (!AudioContextCtor) return null;
    try {
        if (!_sharedAudioContext) {
            _sharedAudioContext = new AudioContextCtor();
        }
        // Resume if suspended (autoplay policy)
        if (_sharedAudioContext && _sharedAudioContext.state === 'suspended') {
            _sharedAudioContext.resume();
        }
        return _sharedAudioContext;
    } catch(e) {
        return null;
    }
}

/**
 * Get cached waveform data for a given key
 */
function getCachedWaveform(key) {
    return waveformCache[key] || null;
}

/**
 * Set cached waveform data
 */
function setCachedWaveform(key, data) {
    waveformCache[key] = data;
}

/**
 * Update cached waveform data (merge)
 */
function updateCachedWaveform(key, updates) {
    waveformCache[key] = waveformCache[key] || {};
    for (var k in updates) {
        if (Object.prototype.hasOwnProperty.call(updates, k)) {
            waveformCache[key][k] = updates[k];
        }
    }
}

/**
 * Check if a fetch is in flight for a given URL
 */
function getFetchPromise(url) {
    return waveformFetchPromises[url] || null;
}

/**
 * Set an in-flight fetch promise
 */
function setFetchPromise(url, promise) {
    waveformFetchPromises[url] = promise;
}

/**
 * Clear an in-flight fetch promise
 */
function clearFetchPromise(url) {
    try { delete waveformFetchPromises[url]; } catch(e) {}
}

/**
 * Get view state for a tiddler
 */
function getViewState(tiddlerTitle) {
    return viewStateCache[tiddlerTitle] || null;
}

/**
 * Set view state for a tiddler
 */
function setViewState(tiddlerTitle, state) {
    viewStateCache[tiddlerTitle] = state;
}

/**
 * Get undo stack for a tiddler
 */
function getUndoStack(tiddlerTitle) {
    return undoStackCache[tiddlerTitle] || null;
}

/**
 * Set undo stack for a tiddler
 */
function setUndoStack(tiddlerTitle, stack) {
    undoStackCache[tiddlerTitle] = stack;
}

/**
 * Initialize undo stack if not exists
 */
function initUndoStack(tiddlerTitle) {
    if (!undoStackCache[tiddlerTitle]) {
        undoStackCache[tiddlerTitle] = { stack: [], index: -1 };
    }
    return undoStackCache[tiddlerTitle];
}

/**
 * Check if AudioContext is available
 */
function hasAudioContext() {
    return !!AudioContextCtor;
}

// Exports
exports.getSharedAudioContext = getSharedAudioContext;
exports.getCachedWaveform = getCachedWaveform;
exports.setCachedWaveform = setCachedWaveform;
exports.updateCachedWaveform = updateCachedWaveform;
exports.getFetchPromise = getFetchPromise;
exports.setFetchPromise = setFetchPromise;
exports.clearFetchPromise = clearFetchPromise;
exports.getViewState = getViewState;
exports.setViewState = setViewState;
exports.getUndoStack = getUndoStack;
exports.setUndoStack = setUndoStack;
exports.initUndoStack = initUndoStack;
exports.hasAudioContext = hasAudioContext;
exports.AudioContextCtor = AudioContextCtor;

// Direct access to caches for advanced use cases
exports.waveformCache = waveformCache;
exports.viewStateCache = viewStateCache;
exports.undoStackCache = undoStackCache;

})();
