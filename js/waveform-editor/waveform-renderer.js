/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/waveform-renderer.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

/**
 * Waveform Renderer Module
 * 
 * Handles canvas rendering of waveform visualization, including peaks,
 * selection region, handles, playhead, and color theming.
 */

var utils = require("$:/plugins/NoteStreams/AudioSuite/js/audio-utils.js");

/**
 * Resolve palette-aware colors from CSS custom properties, palette tiddler, or defaults
 * @param {object} wiki - TiddlyWiki instance for palette lookups
 * @returns {object} Color configuration
 */
function resolveColors(wiki) {
    var colors = {};
    var root = null;
    var rootStyles = null;
    try {
        root = document.documentElement;
        rootStyles = window.getComputedStyle(root);
    } catch(e) {}

    var paletteMap = null;
    function getPaletteMap() {
        if (paletteMap !== null) return paletteMap;
        paletteMap = {};
        try {
            var paletteName = (wiki && wiki.getTiddlerText) ? wiki.getTiddlerText('$:/palette', '').trim() : '';
            if (paletteName) {
                var pt = wiki.getTiddlerText(paletteName, '');
                if (pt) {
                    var lines = pt.split(/\r?\n/);
                    for (var i = 0; i < lines.length; i++) {
                        var m = lines[i].match(/^\s*([^:\s]+)\s*:\s*(.+)$/);
                        if (m) paletteMap[m[1].trim()] = m[2].trim();
                    }
                }
            }
        } catch(e) {}
        return paletteMap;
    }

    function resolve(cssVar, paletteKeys, fallback) {
        try {
            if (rootStyles) {
                var val = rootStyles.getPropertyValue(cssVar).trim();
                if (val) return val;
            }
        } catch(e) {}
        var pm = getPaletteMap();
        if (paletteKeys && paletteKeys.length) {
            for (var i = 0; i < paletteKeys.length; i++) {
                if (pm[paletteKeys[i]]) return pm[paletteKeys[i]];
            }
        }
        return fallback;
    }

    function addAlpha(color, alpha) {
        if (!color) return 'rgba(128,128,128,' + alpha + ')';
        color = color.trim();
        if (color.indexOf('rgba') === 0) return color;
        var rgbMatch = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        if (rgbMatch) return 'rgba(' + rgbMatch[1] + ',' + rgbMatch[2] + ',' + rgbMatch[3] + ',' + alpha + ')';
        var hex = color;
        if (hex.charAt(0) === '#') {
            hex = hex.substring(1);
            if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
            if (hex.length === 6) {
                var r = parseInt(hex.substring(0,2), 16);
                var g = parseInt(hex.substring(2,4), 16);
                var b = parseInt(hex.substring(4,6), 16);
                return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
            }
        }
        return color;
    }

    // Core colors
    colors.background = resolve('--palette-page', ['page-background','page','background'], '#ffffff');
    colors.foreground = resolve('--palette-fg', ['foreground','fg'], '#333333');
    colors.border = resolve('--palette-border', ['table-border','border'], '#cccccc');
    colors.accent = resolve('--palette-accent', ['primary','accent'], '#4285f4');
    colors.accentDark = resolve('--palette-head', ['primary-dark','head'], '#2c5598');
    colors.muted = resolve('--palette-muted', ['muted-foreground','muted'], '#999999');
    colors.mid = resolve('--palette-mid', ['mid','pre-background'], '#e0e0e0');

    // Derived canvas colors
    colors.peakNormal = addAlpha(colors.muted, 0.5);
    colors.peakSelected = addAlpha(colors.accent, 0.85);
    colors.regionOverlay = addAlpha(colors.accent, 0.12);
    colors.handleLine = addAlpha(colors.accentDark, 0.9);
    colors.handleFill = addAlpha(colors.accentDark, 0.9);
    colors.flatTrack = addAlpha(colors.muted, 0.25);
    colors.tickText = addAlpha(colors.muted, 0.7);
    colors.tickLine = addAlpha(colors.muted, 0.6);
    colors.playBtnBg = addAlpha(colors.background, 0.9);
    colors.playBtnBgActive = 'rgba(220, 50, 50, 0.85)';
    colors.playBtnIcon = addAlpha(colors.accentDark, 0.9);
    colors.playBtnIconActive = '#ffffff';
    colors.playBtnStroke = addAlpha(colors.accentDark, 0.6);
    colors.tooltipBg = addAlpha(colors.foreground, 0.85);
    colors.tooltipFg = colors.background;

    return colors;
}

/**
 * Draw the waveform on a canvas
 * @param {object} ctx - Canvas 2D context
 * @param {object} state - Rendering state
 */
function drawWaveform(ctx, state) {
    var w = state.width;
    var h = state.height;
    var dpr = state.dpr || 1;
    var peaks = state.peaks;
    var duration = state.duration || 1;
    var viewStart = state.viewStart || 0;
    var viewEnd = state.viewEnd || duration;
    var startTime = state.startTime || 0;
    var endTime = state.endTime || 0;
    var amplitudeZoom = state.amplitudeZoom || 1.0;
    var colors = state.colors || {};
    var isPlayingRegion = state.isPlayingRegion || false;
    var regionPlayhead = state.regionPlayhead || 0;
    var listenMode = state.listenMode;
    var listenPlayhead = state.listenPlayhead || 0;

    var vs = viewStart;
    var ve = viewEnd;
    if (ve <= vs) ve = vs + 1;
    var totalSecs = ve - vs;

    // Clear and draw background
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colors.background || '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // Helper to convert time to X coordinate
    function timeToX(time) {
        var t = Math.max(vs, Math.min(ve, time));
        return ((t - vs) / (ve - vs)) * w;
    }

    // Draw peaks or flat track fallback
    if (!peaks) {
        // Flat track fallback
        ctx.fillStyle = colors.flatTrack || 'rgba(150,150,150,0.25)';
        var barH = Math.max(8, h * 0.3);
        var by = Math.round((h - barH) / 2);
        ctx.fillRect(0, by, w, barH);
        
        // Ticks
        var tick = (totalSecs <= 60 ? 10 : 30);
        ctx.font = (10 * dpr) + 'px sans-serif';
        for (var t = Math.ceil(vs / tick) * tick; t < ve; t += tick) {
            var x = Math.round(((t - vs) / totalSecs) * w);
            ctx.fillStyle = colors.tickLine || 'rgba(120,120,120,0.6)';
            ctx.fillRect(x, by - 6, 1 * dpr, barH + 12);
            ctx.fillStyle = colors.tickText || colors.tickLine || 'rgba(120,120,120,0.6)';
            ctx.fillText(utils.formatTime(t), x + 4, by - 8);
        }
    } else {
        // Draw peaks
        var peakCount = peaks.length;
        var peaksPerSec = peakCount / duration;
        var visStartIdx = Math.max(0, Math.floor(vs * peaksPerSec));
        var visEndIdx = Math.min(peakCount, Math.ceil(ve * peaksPerSec));
        var visCount = Math.max(1, visEndIdx - visStartIdx);

        for (var px = 0; px < w; px++) {
            var relStart = Math.floor((px / w) * visCount);
            var relEnd = Math.min(visCount - 1, Math.floor(((px + 1) / w) * visCount));
            var startIndex = visStartIdx + relStart;
            var endIndex = visStartIdx + relEnd;
            var m = 0;
            for (var pi = startIndex; pi <= endIndex; pi++) {
                if (peaks[pi] > m) m = peaks[pi];
            }
            var ph = Math.max(1, Math.round(Math.min(1, m * amplitudeZoom) * h));
            var y = Math.round((h - ph) / 2);
            ctx.fillStyle = colors.peakNormal || 'rgba(150,150,150,0.5)';
            ctx.fillRect(px, y, 1, ph);
        }
    }

    // Draw selected region overlay
    if (endTime < startTime) { var tmp = endTime; endTime = startTime; startTime = tmp; }
    startTime = Math.max(0, Math.min(duration, startTime));
    endTime = Math.max(0, Math.min(duration, endTime));

    var sx = timeToX(startTime);
    var ex = timeToX(endTime);
    
    ctx.fillStyle = colors.regionOverlay || 'rgba(66,133,244,0.12)';
    ctx.fillRect(sx, 0, Math.max(1, ex - sx), h);

    // Recolor region peaks
    if (peaks) {
        var peakCount2 = peaks.length;
        var peaksPerSec2 = peakCount2 / duration;
        var visStartIdx2 = Math.max(0, Math.floor(vs * peaksPerSec2));
        var visEndIdx2 = Math.min(peakCount2, Math.ceil(ve * peaksPerSec2));
        var visCount2 = Math.max(1, visEndIdx2 - visStartIdx2);
        
        for (var px2 = Math.floor(sx); px2 < Math.ceil(ex); px2++) {
            if (px2 < 0 || px2 >= w) continue;
            var relStart2 = Math.floor(((px2 - Math.floor(sx)) / Math.max(1, Math.ceil(ex) - Math.floor(sx))) * visCount2);
            relStart2 = Math.max(0, Math.min(visCount2-1, relStart2));
            var relEnd2 = Math.min(visCount2-1, Math.floor(((px2 + 1 - Math.floor(sx)) / Math.max(1, Math.ceil(ex) - Math.floor(sx))) * visCount2));
            relEnd2 = Math.max(relStart2, relEnd2);
            var startIndex2 = visStartIdx2 + relStart2;
            var endIndex2 = visStartIdx2 + relEnd2;
            var m2 = 0;
            for (var pi2 = startIndex2; pi2 <= endIndex2; pi2++) if (peaks[pi2] > m2) m2 = peaks[pi2];
            var ph2 = Math.max(1, Math.round(Math.min(1, m2 * amplitudeZoom) * h));
            var y2 = Math.round((h - ph2) / 2);
            ctx.fillStyle = colors.peakSelected || 'rgba(66,133,244,0.85)';
            ctx.fillRect(px2, y2, 1, ph2);
        }
    }

    // Draw handles
    function drawHandle(x, fill) {
        ctx.strokeStyle = colors.handleLine || 'rgba(44, 85, 152, 0.9)';
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
        ctx.fillStyle = fill || (colors.handleFill || 'rgba(44,85,152,0.9)');
        ctx.beginPath(); ctx.moveTo(x, 4 * dpr); ctx.lineTo(x - 6 * dpr, 14 * dpr); ctx.lineTo(x + 6 * dpr, 14 * dpr); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x, h - 4 * dpr); ctx.lineTo(x - 6 * dpr, h - 14 * dpr); ctx.lineTo(x + 6 * dpr, h - 14 * dpr); ctx.closePath(); ctx.fill();
    }

    drawHandle(sx + 0.5);
    drawHandle(ex + 0.5);

    // Play button
    var playBtnW = ex - sx;
    var playBtnRadius = 14 * dpr;
    if (playBtnW > playBtnRadius * 4) {
        var pbMidX = (sx + ex) / 2;
        var pbMidY = h / 2;
        ctx.beginPath();
        ctx.arc(pbMidX, pbMidY, playBtnRadius, 0, Math.PI * 2);
        ctx.fillStyle = isPlayingRegion ? (colors.playBtnBgActive || 'rgba(220, 50, 50, 0.85)') : (colors.playBtnBg || 'rgba(255, 255, 255, 0.9)');
        ctx.fill();
        ctx.strokeStyle = colors.playBtnStroke || 'rgba(44, 85, 152, 0.6)';
        ctx.lineWidth = 1.5 * dpr;
        ctx.stroke();
        ctx.fillStyle = isPlayingRegion ? (colors.playBtnIconActive || '#fff') : (colors.playBtnIcon || 'rgba(44, 85, 152, 0.9)');
        if (isPlayingRegion) {
            var sq = playBtnRadius * 0.5;
            ctx.fillRect(pbMidX - sq, pbMidY - sq, sq * 2, sq * 2);
        } else {
            var triSize = playBtnRadius * 0.6;
            ctx.beginPath();
            ctx.moveTo(pbMidX - triSize * 0.4, pbMidY - triSize);
            ctx.lineTo(pbMidX + triSize * 0.8, pbMidY);
            ctx.lineTo(pbMidX - triSize * 0.4, pbMidY + triSize);
            ctx.closePath();
            ctx.fill();
        }
    }

    // Listen mode playhead
    if (listenMode && listenPlayhead > 0) {
        var phX = timeToX(listenPlayhead);
        if (phX >= 0 && phX <= w) {
            ctx.strokeStyle = 'rgba(255, 60, 60, 0.9)';
            ctx.lineWidth = 2 * dpr;
            ctx.beginPath();
            ctx.moveTo(phX, 0);
            ctx.lineTo(phX, h);
            ctx.stroke();
            var dSize = 5 * dpr;
            ctx.fillStyle = 'rgba(255, 60, 60, 0.9)';
            ctx.beginPath();
            ctx.moveTo(phX, 2 * dpr);
            ctx.lineTo(phX - dSize, 2 * dpr + dSize);
            ctx.lineTo(phX, 2 * dpr + dSize * 2);
            ctx.lineTo(phX + dSize, 2 * dpr + dSize);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = 'rgba(255, 60, 60, 1)';
            ctx.font = 'bold ' + (10 * dpr) + 'px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(utils.formatTime(Math.round(listenPlayhead)), phX, h - 4 * dpr);
        }
    }

    // Region playback playhead
    if (isPlayingRegion && regionPlayhead > 0) {
        var rphX = timeToX(regionPlayhead);
        if (rphX >= 0 && rphX <= w) {
            ctx.strokeStyle = 'rgba(34, 197, 94, 0.9)';
            ctx.lineWidth = 2 * dpr;
            ctx.beginPath();
            ctx.moveTo(rphX, 0);
            ctx.lineTo(rphX, h);
            ctx.stroke();
            ctx.fillStyle = 'rgba(34, 197, 94, 0.9)';
            ctx.beginPath();
            ctx.arc(rphX, 6 * dpr, 4 * dpr, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

/**
 * Draw minimap overview canvas
 * @param {object} ctx - Canvas 2D context
 * @param {object} state - Rendering state
 */
function drawMinimap(ctx, state) {
    var w = state.width;
    var h = state.height;
    var dpr = state.dpr || 1;
    var peaks = state.peaks;
    var duration = state.duration || 1;
    var startTime = state.startTime || 0;
    var endTime = state.endTime || 0;
    var viewStart = state.viewStart || 0;
    var viewEnd = state.viewEnd || duration;

    ctx.clearRect(0, 0, w, h);

    // Draw full-track peaks
    if (peaks && peaks.length) {
        var peakCount = peaks.length;
        var midY = h / 2;
        for (var px = 0; px < w; px++) {
            var sIdx = Math.floor((px / w) * peakCount);
            var eIdx = Math.min(peakCount - 1, Math.floor(((px + 1) / w) * peakCount));
            var mx = 0;
            for (var i = sIdx; i <= eIdx; i++) {
                if (peaks[i] > mx) mx = peaks[i];
            }
            var barH = Math.max(1, Math.round(mx * midY * 0.9));
            ctx.fillStyle = 'rgba(150, 150, 150, 0.4)';
            ctx.fillRect(px, midY - barH, 1, barH * 2);
        }
    } else {
        ctx.fillStyle = 'rgba(150, 150, 150, 0.2)';
        ctx.fillRect(0, h * 0.3, w, h * 0.4);
    }

    // Highlight selected region
    var regSx = (startTime / duration) * w;
    var regEx = (endTime / duration) * w;
    ctx.fillStyle = 'rgba(66, 133, 244, 0.4)';
    ctx.fillRect(regSx, 0, Math.max(1, regEx - regSx), h);

    // Highlight current viewport
    var vpSx = (viewStart / duration) * w;
    var vpEx = (viewEnd / duration) * w;
    ctx.strokeStyle = 'rgba(44, 85, 152, 0.8)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeRect(vpSx + 0.5, 0.5, Math.max(2, vpEx - vpSx - 1), h - 1);
    ctx.fillStyle = 'rgba(44, 85, 152, 0.08)';
    ctx.fillRect(vpSx, 0, vpEx - vpSx, h);
}

// Exports
exports.resolveColors = resolveColors;
exports.drawWaveform = drawWaveform;
exports.drawMinimap = drawMinimap;

})();
