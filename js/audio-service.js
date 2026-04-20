/*\
title: $:/plugins/NoteStreams/AudioSuite/js/audio-service.js
type: application/javascript
module-type: startup
\*/
(function(){
"use strict";

exports.name = "audiosuite-audio-service";
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function() {
    // Guard: browser-only
    if (!$tw.browser) return;

    var utils = require("$:/plugins/NoteStreams/AudioSuite/js/audio-utils.js");

    // ── Singleton service object ──────────────────────────────────────────
    var service = {};
    var wiki = $tw.wiki;

    // ── Persistent <audio> element ────────────────────────────────────────
    var container = document.createElement('div');
    container.id = 'AudioSuite-persistent-audio';
    container.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0;z-index:-1;';
    var audio = document.createElement('audio');
    audio.preload = 'metadata';
    try { audio.crossOrigin = 'anonymous'; } catch(e){}
    container.appendChild(audio);
    document.body.appendChild(container);

    // ── Internal state ────────────────────────────────────────────────────
    var currentTrack = null;
    var playlist = [];
    var virtualTrackMap = {};
    var _currentSrc = null;
    var _currentPointer = null;
    var _playbackRate = 1;
    var _retryNoCors = false;

    // Configuration (set by widget via service.configure())
    var config = {
        persistPosition: true,
        saveInterval: 5,
        autoPause: true,
        rewindOnResume: 3,
        mode: 'podcast',
        bookTiddler: '',
        srcField: ''
    };

    // Position saver
    var positionSaveIntervalId = null;

    // Track history
    var trackHistory = [];
    var MAX_HISTORY = 20;

    // Capture coordination
    var _wasPlayingBeforeCapture = false;
    var _lastPausedCaptureTitle = null;

    // ── Simple event emitter (service-level) ─────────────────────────────
    var _listeners = Object.create(null);

    service.on = function(event, fn) {
        if (!event || typeof fn !== 'function') return;
        (_listeners[event] = _listeners[event] || []).push(fn);
    };

    service.off = function(event, fn) {
        var a = _listeners[event];
        if (!a) return;
        if (!fn) { delete _listeners[event]; return; }
        var idx = a.indexOf(fn);
        if (idx !== -1) a.splice(idx, 1);
    };

    function _emit(event, data) {
        var a = _listeners[event];
        if (!a) return;
        a.slice().forEach(function(fn){ try{ fn(data); } catch(e){} });
    }

    // ── Configuration ─────────────────────────────────────────────────────
    service.configure = function(opts) {
        if (!opts) return;
        if (opts.persistPosition !== undefined) config.persistPosition = !!opts.persistPosition;
        if (opts.saveInterval !== undefined) config.saveInterval = Math.max(2, Number(opts.saveInterval) || 5);
        if (opts.autoPause !== undefined) config.autoPause = !!opts.autoPause;
        if (opts.rewindOnResume !== undefined) config.rewindOnResume = Math.max(0, Number(opts.rewindOnResume) || 0);
        if (opts.mode !== undefined) config.mode = opts.mode;
        if (opts.bookTiddler !== undefined) config.bookTiddler = opts.bookTiddler;
        if (opts.srcField !== undefined) config.srcField = opts.srcField;
    };

    service.getConfig = function() {
        return { persistPosition: config.persistPosition, saveInterval: config.saveInterval, autoPause: config.autoPause, rewindOnResume: config.rewindOnResume, mode: config.mode, bookTiddler: config.bookTiddler, srcField: config.srcField };
    };

    // ── Position persistence ──────────────────────────────────────────────
    function savePosition() {
        try {
            if (!config.persistPosition) return;
            if (!currentTrack) return;
            if (!audio || typeof audio.currentTime !== 'number' || isNaN(audio.currentTime)) return;
            var secs = String(Math.floor(Math.max(0, audio.currentTime || 0)));

            if (virtualTrackMap && virtualTrackMap[currentTrack]) {
                // Virtual track: store position in a JSON field on the book tiddler
                if (!config.bookTiddler) return;
                var bookTid = wiki.getTiddler(config.bookTiddler);
                if (!bookTid) return;
                try {
                    var positions = {};
                    try { positions = JSON.parse(bookTid.fields['audio-track-positions'] || '{}'); } catch(e) {}
                    positions[currentTrack] = secs;
                    wiki.addTiddler(new $tw.Tiddler(bookTid, {
                        'audio-track-positions': JSON.stringify(positions)
                    }));
                } catch(e) { console.warn('AudioService: failed to save virtual track position', e); }
            } else {
                // Real track: store position on the track tiddler itself
                var tt = wiki.getTiddler(currentTrack);
                if (!tt) return;
                try {
                    wiki.addTiddler(new $tw.Tiddler(tt, {
                        'audio-track-position': secs
                    }));
                } catch(e) {
                    console.warn('AudioService: failed to save audio-track-position', e);
                }
            }
        } catch(e) { console.warn('AudioService: savePosition failed', e); }
    }

    function clearPosition() {
        try {
            if (!currentTrack) return;

            if (virtualTrackMap && virtualTrackMap[currentTrack]) {
                if (!config.bookTiddler) return;
                var bookTid = wiki.getTiddler(config.bookTiddler);
                if (!bookTid) return;
                try {
                    var positions = {};
                    try { positions = JSON.parse(bookTid.fields['audio-track-positions'] || '{}'); } catch(e) {}
                    delete positions[currentTrack];
                    wiki.addTiddler(new $tw.Tiddler(bookTid, {
                        'audio-track-positions': JSON.stringify(positions)
                    }));
                } catch(e) { console.warn('AudioService: failed to clear virtual track position', e); }
            } else {
                var tt = wiki.getTiddler(currentTrack);
                if (!tt) return;
                var fields = tt.fields || {};
                var newFields = {};
                for (var k in fields) {
                    if (Object.prototype.hasOwnProperty.call(fields, k) && k !== 'audio-track-position') {
                        newFields[k] = fields[k];
                    }
                }
                if (!newFields.title && fields.title) newFields.title = fields.title;
                try {
                    wiki.addTiddler(new $tw.Tiddler(newFields));
                } catch(e) {
                    try { wiki.addTiddler(new $tw.Tiddler(tt, {'audio-track-position': '0'})); } catch(e2) { console.warn('AudioService: failed to clear position', e2); }
                }
            }
        } catch(e) { console.warn('AudioService: clearPosition failed', e); }
    }

    function restorePosition(trackTitle) {
        try {
            if (!config.persistPosition) return;
            if (!trackTitle) return;

            var saved = 0;

            if (virtualTrackMap && virtualTrackMap[trackTitle]) {
                if (!config.bookTiddler) return;
                var bookTid = wiki.getTiddler(config.bookTiddler);
                if (!bookTid || !bookTid.fields) return;
                try {
                    var positions = JSON.parse(bookTid.fields['audio-track-positions'] || '{}');
                    saved = Number(positions[trackTitle]) || 0;
                } catch(e) { return; }
            } else {
                var tt = wiki.getTiddler(trackTitle);
                if (!tt || !tt.fields) return;
                saved = Number(tt.fields['audio-track-position']) || 0;
            }

            if (!saved || saved <= 0) return;

            var applySaved = function() {
                try {
                    var dur = Number(audio.duration) || 0;
                    if (dur > 0 && saved >= dur) {
                        clearPosition();
                        try { audio.currentTime = 0; } catch(e) {}
                    } else {
                        try { audio.currentTime = saved; } catch(e) { console.warn('AudioService: failed to restore time', e); }
                    }
                } catch(e) { console.warn('AudioService: applySaved failed', e); }
            };

            if (audio && audio.readyState >= 1) {
                applySaved();
            } else {
                var onLoadMeta = function() {
                    try { applySaved(); } catch(e) {}
                    try { audio.removeEventListener('loadedmetadata', onLoadMeta, false); } catch(e) {}
                };
                audio.addEventListener('loadedmetadata', onLoadMeta, false);
            }
        } catch(e) { console.warn('AudioService: restorePosition failed', e); }
    }

    function startPositionSaver() {
        try {
            stopPositionSaver();
            if (!config.persistPosition) return;
            var intervalSec = Math.max(2, config.saveInterval);
            positionSaveIntervalId = setInterval(function() {
                try { if (audio && !audio.paused) savePosition(); } catch(e) {}
            }, intervalSec * 1000);
        } catch(e) { console.warn('AudioService: startPositionSaver failed', e); }
    }

    function stopPositionSaver() {
        try {
            if (positionSaveIntervalId !== null) {
                clearInterval(positionSaveIntervalId);
                positionSaveIntervalId = null;
            }
        } catch(e) { console.warn('AudioService: stopPositionSaver failed', e); }
    }

    // ── Track loading ─────────────────────────────────────────────────────
    function loadTrack(title) {
        // Save outgoing track position and stop any existing saver
        try { savePosition(); } catch(e) {}
        try { stopPositionSaver(); } catch(e) {}

        var src;
        if (virtualTrackMap && virtualTrackMap[title]) {
            src = virtualTrackMap[title];
        } else {
            src = utils.resolveAudioSrc(wiki, title, config.srcField);
        }
        console.log('AudioService: loadTrack', title, src);

        if (!src) {
            try {
                var t = wiki.getTiddler(title);
                if (t) {
                    console.warn('AudioService: no src resolved for', title, 'tiddler fields:', t.fields);
                } else if (virtualTrackMap && virtualTrackMap[title]) {
                    console.warn('AudioService: virtual track URI was empty/falsy for', title);
                } else {
                    console.warn('AudioService: no src resolved and not in virtualTrackMap for', title);
                }
            } catch(e) { console.warn('AudioService: failed to inspect tiddler', e); }
            audio.removeAttribute('src');
            audio.load();
            return;
        }

        _retryNoCors = false;
        audio.src = src;
        audio.load();
        currentTrack = title;

        // Restore previously-saved playback position for this track
        try { restorePosition(title); } catch(e) { console.warn('AudioService: restorePosition call failed', e); }

        // Remember the currently-resolved src
        try {
            _currentSrc = src || null;
            var pointer = '';
            if (config.srcField && !(virtualTrackMap && virtualTrackMap[title])) {
                try {
                    var tt = wiki.getTiddler(title);
                    if (tt && tt.fields && tt.fields[config.srcField]) {
                        var candidate = tt.fields[config.srcField];
                        if (typeof candidate === 'string' && candidate && wiki.getTiddler(candidate)) {
                            pointer = candidate;
                        }
                    }
                } catch(e) {}
            }
            _currentPointer = pointer || null;
        } catch(e) { _currentSrc = null; _currentPointer = null; }

        // In audiobook mode, save the current chapter to the book tiddler
        if (config.mode === 'audiobook' && config.bookTiddler) {
            try {
                var bookTid = wiki.getTiddler(config.bookTiddler);
                if (bookTid) {
                    wiki.addTiddler(new $tw.Tiddler(bookTid, { 'audio-current-track': title }));
                }
            } catch(e) { console.warn('AudioService: failed to save audio-current-track', e); }
        }

        _emit('service:trackchanged', { track: title, playlist: playlist });
        try { updateMediaSession(); } catch(e) {}
    }

    /*
     * Strip TiddlyWiki [[wikilink]] syntax from a string for plain-text display.
     * Handles both [[target]] and [[target|display]] forms.
     * - [[target]]         → "target"
     * - [[target|display]] → "display" (pipe-delimited; target before pipe)
     * Returns the original string unchanged if no brackets are found.
     * Multiple links in one string are all replaced in a single pass.
     */
    function stripWikiLinks(str) {
        if (!str || typeof str !== 'string') return str || '';
        return str.replace(/\[\[([^\]]*?)\]\]/g, function(match, inner) {
            var parts = inner.split('|');
            return (parts.length > 1 ? parts[1] : parts[0] || '').trim();
        });
    }

    // ── Media Session API integration ─────────────────────────────────────
    // Updates the browser's Media Session metadata and transport-control
    // handlers so that the OS notification shade (Android, macOS, etc.)
    // reflects the currently-loaded track and can control playback.
    // Safe to call on browsers that lack the API — guarded by feature check.
    function updateMediaSession() {
        if (!('mediaSession' in navigator)) return;
        try {
            var trackDisplayName = '';
            var artistName = '';
            var albumName = '';
            var coverUrl = '';
            var coverField = '';
            var coverTid;
            var isVirtual = virtualTrackMap && virtualTrackMap[currentTrack];

            if (isVirtual) {
                // Virtual track: use the dictionary key as display title;
                // pull shared metadata (author, album, cover) from the book tiddler.
                trackDisplayName = currentTrack || '';
                if (config.bookTiddler) {
                    var bookTid = wiki.getTiddler(config.bookTiddler);
                    if (bookTid && bookTid.fields) {
                        var bf = bookTid.fields;
                        artistName = bf.author || bf.artist || '';
                        albumName = bf.caption || bf.title || config.bookTiddler;
                        coverField = bf.cover || bf['cover-image'] || bf['cover_image'] || '';
                        if (coverField) {
                            coverTid = wiki.getTiddler(coverField);
                            if (coverTid && coverTid.fields && coverTid.fields['_canonical_uri']) {
                                coverUrl = coverTid.fields['_canonical_uri'];
                            } else {
                                coverUrl = coverField;
                            }
                        }
                    }
                }
            } else {
                // Real tiddler track: read metadata directly from the track tiddler.
                var trackTid = wiki.getTiddler(currentTrack);
                var tf = (trackTid && trackTid.fields) ? trackTid.fields : {};
                trackDisplayName = tf.caption || currentTrack || '';
                artistName = tf.artist || tf.author || '';
                albumName = tf.album || config.bookTiddler || '';
                coverField = tf.cover || '';
                if (coverField) {
                    coverTid = wiki.getTiddler(coverField);
                    if (coverTid && coverTid.fields && coverTid.fields['_canonical_uri']) {
                        coverUrl = coverTid.fields['_canonical_uri'];
                    } else {
                        coverUrl = coverField;
                    }
                }
            }

            // In audiobook mode, prefix the notification title with the book's
            // display name so the OS notification reads "Book: Chapter".
            // The album field already carries the book name on its own line.
            if (config.mode === 'audiobook' && config.bookTiddler) {
                var bookDisplayName = config.bookTiddler; // fallback: raw tiddler title
                try {
                    var bt = wiki.getTiddler(config.bookTiddler);
                    if (bt && bt.fields) {
                        bookDisplayName = bt.fields.caption || bt.fields.title || config.bookTiddler;
                    }
                } catch(e) {}
                trackDisplayName = stripWikiLinks(bookDisplayName) + ': ' + trackDisplayName;
            }

            var artworkArray = [];
            if (coverUrl) {
                artworkArray = [{ src: coverUrl, sizes: '512x512', type: 'image/png' }];
            }

            navigator.mediaSession.metadata = new MediaMetadata({
                title:   stripWikiLinks(trackDisplayName),
                artist:  stripWikiLinks(artistName),
                album:   stripWikiLinks(albumName),
                artwork: artworkArray
            });

            // Register transport-control handlers (re-registering is idempotent).
            navigator.mediaSession.setActionHandler('play', function() {
                service.play();
            });
            navigator.mediaSession.setActionHandler('pause', function() {
                service.pause();
            });
            navigator.mediaSession.setActionHandler('seekbackward', function() {
                service.skip(-10);
            });
            navigator.mediaSession.setActionHandler('seekforward', function() {
                service.skip(10);
            });
            navigator.mediaSession.setActionHandler('previoustrack', function() {
                var idx = playlist.indexOf(currentTrack);
                if (idx > 0) {
                    var prev = playlist[idx - 1];
                    service.pushHistory('media-session');
                    loadTrack(prev);
                    service.play();
                }
            });
            navigator.mediaSession.setActionHandler('nexttrack', function() {
                var idx = playlist.indexOf(currentTrack);
                if (idx >= 0 && idx < playlist.length - 1) {
                    var next = playlist[idx + 1];
                    service.pushHistory('media-session');
                    loadTrack(next);
                    service.play();
                }
            });
            navigator.mediaSession.setActionHandler('seekto', function(action) {
                if (typeof action.seekTime === 'number') {
                    service.seek(action.seekTime);
                }
            });
        } catch(e) {
            console.warn('AudioService: updateMediaSession failed', e);
        }
    }

    // ── Playback controls ─────────────────────────────────────────────────
    service.play = function() {
        return audio.play().then(function() {
            try { startPositionSaver(); } catch(e) {}
            try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; } catch(e) {}
            _emit('service:statechange', { playing: true, track: currentTrack, rate: _playbackRate });
        }).catch(function(err) {
            console.error('AudioService: play failed', err);
            throw err;
        });
    };

    service.pause = function() {
        audio.pause();
        try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; } catch(e) {}
        try { savePosition(); } catch(e) {}
        try { stopPositionSaver(); } catch(e) {}
        _emit('service:statechange', { playing: false, track: currentTrack, rate: _playbackRate });
    };

    service.toggle = function() {
        if (audio.paused) {
            return service.play();
        } else {
            service.pause();
            return Promise.resolve();
        }
    };

    service.seek = function(seconds) {
        try { audio.currentTime = seconds; } catch(e) {}
    };

    service.skip = function(deltaSec) {
        try {
            var newTime = audio.currentTime + deltaSec;
            if (newTime < 0) newTime = 0;
            var dur = audio.duration || 0;
            if (dur > 0 && newTime > dur) newTime = dur;
            audio.currentTime = newTime;
        } catch(e) {}
    };

    service.isPlaying = function() {
        return audio && !audio.paused;
    };

    service.getCurrentTime = function() {
        return (audio && typeof audio.currentTime === 'number') ? audio.currentTime : 0;
    };

    service.getDuration = function() {
        return (audio && typeof audio.duration === 'number' && !isNaN(audio.duration)) ? audio.duration : 0;
    };

    // ── Track management ──────────────────────────────────────────────────
    service.loadTrack = function(title) {
        loadTrack(title);
    };

    service.getCurrentTrack = function() {
        return currentTrack;
    };

    service.getPlaylist = function() {
        return playlist.slice();
    };

    service.setPlaylist = function(titles, vtMap) {
        playlist = (titles && titles.slice) ? titles.slice() : [];
        virtualTrackMap = vtMap || {};
    };

    service.getPlaybackRate = function() {
        return _playbackRate;
    };

    service.setPlaybackRate = function(rate) {
        _playbackRate = Number(rate) || 1;
        audio.playbackRate = _playbackRate;
        _emit('service:statechange', { playing: !audio.paused, track: currentTrack, rate: _playbackRate });
    };

    // ── Position persistence (public API) ─────────────────────────────────
    service.savePosition = savePosition;
    service.restorePosition = restorePosition;
    service.clearPosition = clearPosition;

    // Return the saved position (seconds) for any track without loading it
    service.getTrackSavedPosition = function(trackTitle) {
        try {
            if (!trackTitle) return 0;
            if (virtualTrackMap && virtualTrackMap[trackTitle]) {
                // Virtual track: read from book tiddler's JSON field
                if (!config.bookTiddler) return 0;
                var bookTid = wiki.getTiddler(config.bookTiddler);
                if (!bookTid || !bookTid.fields) return 0;
                try {
                    var positions = JSON.parse(bookTid.fields['audio-track-positions'] || '{}');
                    return Number(positions[trackTitle]) || 0;
                } catch(e) { return 0; }
            } else {
                // Real track: read from track tiddler field
                var tt = wiki.getTiddler(trackTitle);
                if (!tt || !tt.fields) return 0;
                return Number(tt.fields['audio-track-position']) || 0;
            }
        } catch(e) {
            console.warn('AudioService: getTrackSavedPosition failed', e);
            return 0;
        }
    };

    // ── Source info ────────────────────────────────────────────────────────
    service.getCurrentSrc = function() { return _currentSrc; };
    service.getCurrentPointer = function() { return _currentPointer; };
    service.getVirtualTrackMap = function() { return virtualTrackMap; };

    // ── Track history ─────────────────────────────────────────────────────
    service.pushHistory = function(reason) {
        try {
            if (!currentTrack) return;
            if (trackHistory.length > 0 && trackHistory[trackHistory.length - 1].track === currentTrack) {
                trackHistory[trackHistory.length - 1].position = Math.floor(audio.currentTime || 0);
                trackHistory[trackHistory.length - 1].wasPlaying = !audio.paused;
                return;
            }
            trackHistory.push({
                track: currentTrack,
                position: Math.floor(audio.currentTime || 0),
                wasPlaying: !audio.paused,
                reason: reason || ''
            });
            if (trackHistory.length > MAX_HISTORY) {
                trackHistory.splice(0, trackHistory.length - MAX_HISTORY);
            }
        } catch(e) { console.warn('AudioService: pushHistory failed', e); }
    };

    service.popHistory = function() {
        if (trackHistory.length === 0) return null;
        return trackHistory.pop();
    };

    service.getHistoryLength = function() {
        return trackHistory.length;
    };

    // ── Capture coordination ──────────────────────────────────────────────
    service.getWasPlayingBeforeCapture = function() { return _wasPlayingBeforeCapture; };
    service.setWasPlayingBeforeCapture = function(val) { _wasPlayingBeforeCapture = !!val; };
    service.getLastPausedCaptureTitle = function() { return _lastPausedCaptureTitle; };
    service.setLastPausedCaptureTitle = function(val) { _lastPausedCaptureTitle = val; };

    // ── Audio element event handlers (registered once) ────────────────────

    // timeupdate
    audio.addEventListener('timeupdate', function() {
        var ct = audio.currentTime || 0;
        var dur = audio.duration || 0;
        try {
            if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && dur > 0) {
                navigator.mediaSession.setPositionState({
                    duration: dur,
                    playbackRate: _playbackRate,
                    position: Math.min(ct, dur)
                });
            }
        } catch(e) {}
        _emit('service:timeupdate', { currentTime: ct, duration: dur });
    }, false);

    // loadedmetadata
    audio.addEventListener('loadedmetadata', function() {
        var dur = audio.duration || 0;
        var ct = audio.currentTime || 0;
        _emit('service:timeupdate', { currentTime: ct, duration: dur });
    }, false);

    // error handler with CORS retry
    audio.addEventListener('error', function(ev) {
        try {
            var err = audio.error;
            var code = err && err.code ? err.code : 'unknown';
            var message = err && err.message ? err.message : '';
            var netState = audio.networkState;
            var ready = audio.readyState;
            console.error('AudioService: audio error', code, message, 'networkState', netState, 'readyState', ready, ev);
            if (!_retryNoCors) {
                _retryNoCors = true;
                try {
                    try { audio.removeAttribute('crossorigin'); } catch(e) {}
                    var srcNow = audio.src;
                    audio.src = '';
                    audio.load && audio.load();
                    audio.src = srcNow;
                    audio.load && audio.load();
                } catch(e) { console.warn('AudioService: retry without crossorigin failed', e); }
            }
            _emit('service:error', { error: err });
        } catch(e) {}
    }, false);

    // ended handler
    audio.addEventListener('ended', function() {
        try { clearPosition(); } catch(e) {}
        try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; } catch(e) {}
        try { stopPositionSaver(); } catch(e) {}
        // Auto-advance to next chapter in audiobook mode
        if (config.mode === 'audiobook' && playlist && playlist.length > 1) {
            try {
                var advIdx = playlist.indexOf(currentTrack);
                if (advIdx >= 0 && advIdx < playlist.length - 1) {
                    var advNext = playlist[advIdx + 1];
                    service.pushHistory('auto-advance');
                    loadTrack(advNext);
                    audio.play().then(function() {
                        try { startPositionSaver(); } catch(e) {}
                        _emit('service:statechange', { playing: true, track: currentTrack, rate: _playbackRate });
                    }).catch(function(err) { console.warn('AudioService: auto-advance play failed', err); });
                    return;
                }
            } catch(e) { console.warn('AudioService: auto-advance failed', e); }
        }
        _emit('service:ended', { track: currentTrack });
        _emit('service:statechange', { playing: false, track: currentTrack, rate: _playbackRate });
    }, false);

    // ── Event-bus handlers (AudioSuite global events) ─────────────────────

    // Seek handler from notation widget
    utils.on('AudioSuite:seek', function(data) {
        if (!data || typeof data.seconds !== 'number') return;
        // Handle cross-track seeks
        if (data.track && currentTrack && String(data.track) !== String(currentTrack) && playlist && playlist.indexOf(String(data.track)) !== -1) {
            var targetSecs = data.seconds;
            service.pushHistory('seek');
            loadTrack(data.track);
            var seekAfterLoad = function() {
                try { audio.currentTime = targetSecs; } catch(e) {}
                try { audio.removeEventListener('loadedmetadata', seekAfterLoad, false); } catch(e) {}
                if (audio.paused) {
                    audio.play && audio.play().then(function() {
                        _emit('service:statechange', { playing: true, track: currentTrack, rate: _playbackRate });
                    }).catch(function() {});
                }
            };
            audio.addEventListener('loadedmetadata', seekAfterLoad, false);
            return;
        }
        try { audio.currentTime = data.seconds; } catch(e) {}
        if (audio.paused) {
            audio.play && audio.play().then(function() {
                _emit('service:statechange', { playing: true, track: currentTrack, rate: _playbackRate });
            }).catch(function() {});
        }
    });

    // Notation editor closed handler
    utils.on('AudioSuite:notation-editor-closed', function(data) {
        try {
            if (!_wasPlayingBeforeCapture) return;
            if (!data) return;
            try {
                if (data.skipEditor) {
                    // quick-tag captures may emit immediate closed events; accept these
                } else if (data.entryTitle && _lastPausedCaptureTitle && String(data.entryTitle) !== String(_lastPausedCaptureTitle)) {
                    return;
                }
            } catch(e) {}

            _wasPlayingBeforeCapture = false;
            _lastPausedCaptureTitle = null;

            if (config.rewindOnResume > 0) {
                try { audio.currentTime = Math.max(0, audio.currentTime - config.rewindOnResume); } catch(e) {}
            }
            try {
                audio.play().then(function() {
                    _emit('service:statechange', { playing: true, track: currentTrack, rate: _playbackRate });
                }).catch(function(err) { console.warn('AudioService: auto-resume play failed', err); });
            } catch(e) { console.warn('AudioService: auto-resume failed', e); }
        } catch(e) { console.warn('AudioService: editorClosed handler failed', e); }
    });

    // ── beforeunload ──────────────────────────────────────────────────────
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('beforeunload', function() {
            try { savePosition(); } catch(e) {}
        }, false);
    }

    // ── Navigate back (used by widget back button) ────────────────────────
    service.navigateBack = function() {
        if (trackHistory.length === 0) return null;
        var histEntry = trackHistory.pop();
        loadTrack(histEntry.track);
        var applyBack = function() {
            try { audio.currentTime = histEntry.position; } catch(e) {}
            if (histEntry.wasPlaying) {
                try {
                    audio.play().then(function() {
                        _emit('service:statechange', { playing: true, track: currentTrack, rate: _playbackRate });
                    }).catch(function() {});
                } catch(e) {}
            }
        };
        if (audio.readyState >= 1) {
            applyBack();
        } else {
            var onMeta = function() {
                try { applyBack(); } catch(e) {}
                try { audio.removeEventListener('loadedmetadata', onMeta, false); } catch(e) {}
            };
            audio.addEventListener('loadedmetadata', onMeta, false);
        }
        return histEntry;
    };

    // ── Expose on $tw ─────────────────────────────────────────────────────
    $tw.AudioSuite = $tw.AudioSuite || {};
    $tw.AudioSuite.service = service;
};

})();
