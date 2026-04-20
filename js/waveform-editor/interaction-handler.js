/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/interaction-handler.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

/**
 * Interaction Handler Module
 * 
 * Manages pointer events, drag operations, hit testing for waveform UI elements,
 * and auto-pan during drag operations near edges.
 */

/**
 * Hit test zones for selection handles and other UI elements
 */
var HIT_ZONES = {
    START_HANDLE: 'start-handle',
    END_HANDLE: 'end-handle',
    PLAY_BUTTON: 'play-button',
    REGION: 'region',
    WAVEFORM: 'waveform',
    NONE: 'none'
};

/**
 * Perform hit testing on waveform canvas
 * @param {number} x - Click X position (canvas coordinates)
 * @param {number} y - Click Y position (canvas coordinates)
 * @param {object} state - Current view/selection state
 * @returns {object} Hit test result with zone and metadata
 */
function hitTest(x, y, state) {
    var w = state.width;
    var h = state.height;
    var dpr = state.dpr || 1;
    var duration = state.duration || 1;
    var viewStart = state.viewStart || 0;
    var viewEnd = state.viewEnd || duration;
    var startTime = state.startTime || 0;
    var endTime = state.endTime || 0;
    
    // Convert times to canvas X positions
    function timeToX(time) {
        var t = Math.max(viewStart, Math.min(viewEnd, time));
        return ((t - viewStart) / (viewEnd - viewStart)) * w * dpr;
    }
    
    var sx = timeToX(startTime);
    var ex = timeToX(endTime);
    
    var handleWidth = 12 * dpr;
    var playBtnRadius = 14 * dpr;
    
    // Check start handle
    if (Math.abs(x - sx) < handleWidth) {
        return { zone: HIT_ZONES.START_HANDLE, time: startTime };
    }
    
    // Check end handle
    if (Math.abs(x - ex) < handleWidth) {
        return { zone: HIT_ZONES.END_HANDLE, time: endTime };
    }
    
    // Check play button (centered in region)
    var playBtnW = ex - sx;
    if (playBtnW > playBtnRadius * 4) {
        var pbMidX = (sx + ex) / 2;
        var pbMidY = h / 2;
        var dist = Math.sqrt(Math.pow(x - pbMidX, 2) + Math.pow(y - pbMidY, 2));
        if (dist < playBtnRadius) {
            return { zone: HIT_ZONES.PLAY_BUTTON };
        }
    }
    
    // Check region
    if (x >= sx && x <= ex) {
        return { zone: HIT_ZONES.REGION, time: xToTime(x, state) };
    }
    
    // General waveform
    return { zone: HIT_ZONES.WAVEFORM, time: xToTime(x, state) };
}

/**
 * Convert X coordinate to time
 * @param {number} x - Canvas X position
 * @param {object} state - View state
 * @returns {number} Time in seconds
 */
function xToTime(x, state) {
    var w = (state.width || 1) * (state.dpr || 1);
    var viewStart = state.viewStart || 0;
    var viewEnd = state.viewEnd || (state.duration || 1);
    var ratio = Math.max(0, Math.min(1, x / w));
    return viewStart + ratio * (viewEnd - viewStart);
}

/**
 * Convert time to X coordinate
 * @param {number} time - Time in seconds
 * @param {object} state - View state
 * @returns {number} Canvas X position
 */
function timeToX(time, state) {
    var w = (state.width || 1) * (state.dpr || 1);
    var viewStart = state.viewStart || 0;
    var viewEnd = state.viewEnd || (state.duration || 1);
    var t = Math.max(viewStart, Math.min(viewEnd, time));
    return ((t - viewStart) / (viewEnd - viewStart)) * w;
}

/**
 * Calculate new viewport after zoom operation
 * @param {number} zoomFactor - Zoom multiplier (>1 zoom in, <1 zoom out)
 * @param {number} centerTime - Time to center zoom around (or null for center)
 * @param {object} state - Current view state
 * @returns {object} New viewStart and viewEnd
 */
function calculateZoom(zoomFactor, centerTime, state) {
    var duration = state.duration || 1;
    var viewStart = state.viewStart || 0;
    var viewEnd = state.viewEnd || duration;
    var viewSpan = viewEnd - viewStart;
    
    // Use center of current view if no center time specified
    if (centerTime === null || centerTime === undefined) {
        centerTime = (viewStart + viewEnd) / 2;
    }
    
    var newSpan = viewSpan / zoomFactor;
    var minSpan = 0.5; // Minimum 0.5 seconds view
    var maxSpan = duration;
    newSpan = Math.max(minSpan, Math.min(maxSpan, newSpan));
    
    // Position of center time in current view (0-1)
    var centerRatio = (centerTime - viewStart) / viewSpan;
    
    var newStart = centerTime - newSpan * centerRatio;
    var newEnd = centerTime + newSpan * (1 - centerRatio);
    
    // Clamp to duration bounds
    if (newStart < 0) {
        newEnd -= newStart;
        newStart = 0;
    }
    if (newEnd > duration) {
        newStart -= (newEnd - duration);
        newEnd = duration;
    }
    newStart = Math.max(0, newStart);
    newEnd = Math.min(duration, newEnd);
    
    return { viewStart: newStart, viewEnd: newEnd };
}

/**
 * Calculate pan offset
 * @param {number} deltaX - Pixel delta to pan
 * @param {object} state - Current view state
 * @returns {object} New viewStart and viewEnd
 */
function calculatePan(deltaX, state) {
    var w = (state.width || 1) * (state.dpr || 1);
    var duration = state.duration || 1;
    var viewStart = state.viewStart || 0;
    var viewEnd = state.viewEnd || duration;
    var viewSpan = viewEnd - viewStart;
    
    var timeDelta = (deltaX / w) * viewSpan;
    var newStart = viewStart - timeDelta;
    var newEnd = viewEnd - timeDelta;
    
    // Clamp to bounds
    if (newStart < 0) {
        newEnd -= newStart;
        newStart = 0;
    }
    if (newEnd > duration) {
        newStart -= (newEnd - duration);
        newEnd = duration;
    }
    
    return {
        viewStart: Math.max(0, newStart),
        viewEnd: Math.min(duration, newEnd)
    };
}

/**
 * Auto-pan manager for drag operations near edges
 * @param {object} options - Configuration
 */
function AutoPanner(options) {
    this.edgeThreshold = options.edgeThreshold || 50; // pixels from edge
    this.panSpeed = options.panSpeed || 0.05; // time units per frame
    this.onPan = options.onPan || function() {};
    this.requestFrame = options.requestAnimationFrame || requestAnimationFrame.bind(window);
    this.cancelFrame = options.cancelAnimationFrame || cancelAnimationFrame.bind(window);
    
    this._frameId = null;
    this._direction = 0;
    this._lastTime = 0;
}

AutoPanner.prototype.start = function(x, width) {
    var leftEdge = this.edgeThreshold;
    var rightEdge = width - this.edgeThreshold;
    
    if (x < leftEdge) {
        this._direction = -1;
        this._intensity = 1 - (x / leftEdge);
    } else if (x > rightEdge) {
        this._direction = 1;
        this._intensity = (x - rightEdge) / this.edgeThreshold;
    } else {
        this._direction = 0;
        this._intensity = 0;
    }
    
    if (this._direction !== 0 && !this._frameId) {
        this._lastTime = performance.now();
        this._tick();
    } else if (this._direction === 0 && this._frameId) {
        this.stop();
    }
};

AutoPanner.prototype._tick = function() {
    var self = this;
    var now = performance.now();
    var dt = (now - self._lastTime) / 1000;
    self._lastTime = now;
    
    if (self._direction !== 0) {
        var delta = self._direction * self.panSpeed * self._intensity * Math.min(dt * 60, 2);
        self.onPan(delta);
        self._frameId = self.requestFrame(function() { self._tick(); });
    }
};

AutoPanner.prototype.stop = function() {
    if (this._frameId) {
        this.cancelFrame(this._frameId);
        this._frameId = null;
    }
    this._direction = 0;
};

/**
 * Drag state manager
 */
function DragState() {
    this.isDragging = false;
    this.dragType = null;
    this.startX = 0;
    this.startY = 0;
    this.startTime = 0;
    this.currentX = 0;
    this.currentY = 0;
    this.currentTime = 0;
    this.originalStartTime = 0;
    this.originalEndTime = 0;
    this.originalViewStart = 0;
    this.originalViewEnd = 0;
}

DragState.prototype.begin = function(type, x, y, time, state) {
    this.isDragging = true;
    this.dragType = type;
    this.startX = x;
    this.startY = y;
    this.startTime = time;
    this.currentX = x;
    this.currentY = y;
    this.currentTime = time;
    this.originalStartTime = state.startTime || 0;
    this.originalEndTime = state.endTime || 0;
    this.originalViewStart = state.viewStart || 0;
    this.originalViewEnd = state.viewEnd || (state.duration || 1);
};

DragState.prototype.update = function(x, y, time) {
    this.currentX = x;
    this.currentY = y;
    this.currentTime = time;
};

DragState.prototype.end = function() {
    var result = {
        dragType: this.dragType,
        deltaX: this.currentX - this.startX,
        deltaY: this.currentY - this.startY,
        deltaTime: this.currentTime - this.startTime
    };
    this.isDragging = false;
    this.dragType = null;
    return result;
};

// Exports
exports.HIT_ZONES = HIT_ZONES;
exports.hitTest = hitTest;
exports.xToTime = xToTime;
exports.timeToX = timeToX;
exports.calculateZoom = calculateZoom;
exports.calculatePan = calculatePan;
exports.AutoPanner = AutoPanner;
exports.DragState = DragState;

})();
