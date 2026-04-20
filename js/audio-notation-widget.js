/* Changelog:
    - Added support for `skipEditor` captures and immediate editor-close events.
    - Emits `AudioSuite:notation-editor-closed` when editors are closed (save/cancel) or when skipEditor captures occur.
*/
/*\
title: $:/plugins/NoteStreams/AudioSuite/js/audio-notation-widget.js
type: application/javascript
module-type: widget
\*/

(function(){
"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var utils = require("$:/plugins/NoteStreams/AudioSuite/js/audio-utils.js");

// Apply palette variables from the TiddlyWiki $:/palette tiddler into
// CSS custom properties so the stylesheet can reference them. This runs
// once per page load.
var _AudioSuite_paletteApplied = false;
// Guards against multiple capture modals opening simultaneously (e.g. when
// more than one AudioNotationWidget instance has a _captureHandler registered).
var _AudioSuite_captureModalActive = false;
function _applyTiddlyWikiPalette(wiki) {
    try {
        if (_AudioSuite_paletteApplied) return;
        if (!wiki || !wiki.getTiddlerText) { _AudioSuite_paletteApplied = true; return; }
        var text = wiki.getTiddlerText('$:/palette', '') || wiki.getTiddlerText('$:/SitePalette', '') || '';
        if (!text) { _AudioSuite_paletteApplied = true; return; }
        var lines = text.split(/\r?\n/);
        var map = {};
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var m = line.match(/^\s*([^:\s]+)\s*:\s*(.+)$/);
            if (m) map[m[1].trim()] = m[2].trim();
        }
        var root = document.documentElement;
        function setIf(keyNames, varName) {
            for (var i = 0; i < keyNames.length; i++) {
                var k = keyNames[i];
                if (Object.prototype.hasOwnProperty.call(map, k) && map[k]) {
                    root.style.setProperty(varName, map[k]);
                    return;
                }
            }
        }
        // Map common palette keys to CSS variables used in the stylesheet
        setIf(['page','palette-page','palettePage'], '--palette-page');
        setIf(['background','palette-background','paletteBackground'], '--palette-background');
        setIf(['foreground','fg','palette-fg'], '--palette-fg');
        setIf(['border','palette-border'], '--palette-border');
        setIf(['head','palette-head'], '--palette-head');
        setIf(['accent','primary','palette-accent'], '--palette-accent');
        setIf(['accent-2','secondary','palette-accent-2'], '--palette-accent-2');
        setIf(['accent-3','palette-accent-3'], '--palette-accent-3');
        setIf(['muted','palette-muted'], '--palette-muted');
        setIf(['mid','palette-mid'], '--palette-mid');
        setIf(['timecode-start'], '--palette-timecode-start');
        setIf(['timecode-end'], '--palette-timecode-end');
        // Also set our convenience vars if specific keys exist
        if (map['page']) root.style.setProperty('--as-notes-bg', map['page']);
        if (map['background']) root.style.setProperty('--as-player-bg-grad-start', map['background']);
        if (map['accent']) root.style.setProperty('--as-accent-1', map['accent']);
        _AudioSuite_paletteApplied = true;
    } catch (e) {
        _AudioSuite_paletteApplied = true;
    }
}

// Ensure a single global click handler that listens for clicks on timecode
// links inserted into parent tiddlers. Clicking emits the same 'AudioSuite:seek'
// event used by the in-widget badges.
var _AudioSuite_parentTimecodeHandlerAdded = false;
function _ensureParentTimecodeHandler() {
    if (_AudioSuite_parentTimecodeHandlerAdded) return;
    try {
        document.addEventListener('click', function(ev){
            var el = ev.target;
            while (el && el !== document) {
                if (el.classList && el.classList.contains('AudioSuite-parent-timecode')) {
                    ev.preventDefault();
                    // Prefer resolving the start time from the referenced tiddler
                    // so changes to the notation tiddler are reflected automatically.
                    var tiddlerTitle = el.getAttribute('data-tiddler');
                    var start = 0;
                    try {
                        if (tiddlerTitle && typeof $tw !== 'undefined' && $tw.wiki) {
                            var tt = $tw.wiki.getTiddler(tiddlerTitle);
                            if (tt && tt.fields) {
                                start = Number(tt.fields['start-seconds']) || Number(tt.fields['start-seconds']) || 0;
                            }
                        }
                    } catch (e) {}
                    // Fallback to static attribute for backwards compatibility
                    if (!start) start = Number(el.getAttribute('data-start-seconds')) || 0;
                    var seekTrack = '';
                    var seekAudioSource = '';
                    try {
                        if (tiddlerTitle && typeof $tw !== 'undefined' && $tw.wiki) {
                            var stk = $tw.wiki.getTiddler(tiddlerTitle);
                            if (stk && stk.fields) {
                                seekTrack = stk.fields['parent-tiddler'] || '';
                                seekAudioSource = stk.fields['audio-source'] || '';
                            }
                        }
                    } catch(e) {}
                    if (utils && utils.emit) utils.emit('AudioSuite:seek', { seconds: start, track: seekTrack, audioSource: seekAudioSource });
                    break;
                }
                el = el.parentNode;
            }
        }, false);
        _AudioSuite_parentTimecodeHandlerAdded = true;
    } catch (e) {}
}

// ── Allow optional leading whitespace before [timecode] ──
var TC_LINE_RE       = /^[ \t]*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s?(.*)/;
var TC_ENTRY_START_RE = /^[ \t]*\[(\d{1,2}:\d{2}(?::\d{2})?)\]/;

// ── Indent constants & helpers (mirrors Canvas IndentUtils) ──
var INDENT_UNIT = '    ';   // 4 spaces per level
var INDENT_PX   = 24;       // pixels per level

function countIndent(text) {
    if (!text) return 0;
    var first = (text.split(/\r?\n/)[0]) || '';
    var m = first.match(/^( +)/);
    return m ? Math.floor(m[1].length / 4) : 0;
}

function stripIndent(text) {
    if (!text) return '';
    var n = countIndent(text);
    if (n <= 0) return text;
    var prefix = '';
    for (var i = 0; i < n * 4; i++) prefix += ' ';
    return (text.indexOf(prefix) === 0) ? text.substring(prefix.length) : text;
}

function applyIndent(text, indent) {
    if (!text || !indent || indent <= 0) return text || '';
    var prefix = '';
    for (var i = 0; i < indent; i++) prefix += INDENT_UNIT;
    return prefix + text;
}

var AudioNotationWidget = function(parseTreeNode,options) {
    this.initialise(parseTreeNode,options);
};

AudioNotationWidget.prototype = new Widget();

AudioNotationWidget.prototype.execute = function() {
    this.attrTiddler = this.getAttribute('tiddler', this.getVariable('currentTiddler') || '');
    this.attrEditable = this.getAttribute('editable','yes');
    this.attrClass = this.getAttribute('class','');
    this.attrExtraTags = this.getAttribute('extraTags', '');
    this.attrBookTiddler = this.getAttribute('bookTiddler', this.getVariable('bookTiddler') || '');
    this.attrUpdateParent = this.getAttribute('updateParent', 'yes');
    // Scope attribute: 'track' (default) or 'all' (aggregate all playlist tracks)
    this.attrScope = this.getAttribute('scope', 'track');
    // Runtime scope can be toggled by the user without changing the attribute
    if (typeof this._activeScope === 'undefined') {
        this._activeScope = this.attrScope;
    }
    // Read playlist context from parent player widget
    try {
        this._playlistTitles = JSON.parse(this.getVariable('playlistTitles') || '[]');
    } catch(e) {
        this._playlistTitles = [];
    }
    this.makeChildWidgets();
};

AudioNotationWidget.prototype.render = function(parent,nextSibling) {
    this.computeAttributes();
    this.execute();
    // Attempt to read the wiki palette and set CSS variables so the
    // stylesheet's palette-aware vars resolve to the wiki's colors.
    try { _applyTiddlyWikiPalette(this.wiki); } catch(e) {}

    var self = this;
    this._container = document.createElement('div');
    this._container.className = 'AudioSuite-notation' + (this.attrClass ? ' ' + this.attrClass : '');
    this._container._widget = this;

    var header = document.createElement('div');
    header.className = 'AudioSuite-notation__header';
    var title = document.createElement('strong');
    title.textContent = 'Notations';
    var hint = document.createElement('div');
    hint.className = 'AudioSuite-notation__hint';
    hint.textContent = 'Double-click an entry to edit';
    header.appendChild(title);
    header.appendChild(hint);

    // Scope toggle button: only visible when playlist has more than 1 track
    var scopeToggleBtn = null;
    try {
        if (this._playlistTitles && this._playlistTitles.length > 1) {
            scopeToggleBtn = document.createElement('button');
            scopeToggleBtn.className = 'AudioSuite-btn AudioSuite-notation__scope-toggle';
            scopeToggleBtn.textContent = (this._activeScope === 'all') ? '\uD83D\uDCC4 Current Track' : '\uD83D\uDCCB All Tracks';
            scopeToggleBtn.title = 'Toggle between viewing notes for the current track or all tracks';
            scopeToggleBtn.addEventListener('click', function() {
                try {
                    self._activeScope = (self._activeScope === 'all') ? 'track' : 'all';
                    scopeToggleBtn.textContent = (self._activeScope === 'all') ? '\uD83D\uDCC4 Current Track' : '\uD83D\uDCCB All Tracks';
                    self._renderEntries();
                } catch (e) { console.warn('[AudioSuite] scope toggle failed', e); }
            }, false);
            header.appendChild(scopeToggleBtn);
        }
    } catch (e) { console.warn('[AudioSuite] scope toggle button creation failed', e); }
    this._scopeToggleBtn = scopeToggleBtn;

    this._body = document.createElement('div');
    this._body.className = 'AudioSuite-notation__body';

    this._container.appendChild(header);
    this._container.appendChild(this._body);

    this._editingIndex = -1;
    this._pendingEditIndex = null;
    this._pendingCursorOffset = null;

    // Deregister any stale handler from a previous render() call before
    // registering a new one.  Without this, refreshSelf() paths that skip
    // removeChildDomNodes() would accumulate handlers and open N modals per
    // capture event.
    if (utils && utils.off && this._captureHandler) {
        utils.off('AudioSuite:timecode-captured', this._captureHandler);
    }
    this._captureHandler = function(data) { self._handleTimecodeCapture(data); };
    if (utils && utils.on) {
        utils.on('AudioSuite:timecode-captured', this._captureHandler);
    }

    // Ensure parent-timecode click handler is present so links in the parent
    // transclusion tiddler cause the player to seek.
    _ensureParentTimecodeHandler();

    parent.insertBefore(this._container,nextSibling);
    this.domNodes.push(this._container);

    // Attempt migration if parent tiddler contains old-format notations
    this._migrateOldFormat();
    this._renderEntries();
};
// === MIGRATION HELPERS (old format) ===
// The following parsing helpers are retained only to support a one-time
// migration from the legacy single-tiddler format into atomic notation
// tiddlers. New runtime logic uses `_loadEntries()` to fetch per-notation
// tiddlers via filters. Do not use these helpers in normal operation.

AudioNotationWidget.prototype._parseEntries = function(text) {
    text = text || '';
    var entries = [];
    var lines = text.split(/\r?\n/);
    var pos = 0;
    var current = null;

    function startEntry(isTimecoded, timecode) {
        current = {
            start: pos,
            end: null,
            timecode: isTimecoded ? timecode : null,
            seconds: isTimecoded ? (utils && utils.parseTime ? utils.parseTime(timecode) : 0) : 0,
            text: null,
            noteText: '',
            isTimecoded: !!isTimecoded
        };
    }

    function flushEntry(endPos) {
        if (!current) return;
        current.end = endPos;
        current.text = text.substring(current.start, current.end);

        // ── Outliner indent: count leading 4-space groups ──
        current.indent = countIndent(current.text);

        if (current.isTimecoded) {
            var firstLine = current.text.split(/\r?\n/)[0] || '';
            var m = TC_LINE_RE.exec(stripIndent(firstLine));
            current.noteText = (m && m[2]) ? m[2] : '';
        } else {
            current.noteText = stripIndent(current.text);
        }
        entries.push(current);
        current = null;
    }

    for (var i=0;i<lines.length;i++) {
        var line = lines[i];
        var m = TC_ENTRY_START_RE.exec(line);
        if (m) {
            if (current) flushEntry(pos);
            startEntry(true, m[1]);
        } else {
            if (!current) startEntry(false, null);
        }
        pos += line.length + (i < lines.length - 1 ? 1 : 0);
    }

    if (current) flushEntry(text.length);
    return entries;
};
AudioNotationWidget.prototype._loadEntries = function() {
    // When in 'all' scope with playlist data, aggregate entries from all tracks
    if (this._activeScope === 'all' && this._playlistTitles && this._playlistTitles.length > 0) {
        return this._loadAllTrackEntries();
    }
    // Load notation tiddlers tagged with the parent tiddler title that belong to
    // this parent tiddler, sorted by numeric start-seconds.
    var filter = '[tag[' + this.attrTiddler + ']field:parent-tiddler[' + this.attrTiddler + ']sort:number[start-seconds]]';
    var titles = this.wiki.filterTiddlers(filter) || [];
    var entries = [];
    for (var i=0;i<titles.length;i++){
        var t = this.wiki.getTiddler(titles[i]);
        if(!t) continue;
        var f = t.fields || {};
        var start = Number(f['start-seconds']) || 0;
        var end = Number(f['end-seconds']) || start;
        var entry = {
            title: t.fields.title,
            'audio-source': f['audio-source'] || f['audioSource'] || '',
            'parent-tiddler': f['parent-tiddler'] || '',
            'start-seconds': start,
            'end-seconds': end,
            'start-timecode': f['start-timecode'] || f['start-timecode'] || utils.formatTime(start),
            'end-timecode': f['end-timecode'] || utils.formatTime(end),
            indent: Number(f['indent']) || 0,
            text: t.fields.text || t.text || '',
            isTimecoded: true,
            timecode: utils.formatTime(start),
            seconds: start
        };
        entries.push(entry);
    }
    // Ensure deterministic chronological ordering (numeric), tie-breaking by title.
    try {
        entries.sort(function(a,b){
            var as = Number(a['start-seconds'] || a.seconds || 0);
            var bs = Number(b['start-seconds'] || b.seconds || 0);
            if (as < bs) return -1;
            if (as > bs) return 1;
            // If times equal, sort by title to keep order stable.
            try { return String(a.title || '').localeCompare(String(b.title || '')); } catch(e) { return 0; }
        });
    } catch(e) {}
    return entries;
};

// Load entries from all playlist tracks (for 'all' scope)
AudioNotationWidget.prototype._loadAllTrackEntries = function() {
    var allEntries = [];
    var playlistTitles = this._playlistTitles || [];
    for (var pi = 0; pi < playlistTitles.length; pi++) {
        var trackTitle = playlistTitles[pi];
        try {
            var filter = '[tag[' + trackTitle + ']field:parent-tiddler[' + trackTitle + ']]';
            var titles = this.wiki.filterTiddlers(filter) || [];
            for (var i = 0; i < titles.length; i++) {
                var t = this.wiki.getTiddler(titles[i]);
                if (!t) continue;
                var f = t.fields || {};
                var start = Number(f['start-seconds']) || 0;
                var end = Number(f['end-seconds']) || start;
                var entry = {
                    title: t.fields.title,
                    'audio-source': f['audio-source'] || f['audioSource'] || '',
                    'parent-tiddler': f['parent-tiddler'] || trackTitle,
                    'start-seconds': start,
                    'end-seconds': end,
                    'start-timecode': f['start-timecode'] || utils.formatTime(start),
                    'end-timecode': f['end-timecode'] || utils.formatTime(end),
                    indent: Number(f['indent']) || 0,
                    text: t.fields.text || t.text || '',
                    isTimecoded: true,
                    timecode: utils.formatTime(start),
                    seconds: start
                };
                allEntries.push(entry);
            }
        } catch (e) { console.warn('[AudioSuite] _loadAllTrackEntries failed for track', trackTitle, e); }
    }
    // Sort: primary by parent-tiddler (playlist order), secondary by start-seconds, tertiary by title
    var playlistOrder = playlistTitles;
    try {
        allEntries.sort(function(a, b) {
            var aParent = a['parent-tiddler'] || '';
            var bParent = b['parent-tiddler'] || '';
            var aIdx = playlistOrder.indexOf(aParent);
            var bIdx = playlistOrder.indexOf(bParent);
            if (aIdx === -1) aIdx = 999999;
            if (bIdx === -1) bIdx = 999999;
            if (aIdx !== bIdx) return aIdx - bIdx;
            var as = Number(a['start-seconds'] || 0);
            var bs = Number(b['start-seconds'] || 0);
            if (as !== bs) return as - bs;
            try { return String(a.title || '').localeCompare(String(b.title || '')); } catch(e) { return 0; }
        });
    } catch (e) {}
    return allEntries;
};

AudioNotationWidget.prototype._renderEntries = function() {
    var self = this;
    while (this._body.firstChild) this._body.removeChild(this._body.firstChild);

    // Load atomic notation tiddlers first
    this._entries = this._loadEntries() || [];

    if (!this._entries || !this._entries.length) {
        var empty = document.createElement('div');
        empty.className = 'AudioSuite-notation__empty';
        empty.textContent = 'No notes yet. Use the Add at Timecode button while listening, or double-click here to start writing.';
        this._body.appendChild(empty);
        return;
    }

    var lastParentTrack = null;
    for (var i=0;i<this._entries.length;i++) {
        // Insert track group header in 'all' scope when the parent track changes
        if (this._activeScope === 'all') {
            try {
                var entryParent = this._entries[i]['parent-tiddler'] || '';
                if (entryParent && entryParent !== lastParentTrack) {
                    lastParentTrack = entryParent;
                    var groupHeader = document.createElement('div');
                    groupHeader.className = 'AudioSuite-notation__track-group-header';
                    var groupLabel = entryParent;
                    try {
                        var gt = self.wiki.getTiddler(entryParent);
                        if (gt && gt.fields && gt.fields.caption) groupLabel = gt.fields.caption;
                    } catch (e) {}
                    groupHeader.textContent = groupLabel;
                    this._body.appendChild(groupHeader);
                }
            } catch (e) {}
        }
        var node = this._buildEntryDOM(this._entries[i], i);
        this._body.appendChild(node);
    }

    if (typeof this._pendingEditIndex === 'number') {
        var idx = this._pendingEditIndex;
        var cursorPos = this._pendingCursorOffset || 0;
        this._pendingEditIndex = null;
        this._pendingCursorOffset = null;
        this._openEntryEditor(idx, cursorPos);
    }
};

AudioNotationWidget.prototype._buildEntryDOM = function(entry, index) {
    var self = this;
    var entryDiv = document.createElement('div');
    entryDiv.className = 'AudioSuite-notation__entry';
    entryDiv.setAttribute('data-entry-index', String(index));
    entryDiv._notationWidget = this;
    if (entry.indent) {
        entryDiv.style.marginLeft = (entry.indent * INDENT_PX) + 'px';
    }

    var viewDiv = document.createElement('div');
    viewDiv.className = 'AudioSuite-notation__entry-view';

    // In 'all' scope, prepend a track label before the timecode badge
    if (this._activeScope === 'all' && entry['parent-tiddler']) {
        try {
            var trackLabel = document.createElement('span');
            trackLabel.className = 'AudioSuite-notation__track-label';
            var trackDisplayName = entry['parent-tiddler'];
            try {
                var tlt = self.wiki.getTiddler(entry['parent-tiddler']);
                if (tlt && tlt.fields && tlt.fields.caption) trackDisplayName = tlt.fields.caption;
            } catch (e) {}
            trackLabel.textContent = trackDisplayName;
            trackLabel.title = 'Click to navigate to this track';
            trackLabel.addEventListener('click', (function(entryRef) {
                return function(ev) {
                    ev.stopPropagation();
                    try {
                        if (utils && utils.emit) {
                            utils.emit('AudioSuite:seek', {
                                seconds: Number(entryRef['start-seconds']) || 0,
                                track: entryRef['parent-tiddler'] || '',
                                audioSource: entryRef['audio-source'] || ''
                            });
                        }
                    } catch (e) { console.warn('[AudioSuite] track label click failed', e); }
                };
            })(entry), false);
            viewDiv.appendChild(trackLabel);
        } catch (e) { console.warn('[AudioSuite] track label creation failed', e); }
    }

    if (entry.isTimecoded) {
        var badge = document.createElement('span');
        badge.className = 'AudioSuite-notation__timecode';
        var rangeLabel = utils.formatTimeRange(entry['start-seconds'], entry['end-seconds']);
        badge.textContent = '[' + rangeLabel + ']';
        badge.title = 'Click to seek to ' + utils.formatTime(entry['start-seconds']);
        badge.addEventListener('click', function(ev){ ev.stopPropagation(); if (utils && utils.emit) utils.emit('AudioSuite:seek', { seconds: Number(entry['start-seconds']), track: entry['parent-tiddler'] || self.attrTiddler, audioSource: entry['audio-source'] || '' }); });
        viewDiv.appendChild(badge);

        var openBtn = document.createElement('button');
        openBtn.className = 'AudioSuite-notation__open-tiddler AudioSuite-btn';
        openBtn.textContent = '📄';
        openBtn.title = 'Open note tiddler: ' + (entry.title || '');
        openBtn.addEventListener('click', (function(entryTitle, widget){
            return function(ev){
                ev.stopPropagation();
                if(!entryTitle) return;
                try {
                    // TiddlyWiki navigation: dispatch tm-navigate up the widget tree.
                    // This opens the tiddler in the story river (or whatever the
                    // current navigator widget is configured to do).
                    widget.dispatchEvent({
                        type: 'tm-navigate',
                        navigateTo: entryTitle,
                        navigateFromTitle: widget.attrTiddler || ''
                    });
                } catch(e) {
                    console.warn('[AudioSuite] navigate to notation tiddler failed', e);
                    // Fallback: try global $tw story navigation
                    try {
                        if (typeof $tw !== 'undefined' && $tw.rootWidget) {
                            $tw.rootWidget.dispatchEvent({
                                type: 'tm-navigate',
                                navigateTo: entryTitle
                            });
                        }
                    } catch(e2) {
                        console.warn('[AudioSuite] fallback navigate also failed', e2);
                    }
                }
            };
        })(entry.title, self), false);
        viewDiv.appendChild(openBtn);
    }

    var content = document.createElement('div');
    content.className = 'AudioSuite-notation__note-content';

    if (entry.isTimecoded) {
        // Render as one-or-more paragraphs. Paragraphs are separated by
        // a blank line (two or more newlines). Preserve intra-paragraph
        // line breaks using <br> so that multi-line paragraphs show correctly.
        var text = entry.text || '';
        var paragraphs = text.split(/\r?\n\s*\r?\n/);
        var hasVisible = false;
        for (var pi = 0; pi < paragraphs.length; pi++) {
            var p = paragraphs[pi] || '';
            if (!p.trim()) continue;
            hasVisible = true;
            var pDiv = document.createElement('div');
            pDiv.className = 'AudioSuite-notation__paragraph';
            var plines = p.split(/\r?\n/);
            for (var lj = 0; lj < plines.length; lj++) {
                // Render plain text but convert [[Wikilinks]] into clickable links
                // Pattern: [[target]] or [[target|display]] (target before pipe)
                try {
                    var line = plines[lj] || '';
                    var parts = line.split(/\[\[([^\]]+)\]\]/g);
                    for (var partIdx = 0; partIdx < parts.length; partIdx++) {
                        if (partIdx % 2 === 0) {
                            // plain text
                            if (parts[partIdx]) pDiv.appendChild(document.createTextNode(parts[partIdx]));
                        } else {
                            // wikilink content
                            var linkInner = parts[partIdx] || '';
                            var lp = linkInner.split('|');
                            var target = (lp[0] || '').trim();
                            var display = (lp[1] || lp[0] || '').trim();
                            if (!target) {
                                pDiv.appendChild(document.createTextNode(linkInner));
                            } else {
                                var a = document.createElement('a');
                                a.className = 'AudioSuite-notation__wikilink tc-tiddlylink';
                                try { a.href = '#' + encodeURIComponent(target); } catch(e) { a.href = '#'; }
                                a.setAttribute('data-tiddler', target);
                                a.title = target;
                                a.textContent = display || target;
                                // Navigate via tm-navigate so TiddlyWiki handles opening
                                (function(t){
                                    a.addEventListener('click', function(ev){
                                        ev.preventDefault();
                                        ev.stopPropagation();
                                        try {
                                            self.dispatchEvent({ type: 'tm-navigate', navigateTo: t, navigateFromTitle: self.attrTiddler || '' });
                                        } catch(e) {}
                                    }, false);
                                })(target);
                                pDiv.appendChild(a);
                            }
                        }
                    }
                } catch (e) {
                    pDiv.appendChild(document.createTextNode(plines[lj]));
                }
                if (lj < plines.length - 1) pDiv.appendChild(document.createElement('br'));
            }
            content.appendChild(pDiv);
        }
        if (!hasVisible) {
            var placeholder = document.createElement('span');
            placeholder.className = 'AudioSuite-notation__note-placeholder';
            placeholder.textContent = '(empty — double-click to add a note)';
            content.appendChild(placeholder);
        }
    } else {
        var block = document.createElement('div');
        block.className = 'AudioSuite-notation__text-block';
        // Render block while converting wikilinks
        try {
            var lines = String(entry.text || '').split(/\r?\n/);
            for (var li = 0; li < lines.length; li++) {
                var lnParts = lines[li].split(/\[\[([^\]]+)\]\]/g);
                for (var pi2 = 0; pi2 < lnParts.length; pi2++) {
                    if (pi2 % 2 === 0) {
                        if (lnParts[pi2]) block.appendChild(document.createTextNode(lnParts[pi2]));
                    } else {
                        var inner = lnParts[pi2] || '';
                        var sp = inner.split('|');
                        var tgt = (sp[0] || '').trim();
                        var dsp = (sp[1] || sp[0] || '').trim();
                        if (!tgt) {
                            block.appendChild(document.createTextNode(inner));
                        } else {
                            var link = document.createElement('a');
                            link.className = 'AudioSuite-notation__wikilink tc-tiddlylink';
                            try { link.href = '#' + encodeURIComponent(tgt); } catch(e) { link.href = '#'; }
                            link.setAttribute('data-tiddler', tgt);
                            link.title = tgt;
                            link.textContent = dsp || tgt;
                            (function(t){ link.addEventListener('click', function(ev){ ev.preventDefault(); ev.stopPropagation(); try { self.dispatchEvent({ type: 'tm-navigate', navigateTo: t, navigateFromTitle: self.attrTiddler || '' }); } catch(e){} }, false); })(tgt);
                            block.appendChild(link);
                        }
                    }
                }
                if (li < lines.length - 1) block.appendChild(document.createElement('br'));
            }
        } catch (e) {
            block.textContent = entry.text || '';
        }
        content.appendChild(block);
    }

    if (this.attrEditable === 'yes') {
        viewDiv.addEventListener('dblclick', function(ev){
            ev.preventDefault();
            ev.stopPropagation();
            self._openEntryEditor(index);
        });
    }

    viewDiv.appendChild(content);

    var editDiv = document.createElement('div');
    editDiv.className = 'AudioSuite-notation__entry-edit';
    editDiv.style.display = 'none';

    var editor = document.createElement('div');
    editor.className = 'AudioSuite-notation__entry-editor';
    editor.setAttribute('contenteditable','true');
    editor.setAttribute('spellcheck','true');
    editor.setAttribute('data-placeholder','[MM:SS] Your note text...');

    // Input handling for contenteditable
    editor.addEventListener('input', function(){
        // keep layout consistent; no textarea auto-resize needed
        // trigger any autosave / UI updates later when saving
    });

    editor.addEventListener('keydown', function(ev){
        var isTab   = ev.key === 'Tab';
        var isEnter = ev.key === 'Enter';
        var isEsc   = ev.key === 'Escape' || ev.key === 'Esc';

        // Tab / Shift+Tab → outliner indent / outdent
        if (isTab) {
            ev.preventDefault();
            self._changeEntryIndent(index, ev.shiftKey ? -1 : 1);
            return;
        }

        if ((ev.ctrlKey || ev.metaKey) && isEnter) {
            ev.preventDefault();
            self._closeEntryEditor(index, true);
            return;
        }
        if (isEsc) {
            ev.preventDefault();
            self._closeEntryEditor(index, false);
            return;
        }
    });

    var toolbar = document.createElement('div');
    toolbar.className = 'AudioSuite-notation__entry-toolbar';
    var saveBtn = document.createElement('button');
    saveBtn.className = 'AudioSuite-notation__save-btn AudioSuite-btn';
    saveBtn.textContent = '✔ Save';
    saveBtn.addEventListener('click', function(ev){ ev.stopPropagation(); self._closeEntryEditor(index, true); });
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'AudioSuite-notation__cancel-btn AudioSuite-btn';
    cancelBtn.textContent = '✖ Cancel';
    cancelBtn.addEventListener('click', function(ev){ ev.stopPropagation(); self._closeEntryEditor(index, false); });
    var help = document.createElement('span');
    help.className = 'AudioSuite-notation__help';
    help.textContent = 'Ctrl+Enter to save · Escape to cancel · Tab / Shift+Tab to indent';

    toolbar.appendChild(saveBtn);
    toolbar.appendChild(cancelBtn);
    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'AudioSuite-notation__delete-btn AudioSuite-btn';
    deleteBtn.textContent = '🗑 Delete';
    deleteBtn.addEventListener('click', function(ev){ ev.stopPropagation(); self._deleteEntry(index); });
    toolbar.appendChild(deleteBtn);
    // Tag input: allow per-entry additional tags (excluding parent tag)
    var tagLabel = document.createElement('label');
    tagLabel.className = 'AudioSuite-notation__tag-label';
    tagLabel.textContent = 'Tags: ';

    var tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.className = 'AudioSuite-notation__tag-input';
    tagInput.placeholder = 'e.g. review inbox';
    try {
        var existingTiddler = self.wiki.getTiddler(entry.title);
        if (existingTiddler && existingTiddler.fields && existingTiddler.fields.tags) {
            var t = existingTiddler.fields.tags;
            var tagArr = Array.isArray(t) ? t : String(t).split(/\s+/);
            tagInput.value = tagArr.filter(function(tag){ return tag !== self.attrTiddler; }).join(' ');
        }
    } catch(e) {}
    tagLabel.appendChild(tagInput);
    toolbar.appendChild(tagLabel);
    toolbar.appendChild(help);

    editDiv.appendChild(editor);
    editDiv.appendChild(toolbar);

    entryDiv.appendChild(viewDiv);
    entryDiv.appendChild(editDiv);

    return entryDiv;
};

/**
 * Change the indent level of an entry during editing.
 * Visual-only until the editor is saved (Ctrl+Enter); cancel reverts.
 * Mirrors paragraph.js _applyIndentChange pattern.
 */
AudioNotationWidget.prototype._changeEntryIndent = function(index, delta) {
    var entry = this._entries[index];
    if (!entry) return;
    var current  = entry.indent || 0;
    var newLevel = Math.max(0, Math.min(10, current + delta));
    if (newLevel === current) return;

    // Update in-memory indent (persisted when editor saves)
    entry.indent = newLevel;

    // Immediately update the visual margin
    var entryNode = this._body.querySelector('[data-entry-index="' + index + '"]');
    if (entryNode) {
        entryNode.style.marginLeft = (newLevel * INDENT_PX) + 'px';
    }
};

AudioNotationWidget.prototype._openEntryEditor = function(index, cursorOffset) {
    if (this.attrEditable !== 'yes') return;
    // Capture a stable identifier (title) before closing sibling editors as
    // closing/saving can trigger a re-render which reindexes entries. Resolve
    // the current index for the captured title after sibling editors are closed.
    var targetTitle = (this._entries && this._entries[index]) ? this._entries[index].title : null;
    this._closeSiblingEditors();
    var resolvedIndex = index;
    if (targetTitle) {
        resolvedIndex = -1;
        for (var ri = 0; ri < (this._entries && this._entries.length || 0); ri++) {
            try {
                if (String(this._entries[ri].title) === String(targetTitle)) { resolvedIndex = ri; break; }
            } catch(e) {}
        }
    }
    if (resolvedIndex < 0) return;
    var entryNode = this._body.querySelector('[data-entry-index="' + resolvedIndex + '"]');
    if (!entryNode) return;
    var viewDiv = entryNode.querySelector('.AudioSuite-notation__entry-view');
    var editDiv = entryNode.querySelector('.AudioSuite-notation__entry-edit');
    var editorArea = editDiv.querySelector('.AudioSuite-notation__entry-editor');

    this._populateEditor(editorArea, this._entries[resolvedIndex]);

    viewDiv.style.display = 'none';
    editDiv.style.display = '';
    this._editingIndex = resolvedIndex;
    // Track the title of the entry currently being edited so save/close
    // operations can resolve the correct entry even if re-rendering
    // changes the numeric indices.
    try { this._editingEntryTitle = this._entries[resolvedIndex].title; } catch(e){ this._editingEntryTitle = null; }
    try {
        // Focus the editable child if present (badge is now outside the editable region)
        var editableChild = editorArea.querySelector('[contenteditable="true"]');
        var focusTarget = editableChild || editorArea;
        focusTarget.focus();
        var sel = window.getSelection();
        var range = document.createRange();
        if (editableChild) {
            range.selectNodeContents(editableChild);
        } else {
            range.selectNodeContents(editorArea);
        }
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    } catch(e) {}
};

AudioNotationWidget.prototype._populateEditor = function(editorArea, entry) {
    if (!editorArea) return;
    // Remove any previous inline badge that was inserted as a sibling
    try {
        var prev = editorArea.previousSibling;
        if (prev && prev.classList && prev.classList.contains('AudioSuite-notation__timecode--inline')) {
            prev.parentNode.removeChild(prev);
        }
    } catch(e) {}
    editorArea.innerHTML = '';
    if (!entry) return;
    if (entry.isTimecoded) {
        var badge = document.createElement('span');
        badge.className = 'AudioSuite-notation__timecode AudioSuite-notation__timecode--inline';
        // Keep the badge outside the editable region so the caret never lands inside it
        badge.setAttribute('aria-hidden','true');
        var rangeLabel = utils.formatTimeRange(entry['start-seconds'], entry['end-seconds']);
        badge.textContent = '[' + rangeLabel + '] ';
        // Insert the badge before the editable area so it is not part of the editable content
        if (editorArea.parentNode) {
            editorArea.parentNode.insertBefore(badge, editorArea);
        } else {
            editorArea.appendChild(badge);
        }

        var noteContainer = document.createElement('div');
        noteContainer.className = 'AudioSuite-notation__note-editable';
        noteContainer.setAttribute('contenteditable','true');
        // Populate editable note from the tiddler text (allow multiple paragraphs).
        var text = entry.text || '';
        var paragraphs = text.split(/\r?\n\s*\r?\n/);
        for (var pi = 0; pi < paragraphs.length; pi++) {
            var p = paragraphs[pi] || '';
            var pDiv = document.createElement('div');
            pDiv.className = 'AudioSuite-notation__paragraph-edit';
            var plines = p.split(/\r?\n/);
            for (var lj = 0; lj < plines.length; lj++) {
                pDiv.appendChild(document.createTextNode(plines[lj]));
                if (lj < plines.length - 1) pDiv.appendChild(document.createElement('br'));
            }
            // ensure at least one empty paragraph exists for an empty note
            if (pDiv.childNodes.length === 0) pDiv.appendChild(document.createElement('br'));
            noteContainer.appendChild(pDiv);
        }
        if (paragraphs.length === 0) noteContainer.appendChild(document.createElement('div'));
        editorArea.appendChild(noteContainer);
    } else {
        // For plain (non-timecoded) entries, provide an editable child as well
        var plainContainer = document.createElement('div');
        plainContainer.className = 'AudioSuite-notation__note-editable';
        plainContainer.setAttribute('contenteditable','true');
        plainContainer.textContent = stripIndent(entry.text || '');
        editorArea.appendChild(plainContainer);
    }
};

AudioNotationWidget.prototype._extractTextFromEditor = function(editorArea, entry) {
    if (!editorArea) return '';
    var noteSpan = editorArea.querySelector('.AudioSuite-notation__note-editable');
    if (noteSpan) {
        // Prefer the editable container's text, but fall back to the whole
        // editor area's text if the editable node is empty (some DOM
        // structures place text nodes outside the editable child).
        var raw = noteSpan.innerText || noteSpan.textContent || '';
        if (!raw || !raw.trim()) {
            raw = editorArea.innerText || editorArea.textContent || '';
        }
        var normalized = raw.replace(/\r/g,'').replace(/\n\s*\n/g,'\n\n');
        return normalized.trim();
    }
    return (editorArea.textContent || '').trim();
};

AudioNotationWidget.prototype._closeEntryEditor = function(index, save) {
    // Resolve the intended entry by title when possible. Numeric indices
    // can become stale if re-renders occur; prefer the last-known editing
    // title stored on open.
    var resolvedIndex = index;
    try {
        if (this._editingEntryTitle) {
            resolvedIndex = -1;
            for (var si = 0; si < (this._entries && this._entries.length || 0); si++) {
                try {
                    if (String(this._entries[si].title) === String(this._editingEntryTitle)) { resolvedIndex = si; break; }
                } catch(e) {}
            }
        }
    } catch(e) {}
    var entryNode = this._body.querySelector('[data-entry-index="' + resolvedIndex + '"]');
    if (!entryNode) { this._editingIndex = -1; this._editingEntryTitle = null; return; }
    var viewDiv = entryNode.querySelector('.AudioSuite-notation__entry-view');
    var editDiv = entryNode.querySelector('.AudioSuite-notation__entry-edit');
    var editorArea = editDiv.querySelector('.AudioSuite-notation__entry-editor');

    if (save) {
        var entry = this._entries[resolvedIndex];
        // Debug: inspect editable DOM before extraction
        try {
            var debugEditable = editorArea && editorArea.querySelector ? editorArea.querySelector('.AudioSuite-notation__note-editable') : null;
        } catch(e){}
        var noteText = this._extractTextFromEditor(editorArea, entry);
        try {} catch(e){}
        // Persist to the notation tiddler's `text` field and indent as a field
        if (entry && entry.title) {
            var existing = this.wiki.getTiddler(entry.title);
            try {
                // Preserve existing fields (tags, parent-tiddler, timecodes, etc.)
                var newFields = existing && existing.fields ? Object.assign({}, existing.fields) : { title: entry.title };
                newFields.title = entry.title;
                newFields.text = noteText;
                newFields.indent = String(entry.indent || 0);
                // Build merged tags: parent tag (required) + config + widget extra + user input
                try {
                    var merged = [ String(this.attrTiddler) ];
                    // config tiddler
                    try {
                        var configTags = this.wiki.getTiddlerText('$:/plugins/NoteStreams/AudioSuite/defaultNotationTags', '').trim();
                        if (configTags) merged = merged.concat(configTags.split(/\s+/).filter(function(t){ return t; }));
                    } catch(e){}
                    // widget-level extraTags attribute
                    if (this.attrExtraTags) merged = merged.concat(String(this.attrExtraTags).split(/\s+/).filter(function(t){ return t; }));
                    // user-specified tags from the editor input
                    var tagInputEl = editDiv.querySelector('.AudioSuite-notation__tag-input');
                    if (tagInputEl && tagInputEl.value && tagInputEl.value.trim()) {
                        var extra = String(tagInputEl.value.trim()).split(/[,\s]+/).filter(function(t){ return t; });
                        merged = merged.concat(extra);
                    }
                    // dedupe and clean
                    var uniq = [];
                    for (var ti = 0; ti < merged.length; ti++) {
                        var tg = String(merged[ti] || '').trim();
                        if (!tg) continue;
                        if (uniq.indexOf(tg) === -1) uniq.push(tg);
                    }
                    newFields.tags = uniq;
                } catch(e) {
                    // fallback: keep existing tags if anything fails
                    if (existing && existing.fields && existing.fields.tags) newFields.tags = existing.fields.tags;
                }
                this.wiki.addTiddler(new $tw.Tiddler(existing || null, newFields));
            } catch(e){ console.error('[AudioSuite] save notation failed', e); }
        }
        // Update parent transclusion tiddler to ensure ordering is correct
        if (this.attrUpdateParent !== 'no') {
            // Skip parent tiddler update for virtual tracks — the parent doesn't
            // exist as a real tiddler and creating it would break the virtual
            // tiddler ViewTemplate system. Annotations are still fully loadable
            // via _loadEntries() which searches by tag and field values.
            var isVirtual = !this.wiki.getTiddler(this.attrTiddler);
            if (!isVirtual) {
                try { this._updateParentTiddler(); } catch(e){}
            }
        }
    }

    try { editDiv.style.display = 'none'; } catch(e){}
    try { viewDiv.style.display = ''; } catch(e){}
    var closedEntryTitle = (this._entries && this._entries[resolvedIndex]) ? this._entries[resolvedIndex].title : '';
    this._editingIndex = -1;
    this._editingEntryTitle = null;
    this._renderEntries();
    // Signal the player widget that the editor has been closed
    try {
        if (utils && utils.emit) {
            utils.emit('AudioSuite:notation-editor-closed', { saved: !!save, entryTitle: closedEntryTitle, skipEditor: false });
        }
    } catch(e) {}
};

AudioNotationWidget.prototype._updateParentTiddler = function(){
    if(!this.attrTiddler) return;
    var parentTitle = this.attrTiddler;
    // Build explicit transclusions separated by <br><br> so the parent contains
    // the expanded content of each notation tiddler in order.
    var filter = '[tag[' + parentTitle + ']field:parent-tiddler[' + parentTitle + ']]';
    var titles = this.wiki.filterTiddlers(filter) || [];
    // Build objects and sort numerically to ensure deterministic order
    var items = [];
    for (var ti = 0; ti < titles.length; ti++) {
        var tTitle = titles[ti];
        var tt = this.wiki.getTiddler(tTitle);
        var f = (tt && tt.fields) ? tt.fields : {};
        var start = Number(f['start-seconds']) || 0;
        items.push({ title: tTitle, start: start, end: Number(f['end-seconds']) || start });
    }
    try {
        items.sort(function(a,b){
            if (a.start < b.start) return -1;
            if (a.start > b.start) return 1;
            try { return String(a.title || '').localeCompare(String(b.title || '')); } catch(e) { return 0; }
        });
    } catch(e) {}
    var transclusionWikitext = '';
    for (var i = 0; i < items.length; i++) {
        var tTitle = items[i].title;
        if (i > 0) transclusionWikitext += '\n\n';
        var tt = this.wiki.getTiddler(tTitle);
        var f = (tt && tt.fields) ? tt.fields : {};
        var start = Number(f['start-seconds']) || 0;
        var end = Number(f['end-seconds']) || start;
        var rangeLabel = (utils && utils.formatTimeRange) ? utils.formatTimeRange(start, end) : (utils && utils.formatTime ? utils.formatTime(start) : String(start));
        // Use widget wikitext for a cleaner parent tiddler: <$link> for the
        // timecode and <$transclude/> to insert the notation content. Include
        // a `data-tiddler` attribute so the click handler can look up the
        // latest timecode fields at click time (keeps links accurate).
        var safeTitle = String(tTitle).replace(/"/g,'&quot;');
        transclusionWikitext += '<$link to="' + safeTitle + '" class="AudioSuite-parent-timecode" data-tiddler="' + safeTitle + '">[' +
                       '<$view field="start-timecode" tiddler="' + safeTitle + '"/> → <$view field="end-timecode" tiddler="' + safeTitle + '"/>' +
                       ']</$link>\n\n<$transclude tiddler="' + safeTitle + '"/>';
    }
    // Insert into the parent tiddler's text within a managed region so user content
    // outside the region is preserved. Markers help identify the autogenerated block.
    var startMarker = '<!-- AudioSuite:notations:start -->';
    var endMarker = '<!-- AudioSuite:notations:end -->';
    var block = startMarker + '\n' + transclusionWikitext + '\n' + endMarker;
    var existing = this.wiki.getTiddler(parentTitle);
    var existingText = '';
    try { existingText = existing && (existing.fields && typeof existing.fields.text !== 'undefined') ? existing.fields.text : (existing && existing.text) || ''; } catch(e) { existingText = ''; }
    var newText = '';
    try {
        var sIdx = existingText.indexOf(startMarker);
        var eIdx = existingText.indexOf(endMarker);
        if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
            // Replace only the managed region
            newText = existingText.substring(0, sIdx) + block + existingText.substring(eIdx + endMarker.length);
        } else {
            // Append the managed block to the end, preserving the rest of the tiddler
            newText = existingText || '';
            if (newText && newText.slice(-1) !== '\n') newText += '\n\n';
            newText += block;
        }
    } catch(e) { newText = block; }
    try{
        var newFields = existing && existing.fields ? Object.assign({}, existing.fields) : { title: parentTitle };
        newFields.title = parentTitle;
        newFields.text = newText;
        this.wiki.addTiddler(new $tw.Tiddler(existing || { title: parentTitle }, newFields));
    } catch(e){ console.error('[AudioSuite] failed to update parent transclusion tiddler', e); }
};

AudioNotationWidget.prototype._deleteEntry = function(index){
    var entry = this._entries[index];
    if(!entry || !entry.title) return;
    try{
        this.wiki.deleteTiddler(entry.title);
    } catch(e){ console.error('[AudioSuite] delete notation failed', e); }
    if (this.attrUpdateParent !== 'no') {
        var isVirtual = !this.wiki.getTiddler(this.attrTiddler);
        if (!isVirtual) {
            try{ this._updateParentTiddler(); } catch(e){}
        }
    }
    this._renderEntries();
};

AudioNotationWidget.prototype._closeSiblingEditors = function() {
    if (this._editingIndex >= 0) {
        try { this._closeEntryEditor(this._editingIndex, true); } catch(e){}
    }
    var nodes = document.querySelectorAll('.AudioSuite-notation');
    for (var i=0;i<nodes.length;i++) {
        var node = nodes[i];
        if (node && node._widget && node._widget !== this) {
            var w = node._widget;
            if (w._editingIndex >= 0) {
                try { w._closeEntryEditor(w._editingIndex, true); } catch(e){}
            }
        }
    }
};

AudioNotationWidget.prototype._handleTimecodeCapture = function(data) {
    try { console.log('[AudioSuite] _handleTimecodeCapture called', { attrTiddler: this.attrTiddler, data: data }); } catch(e){}
    if (!this.attrTiddler || !data) {
        try { console.warn('[AudioSuite] capture ignored: missing attrTiddler or data', { attrTiddler: this.attrTiddler, data: data }); } catch(e){}
        return;
    }
    // If the emitter supplied a track title, only handle captures targeted
    // at this widget's tiddler. This prevents global captures from inserting
    // timestamps into every notation widget on the page.
    if (data.track && this.attrTiddler && data.track !== this.attrTiddler) {
        try { console.warn('[AudioSuite] capture ignored: track mismatch', { track: data.track, attrTiddler: this.attrTiddler }); } catch(e){}
        return;
    }
    this._closeSiblingEditors();
    // Prefer numeric seconds if provided (press-and-hold capture provides both)
    var startSeconds = (typeof data.startSeconds === 'number') ? data.startSeconds : (typeof data.seconds === 'number' ? data.seconds : 0);
    var endSeconds = (typeof data.endSeconds === 'number') ? data.endSeconds : startSeconds;
    var startTimecode = data.startTimecode || utils.formatTime(startSeconds);
    var endTimecode = data.endTimecode || utils.formatTime(endSeconds);
    var note = data.note || '';
    var track = data.track || '';
    // optional: field name used by the player (e.g. 'src'), the resolved URL,
    // and an optional pointer tiddler title (when the track's field points to
    // another tiddler that contains the canonical URI).
    var srcField = data.srcField || '';
    var audioSrc = data.audioSrc || '';
    var audioPointer = data.audioPointer || '';

    // Compute the actual audio source value to store on the notation tiddler.
    // Prefer the resolved URL the player provided (`audioSrc`). If that's
    // missing, attempt to resolve via utils.resolveAudioSrc using the
    // provided `srcField` and `track`. Finally fall back to the track title
    // so old behaviour isn't lost.
    var audioSource = '';
    try {
        // Prefer the pointer tiddler title if the player identified one — this
        // keeps the notation linked to the tiddler that holds the canonical
        // URI (e.g. `Kurt Vonneguys - Slapstick.mp3`) instead of the resolved URL.
        if (audioPointer) {
            audioSource = audioPointer;
        } else if (audioSrc) {
            audioSource = audioSrc;
        } else if (srcField && track) {
            audioSource = utils.resolveAudioSrc(this.wiki, track, srcField) || '';
            if (!audioSource) {
                var tt = this.wiki.getTiddler(track);
                if (tt && tt.fields && tt.fields[srcField]) audioSource = tt.fields[srcField];
            }
        }
    } catch (e) { /* ignore resolution failures */ }
    if (!audioSource) audioSource = track || '';

    // Create a new notation tiddler with the canonical schema (note creation deferred on mobile)
    var title = utils.generateNotationTitle(this.wiki, this.attrTiddler, startSeconds, endSeconds);
    // Build merged tags for the new tiddler: parent + config + widget extras + any user-provided tags
    var mergedTags = [ String(this.attrTiddler) ];
    try {
        var cfg = this.wiki.getTiddlerText('$:/plugins/NoteStreams/AudioSuite/defaultNotationTags', '').trim();
        if (cfg) mergedTags = mergedTags.concat(cfg.split(/\s+/).filter(function(t){ return t; }));
    } catch(e){}
    if (this.attrExtraTags) mergedTags = mergedTags.concat(String(this.attrExtraTags).split(/\s+/).filter(function(t){ return t; }));
    if (data && data.userTags) {
        try {
            var u = String(data.userTags || '').trim();
            if (u) mergedTags = mergedTags.concat(u.split(/[,\s]+/).filter(function(t){ return t; }));
        } catch(e){}
    }
    // dedupe
    var _uniqTags = [];
    for (var _ti=0; _ti<mergedTags.length; _ti++){
        var _tg = String(mergedTags[_ti] || '').trim(); if(!_tg) continue; if(_uniqTags.indexOf(_tg) === -1) _uniqTags.push(_tg);
    }
    var fields = {
        title: title,
        'parent-tiddler': this.attrTiddler,
        'audio-source': audioSource,
        'start-seconds': String(Number(startSeconds || 0)),
        'end-seconds': String(Number(endSeconds || startSeconds || 0)),
        'start-timecode': startTimecode,
        'end-timecode': endTimecode,
        indent: String(0),
        tags: _uniqTags,
        text: note || ''
    };
    // Add audiobook fields when in book context
    if (this.attrBookTiddler) {
        fields['cover'] = this.attrBookTiddler;
        fields['structure'] = this.attrTiddler;
    }

    var self = this;
    function finishCreate(finalFields, modalUsed) {
        try{
            self.wiki.addTiddler(new $tw.Tiddler(null, finalFields));
        } catch(e){ console.error('[AudioSuite] failed to create notation tiddler', e); }
        if (self.attrUpdateParent !== 'no') {
            var isVirtual = !self.wiki.getTiddler(self.attrTiddler);
            if (!isVirtual) {
                try{ self._updateParentTiddler(); } catch(e){}
            }
        }
        self._renderEntries();

        if (!data || !data.skipEditor) {
            if (modalUsed) {
                try { if (utils && utils.emit) { utils.emit('AudioSuite:notation-editor-closed', { saved: true, skipEditor: false, entryTitle: finalFields.title }); } } catch(e){}
            } else {
                var newIndex = -1;
                for (var i = 0; i < self._entries.length; i++) {
                    if (self._entries[i].title === finalFields.title) { newIndex = i; break; }
                }
                if (newIndex >= 0) { self._pendingEditIndex = newIndex; self._pendingCursorOffset = 0; }
            }
        } else {
            try {
                if (utils && utils.emit) {
                    utils.emit('AudioSuite:notation-editor-closed', { saved: true, skipEditor: true, entryTitle: finalFields.title });
                }
            } catch (e) {}
        }
    }

    // If on mobile and the capture wasn't explicitly skipEditor, show modal to collect a note
    if (this._isMobile() && (!data || !data.skipEditor)) {
        try {
            this._showCaptureModal({ startTimecode: startTimecode, endTimecode: endTimecode, note: note }, function(res){
                // Always inform listeners so the player can resume whether saved or cancelled
                try {
                    if (!res || !res.saved) {
                        try { if (utils && utils.emit) { utils.emit('AudioSuite:notation-editor-closed', { saved: false, skipEditor: false, entryTitle: title }); } } catch(e){}
                        return; // user cancelled
                    }
                } catch(e){}
                try {
                    var finalNoteLocal = String(res.note || note || '');
                    var finalTags = Array.isArray(fields.tags) ? fields.tags.slice() : (fields.tags || []);
                    if (res.userTags && String(res.userTags).trim()) {
                        var extra = String(res.userTags).trim().split(/[,\s]+/).filter(function(t){ return t; });
                        finalTags = finalTags.concat(extra);
                    }
                    // dedupe
                    var dedup = [];
                    for (var ti=0; ti<finalTags.length; ti++){
                        var tg = String(finalTags[ti] || '').trim(); if(!tg) continue; if(dedup.indexOf(tg) === -1) dedup.push(tg);
                    }
                    fields.text = finalNoteLocal;
                    fields.tags = dedup;
                    finishCreate(fields, true);
                } catch(e) { console.error('[AudioSuite] modal save failed', e); }
            });
        } catch(e){ console.error('[AudioSuite] show capture modal failed', e); finishCreate(fields); }
    } else {
        // Desktop / non-mobile: proceed as before
        finishCreate(fields);
    }
};

AudioNotationWidget.prototype._saveTiddler = function(newText) {
    if (!this.attrTiddler) return;
    var existing = this.wiki.getTiddler(this.attrTiddler);
    try {
        this.wiki.addTiddler(new $tw.Tiddler(
            existing || { title: this.attrTiddler },
            {
                title: this.attrTiddler,
                text: newText,
                type: 'text/vnd.tiddlywiki',
                'AudioSuite-type': 'notation'
            }
        ));
    } catch (e) {
        console.error('[AudioSuite:notation] save failed', e);
    }
};

AudioNotationWidget.prototype.refresh = function(changedTiddlers) {
    this.computeAttributes();
    var newTiddler = this.getAttribute('tiddler', this.getVariable('currentTiddler') || '');
    var newEditable = this.getAttribute('editable','yes');
    var newBookTiddler = this.getAttribute('bookTiddler', this.getVariable('bookTiddler') || '');
    var newUpdateParent = this.getAttribute('updateParent', 'yes');
    if (newTiddler !== this.attrTiddler || newEditable !== this.attrEditable || newBookTiddler !== this.attrBookTiddler || newUpdateParent !== this.attrUpdateParent) {
        this._activeScope = undefined; // reset so execute() re-initializes from attribute
        this.refreshSelf();
        return true;
    }
    // Detect if playlistTitles variable changed; if so and in 'all' scope, re-render
    try {
        var newPlaylistRaw = this.getVariable('playlistTitles') || '[]';
        var newPlaylist = [];
        try { newPlaylist = JSON.parse(newPlaylistRaw); } catch(e) {}
        var oldPlaylist = this._playlistTitles || [];
        var playlistChanged = false;
        if (newPlaylist.length !== oldPlaylist.length) {
            playlistChanged = true;
        } else {
            for (var pi = 0; pi < newPlaylist.length; pi++) {
                if (newPlaylist[pi] !== oldPlaylist[pi]) { playlistChanged = true; break; }
            }
        }
        if (playlistChanged) {
            this._playlistTitles = newPlaylist;
            // Update toggle button visibility
            try {
                if (this._scopeToggleBtn) {
                    this._scopeToggleBtn.style.display = (newPlaylist.length > 1) ? '' : 'none';
                }
            } catch(e) {}
            if (this._activeScope === 'all' && this._editingIndex < 0) {
                this._renderEntries();
                return true;
            }
        }
    } catch(e) {}
    // If the parent tiddler changed, re-render
    if (this.attrTiddler && changedTiddlers && Object.prototype.hasOwnProperty.call(changedTiddlers, this.attrTiddler)) {
        if (this._editingIndex < 0) this._renderEntries();
        return true;
    }
    // If any child notation tiddlers changed (tagged AudioSuiteNotation and parent-tiddler matches), re-render
    if (this.attrTiddler && changedTiddlers) {
        for (var t in changedTiddlers) {
            try{
                var tt = this.wiki.getTiddler(t);
                if(tt && tt.fields && tt.fields.tags){
                    var tags = tt.fields.tags;
                    var hasTag = false;
                    if(Array.isArray(tags)){
                        hasTag = tags.indexOf(String(this.attrTiddler)) !== -1;
                    } else {
                        hasTag = String(tags).split(/\s+/).indexOf(String(this.attrTiddler)) !== -1;
                    }
                    if(hasTag){
                        if(String(tt.fields['parent-tiddler']) === String(this.attrTiddler)){
                            if (this._editingIndex < 0) this._renderEntries();
                            return true;
                        }
                    }
                }
            } catch(e){}
        }
    }
    return false;
};

// One-time migration from legacy single-tiddler format into atomic notation tiddlers.
AudioNotationWidget.prototype._migrateOldFormat = function(){
    if(!this.attrTiddler) return;
    var text = this.wiki.getTiddlerText(this.attrTiddler,'') || '';
    // If it already contains the list transclusion or explicit transclusions/widgets, assume migrated
    if(text.indexOf('<$list') !== -1 || /\{\{[^}]+\}\}/.test(text) || text.indexOf('<$transclude') !== -1 || text.indexOf('<$link') !== -1) return;
    // Quick heuristic: look for timecode lines like [MM:SS]
    if(!/\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(text)) return;
    // Parse old entries and create tiddlers
    var oldEntries = this._parseEntries(text);
    if(!oldEntries || !oldEntries.length) return;
    for(var i=0;i<oldEntries.length;i++){
        var e = oldEntries[i];
        var start = e.seconds || 0;
        var end = start;
        var title = utils.generateNotationTitle(this.wiki, this.attrTiddler, start, end);
        var note = e.noteText || stripIndent(e.text || '');
        var merged = [ String(this.attrTiddler) ];
        try {
            var cfgm = this.wiki.getTiddlerText('$:/plugins/NoteStreams/AudioSuite/defaultNotationTags', '').trim();
            if (cfgm) merged = merged.concat(cfgm.split(/\s+/).filter(function(t){ return t; }));
        } catch(e){}
        if (this.attrExtraTags) merged = merged.concat(String(this.attrExtraTags).split(/\s+/).filter(function(t){ return t; }));
        var migratedTags = [];
        for (var ti=0; ti<merged.length; ti++){ var tg = String(merged[ti] || '').trim(); if(!tg) continue; if(migratedTags.indexOf(tg) === -1) migratedTags.push(tg); }
        var fields = {
            title: title,
            'parent-tiddler': this.attrTiddler,
            'audio-source': '',
            'start-seconds': String(start),
            'end-seconds': String(end),
            'start-timecode': utils.formatTime(start),
            'end-timecode': utils.formatTime(end),
            indent: String(e.indent || 0),
            tags: migratedTags,
            text: note || ''
        };
        try{ this.wiki.addTiddler(new $tw.Tiddler(null, fields)); } catch(e){ console.error('[AudioSuite] migration add tiddler failed', e); }
    }
    // Replace parent tiddler with transclusion list
    try{ this._updateParentTiddler(); } catch(e){}
};

// Mobile detection helper
AudioNotationWidget.prototype._isMobile = function() {
    try {
        if (typeof navigator !== 'undefined' && navigator.userAgent) {
            if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true;
        }
        if (window && window.matchMedia) {
            return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        }
    } catch (e) {}
    return false;
};

// Show a simple modal on mobile to allow entering a note and optional tags.
AudioNotationWidget.prototype._showCaptureModal = function(info, callback) {
    // Prevent a second modal from stacking on top of an already-open one.
    // This handles the case where multiple _captureHandler instances fire for
    // a single event (e.g. widget rendered more than once, or the tiddler
    // open in two story-river panes).  Silently drop the duplicate — the first
    // modal handles the capture.
    if (_AudioSuite_captureModalActive) return;
    _AudioSuite_captureModalActive = true;
    var overlay = document.createElement('div');
    overlay.className = 'AudioSuite-capture-modal-overlay';
    overlay.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
    // Compute an opaque, palette-aware overlay color at runtime to avoid relying on CSS color-mix support
    try {
        var _rootStyle = window.getComputedStyle(document.documentElement);
        var _fg = (_rootStyle.getPropertyValue('--tw-fg') || _rootStyle.getPropertyValue('--palette-fg') || '').trim();
        var _bg = (_rootStyle.getPropertyValue('--tw-bg') || _rootStyle.getPropertyValue('--palette-page') || _rootStyle.getPropertyValue('--palette-background') || '').trim();
        function _parseColor(c) {
            if (!c) return null;
            // rgb(a)
            var m = c.match(/rgba?\s*\(([^)]+)\)/);
            if (m) {
                var parts = m[1].split(',').map(function(p){ return Number(p.trim()); });
                return [parts[0]||0, parts[1]||0, parts[2]||0];
            }
            // hex #rrggbb or #rgb
            var h = c.replace(/\s+/g,'');
            if (h[0] === '#') {
                if (h.length === 4) {
                    return [parseInt(h[1]+h[1],16), parseInt(h[2]+h[2],16), parseInt(h[3]+h[3],16)];
                }
                if (h.length === 7) {
                    return [parseInt(h.substr(1,2),16), parseInt(h.substr(3,2),16), parseInt(h.substr(5,2),16)];
                }
            }
            return null;
        }
        var fgRgb = _parseColor(_fg) || [0,0,0];
        var bgRgb = _parseColor(_bg) || [255,255,255];
        var weight = 0.7; // fg weight
        var r = Math.round(fgRgb[0]*weight + bgRgb[0]*(1-weight));
        var g = Math.round(fgRgb[1]*weight + bgRgb[1]*(1-weight));
        var b = Math.round(fgRgb[2]*weight + bgRgb[2]*(1-weight));
        overlay.style.background = 'rgba(' + r + ',' + g + ',' + b + ',0.6)';
    } catch (e) {}

    var box = document.createElement('div');
    box.className = 'AudioSuite-capture-modal';
    box.style.cssText = 'width:92%;max-width:520px;background:var(--tw-bg, var(--palette-page, var(--palette-background, #fff)));color:var(--tw-fg, var(--palette-fg, #000));border-radius:8px;padding:12px;border:1px solid var(--palette-border,rgba(0,0,0,0.06));box-shadow:0 6px 24px color-mix(in srgb, var(--tw-fg, var(--palette-fg,#000)) 12%, transparent);font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;';

    var h = document.createElement('div');
    h.style.cssText = 'font-weight:600;margin-bottom:8px;';
    h.textContent = 'Capture note';
    box.appendChild(h);

    var time = document.createElement('div');
    time.style.cssText = 'color:var(--palette-muted, var(--tw-fg, #666));margin-bottom:8px;font-size:13px;';
    time.textContent = (info && info.startTimecode ? info.startTimecode : '') + (info && info.endTimecode ? ' → ' + info.endTimecode : '');
    box.appendChild(time);

    var ta = document.createElement('textarea');
    ta.className = 'AudioSuite-capture-textarea';
    ta.style.cssText = 'width:100%;height:120px;padding:8px;border:1px solid var(--palette-border,#ddd);border-radius:4px;resize:vertical;margin-bottom:8px;font-size:14px;background:var(--tw-bg, var(--palette-page,#fff));color:var(--tw-fg, var(--palette-fg,#000));';
    ta.placeholder = 'Write a quick note about this moment...';
    if (info && info.note) ta.value = String(info.note || '');
    box.appendChild(ta);

    var tagLabel = document.createElement('div');
    tagLabel.style.cssText = 'margin-bottom:8px;font-size:13px;color:var(--tw-fg, var(--palette-fg,#000));';
    tagLabel.textContent = 'Tags (optional, space or comma separated):';
    box.appendChild(tagLabel);
    var tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.style.cssText = 'width:100%;padding:8px;border:1px solid var(--palette-border,#ddd);border-radius:4px;margin-bottom:12px;font-size:13px;background:var(--tw-bg, var(--palette-page,#fff));color:var(--tw-fg, var(--palette-fg,#000));';
    box.appendChild(tagInput);

    var controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'AudioSuite-btn';
    cancelBtn.style.cssText = 'padding:8px 12px;background:var(--palette-muted, rgba(0,0,0,0.06));border-radius:4px;border:0;color:var(--tw-fg, var(--palette-fg,#000));';
    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'AudioSuite-btn';
    saveBtn.style.cssText = 'padding:8px 12px;background:var(--as-accent-1,#1976d2);color:var(--tw-bg, var(--palette-page,#fff));border-radius:4px;border:0;';
    controls.appendChild(cancelBtn);
    controls.appendChild(saveBtn);
    box.appendChild(controls);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Focus textarea on show
    setTimeout(function(){ try{ ta.focus(); }catch(e){} },50);

    function cleanup() {
        _AudioSuite_captureModalActive = false;
        try { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); } catch(e){}
    }

    cancelBtn.addEventListener('click', function(){
        document.removeEventListener('keydown', onKey);
        cleanup();
        try{ callback({ saved: false }); } catch(e){}
    });
    saveBtn.addEventListener('click', function(){
        var note = ta.value || '';
        var userTags = tagInput.value || '';
        document.removeEventListener('keydown', onKey);
        cleanup();
        try{ callback({ saved: true, note: note, userTags: userTags }); } catch(e){}
    });
    // Also allow ESC to cancel
    function onKey(e){ if (e.key === 'Escape' || e.key === 'Esc') { cleanup(); try{ callback({ saved: false }); } catch(err){} document.removeEventListener('keydown', onKey); } }
    document.addEventListener('keydown', onKey);
};

AudioNotationWidget.prototype.removeChildDomNodes = function() {
    if (utils && utils.off && this._captureHandler) {
        utils.off('AudioSuite:timecode-captured', this._captureHandler);
    }
    this._editingIndex = -1;
    Widget.prototype.removeChildDomNodes.call(this);
};

exports['audio-notation'] = AudioNotationWidget;

})();
