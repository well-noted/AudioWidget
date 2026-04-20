/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/index.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

/**
 * Waveform Editor Module Index
 * 
 * Re-exports all sub-modules for convenient access.
 */

// Core utilities
exports.mp3Parser = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/mp3-parser.js");
exports.audioCache = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/audio-cache.js");
exports.wavEncoder = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/wav-encoder.js");
exports.peaksGenerator = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/peaks-generator.js");
exports.audioLoader = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/audio-loader.js");

// UI and interaction
exports.renderer = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/waveform-renderer.js");
exports.interaction = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/interaction-handler.js");

// Services
exports.PlaybackManager = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/playback-manager.js").PlaybackManager;
exports.TranscriptionService = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/transcription-service.js").TranscriptionService;
exports.UndoManager = require("$:/plugins/NoteStreams/AudioSuite/js/waveform-editor/undo-manager.js").UndoManager;

})();
