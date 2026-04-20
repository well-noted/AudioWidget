/*\
title: $:/plugins/NoteStreams/AudioSuite/js/sound-effects-widget.js
type: application/javascript
module-type: widget
\*/
(function(){
"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var utils = require("$:/plugins/NoteStreams/AudioSuite/js/audio-utils.js");

function SoundEffectWidget(parseTreeNode,options) {
    this.initialise(parseTreeNode,options);
}

SoundEffectWidget.prototype = new Widget();

SoundEffectWidget.prototype.initialise = function(parseTreeNode,options) {
    Widget.prototype.initialise.call(this,parseTreeNode,options);
};

SoundEffectWidget.prototype.execute = function() {
    this.attrSrc = this.getAttribute("src", "");
    this.attrTiddler = this.getAttribute("tiddler", "");
    this.attrVolume = this.getAttribute("volume", "1");
    this.attrAutoplay = this.getAttribute("autoplay", "no");
    this.attrStartTime = this.getAttribute("startTime", "");
    this.attrEndTime = this.getAttribute("endTime", "");
    this.attrTrigger = this.getAttribute("trigger", this.attrAutoplay === "yes" ? "none" : "click");
    this.attrEvent = this.getAttribute("event", "");
    this.makeChildWidgets();
};

SoundEffectWidget.prototype.render = function(parent,nextSibling) {
    this.parentDomNode = parent;
    this._isDestroyed = false;
    this.computeAttributes();
    this.execute();

    // render start

    if(!parent || typeof parent.insertBefore !== 'function'){
        return;
    }

    // attributes computed via computeAttributes()/execute()

    var doc = (parent && parent.ownerDocument) || document;
    this.document = doc;
    var span = doc.createElement("span");
    span.className = "tc-sound-effect";
    parent.insertBefore(span, nextSibling);
    this.domNode = span;

    // ensure child widgets exist (fallback)
    if(!this.children || !this.children.length) {
        try { this.makeChildWidgets(); } catch(e) {}
    }

    // render children inside span
    try {
        this.renderChildren(span, null);
    } catch(err) {}

    // resolve src
    var src = this.attrSrc;
    if(!src && this.attrTiddler) {
        try{
            src = utils.resolveAudioSrc(this.wiki, this.attrTiddler) || "";
        } catch(e){ src = ""; }
    }
    // resolved src available in `src`

    var audio = new Audio(src);
    audio.volume = parseFloat(this.attrVolume) || 1;
    audio.preload = "auto";
    this.audio = audio;

    var self = this;

    this._play = function(startTime, endTime) {
        try{
            // lazy-resolve source if not set
            if((!self.audio || !self.audio.src) && self.attrTiddler){
                try{
                    var resolved = utils.resolveAudioSrc(self.wiki, self.attrTiddler) || self.attrSrc || "";
                    if(resolved){
                        self.audio.src = resolved;
                    }
                } catch(e){}
            }
        } catch(e){}
        try{
            // choose start time: explicit arg -> attribute -> default 0
            var st = (typeof startTime === 'number') ? startTime : (self.attrStartTime ? Number(self.attrStartTime) : 0);
        } catch(e){
            var st = 0;
        }

        // handle endTime via timeupdate listener (if provided)
        try{
            // remove any previous timeupdate
            if(self._endTimeUpdateHandler){
                try{ self.audio.removeEventListener('timeupdate', self._endTimeUpdateHandler, false); } catch(e){}
                self._endTimeUpdateHandler = null;
            }
            var et = (typeof endTime === 'number') ? endTime : (self.attrEndTime ? Number(self.attrEndTime) : NaN);
            // If this is a point capture (start === end) or no end provided,
            // expand to a sensible default audible duration so snippet playback
            // actually contains audio (fallback behavior).
            try {
                var PLAYBACK_FALLBACK_SECONDS = 20;
                if (typeof st === 'number' && !isNaN(st)) {
                    if (isNaN(et) || Number(et) === Number(st)) {
                        et = Number(st) + PLAYBACK_FALLBACK_SECONDS;
                        try {
                            if (self.audio && typeof self.audio.duration === 'number' && !isNaN(self.audio.duration)) {
                                et = Math.min(et, Number(self.audio.duration));
                            }
                        } catch(e){}
                    }
                }
            } catch(e){ console.warn('SoundEffectsWidget: failed to compute fallback endSeconds', e); }
            if(!isNaN(et)){
                self._endTimeUpdateHandler = function(){
                    try{
                        if(self.audio && typeof self.audio.currentTime === 'number' && self.audio.currentTime >= et){
                            try{ self.audio.pause(); } catch(e){}
                            if(self._endTimeUpdateHandler){
                                try{ self.audio.removeEventListener('timeupdate', self._endTimeUpdateHandler, false); } catch(e){}
                                self._endTimeUpdateHandler = null;
                            }
                        }
                    } catch(e){}
                };
                try{ self.audio.addEventListener('timeupdate', self._endTimeUpdateHandler, false); } catch(e){}
            }
        } catch(e){}

        // always perform seek-then-play flow to ensure seeks apply before playback
        if (self.audio && self.audio.play) {
            var doSeekAndPlay = function() {
                if (self._isDestroyed || !self.audio) return;
                if (!isNaN(st) && st > 0) {
                    try { self.audio.currentTime = st; } catch(e) {
                        console.warn('[sound-effect] seek failed:', e);
                    }
                }
                self.audio.play().catch(function(err) {
                    console.warn('[sound-effect] play() failed:', err);
                });
            };

            if (self.audio.readyState >= 1) {
                doSeekAndPlay();
            } else {
                var onMeta = function(){
                    try{ self.audio.removeEventListener('loadedmetadata', onMeta, false); } catch(e){}
                    doSeekAndPlay();
                };
                try{ self.audio.addEventListener('loadedmetadata', onMeta, false); } catch(e){}
            }
        }
    };

    if(this.attrAutoplay === "yes"){
        this._play();
    }

    if(this.attrTrigger === "click"){
        this._clickHandler = function() { self._play(); };
        span.addEventListener("click", this._clickHandler, false);
    }

    // Event trigger: supports receiving data payload for snippet playback
    if(this.attrTrigger === "event" && this.attrEvent) {
        this._eventHandler = function(data){
            try{
                // If data is provided with audioSource/startSeconds/endSeconds, use those
                if(data && data.audioSource){
                    var resolved = utils.resolveAudioSrc(self.wiki, data.audioSource) || '';
                    if(resolved && self.audio.src !== resolved){
                        self.audio.src = resolved;
                    }
                    var st = (typeof data.startSeconds === 'number') ? data.startSeconds : (data.startTime ? Number(data.startTime) : undefined);
                    var et = (typeof data.endSeconds === 'number') ? data.endSeconds : (data.endTime ? Number(data.endTime) : undefined);
                    self._play(st, et);
                    return;
                }
            } catch(e){}
            // fallback: simple play using attributes
            self._play();
        };
        utils.on(this.attrEvent, this._eventHandler);
    }

    // Attach directly to nested <button> elements to ensure play fires
    try{
        var nestedButtons = this.domNode.querySelectorAll && this.domNode.querySelectorAll('button');
        if(nestedButtons && nestedButtons.length){
            this._nestedButtonHandlers = [];
            Array.prototype.forEach.call(nestedButtons, function(b){
                var fn = function(ev){
                    try{ ev.stopPropagation && ev.stopPropagation(); } catch(e){}
                    self._play();
                };
                b.addEventListener('click', fn, false);
                self._nestedButtonHandlers.push({el: b, fn: fn});
            });
        }
    } catch(e){}
};

SoundEffectWidget.prototype.refresh = function(changedTiddlers) {
    // Ensure attributes are recomputed from bindings
    this.computeAttributes();

    var newSrc = this.getAttribute("src", "");
    var newTiddler = this.getAttribute("tiddler", "");
    var newVolume = this.getAttribute("volume", "1");
    var newAutoplay = this.getAttribute("autoplay", "no");
    var newTrigger = this.getAttribute("trigger", newAutoplay === "yes" ? "none" : "click");
    var newEvent = this.getAttribute("event", "");
    var newStartTime = this.getAttribute("startTime", "");
    var newEndTime = this.getAttribute("endTime", "");

    // If core attributes changed, a full rebuild is required
    if (newSrc !== this.attrSrc || newTiddler !== this.attrTiddler ||
        newVolume !== this.attrVolume || newAutoplay !== this.attrAutoplay ||
        newTrigger !== this.attrTrigger || newEvent !== this.attrEvent) {
        return this.refreshSelf();
    }

    // If only start/end times changed, update in-memory attrs (lightweight)
    if (newStartTime !== this.attrStartTime || newEndTime !== this.attrEndTime) {
        this.attrStartTime = newStartTime;
        this.attrEndTime = newEndTime;
        // no DOM changes needed; _play() reads these values at invocation
    }

    return this.refreshChildren(changedTiddlers);
};

SoundEffectWidget.prototype.removeChildDomNodes = function() {
    // Mark as destroyed so any async callbacks can early-return
    this._isDestroyed = true;

    if(this.domNode && this._clickHandler){
        this.domNode.removeEventListener("click", this._clickHandler, false);
        this._clickHandler = null;
    }
    if(this._eventHandler && this.attrEvent){
        utils.off(this.attrEvent, this._eventHandler);
        this._eventHandler = null;
    }
    // remove any timeupdate end handler
    try{
        if(this._endTimeUpdateHandler && this.audio){
            this.audio.removeEventListener('timeupdate', this._endTimeUpdateHandler, false);
            this._endTimeUpdateHandler = null;
        }
    } catch(e){}
    if(this._nestedButtonHandlers && this._nestedButtonHandlers.length){
        this._nestedButtonHandlers.forEach(function(h){
            try{ h.el.removeEventListener('click', h.fn, false); } catch(e){}
        });
        this._nestedButtonHandlers = null;
    }
    // Ensure audio is paused and underlying resource released
    if(this.audio) {
        try { this.audio.pause(); } catch(e) {}
        try { this.audio.removeAttribute('src'); this.audio.load(); } catch(e) {}
        this.audio = null;
    }
    Widget.prototype.removeChildDomNodes.call(this);
};

exports["sound-effect"] = SoundEffectWidget;

})();
