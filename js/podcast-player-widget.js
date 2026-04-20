/* Changelog:
    - Persistent audio service refactor (Mar 2026):
        - Audio playback now survives $:/layout switches via singleton audio-service.js
        - Widget is a thin UI shell; all audio-owning logic lives in the service
        - removeChildDomNodes() no longer pauses or destroys the <audio> element
    - Added persistent playback position feature.
        - Saves position to tiddler field `audio-track-position` on pause, periodically while playing,
            and on page unload.
        - Restores position on track load (after metadata loads).
        - Clears saved position on track ended.
        - Configurable via widget attributes `persistPosition` (yes|no) and `saveInterval` (seconds, min 2).
    - Cleanup: removes beforeunload handler and interval timers on widget teardown.
    - Capture workflow overhaul (Feb 2026):
        - Tap vs Hold quick capture and range capture
        - Auto-pause on capture and rewind-on-resume
        - Keyboard shortcuts and quick-tag preset buttons
        - Emits and listens to notation-editor-closed for auto-resume coordination
*/
/*\
title: $:/plugins/NoteStreams/AudioSuite/js/podcast-player-widget.js
type: application/javascript
module-type: widget
\*/
(function(){
"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var utils = require("$:/plugins/NoteStreams/AudioSuite/js/audio-utils.js");

function PodcastPlayerWidget(parseTreeNode,options){
    this.initialise(parseTreeNode,options);
}

PodcastPlayerWidget.prototype = new Widget();

PodcastPlayerWidget.prototype.initialise = function(parseTreeNode,options){
    Widget.prototype.initialise.call(this,parseTreeNode,options);
};

PodcastPlayerWidget.prototype.execute = function(){
    this.attrFilter = this.getAttribute("filter", "");
    this.attrFilterProvided = !!this.attrFilter;
    if (!this.attrFilterProvided && this._userFilter) {
        this.attrFilter = this._userFilter;
    }
    this.attrSrcField = this.getAttribute("srcField", "");
    this.attrDebug = this.getAttribute("debug", "");
    this.attrClass = this.getAttribute("class",""
);
    // Persistent playback position attributes
    this.attrPersistPosition = this.getAttribute("persistPosition","yes");
    this.attrSaveInterval = Number(this.getAttribute("saveInterval","5")) || 5;
    // Capture workflow attributes
    this.attrAutoPause = this.getAttribute("autoPause","yes");
    this.attrRewindOnResume = Math.max(0, Number(this.getAttribute("rewindOnResume","3")) || 0);
    this.attrEnableShortcuts = this.getAttribute("enableShortcuts","yes");
    this.attrQuickTags = this.getAttribute("quickTags","$:/plugins/NoteStreams/AudioSuite/quickTagPresets");
    // Audiobook mode attributes
    this.attrMode = this.getAttribute("mode", "podcast");
    this.attrBookTiddler = this.getAttribute("bookTiddler", "");
    // Set currentTiddler variable for child widgets to pick up context
    this.setVariable("currentTiddler", this._currentTrack || '');
    this.setVariable("bookTiddler", this.attrBookTiddler || '');
    this.makeChildWidgets();
};

PodcastPlayerWidget.prototype.render = function(parent,nextSibling){
    var self = this;
    this.parentDomNode = parent;
    // Ensure attributes are computed (computeAttributes + execute must run before render)
    this.computeAttributes();
    this.execute();

    // If no filter attribute was provided and the user has not yet entered one, render filter-entry UI
    if (!this.attrFilterProvided && !this._userFilter) {
        var filterContainer = document.createElement('div');
        filterContainer.className = 'AudioSuite-player AudioSuite-player--no-filter ' + (this.attrClass || '');

        var filterLabel = document.createElement('label');
        filterLabel.className = 'AudioSuite-player__filter-label';
        filterLabel.textContent = 'No filter specified. Enter a TiddlyWiki filter to load audio tracks:';
        filterContainer.appendChild(filterLabel);

        var filterRow = document.createElement('div');
        filterRow.className = 'AudioSuite-player__filter-row';
        filterRow.style.cssText = 'display:flex; gap:0.5em; margin-top:0.5em';

        var filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.className = 'AudioSuite-player__filter-input';
        filterInput.placeholder = 'e.g. [type[audio/mpeg]] or [[My Track.mp3]]';
        filterInput.style.flex = '1';
        filterRow.appendChild(filterInput);

        var filterApplyBtn = document.createElement('button');
        filterApplyBtn.textContent = 'Load';
        filterApplyBtn.className = 'AudioSuite-player__filter-apply';
        filterRow.appendChild(filterApplyBtn);

        filterContainer.appendChild(filterRow);

        var filterPreview = document.createElement('div');
        filterPreview.className = 'AudioSuite-player__filter-preview';
        filterPreview.style.cssText = 'margin-top:0.5em; font-size:0.85em; color:#666';
        filterContainer.appendChild(filterPreview);

        filterInput.addEventListener('input', function(){
            var val = filterInput.value.trim();
            if (!val) { filterPreview.textContent = ''; return; }
            try {
                var results = self.wiki.filterTiddlers(val, self);
                if (!results || results.length === 0) {
                    filterPreview.textContent = 'No matching tiddlers found.';
                } else {
                    var preview = results.slice(0, 10);
                    filterPreview.textContent = results.length + ' match' + (results.length === 1 ? '' : 'es') + ': ' + preview.join(', ') + (results.length > 10 ? ', …' : '');
                }
            } catch(e) {
                filterPreview.textContent = 'Invalid filter syntax.';
            }
        }, false);

        function applyFilter() {
            var val = filterInput.value.trim();
            if (!val) return;
            self._userFilter = val;
            self.refreshSelf();
        }

        filterApplyBtn.addEventListener('click', applyFilter, false);
        filterInput.addEventListener('keydown', function(ev){
            if (ev.key === 'Enter') { ev.preventDefault(); applyFilter(); }
        }, false);

        parent.insertBefore(filterContainer, nextSibling);
        this.domNodes = this.domNodes || [];
        this.domNodes.push(filterContainer);
        return;
    }

    // playlist — attrFilter is guaranteed to be populated at this point
    var playlistFilterRaw = this.attrFilter;
    var playlist = [];
    // Fast-path: if the filter is exactly "[<currentTiddler>]" then treat it
    // as a request for the single tiddler title without invoking the filter
    // parser (which can error on bare title constructs). This keeps it safe
    // for titles containing spaces or special chars.
    if (String(playlistFilterRaw).trim() === '[<currentTiddler>]') {
        var currentToken = this.getVariable('currentTiddler') || this._currentTrack || '';
        if (currentToken) playlist = [currentToken];
    } else {
        // Let the TiddlyWiki filter engine resolve <currentTiddler> and any
        // other widget variables natively. Passing `this` (the widget) as the
        // second argument provides the variable context. This avoids the bug
        // where manual string replacement of <currentTiddler> consumed angle
        // brackets and produced invalid filter syntax for titles containing
        // spaces or special characters.
        playlist = this.wiki.filterTiddlers(playlistFilterRaw, this) || [];
    }
    // Virtual track support: find data-dictionary tiddlers tagged with the book tiddler
    var virtualTrackMap = {};
    if (self.attrMode === 'audiobook' && self.attrBookTiddler) {
        try {
            var allDictTitles = self.wiki.filterTiddlers(
                '[type[application/x-tiddler-dictionary]]', self
            ) || [];
            allDictTitles.forEach(function(dictTitle) {
                var dictTiddler = self.wiki.getTiddler(dictTitle);
                if (!dictTiddler || !dictTiddler.fields || !dictTiddler.fields.tags) return;
                var tags = $tw.utils.parseStringArray(dictTiddler.fields.tags) || [];
                if (tags.indexOf(self.attrBookTiddler) === -1) return;
                var data = self.wiki.getTiddlerDataCached(dictTitle, {});
                if (!data) return;
                Object.keys(data).sort().forEach(function(trackTitle) {
                    // Always record the URI so loadTrack can resolve virtual tracks
                    virtualTrackMap[trackTitle] = data[trackTitle];
                    // Only add to playlist if not already present
                    // (real tiddlers take priority over virtual entries)
                    if (playlist.indexOf(trackTitle) === -1) {
                        playlist.push(trackTitle);
                    }
                });
            });
        } catch(e) {
            console.warn('PodcastPlayer: virtual track scanning failed', e);
        }
    }
    self._virtualTrackMap = virtualTrackMap;
    console.log('PodcastPlayer: render playlist', playlistFilterRaw, playlist,
        'virtual tracks:', Object.keys(virtualTrackMap).length);

    // Get the singleton audio service
    var service = $tw.AudioSuite && $tw.AudioSuite.service;
    if (!service) {
        console.error('PodcastPlayer: AudioSuite service not available');
        return;
    }

    var container = document.createElement('div');
    container.className = 'AudioSuite-player ' + (this.attrClass || '');

    // select
    var select = document.createElement('select');
    select.className = 'AudioSuite-player__select';
    playlist.forEach(function(title){
        var opt = document.createElement('option');
        opt.value = title;
        // Prefer caption field for display, fall back to title
        var displayName = title;
        try {
            var t = self.wiki.getTiddler(title);
            if (t && t.fields && t.fields.caption) {
                displayName = t.fields.caption;
            }
        } catch(e) {}
        opt.textContent = displayName;
        select.appendChild(opt);
    });
    container.appendChild(select);

    // transport
    var transport = document.createElement('div');
    transport.className = 'AudioSuite-player__transport';

    var playBtn = document.createElement('button');
    playBtn.textContent = '▶️';
    playBtn.className = 'AudioSuite-btn AudioSuite-player__play';
    transport.appendChild(playBtn);

    var rewindBtn = document.createElement('button');
    rewindBtn.textContent = '⏪ −10s';
    rewindBtn.className = 'AudioSuite-btn';
    transport.appendChild(rewindBtn);

    var forwardBtn = document.createElement('button');
    forwardBtn.textContent = '⏩ +10s';
    forwardBtn.className = 'AudioSuite-btn';
    transport.appendChild(forwardBtn);

    var rateSel = document.createElement('select');
    rateSel.className = 'AudioSuite-player__rate';
    var rates = [0.5,0.75,1,1.25,1.5,2];
    rates.forEach(function(r){
        var o = document.createElement('option');
        o.value = r;
        o.textContent = r + '×';
        if(r === 1) o.selected = true;
        rateSel.appendChild(o);
    });
    transport.appendChild(rateSel);
    // Chapter navigation buttons (audiobook mode only)
    var prevChapterBtn = null;
    var nextChapterBtn = null;
    if (self.attrMode === 'audiobook') {
        prevChapterBtn = document.createElement('button');
        prevChapterBtn.textContent = '⏮ Prev';
        prevChapterBtn.className = 'AudioSuite-btn AudioSuite-player__prev-chapter';
        prevChapterBtn.title = 'Previous chapter';
        transport.insertBefore(prevChapterBtn, playBtn);

        nextChapterBtn = document.createElement('button');
        nextChapterBtn.textContent = 'Next ⏭';
        nextChapterBtn.className = 'AudioSuite-btn AudioSuite-player__next-chapter';
        nextChapterBtn.title = 'Next chapter';
        transport.appendChild(nextChapterBtn);
    }
    container.appendChild(transport);

    // Back button row — separate line below the transport so it doesn't crowd the controls
    var backBtn = document.createElement('button');
    backBtn.textContent = '\u2190 Back';
    backBtn.className = 'AudioSuite-btn AudioSuite-player__back-btn';
    backBtn.style.display = 'none';
    var backRow = document.createElement('div');
    backRow.className = 'AudioSuite-player__back-row';
    backRow.appendChild(backBtn);
    container.appendChild(backRow);

    // seek row
    var seekRow = document.createElement('div');
    seekRow.className = 'AudioSuite-player__seek-row';

    var timeSpan = document.createElement('span');
    timeSpan.className = 'AudioSuite-player__time';
    timeSpan.textContent = '00:00 / 00:00';
    seekRow.appendChild(timeSpan);

    var seekbar = document.createElement('input');
    seekbar.type = 'range';
    seekbar.className = 'AudioSuite-player__seekbar';
    seekbar.min = 0;
    seekbar.max = 100;
    seekbar.value = 0;
    seekRow.appendChild(seekbar);

    container.appendChild(seekRow);

    // ── Playlist progress row (only for multi-track playlists) ────────────
    var progressSpan = null;
    if (playlist.length > 1) {
        var progressRow = document.createElement('div');
        progressRow.className = 'AudioSuite-player__progress-row';
        progressSpan = document.createElement('span');
        progressSpan.className = 'AudioSuite-player__playlist-progress';
        progressSpan.style.cssText = 'font-size:0.85em; color:var(--palette-muted, #666); margin-top:0.25em;';
        progressRow.appendChild(progressSpan);
        container.appendChild(progressRow);
    }

    // Helper: compute weighted progress across all playlist tracks
    function computeWeightedProgress() {
        try {
            var current = service.getCurrentTrack();
            var currentIdx = playlist.indexOf(current);
            var sumFractions = 0;
            for (var i = 0; i < playlist.length; i++) {
                var trackTitle = playlist[i];
                if (trackTitle === current) {
                    // Currently loaded track — use live time/duration
                    var dur = service.getDuration();
                    if (dur > 0) {
                        sumFractions += Math.min(1, Math.max(0, service.getCurrentTime() / dur));
                    }
                } else if (currentIdx >= 0 && i < currentIdx) {
                    // Track before current — assume completed in sequential listening.
                    // Note: clearPosition() removes the saved position on track end, but
                    // loadTrack()'s initial savePosition() call can re-save it, so we
                    // cannot rely on savedPos === 0 to detect completion. Treating all
                    // preceding tracks as done is the correct heuristic for audiobooks.
                    sumFractions += 1.0;
                } else {
                    // Track after current — check for a saved position (e.g. user
                    // skipped ahead, partially listened, then jumped back)
                    var savedPos = service.getTrackSavedPosition(trackTitle);
                    if (savedPos > 0) {
                        sumFractions += 0.5;
                    }
                    // else: no saved position — unlistened (0.0)
                }
            }
            var percent = (sumFractions / playlist.length) * 100;
            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;
            return { percent: percent, currentTrackIndex: currentIdx, totalTracks: playlist.length };
        } catch(e) {
            console.warn('PodcastPlayer: computeWeightedProgress failed', e);
            return { percent: 0, currentTrackIndex: -1, totalTracks: playlist.length };
        }
    }

    // Helper: update the progress display span
    function updateProgressDisplay() {
        try {
            if (!progressSpan || playlist.length <= 1) return;
            var prog = computeWeightedProgress();
            progressSpan.textContent = 'Overall: ' + prog.percent.toFixed(1) + '% (Track ' + (prog.currentTrackIndex + 1) + ' of ' + prog.totalTracks + ')';
        } catch(e) {
            console.warn('PodcastPlayer: updateProgressDisplay failed', e);
        }
    }

    // capture area: main capture button, quick-tag presets, and shortcut hint
    var capture = document.createElement('div');
    capture.className = 'AudioSuite-player__capture';

    var captureRow = document.createElement('div');
    captureRow.className = 'AudioSuite-player__capture-row';

    var captureBtn = document.createElement('button');
    captureBtn.textContent = '📝 Capture Note';
    captureBtn.className = 'AudioSuite-btn AudioSuite-player__capture-btn';
    captureRow.appendChild(captureBtn);

    var captureHint = document.createElement('span');
    captureHint.className = 'AudioSuite-player__capture-hint';
    captureHint.textContent = 'tap to mark · hold for range';
    captureRow.appendChild(captureHint);

    capture.appendChild(captureRow);

    // shortcut hint (shown only if shortcuts enabled)
    var shortcutHint = document.createElement('div');
    shortcutHint.className = 'AudioSuite-player__shortcut-hint';
    shortcutHint.textContent = 'N: capture · Space: play/pause · B: back to prev track';
    shortcutHint.style.display = 'none';

    capture.appendChild(shortcutHint);

    container.appendChild(capture);

    // status/debug area removed (debugging completed)

    parent.insertBefore(container, nextSibling);
    // track DOM for proper refresh / cleanup
    this.domNodes = this.domNodes || [];
    this.domNodes.push(container);

    // store refs
    this._elements = {
        container: container,
        select: select,
        playBtn: playBtn,
        rewindBtn: rewindBtn,
        forwardBtn: forwardBtn,
        rateSel: rateSel,
        timeSpan: timeSpan,
        seekbar: seekbar,
        captureBtn: captureBtn,
        shortcutHint: shortcutHint,
        prevChapterBtn: prevChapterBtn,
        nextChapterBtn: nextChapterBtn,
        progressSpan: progressSpan
    };

    // ── Configure the singleton service with this widget's attributes ─────
    service.configure({
        persistPosition: self.attrPersistPosition === 'yes',
        saveInterval: Math.max(2, Number(self.attrSaveInterval) || 5),
        autoPause: self.attrAutoPause === 'yes',
        rewindOnResume: self.attrRewindOnResume,
        mode: self.attrMode,
        bookTiddler: self.attrBookTiddler,
        srcField: self.attrSrcField
    });

    // Hand the playlist to the service
    service.setPlaylist(playlist, self._virtualTrackMap || {});

    // ── Subscribe to service events (UI updates) ──────────────────────────
    self._onTimeUpdate = function(data) {
        timeSpan.textContent = utils.formatTime(Math.floor(data.currentTime)) + ' / ' + utils.formatTime(Math.floor(data.duration));
        if (data.duration > 0) {
            var val = (data.currentTime / data.duration) * 100;
            seekbar.value = isFinite(val) ? val : 0;
        }
        try { updateProgressDisplay(); } catch(e) {}
    };
    service.on('service:timeupdate', self._onTimeUpdate);

    self._onTrackChanged = function(data) {
        select.value = data.track;
        self._currentTrack = data.track;
        self._refreshChildWidgets();
        updateBackButton();
        try { updateProgressDisplay(); } catch(e) {}
    };
    service.on('service:trackchanged', self._onTrackChanged);

    self._onStateChange = function(data) {
        playBtn.textContent = data.playing ? '⏸️' : '▶️';
    };
    service.on('service:statechange', self._onStateChange);

    self._onEnded = function() {
        // The service handles auto-advance internally; just update the play button
        playBtn.textContent = '▶️';
        try { updateProgressDisplay(); } catch(e) {}
    };
    service.on('service:ended', self._onEnded);

    // ── Track navigation history helpers (delegate to service) ────────────
    var MAX_HISTORY = 20;
    self._trackHistory = []; // kept for _refreshChildWidgets variable

    // Helper: update back button visibility and label
    function updateBackButton() {
        try {
            var len = service.getHistoryLength();
            if (len > 0) {
                // Peek at history — popHistory would consume it, so use a temp approach
                // We just show "Back" generically since the service owns the stack
                backBtn.style.display = '';
            } else {
                backBtn.style.display = 'none';
            }
        } catch (e) { console.warn('PodcastPlayer: updateBackButton failed', e); }
    }

    // ── Button handlers — delegate to service ─────────────────────────────
    select.addEventListener('change', function(){
        var t = select.value;
        service.pushHistory('manual');
        service.loadTrack(t);
        self._currentTrack = t;
        self._refreshChildWidgets();
        updateBackButton();
    }, false);

    playBtn.addEventListener('click', function(){
        service.toggle();
    }, false);

    rewindBtn.addEventListener('click', function(){
        service.skip(-10);
    }, false);

    forwardBtn.addEventListener('click', function(){
        service.skip(10);
    }, false);

    // Chapter navigation (audiobook mode)
    if (prevChapterBtn) {
        prevChapterBtn.addEventListener('click', function(){
            var curIdx = playlist.indexOf(service.getCurrentTrack());
            if (curIdx > 0) {
                var prevTitle = playlist[curIdx - 1];
                service.pushHistory('chapter-nav');
                service.loadTrack(prevTitle);
                self._currentTrack = prevTitle;
                select.value = prevTitle;
                self._refreshChildWidgets();
                updateBackButton();
            }
        }, false);
    }
    if (nextChapterBtn) {
        nextChapterBtn.addEventListener('click', function(){
            var curIdx = playlist.indexOf(service.getCurrentTrack());
            if (curIdx >= 0 && curIdx < playlist.length - 1) {
                var nextTitle = playlist[curIdx + 1];
                service.pushHistory('chapter-nav');
                service.loadTrack(nextTitle);
                self._currentTrack = nextTitle;
                select.value = nextTitle;
                self._refreshChildWidgets();
                updateBackButton();
            }
        }, false);
    }

    rateSel.addEventListener('change', function(){
        service.setPlaybackRate(Number(rateSel.value) || 1);
    }, false);

    seekbar.addEventListener('input', function(){
        var pct = Number(seekbar.value) || 0;
        var dur = service.getDuration();
        if (dur > 0) service.seek((pct / 100) * dur);
    }, false);

    // ── Capture workflow ──────────────────────────────────────────────────
    this._capturing = false;
    var origCaptureText = captureBtn.textContent;
    var TAP_THRESHOLD_MS = 300;
    var captureTimerId = null;
    var isRangeCapture = false;
    var captureDownTime = 0;

    // Helper: centralised emit for capture events with UI & auto-pause behavior
    function emitCapture(startSec, endSec, skipEditor, userTags) {
        try {
            if (!service.getCurrentTrack()) return;

            // Cancel any pending quick-tag auto-resume
            try { if (self._quickTagResumeTimer) { clearTimeout(self._quickTagResumeTimer); self._quickTagResumeTimer = null; } } catch(e){}

            var track = select.value || '';
            var srcField = self.attrSrcField || '';
            var audioSrc = service.getCurrentSrc() || '';
            var audioPointer = service.getCurrentPointer() || '';
            var vtMap = service.getVirtualTrackMap();

            // Compute tentative notation tiddler title
            var captureTitle = '';
            try { captureTitle = utils.generateNotationTitle(self.wiki, track || '', startSec, endSec); } catch(e){}

            // Auto-pause if requested and audio was playing
            var wasPlaying = false;
            try {
                if (String(self.attrAutoPause || 'yes').toLowerCase() === 'yes' && service.isPlaying()) {
                    wasPlaying = true;
                    service.setWasPlayingBeforeCapture(true);
                    service.setLastPausedCaptureTitle(captureTitle);
                    service.pause();
                }
            } catch(e){ console.warn('PodcastPlayer: autoPause handling failed', e); }

            // Visual feedback
            var label = (startSec === endSec)
                ? '✓ Captured at ' + utils.formatTime(startSec)
                : '✓ Captured ' + utils.formatTimeRange(startSec, endSec);
            try {
                captureBtn.textContent = label;
                captureBtn.classList.add('AudioSuite-captured');
            } catch(e){}
            (function(orig){
                setTimeout(function(){ try{ captureBtn.textContent = orig; captureBtn.classList.remove('AudioSuite-captured'); }catch(e){} }, 1500);
            })(origCaptureText);

            // Emit the capture event
            var payload = {
                startTimecode: utils.formatTime(startSec),
                endTimecode: utils.formatTime(endSec),
                startSeconds: startSec,
                endSeconds: endSec,
                note: '',
                track: track,
                srcField: srcField,
                audioSrc: audioSrc,
                audioPointer: audioPointer,
                skipEditor: !!skipEditor,
                isVirtual: !!(vtMap && vtMap[track]),
                virtualUri: (vtMap && vtMap[track]) ? vtMap[track] : '',
                bookTiddler: self.attrBookTiddler || ''
            };
            if (userTags) payload.userTags = userTags;
            if (captureTitle) payload.captureTitle = captureTitle;
            try { utils.emit('AudioSuite:timecode-captured', payload); } catch(e){ console.warn('PodcastPlayer: emit capture failed', e); }

            // If this was a quick-tag capture (skipEditor true), schedule an auto-resume
            if (skipEditor && wasPlaying && String(self.attrAutoPause || 'yes').toLowerCase() === 'yes') {
                try {
                    if (self._quickTagResumeTimer) { clearTimeout(self._quickTagResumeTimer); }
                    self._quickTagResumeTimer = setTimeout(function(){
                        try {
                            self._quickTagResumeTimer = null;
                            if (self.attrRewindOnResume > 0) {
                                service.skip(-self.attrRewindOnResume);
                            }
                            service.play().catch(function(){});
                        } catch(e){}
                    }, 400);
                } catch(e){}
            }
        } catch(e){ console.warn('PodcastPlayer: emitCapture failed', e); }
    }

    // Tap vs Hold handlers
    var captureDownHandler = function(ev){
        try{ ev.preventDefault(); } catch(e){}
        if(!service.getCurrentTrack()) return;
        captureDownTime = Date.now();
        isRangeCapture = false;
        self._captureStartSeconds = Math.floor(service.getCurrentTime());
        try {
            if (captureTimerId) { clearTimeout(captureTimerId); captureTimerId = null; }
            captureTimerId = setTimeout(function(){
                isRangeCapture = true;
                self._capturing = true;
                try{ captureBtn.classList.add('AudioSuite-capturing'); captureBtn.textContent = '🔴 Recording...'; } catch(e){}
            }, TAP_THRESHOLD_MS);
            try { self._captureThresholdTimer = captureTimerId; } catch(e){}
        } catch(e){}
    };
    var captureUpHandler = function(ev){
        try{ ev.preventDefault(); } catch(e){}
        try{ if (captureTimerId) { clearTimeout(captureTimerId); captureTimerId = null; self._captureThresholdTimer = null; } } catch(e){}
        if(!service.getCurrentTrack()) return;
        var endSeconds = Math.floor(service.getCurrentTime());
        if (isRangeCapture) {
            self._capturing = false;
            self._captureEndSeconds = endSeconds;
            try{ captureBtn.classList.remove('AudioSuite-capturing'); } catch(e){}
            emitCapture(self._captureStartSeconds, self._captureEndSeconds, false);
        } else {
            emitCapture(self._captureStartSeconds, self._captureStartSeconds, false);
        }
        isRangeCapture = false;
    };
    var captureLeaveHandler = function(ev){
        try{ if (self._capturing) captureUpHandler(ev || {}); } catch(e){}
    };
    var supportsPointer = (typeof window !== 'undefined' && window.PointerEvent);
    // Click fallback for some mobile browsers where touchend/pointerup may not fire
    var lastCaptureEmit = 0;
    var captureClickHandler = function(ev){
        try{
            var now = Date.now();
            // Prevent duplicate emits (if pointer/touch already emitted)
            if (now - lastCaptureEmit < 500) return;
            // If we're in the middle of range capture, ignore click
            if (self._capturing) return;
            // If there's no current track, ignore
            if(!service.getCurrentTrack()) return;
            ev.preventDefault();
            var start = Math.floor(service.getCurrentTime());
            emitCapture(start, start, false);
            lastCaptureEmit = now;
        } catch(e){}
    };
    if (supportsPointer) {
        captureBtn.addEventListener('pointerdown', captureDownHandler, false);
        captureBtn.addEventListener('pointerup', captureUpHandler, false);
        captureBtn.addEventListener('pointerleave', captureLeaveHandler, false);
        captureBtn.addEventListener('click', captureClickHandler, false);
        this._captureHandlers = { startHandler: captureDownHandler, endHandler: captureUpHandler, leaveHandler: captureLeaveHandler, clickHandler: captureClickHandler, pointer: true };
    } else {
        captureBtn.addEventListener('mousedown', captureDownHandler, false);
        captureBtn.addEventListener('touchstart', captureDownHandler, false);
        captureBtn.addEventListener('mouseup', captureUpHandler, false);
        captureBtn.addEventListener('touchend', captureUpHandler, false);
        captureBtn.addEventListener('mouseleave', captureLeaveHandler, false);
        captureBtn.addEventListener('click', captureClickHandler, false);
        this._captureHandlers = { startHandler: captureDownHandler, endHandler: captureUpHandler, leaveHandler: captureLeaveHandler, clickHandler: captureClickHandler, pointer: false };
    }

    // Show shortcut hint if enabled
    if (String(this.attrEnableShortcuts || 'yes').toLowerCase() === 'yes') {
        shortcutHint.style.display = '';
    }

    // ── Keyboard shortcuts ────────────────────────────────────────────────
    if (String(this.attrEnableShortcuts || 'yes').toLowerCase() === 'yes') {
        try { container.setAttribute('tabindex', '0'); } catch(e){}
        this._keydownHandler = function(ev){
            try {
                var tag = (ev.target && ev.target.tagName) ? String(ev.target.tagName).toLowerCase() : '';
                var isEditable = (tag === 'input' || tag === 'textarea' || tag === 'select' || (ev.target && ev.target.isContentEditable));
                try { if (!isEditable && ev.target && typeof ev.target.closest === 'function') { if (ev.target.closest('.AudioSuite-notation__entry-edit')) isEditable = true; } } catch(e){}
                if (isEditable) return;

                var key = ev.key;
                var code = ev.code;

                if (code === 'Space' || key === ' ') {
                    ev.preventDefault();
                    service.toggle();
                    return;
                }

                if ((key === 'n' || key === 'N') && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
                    ev.preventDefault();
                    var now = Math.floor(service.getCurrentTime());
                    emitCapture(now, now, false);
                    return;
                }

                if (key === 'ArrowLeft') {
                    ev.preventDefault();
                    var skip = ev.shiftKey ? 30 : 10;
                    service.skip(-skip);
                    return;
                }
                if (key === 'ArrowRight') {
                    ev.preventDefault();
                    var skipR = ev.shiftKey ? 30 : 10;
                    service.skip(skipR);
                    return;
                }

                if (key === '[') {
                    ev.preventDefault();
                    var rates = [0.5,0.75,1,1.25,1.5,2];
                    var currentRate = service.getPlaybackRate();
                    var currentIdx = rates.indexOf(Number(currentRate));
                    if (currentIdx > 0) { service.setPlaybackRate(rates[currentIdx-1]); rateSel.value = String(rates[currentIdx-1]); }
                    return;
                }
                if (key === ']') {
                    ev.preventDefault();
                    var rates2 = [0.5,0.75,1,1.25,1.5,2];
                    var currentRate2 = service.getPlaybackRate();
                    var currentIdx2 = rates2.indexOf(Number(currentRate2));
                    if (currentIdx2 < rates2.length - 1) { service.setPlaybackRate(rates2[currentIdx2+1]); rateSel.value = String(rates2[currentIdx2+1]); }
                    return;
                }

                if ((key === 'b' || key === 'B') && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
                    ev.preventDefault();
                    if (service.getHistoryLength() > 0) backBtn.click();
                    return;
                }
            } catch(e){ }
        };
        container.addEventListener('keydown', this._keydownHandler, false);
    }

    // save refs to cleanup
    this._playlist = playlist;
    this._select = select;
    this._backBtn = backBtn;

    // Back button click handler: pop history and navigate back
    backBtn.addEventListener('click', function() {
        try {
            var histEntry = service.navigateBack();
            if (!histEntry) return;
            select.value = histEntry.track;
            self._currentTrack = histEntry.track;
            self._refreshChildWidgets();
            updateBackButton();
        } catch (e) { console.warn('PodcastPlayer: back button handler failed', e); }
    }, false);

    // ── Sync UI to current service state ──────────────────────────────────
    // If the service was already playing from a previous layout, reconnect
    var existingTrack = service.getCurrentTrack();
    if (existingTrack && playlist.indexOf(existingTrack) !== -1) {
        select.value = existingTrack;
        self._currentTrack = existingTrack;
        playBtn.textContent = service.isPlaying() ? '⏸️' : '▶️';
        // Sync the rate selector
        try { rateSel.value = String(service.getPlaybackRate()); } catch(e) {}
        // Do NOT call loadTrack — audio is already playing
    } else if (playlist && playlist.length) {
        // Service has no track or a track not in this playlist — load initial
        var initialTrack = playlist[0];
        if (self.attrMode === 'audiobook' && self.attrBookTiddler) {
            try {
                var savedBt = self.wiki.getTiddler(self.attrBookTiddler);
                if (savedBt && savedBt.fields && savedBt.fields['audio-current-track']) {
                    var savedChapter = String(savedBt.fields['audio-current-track']);
                    if (playlist.indexOf(savedChapter) !== -1) initialTrack = savedChapter;
                }
            } catch(e) {}
        }
        select.value = initialTrack;
        service.loadTrack(initialTrack);
        self._currentTrack = initialTrack;
    }
    updateBackButton();

    // Create a container for child widgets (e.g., audio-notation)
    this._childContainer = document.createElement('div');
    this._childContainer.className = 'AudioSuite-player__children';
    container.appendChild(this._childContainer);

    // Render child widgets with currentTiddler already set
    this._refreshChildWidgets();
};

// Destroy and recreate child widgets with updated `currentTiddler`
PodcastPlayerWidget.prototype._refreshChildWidgets = function() {
    if(this.children && this.children.length) {
        for(var i = 0; i < this.children.length; i++) {
            try { this.children[i].removeChildDomNodes(); } catch(e) {}
        }
    }
    if(this._childContainer) {
        while(this._childContainer.firstChild) {
            this._childContainer.removeChild(this._childContainer.firstChild);
        }
    }
    this.children = [];
    this.setVariable("currentTiddler", this._currentTrack || '');
    this.setVariable("bookTiddler", this.attrBookTiddler || '');
    try { this.setVariable("playlistTitles", JSON.stringify(this._playlist || [])); } catch(e) { this.setVariable("playlistTitles", '[]'); }
    var service = $tw.AudioSuite && $tw.AudioSuite.service;
    try { this.setVariable("hasTrackHistory", (service && service.getHistoryLength() > 0) ? 'yes' : 'no'); } catch(e) { this.setVariable("hasTrackHistory", 'no'); }
    var vtMap = service ? service.getVirtualTrackMap() : {};
    this.setVariable("isVirtualTrack",
        (vtMap && this._currentTrack && vtMap[this._currentTrack])
            ? 'yes' : 'no'
    );
    this.makeChildWidgets(this.parseTreeNode.children);
    this.renderChildren(this._childContainer, null);
};

PodcastPlayerWidget.prototype.refresh = function(changedTiddlers){
    var newFilter = this.getAttribute('filter', '');
    var newSrcField = this.getAttribute('srcField','');
    var newPersist = this.getAttribute('persistPosition','yes');
    var newSaveInterval = Number(this.getAttribute('saveInterval','5')) || 5;
    var newAutoPause = this.getAttribute('autoPause','yes');
    var newRewindOnResume = Math.max(0, Number(this.getAttribute('rewindOnResume','3')) || 0);
    var newEnableShortcuts = this.getAttribute('enableShortcuts','yes');
    var newQuickTags = this.getAttribute('quickTags','$:/plugins/NoteStreams/AudioSuite/quickTagPresets');
    var newMode = this.getAttribute('mode', 'podcast');
    var newBookTiddler = this.getAttribute('bookTiddler', '');
    if(newFilter !== this.attrFilter || newSrcField !== this.attrSrcField || newPersist !== this.attrPersistPosition || newSaveInterval !== this.attrSaveInterval || newAutoPause !== this.attrAutoPause || newRewindOnResume !== this.attrRewindOnResume || newEnableShortcuts !== this.attrEnableShortcuts || newQuickTags !== this.attrQuickTags || newMode !== this.attrMode || newBookTiddler !== this.attrBookTiddler){
        return this.refreshSelf();
    }
    // Check if any source dictionaries changed (virtual track data updated)
    if (this.attrMode === 'audiobook' && this.attrBookTiddler && this._virtualTrackMap) {
        try {
            var dictTitles = this.wiki.filterTiddlers(
                '[type[application/x-tiddler-dictionary]]', this
            ) || [];
            for (var i = 0; i < dictTitles.length; i++) {
                if (changedTiddlers[dictTitles[i]]) {
                    return this.refreshSelf();
                }
            }
        } catch(e) {}
    }
    // Propagate refresh to child widgets (e.g., notation widget)
    return this.refreshChildren(changedTiddlers);
};

PodcastPlayerWidget.prototype.removeChildDomNodes = function(){
    // Recursively tear down child widgets
    if(this.children && this.children.length) {
        for(var i = 0; i < this.children.length; i++) {
            try { this.children[i].removeChildDomNodes(); } catch(e) {}
        }
    }
    // Unsubscribe from service events (UI-only)
    var service = $tw.AudioSuite && $tw.AudioSuite.service;
    if (service) {
        if (this._onTimeUpdate) service.off('service:timeupdate', this._onTimeUpdate);
        if (this._onTrackChanged) service.off('service:trackchanged', this._onTrackChanged);
        if (this._onStateChange) service.off('service:statechange', this._onStateChange);
        if (this._onEnded) service.off('service:ended', this._onEnded);
    }
    this._onTimeUpdate = null;
    this._onTrackChanged = null;
    this._onStateChange = null;
    this._onEnded = null;
    // Clear progress span reference
    try { if (this._elements) this._elements.progressSpan = null; } catch(e) {}
    // Detach keyboard handler
    try{ if (this._keydownHandler && this._elements && this._elements.container) { this._elements.container.removeEventListener('keydown', this._keydownHandler, false); this._keydownHandler = null; } } catch(e){}
    // Clear any pending quick-tag resume timer
    try{ if (this._quickTagResumeTimer) { clearTimeout(this._quickTagResumeTimer); this._quickTagResumeTimer = null; } } catch(e){}
    // Clear any pending capture threshold timer
    try{ if (this._captureThresholdTimer) { clearTimeout(this._captureThresholdTimer); this._captureThresholdTimer = null; } } catch(e){}
    // Detach capture button handlers
    try{
        if(this._elements && this._elements.captureBtn && this._captureHandlers){
            var cb = this._elements.captureBtn;
            if(this._captureHandlers.pointer){
                cb.removeEventListener('pointerdown', this._captureHandlers.startHandler, false);
                cb.removeEventListener('pointerup', this._captureHandlers.endHandler, false);
                cb.removeEventListener('pointerleave', this._captureHandlers.leaveHandler, false);
                if (this._captureHandlers.clickHandler) {
                    cb.removeEventListener('click', this._captureHandlers.clickHandler, false);
                }
            } else {
                cb.removeEventListener('mousedown', this._captureHandlers.startHandler, false);
                cb.removeEventListener('touchstart', this._captureHandlers.startHandler, false);
                cb.removeEventListener('mouseup', this._captureHandlers.endHandler, false);
                cb.removeEventListener('touchend', this._captureHandlers.endHandler, false);
                cb.removeEventListener('mouseleave', this._captureHandlers.leaveHandler, false);
                if (this._captureHandlers.clickHandler) {
                    cb.removeEventListener('click', this._captureHandlers.clickHandler, false);
                }
            }
        }
    } catch(e){}
    // Do NOT touch the audio element, position saver, or beforeunload handler —
    // the singleton service owns those and they must survive layout switches.
    Widget.prototype.removeChildDomNodes.call(this);
};

exports['podcast-player'] = PodcastPlayerWidget;

})();
