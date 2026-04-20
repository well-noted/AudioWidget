/*\
title: $:/plugins/NoteStreams/AudioSuite/js/audio-utils.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

var exports = exports || {};

// Time formatting: seconds -> "HH:MM:SS" or "MM:SS"
exports.formatTime = function(totalSeconds) {
    totalSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    function pad(n){ return (n < 10 ? "0" : "") + n; }
    if(hours > 0) {
        return pad(hours) + ":" + pad(minutes) + ":" + pad(seconds);
    }
    return pad(minutes) + ":" + pad(seconds);
};

exports.parseTime = function(str) {
    if(!str) return 0;
    str = String(str).trim();
    if(!str) return 0;
    var parts = str.split(":").map(function(p){ return Number(p) || 0; });
    if(parts.length === 3){
        return parts[0]*3600 + parts[1]*60 + parts[2];
    }
    if(parts.length === 2){
        return parts[0]*60 + parts[1];
    }
    // single number - treat as seconds
    return parts.length ? parts[0] : 0;
};

// Sanitize a string for use in tiddler titles (remove unsafe chars)
exports.sanitizeTiddlerTitle = function(str){
    str = String(str || "");
    // Replace characters that are unsafe or problematic in tiddler paths
    var s = str.replace(/[\\/\[\]{}|#:?<>"'%*+^`~\\\\]+/g, '-');
    // collapse multiple hyphens and trim
    s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
    return s || 'unnamed';
};

// Generate a unique notation tiddler title for a parent + time range.
// Ensures uniqueness by appending a numeric suffix if needed.
exports.generateNotationTitle = function(wiki, parentTitle, startSeconds, endSeconds){
    // Allow a site/user-configurable template to define notation tiddler names.
    // Template tiddler path: $:/plugins/NoteStreams/AudioSuite/notationTitleTemplate
    // Supported placeholders: {parent}, {safeParent}, {start}, {end}, {start_time}, {end_time}
    var safeParent = exports.sanitizeTiddlerTitle(parentTitle || 'parent');
    var startNum = Number(startSeconds) || 0;
    var endNum = Number(endSeconds) || 0;
    var startTime = exports.formatTime(startNum);
    var endTime = exports.formatTime(endNum);

    var template = '';
    try {
        if (wiki && wiki.getTiddlerText) {
            template = wiki.getTiddlerText('$:/plugins/NoteStreams/AudioSuite/notationTitleTemplate', '');
        }
    } catch (e) { template = ''; }
    if (!template) {
        template = '$:/annotations/{safeParent}/{start}-{end}';
    }

    var title = String(template)
        .replace(/\{parent\}/g, String(parentTitle || ''))
        .replace(/\{safeParent\}/g, String(safeParent))
        .replace(/\{start\}/g, String(startNum))
        .replace(/\{end\}/g, String(endNum))
        .replace(/\{start_time\}/g, String(startTime))
        .replace(/\{end_time\}/g, String(endTime));

    // Ensure uniqueness by appending a numeric suffix when collisions occur
    var base = title;
    var suffix = 1;
    while(wiki && wiki.getTiddler(title)){
        title = base + '-' + suffix++;
    }
    return title;
};

// Format a time-range for display: either "MM:SS → MM:SS" or single time
exports.formatTimeRange = function(startSeconds, endSeconds){
    startSeconds = Number(startSeconds) || 0;
    endSeconds = Number(endSeconds) || 0;
    var s = exports.formatTime(startSeconds);
    if(endSeconds && endSeconds !== startSeconds){
        return s + ' → ' + exports.formatTime(endSeconds);
    }
    return s;
};

// Simple event bus
var listeners = Object.create(null);

exports.on = function(event, fn) {
    if(!event || typeof fn !== 'function') return;
    (listeners[event] = listeners[event] || []).push(fn);
};

exports.off = function(event, fn) {
    var a = listeners[event];
    if(!a) return;
    if(!fn) { delete listeners[event]; return; }
    var idx = a.indexOf(fn);
    if(idx !== -1) a.splice(idx,1);
};

exports.emit = function(event, data) {
    var a = listeners[event];
    if(!a) return;
    // copy to allow mutation during emit
    a.slice().forEach(function(fn){ try{ fn(data); } catch(e){} });
};

exports.resolveAudioSrc = function(wiki, title, preferredField) {
    if(!wiki || !title) return null;
    var t = wiki.getTiddler(title);
    if(!t) return null;
    var fields = t.fields || {};
    // If a preferred field was provided, check it first. If that field
    // contains the name of another tiddler, prefer the canonical URI on
    // that tiddler. Otherwise, if the field looks like a URL, return it.
    if(preferredField && fields[preferredField]){
        var pointer = fields[preferredField];
        try{
            var pt = wiki.getTiddler(pointer);
            if(pt && pt.fields){
                var pf = pt.fields;
                if(pf._canonical_uri) return pf._canonical_uri;
                if(pf.canonical_uri) return pf.canonical_uri;
                if(pf.canonicalUri) return pf.canonicalUri;
                if(pf.src) return pf.src;
                if(pf.url) return pf.url;
            }
        } catch(e){}
        // If pointer looks like an absolute/relative URL, return it directly
        if(typeof pointer === 'string' && (pointer.indexOf('://') !== -1 || pointer.charAt(0) === '/')){
            return pointer;
        }
        // Otherwise fall through to check the original tiddler's fields
    }
    // Common ways to reference an external audio resource on the source tiddler
    if(fields._canonical_uri) return fields._canonical_uri;
    if(fields.canonical_uri) return fields.canonical_uri;
    if(fields.canonicalUri) return fields.canonicalUri;
    if(fields.src) return fields.src;
    if(fields.url) return fields.url;
    // If the tiddler stores inline base64 audio and the type is audio/*, return a data: URI
    var type = fields.type || "";
    var text = fields.text;
    if(type.indexOf("audio/") === 0 && text) {
        return "data:" + type + ";base64," + text;
    }
    return null;
};

// export for require()
if(typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
} else {
    this.AudioSuiteUtils = exports;
}

})();
