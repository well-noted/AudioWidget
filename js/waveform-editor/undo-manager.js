/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/undo-manager.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

var audioCache = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/audio-cache.js");

var DEFAULT_MAX_UNDO = 50;

function UndoManager(tiddlerTitle, maxUndo) {
    this.tiddlerTitle = tiddlerTitle;
    this.maxUndo = maxUndo || DEFAULT_MAX_UNDO;
    audioCache.initUndoStack(tiddlerTitle);
}

UndoManager.prototype._getStack = function() {
    return audioCache.getUndoStack(this.tiddlerTitle);
};

UndoManager.prototype._setStack = function(stack) {
    audioCache.setUndoStack(this.tiddlerTitle, stack);
};

/**
 * Push a new state onto the undo stack.
 * Truncates any redo history (states ahead of current index),
 * appends the new state, and trims if over max.
 */
UndoManager.prototype.push = function(state) {
    var u = this._getStack();
    if (!u) return;

    var cloned = this._clone(state);

    // Don't push if identical to current state
    if (u.index >= 0 && u.index < u.stack.length) {
        if (this._isEqual(u.stack[u.index], cloned)) {
            return;
        }
    }

    // Truncate any forward (redo) history
    if (u.index < u.stack.length - 1) {
        u.stack = u.stack.slice(0, u.index + 1);
    }

    u.stack.push(cloned);

    // Trim oldest entries if over max
    while (u.stack.length > this.maxUndo) {
        u.stack.shift();
    }

    u.index = u.stack.length - 1;
};

/**
 * Undo: move index back by one and return that state.
 * @returns {object|null} The previous state, or null if nothing to undo.
 */
UndoManager.prototype.undo = function() {
    var u = this._getStack();
    if (!u || u.index <= 0) return null;

    u.index--;
    return this._clone(u.stack[u.index]);
};

/**
 * Redo: move index forward by one and return that state.
 * @returns {object|null} The redo state, or null if nothing to redo.
 */
UndoManager.prototype.redo = function() {
    var u = this._getStack();
    if (!u || u.index >= u.stack.length - 1) return null;

    u.index++;
    return this._clone(u.stack[u.index]);
};

UndoManager.prototype.canUndo = function() {
    var u = this._getStack();
    return !!(u && u.index > 0);
};

UndoManager.prototype.canRedo = function() {
    var u = this._getStack();
    return !!(u && u.index < u.stack.length - 1);
};

UndoManager.prototype.getUndoCount = function() {
    var u = this._getStack();
    return (u && u.index > 0) ? u.index : 0;
};

UndoManager.prototype.getRedoCount = function() {
    var u = this._getStack();
    return (u) ? Math.max(0, u.stack.length - 1 - u.index) : 0;
};

UndoManager.prototype.clear = function() {
    this._setStack({ stack: [], index: -1 });
};

UndoManager.prototype._clone = function(obj) {
    if (obj === null || obj === undefined) return obj;
    return JSON.parse(JSON.stringify(obj));
};

UndoManager.prototype._isEqual = function(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
};

function createSelectionState(startTime, endTime, viewStart, viewEnd) {
    var state = {
        startTime: startTime,
        endTime: endTime
    };
    if (viewStart !== undefined) state.viewStart = viewStart;
    if (viewEnd !== undefined) state.viewEnd = viewEnd;
    return state;
}

exports.UndoManager = UndoManager;
exports.createSelectionState = createSelectionState;
exports.DEFAULT_MAX_UNDO = DEFAULT_MAX_UNDO;

})();
