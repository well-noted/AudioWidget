/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/waveform-editor-widget.js
type: application/javascript
module-type: widget
\*/
(function(){
"use strict";

/*─────────────────────────────────────────────────────────────────
  Waveform Editor Widget – Main Organizing Module

  Coordinates all extracted modules:
    mp3-parser, audio-cache, wav-encoder, peaks-generator,
    audio-loader, waveform-renderer, interaction-handler
─────────────────────────────────────────────────────────────────*/

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var utils  = require("$:/plugins/NoteStreams/AudioSuite/js/audio-utils.js");

// Extracted modules
var audioCache     = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/audio-cache.js");
var audioLoader    = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/audio-loader.js");
var renderer       = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/waveform-renderer.js");
var mp3Parser      = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/mp3-parser.js");
var wavEncoder     = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/wav-encoder.js");
var peaksGenerator = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/peaks-generator.js");
var mp3Parser      = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/mp3-parser.js");
var wavEncoder     = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/wav-encoder.js");
var peaksGenerator = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/peaks-generator.js");

// Shared AudioContext
var AudioContextCtor = (typeof window !== 'undefined') &&
    (window.AudioContext || window.webkitAudioContext) || null;
var _sharedAudioContext = null;
function getSharedAudioContext() {
    try {
        if (_sharedAudioContext) return _sharedAudioContext;
        _sharedAudioContext = audioCache.getSharedAudioContext();
        if (!_sharedAudioContext && AudioContextCtor) _sharedAudioContext = new AudioContextCtor();
        return _sharedAudioContext;
    } catch(e) { return null; }
}

/* ═══════════════════════════════════════════════════════════════
   CONSTRUCTOR + TW LIFECYCLE (execute)
   ═══════════════════════════════════════════════════════════════ */

function WaveformEditor(parseTreeNode, options) {
    this.initialise(parseTreeNode, options);
}
WaveformEditor.prototype = new Widget();

WaveformEditor.prototype.initialise = function(parseTreeNode, options) {
    Widget.prototype.initialise.call(this, parseTreeNode, options);
    this._bound = Object.create(null);
};

WaveformEditor.prototype.execute = function() {
    this.attrAudioSource = this.getAttribute("audio-source", "");
    this.attrStartTime   = Number(this.getAttribute("startTime", "0")) || 0;
    this.attrEndTime     = Number(this.getAttribute("endTime", "0")) || 0;
    this.attrTiddler     = this.getAttribute("tiddler", "");
    this.attrWidth       = Number(this.getAttribute("width", "600")) || 600;
    this.attrHeight      = Number(this.getAttribute("height", "120")) || 120;
    this.attrZoomPadding = Number(this.getAttribute("zoomPadding", "10")) || 10;
    this.makeChildWidgets();
};

/* ═══════════════════════════════════════════════════════════════
   RENDER — Build DOM, bind events, start loading
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype.render = function(parent, nextSibling) {
    this.parentDomNode = parent;
    this._isDestroyed = false;
    this.computeAttributes();
    this.execute();

    // Resolve palette colors
    try { this._colors = renderer.resolveColors(this.wiki); } catch(e) { this._colors = {}; }

    if (!parent || typeof parent.insertBefore !== 'function') return;
    var doc = (parent && parent.ownerDocument) || document;
    this.document = doc;

    // ── Initialise state ──
    this._initializeState();

    // ── Build DOM ──
    this._buildDOM(doc, parent, nextSibling);

    // ── Bind events ──
    this._bindEventHandlers();

    // ── Resolve source and load ──
    this._loadAndRender();
};

/* ── State initialisation ────────────────────────────────────── */

WaveformEditor.prototype._initializeState = function() {
    // Audio state
    this.duration = 0;
    this.peaks = null;
    this._audioBuffer = null;
    this._resolvedSrc = null;

    // View state
    this.viewStart = 0;
    this.viewEnd = 0;
    this.isZoomed = false;

    // Drag / interaction
    this.dragging = false;
    this.dragMode = null;
    this._lastDraggedHandle = 'start';
    this._lastPointerClientX = 0;
    this._slideCursorOffset = 0;
    this._slideRegionLength = 0;
    this._scrollAnchorClientX = 0;
    this._scrollAnchorViewStart = 0;
    this._scrollAnchorViewEnd = 0;
    this._needsDraw = false;
    this._activePointerId = null;

    // Playback
    this._isPlayingRegion = false;
    this._regionPlayhead = 0;
    this._regionAudio = null;
    this._regionBufferSource = null;
    this._regionBufferCtx = null;
    this._regionBufferStartReal = 0;
    this._regionBufferStartSec = 0;
    this._regionBufferEndSec = 0;
    this._regionPlayheadRAF = null;
    this._playRegionGen = 0;
    this._loopEnabled = false;

    // Listen mode
    this._listenMode = null;
    this._listenPlayhead = 0;
    this._listenAudio = null;
    this._listenBufferSource = null;
    this._listenBufferCtx = null;
    this._listenBufferStartReal = 0;
    this._listenBufferStartSec = 0;
    this._listenRAF = null;

    // Scrub
    this._scrubAudio = null;
    this._scrubLastHandleTime = 0;
    this._scrubLastRealTime = 0;
    this._scrubSyncInterval = null;

    // Auto-pan
    this._autoPanRAF = null;

    // Amplitude zoom
    this._amplitudeZoom = 1.0;

    // Timing guards
    this._lastPersistTime = 0;
    this._persistDebounceTimer = null;
    this._loadingCount = 0;

    // Pointer support
    this._supportsPointer = (typeof window !== 'undefined' && !!window.PointerEvent);

    // Meta audio (for Strategy 0)
    this._metaAudio = null;
    this._metaFallbackAudio = null;

    // Restore cached view state
    if (this.attrTiddler) {
        var vs = audioCache.getViewState(this.attrTiddler);
        if (vs) {
            if (typeof vs.viewStart === 'number') this.viewStart = vs.viewStart;
            if (typeof vs.viewEnd === 'number') this.viewEnd = vs.viewEnd;
            if (typeof vs.isZoomed === 'boolean') this.isZoomed = vs.isZoomed;
        }
    }
};

/* ═══════════════════════════════════════════════════════════════
   DOM CONSTRUCTION
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._buildDOM = function(doc, parent, nextSibling) {
    var self = this;

    // ── Wrapper ──
    var wrapper = doc.createElement('div');
    wrapper.className = 'AudioSuite-waveform-editor';
    wrapper.style.width = String(this.attrWidth) + 'px';
    wrapper.style.boxSizing = 'border-box';
    wrapper.style.position = 'relative';
    parent.insertBefore(wrapper, nextSibling);
    this.domNode = wrapper;
    this.domNodes = this.domNodes || [];
    this.domNodes.push(wrapper);

    // Apply palette colours as CSS custom properties
    try {
        var c = this._colors;
        wrapper.style.setProperty('--we-background', c.background || '#ffffff');
        wrapper.style.setProperty('--we-foreground', c.foreground || '#333333');
        wrapper.style.setProperty('--we-border', c.border || '#cccccc');
        wrapper.style.setProperty('--we-accent', c.accent || '#4285f4');
        wrapper.style.setProperty('--we-accent-dark', c.accentDark || '#2c5598');
        wrapper.style.setProperty('--we-muted', c.muted || '#999999');
        wrapper.style.background = c.background || '';
        wrapper.style.color = c.foreground || '';
        // Export to document root for other components
        try {
            var root = doc.documentElement;
            root.style.setProperty('--waveform-bg', c.background || '');
            root.style.setProperty('--waveform-fg', c.foreground || '');
            root.style.setProperty('--waveform-accent', c.accent || '');
        } catch(e){}
    } catch(e) {}

    // ── Toolbar ──
    this._buildToolbar(doc, wrapper);

    // ── Canvas ──
    var dpr = window.devicePixelRatio || 1;
    var canvas = doc.createElement('canvas');
    canvas.className = 'AudioSuite-waveform-editor__canvas';
    canvas.width  = this.attrWidth * dpr;
    canvas.height = this.attrHeight * dpr;
    canvas.style.width  = String(this.attrWidth) + 'px';
    canvas.style.height = String(this.attrHeight) + 'px';
    canvas.setAttribute('tabindex', '0');
    canvas.style.outline = 'none';
    canvas.style.touchAction = 'none';
    wrapper.appendChild(canvas);
    this.canvas = canvas;

    // ── Minimap ──
    var minimap = doc.createElement('canvas');
    minimap.className = 'AudioSuite-waveform-editor__minimap';
    minimap.width  = this.attrWidth * dpr;
    minimap.height = 24 * dpr;
    minimap.style.width  = String(this.attrWidth) + 'px';
    minimap.style.height = '24px';
    minimap.style.cursor = 'pointer';
    wrapper.appendChild(minimap);
    this._minimap = minimap;

    // ── Tooltip ──
    var tooltip = doc.createElement('div');
    tooltip.className = 'AudioSuite-waveform-editor__tooltip';
    tooltip.style.cssText = 'position:absolute;display:none;pointer-events:none;';
    wrapper.appendChild(tooltip);
    this._tooltip = tooltip;
};

WaveformEditor.prototype._buildToolbar = function(doc, wrapper) {
    var self = this;
    var tb = doc.createElement('div');
    tb.className = 'AudioSuite-waveform-editor__toolbar';
    wrapper.appendChild(tb);

    function btn(text, cls, title) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = text;
        if (title) b.title = title;
        return b;
    }

    // Zoom buttons
    this._zoomBtn = btn('🔍 Zoom to Region', 'AudioSuite-btn AudioSuite-waveform-editor__zoom');
    tb.appendChild(this._zoomBtn);

    this._fullBtn = btn('↔ Full Track', 'AudioSuite-btn AudioSuite-waveform-editor__full');
    this._fullBtn.style.display = 'none';
    tb.appendChild(this._fullBtn);

    // Play region
    this._playBtn = btn('▶ Play', 'AudioSuite-btn AudioSuite-waveform-editor__play', 'Play selected region (click waveform play button)');
    tb.appendChild(this._playBtn);

    // Set Start/End
    this._setStartBtn = btn('🎯 Set Start', 'AudioSuite-btn AudioSuite-waveform-editor__set-start', 'Play audio and tap to set the start time');
    tb.appendChild(this._setStartBtn);
    this._setEndBtn = btn('🎯 Set End', 'AudioSuite-btn AudioSuite-waveform-editor__set-end', 'Play audio and tap to set the end time');
    tb.appendChild(this._setEndBtn);

    // Loop
    this._loopBtn = btn('🔁 Loop', 'AudioSuite-btn AudioSuite-waveform-editor__loop', 'Toggle loop playback of selected region');
    tb.appendChild(this._loopBtn);

    // Pre/Post roll
    var prevGrp = doc.createElement('span');
    prevGrp.className = 'AudioSuite-waveform-editor__preview-group';
    this._preRollBtn = btn('⏮ Pre-roll', 'AudioSuite-btn AudioSuite-waveform-editor__preroll', 'Play 3s before and 2s after start handle');
    prevGrp.appendChild(this._preRollBtn);
    this._postRollBtn = btn('⏭ Post-roll', 'AudioSuite-btn AudioSuite-waveform-editor__postroll', 'Play 2s before and 3s after end handle');
    prevGrp.appendChild(this._postRollBtn);
    tb.appendChild(prevGrp);

    // Snap
    this._snapBtn = btn('🧲 Snap to Silence', 'AudioSuite-btn AudioSuite-waveform-editor__snap', 'Snap both handles to nearest silence boundaries (S key)');
    tb.appendChild(this._snapBtn);

    // Amplitude slider
    var ampGrp = doc.createElement('span');
    ampGrp.className = 'AudioSuite-waveform-editor__amp-group';
    var ampLbl = doc.createElement('span');
    ampLbl.className = 'AudioSuite-waveform-editor__amp-label';
    ampLbl.textContent = '🔊';
    ampLbl.title = 'Vertical zoom (amplitude)';
    ampGrp.appendChild(ampLbl);
    var ampSlider = doc.createElement('input');
    ampSlider.type = 'range'; ampSlider.className = 'AudioSuite-waveform-editor__amp-slider';
    ampSlider.min = '1'; ampSlider.max = '8'; ampSlider.step = '0.5'; ampSlider.value = '1';
    ampSlider.title = 'Vertical zoom: amplify quiet sections';
    ampGrp.appendChild(ampSlider);
    this._ampSlider = ampSlider;
    tb.appendChild(ampGrp);

    // Transcribe
    this._transcribeBtn = btn('🎤 Transcribe', 'AudioSuite-btn AudioSuite-waveform-editor__transcribe', 'Transcribe selected region using OpenAI Whisper (T key)');
    tb.appendChild(this._transcribeBtn);
    var tStatus = doc.createElement('span');
    tStatus.className = 'AudioSuite-waveform-editor__transcribe-status';
    tStatus.style.display = 'none';
    tb.appendChild(tStatus);
    this._transcribeStatus = tStatus;

    // Readout
    var readout = doc.createElement('span');
    readout.className = 'AudioSuite-waveform-editor__readout';
    readout.textContent = utils.formatTime(this.attrStartTime) + ' → ' + utils.formatTime(this.attrEndTime);
    tb.appendChild(readout);
    this._readout = readout;

    // Loading indicator
    var loading = doc.createElement('span');
    loading.className = 'AudioSuite-waveform-editor__loading';
    loading.textContent = 'Loading…';
    loading.style.display = 'none';
    tb.appendChild(loading);
    this._loadingIndicator = loading;

    // Keyboard hint
    var kbHint = doc.createElement('span');
    kbHint.className = 'AudioSuite-waveform-editor__kb-hint';
    kbHint.textContent = '← → nudge · Shift ±5s · S snap · T transcribe';
    tb.appendChild(kbHint);

    this._toolbar = tb;
};

/* ═══════════════════════════════════════════════════════════════
   EVENT BINDING
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._bindEventHandlers = function() {
    var self = this;

    // Bound handlers
    this._bound.onPointerDown  = this._onPointerDown.bind(this);
    this._bound.onPointerMove  = this._onPointerMove.bind(this);
    this._bound.onPointerUp    = this._onPointerUp.bind(this);
    this._bound.onHoverMove    = this._onHoverMove.bind(this);
    this._bound.onPointerLeave = this._onPointerLeave.bind(this);
    this._bound.onKeyDown      = this._onKeyDown.bind(this);
    this._bound.onResize       = function() { try { self._draw(); } catch(e){} };

    var c = this.canvas;
    if (this._supportsPointer) {
        c.addEventListener('pointerdown', this._bound.onPointerDown, false);
        c.addEventListener('pointermove', this._bound.onHoverMove, false);
    } else {
        c.addEventListener('mousedown', this._bound.onPointerDown, false);
        c.addEventListener('mousemove', this._bound.onHoverMove, false);
    }
    c.addEventListener('pointerleave', this._bound.onPointerLeave, false);
    c.addEventListener('mouseleave', this._bound.onPointerLeave, false);
    c.addEventListener('keydown', this._bound.onKeyDown, false);
    window.addEventListener('resize', this._bound.onResize, false);

    // Toolbar buttons
    this._zoomBtn.addEventListener('click', function() { self._zoomToRegion(); }, false);
    this._fullBtn.addEventListener('click', function() { self._resetZoom(); }, false);

    this._playBtn.addEventListener('click', function() {
        if (self._isPlayingRegion) self._stopRegion();
        else self._playRegion();
    }, false);

    this._setStartBtn.addEventListener('click', function() {
        if (self._listenMode === 'start') self._listenMark();
        else self._startListenMode('start');
    }, false);
    this._setEndBtn.addEventListener('click', function() {
        if (self._listenMode === 'end') self._listenMark();
        else self._startListenMode('end');
    }, false);

    this._transcribeBtn.addEventListener('click', function() { self._transcribeRegion(); }, false);

    this._loopBtn.addEventListener('click', function() {
        self._loopEnabled = !self._loopEnabled;
        self._loopBtn.classList.toggle('AudioSuite-waveform-editor__btn--active', self._loopEnabled);
    }, false);

    this._preRollBtn.addEventListener('click', function() {
        self._playPreview(Number(self.attrStartTime) || 0, 3, 2);
    }, false);
    this._postRollBtn.addEventListener('click', function() {
        self._playPreview(Number(self.attrEndTime) || 0, 2, 3);
    }, false);

    this._snapBtn.addEventListener('click', function() {
        try { self._pushUndoState(); } catch(e){}
        self._snapHandleToSilence('start');
        self._snapHandleToSilence('end');
    }, false);

    this._ampSlider.addEventListener('input', function() {
        self._amplitudeZoom = Number(self._ampSlider.value) || 1.0;
        self._draw();
    }, false);

    // Minimap click → center view at that time
    this._minimap.addEventListener('click', function(ev) {
        if (!self.duration) return;
        var rect = self._minimap.getBoundingClientRect();
        var ratio = (ev.clientX - rect.left) / rect.width;
        var clickTime = ratio * self.duration;
        var viewSpan = (self.viewEnd || 1) - (self.viewStart || 0);
        var ns = clickTime - viewSpan / 2;
        var ne = clickTime + viewSpan / 2;
        if (ns < 0) { ns = 0; ne = viewSpan; }
        if (ne > self.duration) { ne = self.duration; ns = self.duration - viewSpan; }
        self.viewStart = ns; self.viewEnd = ne;
        self.isZoomed = true;
        self._draw();
        self._saveViewState();
    }, false);
};

/* ═══════════════════════════════════════════════════════════════
   LOADING PIPELINE
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._loadAndRender = function() {
    var self = this;
    var srcAttr = this.attrAudioSource || '';

    // Resolve audio source
    var resolved = '';
    try { resolved = utils.resolveAudioSrc(this.wiki, srcAttr) || srcAttr || ''; } catch(e) { resolved = srcAttr || ''; }

    // Check for inline base64 tiddler
    var inlineDataUri = null;
    try {
        var t = this.wiki.getTiddler(srcAttr);
        if (t && t.fields) {
            var ftype = t.fields.type || '';
            var ftext = t.fields.text || '';
            if (ftype.indexOf('audio/') === 0 && ftext) {
                inlineDataUri = 'data:' + ftype + ';base64,' + ftext;
            }
        }
    } catch(e) {}

    this._resolvedSrc = inlineDataUri || resolved || null;
    if (!this._resolvedSrc) return;

    /* ── Strategy 0: metadata-only preload via <audio> element ── */
    // This gives us a quick duration without decoding, so we can show
    // a flat track + ticks immediately while the full decode happens.
    try {
        if (this._resolvedSrc && this._resolvedSrc.indexOf('data:') !== 0) {
            this._metaAudio = new Audio();
            this._metaAudio.preload = 'metadata';
            this._metaAudio.src = this._resolvedSrc;
            var metaDone = false;
            this._metaAudio.addEventListener('loadedmetadata', function onMeta() {
                if (metaDone || self._isDestroyed) return;
                metaDone = true;
                try { self._metaAudio.removeEventListener('loadedmetadata', onMeta, false); } catch(e) {}
                try {
                    var metaDur = self._metaAudio.duration;
                    if (typeof metaDur === 'number' && isFinite(metaDur) && metaDur > 0) {
                        // Cache metadata duration (useful for VBR playback mapping later)
                        audioCache.updateCachedWaveform(self._resolvedSrc, { metaAudioDuration: metaDur });
                        if (!self.duration || self.duration <= 0) {
                            self.duration = metaDur;
                            self._applyDefaultView();
                            self._draw();
                        }
                    }
                } catch(e) {}
            }, false);
        }
    } catch(e) {}

    /* ── Check cache ── */
    var cached = audioCache.getCachedWaveform(this._resolvedSrc);
    if (cached && cached.peaks && cached.duration) {
        this.peaks = cached.peaks;
        this.duration = cached.duration;
        this._audioBuffer = cached.audioBuffer || null;
        this._applyDefaultView();
        this._draw();
        return;
    }

    /* ── Full load: fetch + decode ── */
    this._showLoading();

    var loadSrc = this._resolvedSrc;
    var loadPromise;

    if (inlineDataUri || (loadSrc && loadSrc.indexOf('data:') === 0)) {
        loadPromise = audioLoader.dataUriToArrayBuffer(loadSrc).then(function(ab) {
            return audioLoader.decodeArrayBuffer(ab, loadSrc, {
                onDuration: function(d) {
                    if (!self._isDestroyed) { self.duration = d; self._applyDefaultView(); self._draw(); }
                },
                onPeaks: function(p) {
                    if (!self._isDestroyed) { self.peaks = p; self._draw(); }
                },
                onBuffer: function(buf) {
                    if (!self._isDestroyed) self._audioBuffer = buf;
                }
            });
        });
    } else {
        loadPromise = this._attemptFetch(loadSrc);
    }

    loadPromise.then(function() {
        if (self._isDestroyed) return;
        // Sync from cache
        var c2 = audioCache.getCachedWaveform(loadSrc);
        if (c2) {
            if (c2.peaks) self.peaks = c2.peaks;
            if (c2.duration) self.duration = c2.duration;
            if (c2.audioBuffer) self._audioBuffer = c2.audioBuffer;
        }
        self._applyDefaultView();
    }).catch(function(err) {
        console.warn('[waveform-editor] load failed, trying metadata fallback:', err);
        self._metadataFallback();
    }).finally(function() {
        self._hideLoading();
        self._draw();
    });
};

/* ── Fetch with deduplication ── */
WaveformEditor.prototype._attemptFetch = function(url) {
    var self = this;
    if (!url) return Promise.reject(new Error('no src'));

    // Dedup concurrent requests
    var existing = audioCache.getFetchPromise(url);
    if (existing) return existing;

    var p = audioLoader.fetchAudio(url, {
        onDuration: function(d) {
            if (!self._isDestroyed) { self.duration = d; self._applyDefaultView(); self._draw(); }
        },
        onPeaks: function(peaks) {
            if (!self._isDestroyed) { self.peaks = peaks; self._draw(); }
        },
        onBuffer: function(buf) {
            if (!self._isDestroyed) self._audioBuffer = buf;
        }
    });

    audioCache.setFetchPromise(url, p);
    p.finally(function() { audioCache.clearFetchPromise(url); });
    return p;
};

/* ── Metadata-only fallback ── */
WaveformEditor.prototype._metadataFallback = function() {
    var self = this;
    if (!this._resolvedSrc) return;
    try {
        this._metaFallbackAudio = new Audio();
        this._metaFallbackAudio.preload = 'metadata';
        this._metaFallbackAudio.src = this._resolvedSrc;
        this._metaFallbackAudio.addEventListener('loadedmetadata', function() {
            if (self._isDestroyed) return;
            try {
                var d = self._metaFallbackAudio.duration;
                if (typeof d === 'number' && isFinite(d) && d > 0 && (!self.duration || self.duration <= 0)) {
                    self.duration = d;
                    self._applyDefaultView();
                    self._draw();
                }
            } catch(e) {}
        }, false);
    } catch(e) {}
};

/* ── Loading indicators ── */
WaveformEditor.prototype._showLoading = function() {
    this._loadingCount = (this._loadingCount || 0) + 1;
    try { if (this._loadingIndicator) this._loadingIndicator.style.display = ''; } catch(e){}
};
WaveformEditor.prototype._hideLoading = function() {
    this._loadingCount = Math.max(0, (this._loadingCount || 0) - 1);
    if (this._loadingCount === 0) {
        try { if (this._loadingIndicator) this._loadingIndicator.style.display = 'none'; } catch(e){}
    }
};

/* ═══════════════════════════════════════════════════════════════
   COORDINATE HELPERS
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._xToTime = function(clientX) {
    if (!this.canvas) return 0;
    var rect = this.canvas.getBoundingClientRect();
    var x = clientX - rect.left;
    var w = rect.width;
    if (w <= 0) return this.viewStart || 0;
    var ratio = Math.max(0, Math.min(1, x / w));
    var vs = this.viewStart || 0;
    var ve = this.viewEnd || (this.duration || 1);
    return vs + ratio * (ve - vs);
};

WaveformEditor.prototype._timeToX = function(timeSec) {
    if (!this.canvas) return 0;
    var rect = this.canvas.getBoundingClientRect();
    var w = rect.width;
    var vs = this.viewStart || 0;
    var ve = this.viewEnd || (this.duration || 1);
    if (ve <= vs) return 0;
    return ((timeSec - vs) / (ve - vs)) * w;
};

WaveformEditor.prototype._isOverPlayButton = function(canvasX, canvasY) {
    if (!this.attrStartTime && this.attrStartTime !== 0) return false;
    if (!this.attrEndTime && this.attrEndTime !== 0) return false;
    var sx = this._timeToX(this.attrStartTime);
    var ex = this._timeToX(this.attrEndTime);
    var midX = (sx + ex) / 2;
    var midY = (this.attrHeight || 120) / 2;
    var radius = 14;
    if ((ex - sx) < radius * 4) return false;
    var dx = canvasX - midX, dy = canvasY - midY;
    return (dx * dx + dy * dy) <= (radius * radius);
};

/* ═══════════════════════════════════════════════════════════════
   VIEW MANAGEMENT
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._applyDefaultView = function() {
    // Don't override if view state was restored from cache
    if (this.viewEnd && this.viewEnd > this.viewStart) return;

    var start = Number(this.attrStartTime) || 0;
    var end   = Number(this.attrEndTime) || 0;
    var dur   = this.duration || end || 1;

    if (end > start) {
        try { this._zoomToRegion(); } catch(e) {
            var pad = Number(this.attrZoomPadding) || 10;
            this.viewStart = Math.max(0, start - pad);
            this.viewEnd   = Math.min(dur, end + pad);
            this.isZoomed  = true;
        }
    } else if (end === start && (start > 0 || (this.getAttribute && this.getAttribute('startTime') !== undefined && this.getAttribute('startTime') !== '0'))) {
        // Zero-length selection → show ~2 minutes context
        try { this._zoomToRegion(); } catch(e) {
            var pointPad = Math.max(Number(this.attrZoomPadding) || 10, 120);
            this.viewStart = Math.max(0, start - pointPad);
            this.viewEnd   = Math.min(dur, start + pointPad);
            this.isZoomed  = true;
        }
    } else {
        this.viewStart = 0;
        this.viewEnd   = dur;
        this.isZoomed  = false;
    }
};

WaveformEditor.prototype._zoomToRegion = function() {
    var start = Number(this.attrStartTime) || 0;
    var end   = Number(this.attrEndTime) || 0;
    var pad   = Number(this.attrZoomPadding) || 10;
    var dur   = this.duration || Math.max(end + pad, 1);

    if (end <= start) {
        // Point selection → ±120s context
        var pointPad = Math.max(pad, 120);
        this.viewStart = Math.max(0, start - pointPad);
        this.viewEnd   = Math.min(dur, start + pointPad);
    } else {
        this.viewStart = Math.max(0, start - pad);
        this.viewEnd   = Math.min(dur, end + pad);
    }
    this.isZoomed = true;
    this._draw();
    this._saveViewState();
};

WaveformEditor.prototype._resetZoom = function() {
    this.viewStart = 0;
    this.viewEnd   = this.duration || Math.max(1, Number(this.attrEndTime) || 1);
    this.isZoomed  = false;
    this._draw();
    this._saveViewState();
};

WaveformEditor.prototype._saveViewState = function() {
    if (this.attrTiddler) {
        audioCache.setViewState(this.attrTiddler, {
            viewStart: this.viewStart,
            viewEnd: this.viewEnd,
            isZoomed: this.isZoomed
        });
    }
};

/* ═══════════════════════════════════════════════════════════════
   DRAWING  (delegates to waveform-renderer)
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._draw = function() {
    if (!this.canvas || this._isDestroyed) return;

    // Ensure canvas dimensions match DPR
    var dpr = window.devicePixelRatio || 1;
    var needW = this.attrWidth * dpr;
    var needH = this.attrHeight * dpr;
    if (this.canvas.width !== needW || this.canvas.height !== needH) {
        this.canvas.width  = needW;
        this.canvas.height = needH;
    }

    var ctx = this.canvas.getContext('2d');
    renderer.drawWaveform(ctx, {
        width:  this.canvas.width,
        height: this.canvas.height,
        dpr: dpr,
        peaks: this.peaks,
        duration: this.duration || 1,
        viewStart: this.viewStart || 0,
        viewEnd: this.viewEnd || this.duration || 1,
        startTime: this.attrStartTime || 0,
        endTime: this.attrEndTime || 0,
        amplitudeZoom: this._amplitudeZoom || 1.0,
        colors: this._colors,
        isPlayingRegion: this._isPlayingRegion,
        regionPlayhead: this._regionPlayhead,
        listenMode: this._listenMode,
        listenPlayhead: this._listenPlayhead
    });

    // Minimap
    if (this._minimap) {
        var mmDpr = dpr;
        var mmW = this.attrWidth * mmDpr;
        var mmH = 24 * mmDpr;
        if (this._minimap.width !== mmW || this._minimap.height !== mmH) {
            this._minimap.width = mmW; this._minimap.height = mmH;
        }
        renderer.drawMinimap(this._minimap.getContext('2d'), {
            width: this._minimap.width, height: this._minimap.height, dpr: mmDpr,
            peaks: this.peaks, duration: this.duration || 1,
            startTime: this.attrStartTime || 0, endTime: this.attrEndTime || 0,
            viewStart: this.viewStart || 0, viewEnd: this.viewEnd || this.duration || 1
        });
    }

    // Update readout
    try {
        if (this._readout) {
            this._readout.textContent = utils.formatTime(Math.round(this.attrStartTime)) + ' → ' + utils.formatTime(Math.round(this.attrEndTime));
        }
    } catch(e) {}

    // Toggle zoom/full buttons
    try {
        if (this._zoomBtn) this._zoomBtn.style.display = this.isZoomed ? 'none' : '';
        if (this._fullBtn) this._fullBtn.style.display = this.isZoomed ? '' : 'none';
    } catch(e) {}

    // Sync toolbar play button state
    try {
        if (this._playBtn) {
            if (this._isPlayingRegion) {
                this._playBtn.textContent = '⏹ Stop';
                this._playBtn.classList.add('AudioSuite-waveform-editor__btn--active');
            } else {
                this._playBtn.textContent = '▶ Play';
                this._playBtn.classList.remove('AudioSuite-waveform-editor__btn--active');
            }
        }
    } catch(e) {}

    this._needsDraw = false;
};

/* ═══════════════════════════════════════════════════════════════
   POINTER EVENTS
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._onPointerDown = function(ev) {
    if (this._isDestroyed || !this.canvas) return;

    var rect = this.canvas.getBoundingClientRect();
    var localX = ev.clientX - rect.left;
    var localY = ev.clientY - rect.top;

    // ── Listen mode: click on canvas = mark time ──
    if (this._listenMode) {
        this._listenMark();
        return;
    }

    // ── Hit test ──
    var isOverPlay = this._isOverPlayButton(localX, localY);
    if (isOverPlay) {
        if (this._isPlayingRegion) { this._stopRegion(); }
        else { this._playRegion(); }
        return;
    }

    // Determine drag mode
    var t = this._xToTime(ev.clientX);
    var sx = this._timeToX(this.attrStartTime);
    var ex = this._timeToX(this.attrEndTime);
    var HANDLE_ZONE = 12; // pixels

    var distStart = Math.abs(localX - sx);
    var distEnd   = Math.abs(localX - ex);
    var inRegion  = localX >= sx && localX <= ex;

    var mode = 'scroll'; // default: scroll-drag (pan the timeline)

    // Handle overlap priority: closer handle wins
    if (distStart < HANDLE_ZONE && distEnd < HANDLE_ZONE) {
        mode = (distStart <= distEnd) ? 'start' : 'end';
    } else if (distStart < HANDLE_ZONE) {
        mode = 'start';
    } else if (distEnd < HANDLE_ZONE) {
        mode = 'end';
    } else if (inRegion && ev.shiftKey) {
        // Shift + drag inside region → slide both handles
        mode = 'slide';
    } else if (inRegion) {
        // Plain click inside region → scroll-drag
        mode = 'scroll';
    }

    this.dragging = true;
    this.dragMode = mode;
    this._lastPointerClientX = ev.clientX;

    // ── Push undo for handle / slide drags ──
    if (mode === 'start' || mode === 'end' || mode === 'slide') {
        try { this._pushUndoState(); } catch(e) {}
        this._lastDraggedHandle = (mode === 'slide') ? this._lastDraggedHandle : mode;
    }

    // ── Scroll-drag anchors ──
    if (mode === 'scroll') {
        this._scrollAnchorClientX  = ev.clientX;
        this._scrollAnchorViewStart = this.viewStart;
        this._scrollAnchorViewEnd   = this.viewEnd;
        this.canvas.style.cursor = 'grabbing';
    }

    // ── Slide anchors ──
    if (mode === 'slide') {
        var cursorTime = this._xToTime(ev.clientX);
        this._slideCursorOffset  = (Number(this.attrStartTime) || 0) - cursorTime;
        this._slideRegionLength  = (Number(this.attrEndTime) || 0) - (Number(this.attrStartTime) || 0);
        this.canvas.style.cursor = 'move';
    }

    // ── Handle drag cursors ──
    if (mode === 'start' || mode === 'end') {
        this.canvas.style.cursor = 'ew-resize';
    }

    // ── Pointer capture ──
    if (this._supportsPointer) {
        try { this.canvas.setPointerCapture(ev.pointerId); } catch(e) {}
        this._activePointerId = ev.pointerId;
        document.addEventListener('pointermove', this._bound.onPointerMove, false);
        document.addEventListener('pointerup', this._bound.onPointerUp, false);
    } else {
        document.addEventListener('mousemove', this._bound.onPointerMove, false);
        document.addEventListener('mouseup', this._bound.onPointerUp, false);
    }

    // ── Start scrub audio for handle drags ──
    if (mode === 'start' || mode === 'end') {
        var handleTime = (mode === 'start') ? Number(this.attrStartTime) || 0 : Number(this.attrEndTime) || 0;
        try { this._startScrub(handleTime); } catch(e) {}
    }

    // ── Start auto-pan for handle / slide drags ──
    if (mode === 'start' || mode === 'end' || mode === 'slide') {
        try { this._startAutoPan(); } catch(e) {}
    }
};

WaveformEditor.prototype._onPointerMove = function(ev) {
    if (!this.dragging || this._isDestroyed) return;

    this._lastPointerClientX = ev.clientX;

    if (this.dragMode === 'scroll') {
        // ── Scroll drag: pan the view ──
        var dx = ev.clientX - this._scrollAnchorClientX;
        var w = this.canvas.getBoundingClientRect().width;
        if (w <= 0) return;
        var viewSpan = this._scrollAnchorViewEnd - this._scrollAnchorViewStart;
        var timeDelta = (dx / w) * viewSpan;
        var ns = this._scrollAnchorViewStart - timeDelta;
        var ne = this._scrollAnchorViewEnd - timeDelta;
        var dur = this.duration || Math.max(ne, 1);
        if (ns < 0) { ne -= ns; ns = 0; }
        if (ne > dur) { ns -= (ne - dur); ne = dur; }
        this.viewStart = Math.max(0, ns);
        this.viewEnd   = Math.min(dur, ne);
        this.isZoomed  = true;
        this._draw();
        return;
    }

    // ── Handle or slide drag ──
    this._updateDragPosition();

    // ── Update scrub audio ──
    if (this.dragMode === 'start' || this.dragMode === 'end') {
        var scrubTime = (this.dragMode === 'start') ? Number(this.attrStartTime) || 0 : Number(this.attrEndTime) || 0;
        try { this._updateScrub(scrubTime); } catch(e) {}
    }

    // ── Update tooltip ──
    try {
        if (this._tooltip) {
            var t = this._xToTime(ev.clientX);
            var wrapperRect = this.domNode.getBoundingClientRect();
            var cRect = this.canvas.getBoundingClientRect();
            this._tooltip.textContent = utils.formatTime(Math.round(t));
            this._tooltip.style.display = 'block';
            this._tooltip.style.left = (ev.clientX - wrapperRect.left) + 'px';
            this._tooltip.style.top  = (cRect.bottom - wrapperRect.top + 4) + 'px';
            if (this._colors) {
                this._tooltip.style.background = this._colors.tooltipBg || 'rgba(0,0,0,0.85)';
                this._tooltip.style.color      = this._colors.tooltipFg || '#fff';
            }
        }
    } catch(e) {}

    this._needsDraw = true;
    // Draw immediately if not in auto-pan (auto-pan handles its own draws)
    if (!this._autoPanRAF) {
        this._needsDraw = false;
        this._draw();
    }
};

WaveformEditor.prototype._onPointerUp = function(ev) {
    if (!this.dragging) return;

    this.canvas.style.cursor = '';

    // Remove document-level listeners
    try {
        if (this._supportsPointer) {
            document.removeEventListener('pointermove', this._bound.onPointerMove, false);
            document.removeEventListener('pointerup', this._bound.onPointerUp, false);
        } else {
            document.removeEventListener('mousemove', this._bound.onPointerMove, false);
            document.removeEventListener('mouseup', this._bound.onPointerUp, false);
        }
    } catch(e) {}

    // Save view state for scroll drags
    if (this.dragMode === 'scroll') {
        this.isZoomed = true;
        this._saveViewState();
    }

    // Cleanup scroll anchors
    this._scrollAnchorClientX  = 0;
    this._scrollAnchorViewStart = 0;
    this._scrollAnchorViewEnd   = 0;

    // Stop auto-pan
    if (this.dragMode === 'start' || this.dragMode === 'end' || this.dragMode === 'slide') {
        this._stopAutoPan();
    }

    // Stop scrub
    if (this.dragMode !== 'scroll') {
        try { this._stopScrub(); } catch(e) {}
    }

    // Clear slide state
    this._slideCursorOffset = 0;
    this._slideRegionLength = 0;

    // Hide tooltip
    try { if (this._tooltip) this._tooltip.style.display = 'none'; } catch(e) {}

    // Focus canvas for keyboard nudges
    try { this.canvas.focus(); } catch(e) {}

    this.dragging = false;

    // Persist times for handle/slide drags (not scroll)
    if (this.dragMode !== 'scroll') {
        this._debouncedPersist();
    }

    this.dragMode = null;
};

/* ── Centralized drag position updater ── */
WaveformEditor.prototype._updateDragPosition = function() {
    if (!this.dragging || !this.dragMode) return;

    var t = this._xToTime(this._lastPointerClientX || 0);
    var dur = this.duration || 0;

    // Auto-swap for zero-length region
    var start = Number(this.attrStartTime) || 0;
    var end   = Number(this.attrEndTime) || 0;
    var ZERO_EPS = 0.0005;
    if (Math.abs(end - start) <= ZERO_EPS) {
        if (this.dragMode === 'start' && t >= start) { this.dragMode = 'end'; this._lastDraggedHandle = 'end'; }
        else if (this.dragMode === 'end' && t <= end) { this.dragMode = 'start'; this._lastDraggedHandle = 'start'; }
    }

    if (this.dragMode === 'start') {
        var e2 = Number(this.attrEndTime) || 0;
        this.attrStartTime = Math.max(0, Math.min(t, e2 - 0.5));
    } else if (this.dragMode === 'end') {
        var s2 = Number(this.attrStartTime) || 0;
        this.attrEndTime = Math.max(s2 + 0.5, Math.min(dur > 0 ? dur : t, t));
    } else if (this.dragMode === 'slide') {
        var cursorTime = t;
        var ns = cursorTime + (this._slideCursorOffset || 0);
        var ne = ns + (this._slideRegionLength || 0);
        if (ns < 0) { ns = 0; ne = this._slideRegionLength || 0; }
        if (dur > 0 && ne > dur) { ne = dur; ns = dur - (this._slideRegionLength || 0); }
        this.attrStartTime = ns;
        this.attrEndTime   = ne;
    }
};

/* ── Hover (non-drag) ── */
WaveformEditor.prototype._onHoverMove = function(ev) {
    if (this.dragging) return;
    if (!this.canvas) return;

    var rect = this.canvas.getBoundingClientRect();
    var lx = ev.clientX - rect.left;
    var ly = ev.clientY - rect.top;

    // Cursor based on hit zone
    if (this._isOverPlayButton(lx, ly)) {
        this.canvas.style.cursor = 'pointer';
    } else {
        var sx = this._timeToX(this.attrStartTime);
        var ex = this._timeToX(this.attrEndTime);
        var HZ = 12;
        if (Math.abs(lx - sx) < HZ || Math.abs(lx - ex) < HZ) {
            this.canvas.style.cursor = 'ew-resize';
        } else if (lx >= sx && lx <= ex) {
            this.canvas.style.cursor = ev.shiftKey ? 'move' : 'grab';
        } else {
            this.canvas.style.cursor = 'grab';
        }
    }

    // Tooltip
    try {
        if (this._tooltip) {
            var t = this._xToTime(ev.clientX);
            var wR = this.domNode.getBoundingClientRect();
            this._tooltip.textContent = utils.formatTime(Math.round(t));
            this._tooltip.style.display = 'block';
            this._tooltip.style.left = (ev.clientX - wR.left) + 'px';
            this._tooltip.style.top  = (rect.bottom - wR.top + 4) + 'px';
            if (this._colors) {
                this._tooltip.style.background = this._colors.tooltipBg || 'rgba(0,0,0,0.85)';
                this._tooltip.style.color      = this._colors.tooltipFg || '#fff';
            }
        }
    } catch(e) {}
};

WaveformEditor.prototype._onPointerLeave = function() {
    if (!this.dragging && this._tooltip) {
        this._tooltip.style.display = 'none';
    }
};

/* ═══════════════════════════════════════════════════════════════
   AUTO-PAN (frame-rate independent, quadratic edge proximity)
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._startAutoPan = function() {
    if (this._autoPanRAF) return;
    var self = this;
    var EDGE_ZONE = 50;
    var BASE_SPEED = 80;
    var lastFrameTime = performance.now();

    function tick(now) {
        if (!self.dragging || !self.canvas) { self._autoPanRAF = null; return; }
        var dt = (now - lastFrameTime) / 1000;
        lastFrameTime = now;
        if (dt > 0.1) dt = 0.1;
        if (dt <= 0) { self._autoPanRAF = requestAnimationFrame(tick); return; }

        var rect = self.canvas.getBoundingClientRect();
        var x = (self._lastPointerClientX || 0) - rect.left;
        var w = rect.width;
        var viewSpan = (self.viewEnd || 1) - (self.viewStart || 0);
        var dur = self.duration || viewSpan;

        var edgeFactor = 0;
        if (x < EDGE_ZONE && x >= 0) {
            var raw = 1 - (x / EDGE_ZONE);
            edgeFactor = -(raw * raw);
        } else if (x > w - EDGE_ZONE && x <= w) {
            var raw2 = 1 - ((w - x) / EDGE_ZONE);
            edgeFactor = raw2 * raw2;
        }

        if (edgeFactor !== 0 && viewSpan > 0) {
            var speedScale = Math.min(1, viewSpan / 120);
            var panAmount  = edgeFactor * BASE_SPEED * speedScale * dt;
            var nvs = self.viewStart + panAmount;
            var nve = self.viewEnd   + panAmount;
            if (nvs < 0)   { nvs = 0;   nve = viewSpan; }
            if (nve > dur)  { nve = dur; nvs = dur - viewSpan; }
            if (Math.abs(nvs - self.viewStart) > 1e-6) {
                self.viewStart = nvs;
                self.viewEnd   = nve;
                try { self._updateDragPosition(); } catch(e) {}
                self._needsDraw = true;
            }
        }

        if (self._needsDraw) { self._needsDraw = false; try { self._draw(); } catch(e) {} }
        self._autoPanRAF = requestAnimationFrame(tick);
    }
    this._autoPanRAF = requestAnimationFrame(tick);
};

WaveformEditor.prototype._stopAutoPan = function() {
    if (this._autoPanRAF) { cancelAnimationFrame(this._autoPanRAF); this._autoPanRAF = null; }
};

/* ═══════════════════════════════════════════════════════════════
   SCRUB AUDIO (during handle drag)
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._startScrub = function(handleTimeSec) {
    if (!this._resolvedSrc) return;
    try {
        if (!this._scrubAudio) { this._scrubAudio = new Audio(); this._scrubAudio.preload = 'auto'; this._scrubAudio.volume = 0.7; }
        if (this._scrubAudio.src !== this._resolvedSrc) this._scrubAudio.src = this._resolvedSrc;
        this._scrubLastHandleTime = handleTimeSec;
        this._scrubLastRealTime   = performance.now();
        var self = this;
        var doPlay = function() {
            if (self._isDestroyed || !self._scrubAudio) return;
            try { self._scrubAudio.currentTime = handleTimeSec; self._scrubAudio.playbackRate = 1.0; self._scrubAudio.play().catch(function(){}); } catch(e) {}
        };
        if (this._scrubAudio.readyState >= 1) { doPlay(); }
        else {
            self._scrubMetaHandler = function() {
                try { self._scrubAudio.removeEventListener('loadedmetadata', self._scrubMetaHandler, false); } catch(e) {}
                self._scrubMetaHandler = null; doPlay();
            };
            this._scrubAudio.addEventListener('loadedmetadata', self._scrubMetaHandler, false);
            this._scrubAudio.load();
        }
        if (this._scrubSyncInterval) clearInterval(this._scrubSyncInterval);
        this._scrubSyncInterval = setInterval(function() {
            if (!self._scrubAudio || self._scrubAudio.paused) return;
            var target = self.dragMode === 'start' ? Number(self.attrStartTime) || 0
                       : self.dragMode === 'end'   ? Number(self.attrEndTime) || 0
                       : Number(self.attrStartTime) || 0;
            if (Math.abs(self._scrubAudio.currentTime - target) > 0.8) {
                try { self._scrubAudio.currentTime = target; } catch(e) {}
            }
        }, 250);
    } catch(e) {}
};

WaveformEditor.prototype._updateScrub = function(handleTimeSec) {
    if (!this._scrubAudio || this._scrubAudio.paused) return;
    try {
        var now = performance.now();
        var realDelta  = (now - this._scrubLastRealTime) / 1000;
        var audioDelta = handleTimeSec - this._scrubLastHandleTime;
        if (realDelta > 0.03) {
            var velocity = audioDelta / realDelta;
            if (velocity < 0) { try { this._scrubAudio.currentTime = handleTimeSec; } catch(e) {} this._scrubAudio.playbackRate = 0.5; }
            else if (velocity < 0.1) { this._scrubAudio.playbackRate = 0.25; try { this._scrubAudio.currentTime = handleTimeSec; } catch(e) {} }
            else { this._scrubAudio.playbackRate = Math.max(0.25, Math.min(4.0, velocity)); if (Math.abs(this._scrubAudio.currentTime - handleTimeSec) > 1.5) { try { this._scrubAudio.currentTime = handleTimeSec; } catch(e) {} } }
            this._scrubLastHandleTime = handleTimeSec;
            this._scrubLastRealTime   = now;
        }
    } catch(e) {}
};

WaveformEditor.prototype._stopScrub = function() {
    try {
        if (this._scrubSyncInterval) { clearInterval(this._scrubSyncInterval); this._scrubSyncInterval = null; }
        if (this._scrubMetaHandler && this._scrubAudio) { try { this._scrubAudio.removeEventListener('loadedmetadata', this._scrubMetaHandler, false); } catch(e) {} this._scrubMetaHandler = null; }
        if (this._scrubAudio) { try { this._scrubAudio.pause(); } catch(e) {} this._scrubAudio.playbackRate = 1.0; }
    } catch(e) {}
};

/* ── Play a short blip for keyboard feedback ── */
WaveformEditor.prototype._playBlip = function(timeSec) {
    if (!this._resolvedSrc) return;
    var self = this;
    try {
        if (!this._scrubAudio) { this._scrubAudio = new Audio(); this._scrubAudio.preload = 'auto'; this._scrubAudio.volume = 0.7; }
        if (this._scrubAudio.src !== this._resolvedSrc) this._scrubAudio.src = this._resolvedSrc;
        var play = function() {
            if (self._isDestroyed) return;
            try { self._scrubAudio.currentTime = timeSec; self._scrubAudio.playbackRate = 1.0; self._scrubAudio.play().catch(function(){}); setTimeout(function() { try { self._scrubAudio.pause(); } catch(e){} }, 300); } catch(e) {}
        };
        if (this._scrubAudio.readyState >= 1) play();
        else {
            var onM = function() { try { self._scrubAudio.removeEventListener('loadedmetadata', onM, false); } catch(e){} play(); };
            this._scrubAudio.addEventListener('loadedmetadata', onM, false);
        }
    } catch(e) {}
};

/* ═══════════════════════════════════════════════════════════════
   REGION PLAYBACK
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._getPlaybackDuration = function() {
    var dur = null;
    try { if (this._scrubAudio && typeof this._scrubAudio.duration === 'number' && isFinite(this._scrubAudio.duration) && this._scrubAudio.duration > 0) dur = this._scrubAudio.duration; } catch(e) {}
    if (!dur) try { var c = audioCache.getCachedWaveform(this._resolvedSrc); if (c && c.metaAudioDuration > 0) dur = c.metaAudioDuration; } catch(e) {}
    if (!dur) try { var c2 = audioCache.getCachedWaveform(this._resolvedSrc); if (c2 && c2.mp3Info && c2.mp3Info.duration > 0) dur = c2.mp3Info.duration; } catch(e) {}
    return dur;
};

WaveformEditor.prototype._playRegion = function() {
    if (this._listenMode) { try { this._stopListenMode(false); } catch(e) {} }
    this._stopRegion();
    if (!this._resolvedSrc) return;

    var self = this;
    var startTime = Number(this.attrStartTime) || 0;
    var endTime   = Number(this.attrEndTime) || 0;
    if (endTime <= startTime) {
        var dur = this.duration || 0;
        if (dur <= 0) return;
        endTime = Math.min(startTime + 20, dur);
        if (endTime <= startTime) return;
    }

    this._playRegionGen = (this._playRegionGen || 0) + 1;
    var myGen = this._playRegionGen;

    // ── Fast path: AudioBuffer already decoded ──
    var cachedAB = this._audioBuffer ||
        (this._resolvedSrc && audioCache.getCachedWaveform(this._resolvedSrc) && audioCache.getCachedWaveform(this._resolvedSrc).audioBuffer) || null;

    if (cachedAB) {
        this._playRegionFromBufferWithAdjustment(cachedAB, startTime, endTime);
        return;
    }

    // ── Slow path: decode first, then play ──
    self._isPlayingRegion = true;
    self._regionPlayhead = startTime;
    self._draw();

    var resolvedKey = this._resolvedSrc;
    var cacheEntry = audioCache.getCachedWaveform(resolvedKey) || {};
    var decodePromise;

    if (cacheEntry.originalArrayBuffer && cacheEntry.originalArrayBuffer.byteLength > 0) {
        self._showLoading();
        var decodeBuf = cacheEntry.originalArrayBuffer.slice(0);
        decodePromise = audioLoader.decodeArrayBuffer(decodeBuf, resolvedKey).then(function(decoded) {
            self._audioBuffer = decoded || (audioCache.getCachedWaveform(resolvedKey) && audioCache.getCachedWaveform(resolvedKey).audioBuffer) || self._audioBuffer;
            return self._audioBuffer || null;
        });
    } else if (resolvedKey && resolvedKey.indexOf('data:') !== 0) {
        self._showLoading();
        decodePromise = self._attemptFetch(resolvedKey).then(function() {
            self._audioBuffer = (audioCache.getCachedWaveform(resolvedKey) && audioCache.getCachedWaveform(resolvedKey).audioBuffer) || self._audioBuffer;
            return self._audioBuffer || null;
        });
    } else {
        decodePromise = Promise.resolve(null);
    }

    decodePromise.then(function(audioBuffer) {
        if (self._isDestroyed || self._playRegionGen !== myGen) return;
        self._hideLoading();
        if (audioBuffer) self._playRegionFromBufferWithAdjustment(audioBuffer, startTime, endTime);
        else self._playRegionHTMLAudioFallback(startTime, endTime);
    }).catch(function() {
        if (self._isDestroyed || self._playRegionGen !== myGen) return;
        self._hideLoading();
        self._playRegionHTMLAudioFallback(startTime, endTime);
    });
};

WaveformEditor.prototype._playRegionFromBufferWithAdjustment = function(audioBuffer, startTime, endTime) {
    var playStart = startTime, playEnd = endTime;
    try {
        var abDur = audioBuffer.duration;
        var playbackDur = this._getPlaybackDuration();
        if (playbackDur && abDur > 0 && Math.abs(abDur - playbackDur) > 0.1) {
            var factor = abDur / playbackDur;
            playStart = startTime * factor;
            playEnd   = endTime * factor;
        }
    } catch(e) {}
    try { playStart = Math.max(0, Math.min(audioBuffer.duration, playStart)); playEnd = Math.max(0, Math.min(audioBuffer.duration, playEnd)); } catch(e) {}
    if (playEnd > playStart) {
        if (this._playRegionFromBuffer(audioBuffer, playStart, playEnd)) return;
    }
    this._playRegionHTMLAudioFallback(startTime, endTime);
};

WaveformEditor.prototype._playRegionFromBuffer = function(audioBuffer, startSec, endSec) {
    var self = this;
    try {
        this._stopRegion();
        var ctx = getSharedAudioContext();
        if (!ctx) return false;
        try { if (ctx.state === 'suspended') ctx.resume(); } catch(e) {}

        var source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        var duration = endSec - startSec;
        if (duration <= 0) return false;

        self._regionBufferSource   = source;
        self._regionBufferCtx      = ctx;
        self._regionBufferStartReal = ctx.currentTime;
        self._regionBufferStartSec  = startSec;
        self._regionBufferEndSec    = endSec;
        self._isPlayingRegion       = true;
        self._regionPlayhead        = startSec;

        source.start(0, startSec, duration);

        source.onended = function() {
            if (self._loopEnabled && self._isPlayingRegion) {
                try { self._playRegionFromBuffer(audioBuffer, startSec, endSec); } catch(e) { self._isPlayingRegion = false; self._draw(); }
            } else {
                self._isPlayingRegion = false;
                self._regionBufferSource = null;
                self._regionPlayhead = 0;
                self._draw();
            }
        };

        self._draw();

        // Playhead animation using AudioContext timing
        if (self._regionPlayheadRAF) cancelAnimationFrame(self._regionPlayheadRAF);
        function tick() {
            if (!self._isPlayingRegion || !self._regionBufferCtx) { self._regionPlayheadRAF = null; return; }
            try {
                var elapsed = self._regionBufferCtx.currentTime - self._regionBufferStartReal;
                var ct = self._regionBufferStartSec + elapsed;
                if (ct > self._regionBufferEndSec) ct = self._regionBufferEndSec;
                var prev = self._regionPlayhead || 0;
                if (Math.abs(self._timeToX(ct) - self._timeToX(prev)) >= 0.5) {
                    self._regionPlayhead = ct;
                    self._draw();
                }
            } catch(e) {}
            self._regionPlayheadRAF = requestAnimationFrame(tick);
        }
        self._regionPlayheadRAF = requestAnimationFrame(tick);
        return true;
    } catch(e) { return false; }
};

WaveformEditor.prototype._playRegionHTMLAudioFallback = function(startTime, endTime) {
    var self = this;
    if (!this._resolvedSrc) return;
    try {
        this._regionAudio = new Audio();
        this._regionAudio.preload = 'auto';
        this._regionAudio.src = this._resolvedSrc;
        var doPlay = function() {
            if (self._isDestroyed || !self._regionAudio) return;
            try {
                self._regionAudio.currentTime = startTime;
                self._isPlayingRegion = true;
                self._regionPlayhead = startTime;
                self._draw();
                self._regionAudio.play().catch(function() { self._isPlayingRegion = false; self._draw(); });
                self._startRegionPlayheadAnimation();
            } catch(e) {}
        };
        this._regionAudio.addEventListener('timeupdate', function() {
            if (!self._regionAudio) return;
            var liveEnd = Number(self.attrEndTime) || 0;
            var liveStart = Number(self.attrStartTime) || 0;
            if (self._regionAudio.currentTime >= liveEnd) {
                if (self._loopEnabled) { try { self._regionAudio.currentTime = liveStart; } catch(e){} }
                else self._stopRegion();
            }
        }, false);
        this._regionAudio.addEventListener('ended', function() { self._isPlayingRegion = false; self._draw(); }, false);
        if (this._regionAudio.readyState >= 1) doPlay();
        else {
            var onM = function() { try { self._regionAudio.removeEventListener('loadedmetadata', onM, false); } catch(e) {} doPlay(); };
            this._regionAudio.addEventListener('loadedmetadata', onM, false);
            this._regionAudio.load();
        }
    } catch(e) {}
};

WaveformEditor.prototype._startRegionPlayheadAnimation = function() {
    if (this._regionPlayheadRAF) cancelAnimationFrame(this._regionPlayheadRAF);
    var self = this;
    function tick() {
        if (!self._isPlayingRegion || !self._regionAudio) { self._regionPlayheadRAF = null; return; }
        try {
            var ct = self._regionAudio.currentTime || 0;
            var prev = self._regionPlayhead || 0;
            if (Math.abs(self._timeToX(ct) - self._timeToX(prev)) >= 0.5) {
                self._regionPlayhead = ct; self._draw();
            }
        } catch(e) {}
        self._regionPlayheadRAF = requestAnimationFrame(tick);
    }
    this._regionPlayheadRAF = requestAnimationFrame(tick);
};

WaveformEditor.prototype._stopRegion = function() {
    try { this._playRegionGen = (this._playRegionGen || 0) + 1; } catch(e) {}
    if (this._listenMode) { try { this._stopListenMode(false); } catch(e) {} }
    try { if (this._regionBufferSource) { try { this._regionBufferSource.stop(); } catch(e){} try { this._regionBufferSource.disconnect(); } catch(e){} this._regionBufferSource = null; } } catch(e) {}
    this._regionBufferCtx = null; this._regionBufferStartReal = 0; this._regionBufferStartSec = 0; this._regionBufferEndSec = 0;
    try { if (this._regionAudio) { try { this._regionAudio.pause(); } catch(e){} try { this._regionAudio.removeAttribute('src'); this._regionAudio.load(); } catch(e){} this._regionAudio = null; } } catch(e) {}
    this._isPlayingRegion = false;
    if (this._regionPlayheadRAF) { cancelAnimationFrame(this._regionPlayheadRAF); this._regionPlayheadRAF = null; }
    this._regionPlayhead = 0;
    this._draw();
};

/* ── Preview playback ── */
WaveformEditor.prototype._playPreview = function(centerTime, preSeconds, postSeconds) {
    this._stopRegion();
    if (!this._resolvedSrc) return;
    var from = Math.max(0, centerTime - preSeconds);
    var to   = Math.min(this.duration || centerTime + postSeconds, centerTime + postSeconds);

    var cachedAB = this._audioBuffer ||
        (this._resolvedSrc && audioCache.getCachedWaveform(this._resolvedSrc) && audioCache.getCachedWaveform(this._resolvedSrc).audioBuffer) || null;
    if (cachedAB) {
        try { this._playRegionFromBufferWithAdjustment(cachedAB, from, to); return; } catch(e) {}
    }
    // Fallback to HTML Audio
    this._playRegionHTMLAudioFallback(from, to);
};

/* ═══════════════════════════════════════════════════════════════
   LISTEN MODE (Set Start / Set End)
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._startListenMode = function(mode) {
    this._stopListenMode(false);
    try { this._stopRegion(); } catch(e) {}
    if (!this._resolvedSrc) return;

    this._listenMode = mode;
    this._updateListenButtonState();

    // Create or reuse listen audio element
    try {
        if (!this._listenAudio) { this._listenAudio = new Audio(); this._listenAudio.preload = 'auto'; }
        if (this._listenAudio.src !== this._resolvedSrc) this._listenAudio.src = this._resolvedSrc;
    } catch(e) { return; }

    var startSec = Number(this.attrStartTime) || 0;
    var seekTo = (mode === 'start') ? Math.max(0, startSec - 10) : startSec;

    var self = this;
    var doPlay = function() {
        if (self._isDestroyed) return;
        try {
            // Prefer decoded AudioBuffer for sample-accurate marking
            var cachedAB = self._audioBuffer ||
                (self._resolvedSrc && audioCache.getCachedWaveform(self._resolvedSrc) && audioCache.getCachedWaveform(self._resolvedSrc).audioBuffer) || null;
            if (cachedAB && AudioContextCtor) {
                var ctx = getSharedAudioContext();
                try { if (ctx && ctx.state === 'suspended') ctx.resume(); } catch(e) {}
                if (ctx) {
                    try {
                        var playStart = seekTo;
                        try {
                            var playbackDur = self._getPlaybackDuration();
                            if (playbackDur && cachedAB.duration > 0 && Math.abs(cachedAB.duration - playbackDur) > 0.1) {
                                playStart = seekTo * (cachedAB.duration / playbackDur);
                            }
                        } catch(e) {}
                        playStart = Math.max(0, Math.min(cachedAB.duration, playStart));
                        var source = ctx.createBufferSource();
                        source.buffer = cachedAB;
                        source.connect(ctx.destination);
                        source.start(0, playStart);
                        self._listenBufferSource   = source;
                        self._listenBufferCtx      = ctx;
                        self._listenBufferStartReal = ctx.currentTime;
                        self._listenBufferStartSec  = playStart;
                        source.onended = function() { try { self._stopListenMode(false); } catch(e) {} };
                        self._startPlayheadAnimation();
                        return;
                    } catch(e) {}
                }
            }
            // Fallback: HTML Audio
            if (!self._listenAudio) return;
            self._listenAudio.currentTime = seekTo;
            self._listenAudio.playbackRate = 1.0;
            self._listenAudio.volume = 1.0;
            self._listenAudio.play().catch(function() { self._stopListenMode(false); });
            self._startPlayheadAnimation();
        } catch(e) { self._stopListenMode(false); }
    };

    if (this._listenAudio.readyState >= 1) doPlay();
    else {
        self._listenMetaHandler = function() {
            try { self._listenAudio.removeEventListener('loadedmetadata', self._listenMetaHandler, false); } catch(e) {}
            self._listenMetaHandler = null; doPlay();
        };
        this._listenAudio.addEventListener('loadedmetadata', self._listenMetaHandler, false);
        this._listenAudio.load();
    }

    this._listenEndedHandler = function() { self._stopListenMode(false); };
    this._listenAudio.addEventListener('ended', this._listenEndedHandler, false);

    // Document-level key handler
    this._boundListenKeyDown = function(ev) {
        try {
            if (ev.key === 'Escape' || ev.key === 'Esc') { ev.preventDefault(); self._stopListenMode(false); return; }
            if (ev.key === ' ' || ev.key === 'Enter' || ev.code === 'Space') { ev.preventDefault(); self._listenMark(); return; }
        } catch(e) {}
    };
    document.addEventListener('keydown', this._boundListenKeyDown, false);

    // Document click handler: cancel on click outside
    this._boundListenDocClick = function(ev) {
        try {
            var tgt = ev.target || ev.srcElement;
            if (self.canvas && (tgt === self.canvas || (self.canvas.contains && self.canvas.contains(tgt)))) return;
            if (self._setStartBtn && (tgt === self._setStartBtn || (self._setStartBtn.contains && self._setStartBtn.contains(tgt)))) return;
            if (self._setEndBtn && (tgt === self._setEndBtn || (self._setEndBtn.contains && self._setEndBtn.contains(tgt)))) return;
            self._stopListenMode(false);
        } catch(e) {}
    };
    document.addEventListener('click', this._boundListenDocClick, true);
};

WaveformEditor.prototype._listenMark = function() {
    if (!this._listenMode || (!this._listenAudio && !this._listenBufferCtx)) return;
    try { this._pushUndoState(); } catch(e) {}

    var markTime = 0;
    try {
        if (this._listenBufferCtx && typeof this._listenBufferStartReal === 'number') {
            var bufTime = (this._listenBufferStartSec || 0) + (this._listenBufferCtx.currentTime - (this._listenBufferStartReal || 0));
            try {
                var cachedAB = this._audioBuffer || (this._resolvedSrc && audioCache.getCachedWaveform(this._resolvedSrc) && audioCache.getCachedWaveform(this._resolvedSrc).audioBuffer) || null;
                var playbackDur = this._getPlaybackDuration();
                if (cachedAB && playbackDur && cachedAB.duration > 0 && Math.abs(cachedAB.duration - playbackDur) > 0.001) {
                    markTime = bufTime * (playbackDur / cachedAB.duration);
                } else { markTime = bufTime; }
            } catch(e) { markTime = bufTime; }
        } else if (this._listenAudio) {
            markTime = this._listenAudio.currentTime || 0;
        }
    } catch(e) { markTime = 0; }

    var MIN_LEN = 0.5;
    var mode = this._listenMode;
    if (mode === 'start') {
        var end = Number(this.attrEndTime) || 0;
        var dur = this.duration || markTime;
        if (markTime > end - MIN_LEN) {
            var ns = Math.max(0, Math.min(markTime, dur - MIN_LEN));
            var ne = Math.min(dur, ns + MIN_LEN);
            if (ne < end) ne = end;
            this.attrStartTime = ns; this.attrEndTime = ne;
        } else {
            this.attrStartTime = Math.max(0, Math.min(markTime, end - MIN_LEN));
        }
    } else if (mode === 'end') {
        var start = Number(this.attrStartTime) || 0;
        var dur2 = this.duration || markTime;
        if (markTime < start + MIN_LEN) {
            var ne2 = Math.max(0, Math.min(markTime, dur2));
            var ns2 = Math.max(0, ne2 - MIN_LEN);
            if (ns2 > start) ns2 = start;
            this.attrEndTime = ne2; this.attrStartTime = ns2;
        } else {
            this.attrEndTime = Math.max(start + MIN_LEN, Math.min(dur2, markTime));
        }
    }

    this._stopListenMode(true);
    this._debouncedPersist();
    this._draw();
};

WaveformEditor.prototype._stopListenMode = function(marked) {
    this._listenMode = null;
    this._listenPlayhead = 0;

    try { if (this._listenBufferSource) { try { this._listenBufferSource.stop(); } catch(e){} try { this._listenBufferSource.disconnect(); } catch(e){} this._listenBufferSource = null; } } catch(e) {}
    this._listenBufferCtx = null; this._listenBufferStartReal = 0; this._listenBufferStartSec = 0;
    try {
        if (this._listenAudio) {
            try { this._listenAudio.pause(); } catch(e) {}
            if (this._listenEndedHandler) { try { this._listenAudio.removeEventListener('ended', this._listenEndedHandler, false); } catch(e){} this._listenEndedHandler = null; }
            if (this._listenMetaHandler) { try { this._listenAudio.removeEventListener('loadedmetadata', this._listenMetaHandler, false); } catch(e){} this._listenMetaHandler = null; }
        }
    } catch(e) {}
    if (this._listenRAF) { cancelAnimationFrame(this._listenRAF); this._listenRAF = null; }

    try { if (this._boundListenKeyDown) { document.removeEventListener('keydown', this._boundListenKeyDown, false); this._boundListenKeyDown = null; } } catch(e) {}
    try { if (this._boundListenDocClick) { document.removeEventListener('click', this._boundListenDocClick, true); this._boundListenDocClick = null; } } catch(e) {}

    this._updateListenButtonState();
    try { this._draw(); } catch(e) {}
};

WaveformEditor.prototype._updateListenButtonState = function() {
    try {
        if (this._setStartBtn) {
            if (this._listenMode === 'start') {
                this._setStartBtn.classList.add('AudioSuite-waveform-editor__btn--active');
                this._setStartBtn.textContent = '⏎ Tap to Mark Start';
            } else {
                this._setStartBtn.classList.remove('AudioSuite-waveform-editor__btn--active');
                this._setStartBtn.textContent = '🎯 Set Start';
            }
        }
        if (this._setEndBtn) {
            if (this._listenMode === 'end') {
                this._setEndBtn.classList.add('AudioSuite-waveform-editor__btn--active');
                this._setEndBtn.textContent = '⏎ Tap to Mark End';
            } else {
                this._setEndBtn.classList.remove('AudioSuite-waveform-editor__btn--active');
                this._setEndBtn.textContent = '🎯 Set End';
            }
        }
    } catch(e) {}
};

WaveformEditor.prototype._startPlayheadAnimation = function() {
    if (this._listenRAF) cancelAnimationFrame(this._listenRAF);
    var self = this;
    function tick() {
        if (!self._listenMode || (!self._listenAudio && !self._listenBufferCtx)) { self._listenRAF = null; return; }
        try {
            var currentTime = 0;
            if (self._listenBufferCtx && typeof self._listenBufferStartReal === 'number') {
                currentTime = (self._listenBufferStartSec || 0) + (self._listenBufferCtx.currentTime - (self._listenBufferStartReal || 0));
            } else {
                currentTime = self._listenAudio ? (self._listenAudio.currentTime || 0) : 0;
            }
            var prev = self._listenPlayhead || 0;
            if (Math.abs(self._timeToX(currentTime) - self._timeToX(prev)) >= 0.5) {
                self._listenPlayhead = currentTime;
                // Auto-scroll to follow playhead
                try {
                    var phPx = self._timeToX(currentTime);
                    var canvasW = self.canvas.getBoundingClientRect().width;
                    var viewSpan = (self.viewEnd || 1) - (self.viewStart || 0);
                    if (phPx > canvasW * 0.85 && self.viewEnd < (self.duration || 0)) {
                        var shift = viewSpan * 0.3;
                        self.viewStart = Math.min(self.duration - viewSpan, self.viewStart + shift);
                        self.viewEnd = self.viewStart + viewSpan;
                        self.isZoomed = true;
                    }
                    if (phPx < canvasW * 0.15 && self.viewStart > 0) {
                        var shift2 = viewSpan * 0.3;
                        self.viewStart = Math.max(0, self.viewStart - shift2);
                        self.viewEnd = self.viewStart + viewSpan;
                        self.isZoomed = true;
                    }
                } catch(e) {}
                self._draw();
            }
        } catch(e) {}
        self._listenRAF = requestAnimationFrame(tick);
    }
    this._listenRAF = requestAnimationFrame(tick);
};

/* ═══════════════════════════════════════════════════════════════
   SILENCE DETECTION & SNAP
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._findNearestSilence = function(timeSec, direction, maxSearchSeconds) {
    if (!this.peaks || !this.duration) return timeSec;
    var THRESHOLD = 0.05;
    var MIN_DUR   = 0.15;
    var maxSearch = maxSearchSeconds || 5;
    var peaksPerSec = this.peaks.length / this.duration;
    var startIdx = Math.round(timeSec * peaksPerSec);
    var minSilSamples  = Math.ceil(MIN_DUR * peaksPerSec);
    var maxSearchSamples = Math.ceil(maxSearch * peaksPerSec);
    var self = this;
    function searchDir(dir) {
        var consec = 0, silStart = -1;
        for (var i = 0; i < maxSearchSamples; i++) {
            var idx = startIdx + i * dir;
            if (idx < 0 || idx >= self.peaks.length) break;
            if (self.peaks[idx] < THRESHOLD) {
                if (consec === 0) silStart = idx;
                consec++;
                if (consec >= minSilSamples) return ((dir > 0) ? silStart : idx) / peaksPerSec;
            } else { consec = 0; silStart = -1; }
        }
        return null;
    }
    if (direction === 0) {
        var bk = searchDir(-1), fw = searchDir(1);
        if (bk === null && fw === null) return timeSec;
        if (bk === null) return fw;
        if (fw === null) return bk;
        return (Math.abs(bk - timeSec) <= Math.abs(fw - timeSec)) ? bk : fw;
    }
    var r = searchDir(direction);
    return (r !== null) ? r : timeSec;
};

WaveformEditor.prototype._snapHandleToSilence = function(handle) {
    if (!this.peaks || !this.duration) return;
    if (handle === 'start') {
        var start = Number(this.attrStartTime) || 0;
        var bk = this._findNearestSilence(start, -1, 5);
        var fw = this._findNearestSilence(start, 1, 5);
        var snapped = start;
        if (bk === null && fw === null) snapped = start;
        else if (bk === null) snapped = fw;
        else if (fw === null) snapped = bk;
        else snapped = (Math.abs(bk - start) <= Math.abs(fw - start)) ? bk : fw;
        this.attrStartTime = Math.max(0, Math.min(snapped, (Number(this.attrEndTime) || 0) - 0.5));
    } else if (handle === 'end') {
        var end = Number(this.attrEndTime) || 0;
        var bk2 = this._findNearestSilence(end, -1, 5);
        var fw2 = this._findNearestSilence(end, 1, 5);
        var snapped2 = end;
        if (bk2 === null && fw2 === null) snapped2 = end;
        else if (bk2 === null) snapped2 = fw2;
        else if (fw2 === null) snapped2 = bk2;
        else snapped2 = (Math.abs(bk2 - end) <= Math.abs(fw2 - end)) ? bk2 : fw2;
        this.attrEndTime = Math.max((Number(this.attrStartTime) || 0) + 0.5, Math.min(this.duration, snapped2));
    }
    this._draw();
    this._debouncedPersist();
};

/* ═══════════════════════════════════════════════════════════════
   UNDO / REDO  (uses audioCache undo stacks)
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._pushUndoState = function() {
    var key = this.attrTiddler;
    if (!key) return;
    var u = audioCache.getUndoStack(key);
    if (!u) { audioCache.initUndoStack(key); u = audioCache.getUndoStack(key); }
    if (!u) return;
    var state = { start: Number(this.attrStartTime) || 0, end: Number(this.attrEndTime) || 0 };
    if (u.index < u.stack.length - 1) u.stack = u.stack.slice(0, u.index + 1);
    u.stack.push(state);
    if (u.stack.length > 20) u.stack.shift();
    u.index = u.stack.length - 1;
};

WaveformEditor.prototype._undo = function() {
    var key = this.attrTiddler;
    if (!key) return;
    var u = audioCache.getUndoStack(key);
    if (!u || u.index <= 0) return;
    u.index--;
    var s = u.stack[u.index];
    this.attrStartTime = s.start; this.attrEndTime = s.end;
    this._draw();
    this._debouncedPersist();
};

WaveformEditor.prototype._redo = function() {
    var key = this.attrTiddler;
    if (!key) return;
    var u = audioCache.getUndoStack(key);
    if (!u || u.index >= u.stack.length - 1) return;
    u.index++;
    var s = u.stack[u.index];
    this.attrStartTime = s.start; this.attrEndTime = s.end;
    this._draw();
    this._debouncedPersist();
};

/* ═══════════════════════════════════════════════════════════════
   KEYBOARD HANDLER
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._onKeyDown = function(ev) {
    // Listen mode keys
    if (this._listenMode && (ev.key === ' ' || ev.key === 'Enter' || ev.code === 'Space')) { ev.preventDefault(); this._listenMark(); return; }
    if (this._listenMode && (ev.key === 'Escape' || ev.key === 'Esc')) { ev.preventDefault(); this._stopListenMode(false); return; }

    var key = ev.key;

    // Undo / Redo
    if ((key === 'z' || key === 'Z') && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey) { ev.preventDefault(); this._undo(); return; }
    if (((key === 'z' || key === 'Z') && (ev.ctrlKey || ev.metaKey) && ev.shiftKey) ||
        ((key === 'y' || key === 'Y') && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); this._redo(); return; }

    // Snap to silence: S = last handle, Shift+S = both
    if ((key === 's' || key === 'S') && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault();
        try { this._pushUndoState(); } catch(e) {}
        if (ev.shiftKey) {
            this._snapHandleToSilence('start');
            this._snapHandleToSilence('end');
        } else {
            var snapH = this._lastDraggedHandle || 'start';
            this._snapHandleToSilence(snapH);
            try { this._playBlip(Number(snapH === 'start' ? this.attrStartTime : this.attrEndTime)); } catch(e) {}
        }
        return;
    }

    // T = transcribe
    if ((key === 't' || key === 'T') && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); this._transcribeRegion(); return; }

    // Arrow nudge
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    ev.preventDefault();
    try { this._pushUndoState(); } catch(e) {}

    var handle = this._lastDraggedHandle;
    if (handle !== 'start' && handle !== 'end') handle = 'start';
    var step = ev.shiftKey ? 5 : 1;
    var dir  = (key === 'ArrowRight') ? 1 : -1;
    var delta = step * dir;
    var start = Number(this.attrStartTime) || 0;
    var end   = Number(this.attrEndTime) || 0;
    var dur   = this.duration || Math.max(end, 1);

    if (handle === 'start') {
        this.attrStartTime = Math.max(0, Math.min(end - 0.5, start + delta));
    } else {
        this.attrEndTime = Math.max(start + 0.5, Math.min(dur, end + delta));
    }

    this._draw();
    try { this._playBlip(handle === 'start' ? Number(this.attrStartTime) : Number(this.attrEndTime)); } catch(e) {}
    this._debouncedPersist();
};

/* ═══════════════════════════════════════════════════════════════
   MP3 REGION HELPERS
   Uses mp3-parser module for byte-level operations
   ═══════════════════════════════════════════════════════════════ */

/**
 * Slice a region of MP3 bytes from an in-memory ArrayBuffer
 * using mp3-parser for frame-accurate seeking.
 */
WaveformEditor.prototype._sliceRegionBytes = function(arrayBuffer, startSec, endSec) {
    if (!arrayBuffer || arrayBuffer.byteLength < 100) return null;
    try {
        // Skip ID3v2 header
        var id3Skip = 0;
        if (arrayBuffer.byteLength >= 10) {
            var id3h = new Uint8Array(arrayBuffer.slice ? arrayBuffer.slice(0, 10) : new ArrayBuffer(0));
            if (id3h[0] === 0x49 && id3h[1] === 0x44 && id3h[2] === 0x33) {
                id3Skip = 10 + ((id3h[6] & 0x7F) << 21 | (id3h[7] & 0x7F) << 14 | (id3h[8] & 0x7F) << 7 | (id3h[9] & 0x7F));
            }
        }

        // Parse MP3 info from header area
        var headerEnd = Math.min(arrayBuffer.byteLength, Math.max(131072, id3Skip + 4096));
        var headerBuf = arrayBuffer.slice(0, headerEnd);
        var mi = mp3Parser.parseMp3Info(headerBuf);
        if (!mi) return null;

        // Cache mp3Info
        if (this._resolvedSrc) {
            audioCache.updateCachedWaveform(this._resolvedSrc, { mp3Info: mi });
        }

        var playbackDur = this._getPlaybackDuration() || mi.duration || this.duration || 0;
        if (playbackDur <= 0) return null;

        var startByte, endByte;
        if (mi.isVBR && mi.tocEntries && mi.totalBytes) {
            startByte = mp3Parser.xingSeekByte(mi, startSec);
            endByte   = mp3Parser.xingSeekByte(mi, endSec);
        } else if (mi.bitrate) {
            var bps = mi.bitrate / 8;
            startByte = Math.max(0, Math.floor(startSec * bps) + (mi.dataStart || 0));
            endByte   = Math.min(arrayBuffer.byteLength, Math.ceil(endSec * bps) + (mi.dataStart || 0));
        } else {
            // Avg bitrate fallback
            var audioBytes = Math.max(0, arrayBuffer.byteLength - (mi.dataStart || id3Skip));
            var avgBps = audioBytes / playbackDur;
            startByte = Math.max(0, Math.floor(startSec * avgBps) + (mi.dataStart || id3Skip));
            endByte   = Math.min(arrayBuffer.byteLength, Math.ceil(endSec * avgBps) + (mi.dataStart || id3Skip));
        }

        if (endByte <= startByte) return null;

        // Neutralize VBR headers in the slice to prevent wrong seeking
        var slice = arrayBuffer.slice(startByte, endByte);
        try { mp3Parser.neutralizeVbrHeaders(slice); } catch(e) {}

        return { arrayBuffer: slice, startByte: startByte, endByte: endByte };
    } catch(e) {
        console.warn('[waveform-editor] _sliceRegionBytes failed:', e);
        return null;
    }
};

/**
 * Fetch a byte range of a remote MP3 for region transcription.
 * Returns a Promise<{arrayBuffer}>.
 */
WaveformEditor.prototype._fetchRegionBytes = function(url, startSec, endSec) {
    var self = this;
    return new Promise(function(resolve, reject) {
        // If we have the full file cached, just slice it
        var c = audioCache.getCachedWaveform(url);
        if (c && c.originalArrayBuffer && c.originalArrayBuffer.byteLength > 0) {
            var result = self._sliceRegionBytes(c.originalArrayBuffer, startSec, endSec);
            return resolve(result);
        }

        // Fetch the full file, then slice
        self._attemptFetch(url).then(function() {
            var c2 = audioCache.getCachedWaveform(url);
            if (c2 && c2.originalArrayBuffer) {
                resolve(self._sliceRegionBytes(c2.originalArrayBuffer, startSec, endSec));
            } else {
                resolve(null);
            }
        }).catch(function(err) { reject(err); });
    });
};

/* ═══════════════════════════════════════════════════════════════
   TRANSCRIPTION
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._getTranscriptionConfig = function() {
    var BASE = '$:/plugins/NoteStreams/AudioSuite/configuration/transcriptions/';
    var cfg = {
        apiKey: '', model: 'whisper-1', language: '', prompt: '',
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        editorModel: 'gpt-4.1-nano', editorPrompt: '',
        editorEndpoint: 'https://api.openai.com/v1/chat/completions',
        editorEnabled: true
    };
    try {
        cfg.apiKey   = (this.wiki.getTiddlerText(BASE + 'api-key', '') || '').trim();
        var m = (this.wiki.getTiddlerText(BASE + 'model', '') || '').trim(); if (m) cfg.model = m;
        cfg.language = (this.wiki.getTiddlerText(BASE + 'language', '') || '').trim();
        var ep = (this.wiki.getTiddlerText(BASE + 'endpoint', '') || '').trim(); if (ep) cfg.endpoint = ep;
        cfg.prompt   = (this.wiki.getTiddlerText(BASE + 'prompt', '') || '').trim();
        var em = (this.wiki.getTiddlerText(BASE + 'editor-model', '') || '').trim(); if (em) cfg.editorModel = em;
        cfg.editorPrompt = (this.wiki.getTiddlerText(BASE + 'editor-prompt', '') || '').trim();
        var ee = (this.wiki.getTiddlerText(BASE + 'editor-endpoint', '') || '').trim(); if (ee) cfg.editorEndpoint = ee;
        try {
            var ev = (this.wiki.getTiddlerText(BASE + 'editor-enabled', '') || '').trim().toLowerCase();
            if (ev === 'false' || ev === '0' || ev === 'no' || ev === 'off') cfg.editorEnabled = false;
            else if (ev === 'true' || ev === '1' || ev === 'yes' || ev === 'on') cfg.editorEnabled = true;
        } catch(e) {}
    } catch(e) {}
    return cfg;
};

WaveformEditor.prototype._showTranscribeStatus = function(message, type) {
    if (!this._transcribeStatus) return;
    this._transcribeStatus.textContent = message;
    this._transcribeStatus.style.display = '';
    this._transcribeStatus.className = 'AudioSuite-waveform-editor__transcribe-status';
    if (type) this._transcribeStatus.classList.add('AudioSuite-waveform-editor__transcribe-status--' + type);
};

WaveformEditor.prototype._editTranscription = function(rawText) {
    var self = this;
    return new Promise(function(resolve) {
        try {
            var cfg = self._getTranscriptionConfig();
            if (cfg && cfg.editorEnabled === false) return resolve(rawText);
            if (!cfg.apiKey) return resolve(rawText);
            var systemPrompt = cfg.editorPrompt || 'You are an assistant that edits transcriptions for readability. Insert <br><br> between logical sections, improve coherence and grammar, preserve original meaning, and return only the edited transcription (no commentary).';
            fetch(cfg.editorEndpoint, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: cfg.editorModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: 'Please edit the following transcription for clarity and insert <br><br> between sections where appropriate. Preserve meaning and do not add new facts. Return only the edited transcription:\n\n' + rawText }
                    ],
                    temperature: 0.2
                })
            }).then(function(resp) {
                if (!resp.ok) return resp.text().then(function(t) { throw new Error(t); });
                return resp.json();
            }).then(function(data) {
                try {
                    var content = '';
                    if (data && data.choices && data.choices.length) {
                        var ch = data.choices[0];
                        if (ch.message && ch.message.content) content = ch.message.content;
                        else if (ch.text) content = ch.text;
                    }
                    content = (content || '').toString().trim();
                    resolve(content || rawText);
                } catch(e) { resolve(rawText); }
            }).catch(function() { resolve(rawText); });
        } catch(e) { resolve(rawText); }
    });
};

WaveformEditor.prototype._applyTranscription = function(transcriptionText) {
    if (!this.attrTiddler || !transcriptionText) return;
    try {
        var existing = this.wiki.getTiddler(this.attrTiddler);
        if (!existing) return;
        var fields = {};
        var ef = existing.fields || {};
        for (var k in ef) { if (Object.prototype.hasOwnProperty.call(ef, k)) fields[k] = ef[k]; }
        var prev = (ef.transcription || '').toString().trim();
        var next = (transcriptionText || '').toString().trim();
        if (prev && next.indexOf(prev) !== -1) { next = next.replace(prev, '').trim().replace(/^[-\s\n]*([\r\n])*/g, '').trim(); }
        fields.transcription = prev ? (next ? prev + '\n\n---\n' + next : prev) : next;
        fields.tags = ef.tags || fields.tags || [];
        this.wiki.addTiddler(new $tw.Tiddler(existing, fields));
    } catch(e) { console.error('[waveform-editor] apply transcription failed:', e); }
};

/* ── Main transcription flow ── */
WaveformEditor.prototype._transcribeRegion = function() {
    var self = this;
    var config = this._getTranscriptionConfig();

    if (!config.apiKey) {
        this._showTranscribeStatus('⚠️ No API key — set it in $:/plugins/NoteStreams/AudioSuite/configuration/transcriptions/api-key', 'error');
        return;
    }

    var startSec = Number(this.attrStartTime) || 0;
    var endSec   = Number(this.attrEndTime) || 0;
    if (endSec <= startSec) {
        this._showTranscribeStatus('⚠️ Invalid region (start ≥ end)', 'error');
        return;
    }
    var regionDuration = endSec - startSec;

    this._showTranscribeStatus('🔄 Preparing audio...', 'progress');
    try { this._transcribeBtn.disabled = true; } catch(e) {}

    // ── Try raw MP3 slice first (most accurate for VBR) ──
    var cacheEntry = audioCache.getCachedWaveform(this._resolvedSrc) || {};
    var rawBuf = cacheEntry.originalArrayBuffer;

    if (rawBuf && rawBuf.byteLength > 0) {
        var sliceResult = null;
        try { sliceResult = this._sliceRegionBytes(rawBuf, startSec, endSec); } catch(e) {}
        if (sliceResult && sliceResult.arrayBuffer) {
            this._sendMp3BlobToWhisper(sliceResult.arrayBuffer, regionDuration, config);
            return;
        }
    }

    // ── Try WAV encode from decoded AudioBuffer ──
    if (this._audioBuffer) {
        this._showTranscribeStatus('🔄 Encoding region audio...', 'progress');
        var extractStart = startSec, extractEnd = endSec;
        try {
            var abDur = this._audioBuffer.duration;
            var playbackDur = this._getPlaybackDuration();
            if (playbackDur && abDur > 0 && Math.abs(abDur - playbackDur) > 0.1) {
                var factor = abDur / playbackDur;
                extractStart = startSec * factor;
                extractEnd   = endSec * factor;
            }
        } catch(e) {}
        wavEncoder.encodeRegionToWavBlob(this._audioBuffer, extractStart, extractEnd).then(function(wavBlob) {
            if (wavBlob) self._sendWavToWhisper(wavBlob, regionDuration, config);
            else self._transcribeFallbackFetch(config, startSec, endSec, regionDuration);
        }).catch(function() {
            self._transcribeFallbackFetch(config, startSec, endSec, regionDuration);
        });
        return;
    }

    // ── Fallback: fetch full file, then try raw MP3 or WAV ──
    this._transcribeFallbackFetch(config, startSec, endSec, regionDuration);
};

WaveformEditor.prototype._transcribeFallbackFetch = function(config, startSec, endSec, regionDuration) {
    var self = this;
    if (!this._resolvedSrc) {
        this._showTranscribeStatus('⚠️ Audio not available', 'error');
        try { this._transcribeBtn.disabled = false; } catch(e) {}
        return;
    }
    this._showTranscribeStatus('🔄 Fetching audio...', 'progress');
    this._attemptFetch(this._resolvedSrc).then(function() {
        self._audioBuffer = (audioCache.getCachedWaveform(self._resolvedSrc) && audioCache.getCachedWaveform(self._resolvedSrc).audioBuffer) || self._audioBuffer;
        // Try raw MP3 slice from now-cached data
        var c = audioCache.getCachedWaveform(self._resolvedSrc) || {};
        if (c.originalArrayBuffer) {
            var sl = null;
            try { sl = self._sliceRegionBytes(c.originalArrayBuffer, startSec, endSec); } catch(e) {}
            if (sl && sl.arrayBuffer) { self._sendMp3BlobToWhisper(sl.arrayBuffer, regionDuration, config); return; }
        }
        // Try WAV from AudioBuffer
        if (self._audioBuffer) {
            wavEncoder.encodeRegionToWavBlob(self._audioBuffer, startSec, endSec).then(function(blob) {
                if (blob) self._sendWavToWhisper(blob, regionDuration, config);
                else { self._showTranscribeStatus('⚠️ Encoding failed', 'error'); try { self._transcribeBtn.disabled = false; } catch(e) {} }
            }).catch(function() { self._showTranscribeStatus('⚠️ Encoding failed', 'error'); try { self._transcribeBtn.disabled = false; } catch(e) {} });
        } else {
            self._showTranscribeStatus('⚠️ Audio not decoded', 'error');
            try { self._transcribeBtn.disabled = false; } catch(e) {}
        }
    }).catch(function(err) {
        self._showTranscribeStatus('⚠️ Fetch failed', 'error');
        try { self._transcribeBtn.disabled = false; } catch(e) {}
    });
};

WaveformEditor.prototype._sendWavToWhisper = function(wavBlob, regionDuration, config) {
    this._sendAudioToWhisper(wavBlob, 'region.wav', regionDuration, config);
};

WaveformEditor.prototype._sendMp3BlobToWhisper = function(mp3ArrayBuffer, regionDuration, config) {
    var blob = new Blob([mp3ArrayBuffer], { type: 'audio/mpeg' });
    this._sendAudioToWhisper(blob, 'region.mp3', regionDuration, config);
};

WaveformEditor.prototype._sendAudioToWhisper = function(audioBlob, filename, regionDuration, config) {
    var self = this;
    if (!audioBlob) { self._showTranscribeStatus('⚠️ Failed to prepare audio', 'error'); try { self._transcribeBtn.disabled = false; } catch(e) {} return; }
    if (audioBlob.size > 25 * 1024 * 1024) { self._showTranscribeStatus('⚠️ Region too large (' + Math.round(audioBlob.size / 1048576) + 'MB > 25MB limit)', 'error'); try { self._transcribeBtn.disabled = false; } catch(e) {} return; }

    self._showTranscribeStatus('🔄 Transcribing (' + Math.round(regionDuration) + 's)...', 'progress');

    var formData = new FormData();
    formData.append('file', audioBlob, filename);
    formData.append('model', config.model);
    if (config.language) formData.append('language', config.language);
    if (config.prompt) formData.append('prompt', config.prompt);
    formData.append('response_format', 'json');

    var maxAttempts = 3;
    function post(attempt) {
        return new Promise(function(res, rej) {
            fetch(config.endpoint, { method: 'POST', headers: { 'Authorization': 'Bearer ' + config.apiKey }, body: formData })
            .then(function(resp) {
                if (!resp.ok) {
                    return resp.text().then(function(body) {
                        var msg = 'API error ' + resp.status;
                        try { var p = JSON.parse(body); if (p.error && p.error.message) msg = p.error.message; } catch(e) { if (body && body.length < 200) msg = body; }
                        if (attempt < maxAttempts) { setTimeout(function() { post(attempt + 1).then(res).catch(rej); }, attempt * 1000); return; }
                        rej(new Error(msg));
                    }).catch(function() { if (attempt < maxAttempts) { setTimeout(function() { post(attempt + 1).then(res).catch(rej); }, attempt * 1000); return; } rej(new Error('API error ' + resp.status)); });
                }
                return resp.json().then(res).catch(rej);
            }).catch(function(err) {
                if (attempt < maxAttempts) { setTimeout(function() { post(attempt + 1).then(res).catch(rej); }, attempt * 1000); return; }
                rej(err);
            });
        });
    }

    post(1).then(function(data) {
        var text = (data && data.text) ? data.text.trim() : '';
        if (!text) { self._showTranscribeStatus('ℹ️ No speech detected in region', 'info'); try { self._transcribeBtn.disabled = false; } catch(e) {} return; }
        self._showTranscribeStatus('🔄 Editing transcription...', 'progress');
        self._editTranscription(text).then(function(edited) {
            var final = (edited && edited.toString().trim()) || text;
            self._applyTranscription(final);
            self._showTranscribeStatus('✅ Transcribed & edited (' + final.split(/\s+/).length + ' words)', 'success');
            try { self._transcribeBtn.disabled = false; } catch(e) {}
            setTimeout(function() { try { if (self._transcribeStatus && self._transcribeStatus.textContent.indexOf('✅') === 0) self._transcribeStatus.style.display = 'none'; } catch(e) {} }, 3000);
        }).catch(function() {
            try { self._applyTranscription(text); } catch(e) {}
            self._showTranscribeStatus('✅ Transcribed (edit failed)', 'success');
            try { self._transcribeBtn.disabled = false; } catch(e) {}
        });
    }).catch(function(err) {
        self._showTranscribeStatus('❌ ' + (err.message || 'Transcription failed'), 'error');
        try { self._transcribeBtn.disabled = false; } catch(e) {}
    });
};

/* ═══════════════════════════════════════════════════════════════
   PERSISTENCE
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype._persistTimes = function() {
    if (!this.attrTiddler) return;
    try {
        var existing = this.wiki.getTiddler(this.attrTiddler) || null;
        var startRoundedNum = Math.round(Number(this.attrStartTime) || 0);
        var endRoundedNum   = Math.round(Number(this.attrEndTime) || 0);
        var fields = Object.assign({}, (existing && existing.fields) ? existing.fields : {});
        fields.title = this.attrTiddler;
        fields["start-seconds"] = String(startRoundedNum);
        fields["end-seconds"]   = String(endRoundedNum);
        fields["start-timecode"] = utils.formatTime(startRoundedNum);
        fields["end-timecode"]   = utils.formatTime(endRoundedNum);
        this._lastPersistTime = Date.now();
        // Sync in-memory to rounded values
        this.attrStartTime = startRoundedNum;
        this.attrEndTime   = endRoundedNum;
        this.wiki.addTiddler(new $tw.Tiddler(existing || null, fields));
    } catch(e) { console.warn('[waveform-editor] persist failed', e); }
};

WaveformEditor.prototype._debouncedPersist = function() {
    var self = this;
    if (this._persistDebounceTimer) clearTimeout(this._persistDebounceTimer);
    this._persistDebounceTimer = setTimeout(function() {
        self._persistDebounceTimer = null;
        try { self._persistTimes(); } catch(e) {}
    }, 300);
};

/* ═══════════════════════════════════════════════════════════════
   TW LIFECYCLE: refresh & removeChildDomNodes
   ═══════════════════════════════════════════════════════════════ */

WaveformEditor.prototype.refresh = function(changedTiddlers) {
    var changedAttributes = this.computeAttributes();

    var newAudio   = this.getAttribute("audio-source", "");
    var newStart   = this.getAttribute("startTime", "0");
    var newEnd     = this.getAttribute("endTime", "0");
    var newTiddler = this.getAttribute("tiddler", "");

    // If debounce timer pending, we have fresher in-memory state → just redraw
    if (this._persistDebounceTimer) { try { this._draw(); } catch(e) {} return true; }

    // If we recently persisted, accept new values (they're ours) and redraw
    if (this._lastPersistTime && (Date.now() - this._lastPersistTime) < 1000) {
        this.attrStartTime = Number(newStart) || 0;
        this.attrEndTime   = Number(newEnd) || 0;
        try { this._draw(); } catch(e) {}
        return true;
    }

    // Audio source or tiddler identity changed → full re-render
    if (newAudio !== this.attrAudioSource || newTiddler !== this.attrTiddler) {
        this.refreshSelf();
        return true;
    }

    // Only start/end changed → update in-memory and redraw
    var ns = Number(newStart) || 0;
    var ne = Number(newEnd) || 0;
    if (ns !== this.attrStartTime || ne !== this.attrEndTime) {
        this.attrStartTime = ns;
        this.attrEndTime   = ne;
        try { this._draw(); } catch(e) {}
        return true;
    }

    return false;
};

WaveformEditor.prototype.removeChildDomNodes = function() {
    this._isDestroyed = true;

    // Stop meta audio elements
    try { if (this._metaAudio) { try { this._metaAudio.pause(); } catch(e){} try { this._metaAudio.removeAttribute('src'); this._metaAudio.load(); } catch(e){} this._metaAudio = null; } } catch(e) {}
    try { if (this._metaFallbackAudio) { try { this._metaFallbackAudio.pause(); } catch(e){} try { this._metaFallbackAudio.removeAttribute('src'); this._metaFallbackAudio.load(); } catch(e){} this._metaFallbackAudio = null; } } catch(e) {}

    // Remove canvas listeners
    try {
        if (this.canvas && this._bound) {
            if (this._bound.onPointerDown) {
                this.canvas.removeEventListener('pointerdown', this._bound.onPointerDown, false);
                this.canvas.removeEventListener('mousedown', this._bound.onPointerDown, false);
            }
            if (this._bound.onHoverMove) {
                this.canvas.removeEventListener('pointermove', this._bound.onHoverMove, false);
                this.canvas.removeEventListener('mousemove', this._bound.onHoverMove, false);
            }
            if (this._bound.onPointerLeave) {
                this.canvas.removeEventListener('pointerleave', this._bound.onPointerLeave, false);
                this.canvas.removeEventListener('mouseleave', this._bound.onPointerLeave, false);
            }
            if (this._bound.onKeyDown) this.canvas.removeEventListener('keydown', this._bound.onKeyDown, false);
        }
        if (this._bound && this._bound.onPointerMove) {
            document.removeEventListener('pointermove', this._bound.onPointerMove, false);
            document.removeEventListener('mousemove', this._bound.onPointerMove, false);
        }
        if (this._bound && this._bound.onPointerUp) {
            document.removeEventListener('pointerup', this._bound.onPointerUp, false);
            document.removeEventListener('mouseup', this._bound.onPointerUp, false);
        }
        if (this._bound && this._bound.onResize) window.removeEventListener('resize', this._bound.onResize, false);
    } catch(e) {}

    // Flush pending persist
    try { if (this._persistDebounceTimer) { clearTimeout(this._persistDebounceTimer); this._persistDebounceTimer = null; try { this._persistTimes(); } catch(e){} } } catch(e) {}

    // Stop playback
    try { this._stopRegion(); } catch(e) {}
    try { this._stopListenMode(false); } catch(e) {}

    // Cleanup scrub audio
    try {
        if (this._scrubSyncInterval) { clearInterval(this._scrubSyncInterval); this._scrubSyncInterval = null; }
        if (this._scrubMetaHandler && this._scrubAudio) { try { this._scrubAudio.removeEventListener('loadedmetadata', this._scrubMetaHandler, false); } catch(e) {} this._scrubMetaHandler = null; }
        if (this._scrubAudio) { try { this._scrubAudio.pause(); } catch(e){} try { this._scrubAudio.removeAttribute('src'); this._scrubAudio.load(); } catch(e){} this._scrubAudio = null; }
    } catch(e) {}

    // Cleanup listen audio
    try { if (this._listenAudio) { try { this._listenAudio.pause(); } catch(e){} try { this._listenAudio.removeAttribute('src'); this._listenAudio.load(); } catch(e){} this._listenAudio = null; } } catch(e) {}

    // Cancel animation frames
    try { if (this._autoPanRAF) { cancelAnimationFrame(this._autoPanRAF); this._autoPanRAF = null; } } catch(e) {}
    try { if (this._regionPlayheadRAF) { cancelAnimationFrame(this._regionPlayheadRAF); this._regionPlayheadRAF = null; } } catch(e) {}
    try { if (this._listenRAF) { cancelAnimationFrame(this._listenRAF); this._listenRAF = null; } } catch(e) {}

    // Cleanup tooltip
    try { if (this._tooltip && this._tooltip.parentNode) this._tooltip.parentNode.removeChild(this._tooltip); } catch(e) {}
    // Cleanup minimap
    try { if (this._minimap && this._minimap.parentNode) this._minimap.parentNode.removeChild(this._minimap); this._minimap = null; } catch(e) {}

    // Clear DOM refs
    this.canvas = null; this._readout = null; this._zoomBtn = null; this._fullBtn = null; this._playBtn = null;
    this._loopBtn = null; this._ampSlider = null; this._transcribeBtn = null; this._transcribeStatus = null;
    this._setStartBtn = null; this._setEndBtn = null; this._preRollBtn = null; this._postRollBtn = null;
    this._snapBtn = null; this._toolbar = null; this._tooltip = null; this._loadingIndicator = null;
    this._bound = Object.create(null);
    this._resolvedSrc = null; this._audioBuffer = null;

    Widget.prototype.removeChildDomNodes.call(this);
};

/* ═══════════════════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════════════════ */

exports['waveform-editor'] = WaveformEditor;

})();
