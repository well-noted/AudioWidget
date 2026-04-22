# AudioWidget
Podcast Player, Audiobook Mode, Waveform Editor &amp; Timestamped Note Capture for TiddlyWiki

---


# 🎧 AudioSuite for TiddlyWiki

**A full-featured audio toolkit for TiddlyWiki — podcast player, audiobook mode, waveform editing, and timestamped note capture that lives alongside your wiki content.**

<img width="1205" height="1081" alt="vivaldi_H0Ct9pXZR6" src="https://github.com/user-attachments/assets/319506a6-fe20-4791-b5c2-4b8f855e33c2" />


---

## Why AudioSuite?

If you take notes on podcasts, audiobooks, lectures, or interviews, you've
probably felt the friction of switching between your audio app and your notes.
AudioSuite removes that gap entirely — your player, your annotations, and
your knowledge base all live in the same TiddlyWiki.

The audio player **survives layout switches and navigation** because it runs
as a singleton service attached to the document body, not inside any particular
tiddler render tree. The widget is just a UI shell that reconnects to that
persistent audio element on every render.

---

## Features

- 🎵 **Filter-driven playlists** — point the player at any TiddlyWiki filter
  and it builds your track list
- 📖 **Audiobook mode** — chapter navigation, auto-advance, weighted progress,
  and per-book position memory
- 📝 **Timestamped note capture** — tap for a point, hold for a range; each
  note becomes its own tiddler with full timecode metadata
- 🔊 **Inline snippet playback** — every annotation gets a "play this moment"
  button via the `<$sound-effect>` widget
- 🌊 **Waveform editor** — visual, zoomable, draggable canvas for precision
  editing of annotation boundaries with snap-to-silence
- 🎤 **Whisper transcription** — send a selected audio region to OpenAI's
  Whisper API and get text back into your note
- 💾 **Persistent position** — your playback position is saved to tiddler
  fields periodically, on pause, and on page unload
- 🎨 **Palette-aware theming** — reads your `$:/palette` colours and applies
  them as CSS custom properties
- 📱 **Media Session API** — control playback from your phone's lock screen
  or OS notification shade
- ⌨️ **Full keyboard shortcuts** — play/pause, skip, speed, capture, and
  navigate without touching the mouse

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Widgets](#widgets)
  - [`<$podcast-player>`](#podcast-player)
  - [`<$sound-effect>`](#sound-effect)
  - [`<$waveform-editor>`](#waveform-editor)
  - [`<$audio-notation>`](#audio-notation)
- [The Capture Workflow](#the-capture-workflow)
- [Audio Source Resolution](#audio-source-resolution)
- [Audiobook Mode](#audiobook-mode)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Event Bus](#event-bus)
- [Configuration](#configuration)
- [License](#license)

---



## Quick Start

Drop this into any tiddler:

```html
<$podcast-player filter="[type[audio/mpeg]sort[title]]" />
```

That's it. You get a player with transport controls, a track dropdown, and a
capture button. Start playing, and tap **📝 Capture Note** to create a
timestamped annotation tiddler.

For audiobooks:

```html
<$podcast-player
  filter="[tag[My Audiobook]sort[title]]"
  mode="audiobook"
  bookTiddler="My Audiobook"
/>
```

<img width="1346" height="986" alt="vivaldi_wb6i8vNG9A" src="https://github.com/user-attachments/assets/7ec99c37-cbd4-46e7-9027-f9c2b46d36de" />


---

## Architecture

AudioSuite is built around a **singleton audio service** that starts once as a
TiddlyWiki startup module and lives for the entire browser session.

```
┌──────────────────────────────────────────────────┐
│  document.body                                   │
│  ┌────────────────────────────────────────────┐  │
│  │ #AudioSuite-persistent-audio               │  │
│  │   <audio> element (hidden, position:fixed) │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ Player   │  │ Notation │  │ Sound Effect │   │
│  │ Widget   │  │ Widget   │  │ Widget       │   │
│  │ (UI)     │  │ (notes)  │  │ (snippets)   │   │
│  └────┬─────┘  └────┬─────┘  └──────────────┘   │
│       │              │                           │
│       └──────┬───────┘                           │
│              ▼                                   │
│     $tw.AudioSuite.service                       │
│     (singleton, startup module)                  │
└──────────────────────────────────────────────────┘
```

The `<audio>` element is appended to `document.body` inside a zero-size hidden
container. Widget instances talk to the service via `$tw.AudioSuite.service`
and a shared event bus in `audio-utils.js`. This means you can **switch
`$:/layout`, close the tiddler containing the player, navigate anywhere** — audio
keeps playing. When a player widget renders again, it reconnects to the service
and picks up the current state.


---

## Widgets

### `<$podcast-player>`

The main player interface. Renders transport controls, a seekbar, a track
dropdown, playback-rate selector, and a capture button.

#### Attributes

| Attribute | Default | Description |
|-----------|---------|-------------|
| `filter` | `""` | TiddlyWiki filter to build the playlist. If empty, a filter-entry UI is rendered. |
| `mode` | `"podcast"` | `"podcast"` or `"audiobook"`. Audiobook adds chapter nav, auto-advance, weighted progress. |
| `bookTiddler` | `""` | Tiddler title for the audiobook container. Used for chapter persistence and virtual tracks. |
| `srcField` | `""` | Optional field name on track tiddlers that points to another tiddler holding the audio URI. |
| `autoPause` | `"yes"` | Pause audio automatically when a note is captured. |
| `rewindOnResume` | `"3"` | Seconds to rewind when auto-resuming after capture. |
| `saveInterval` | `"5"` | How often (seconds) to persist playback position while playing. |

#### Filter Entry UI

When no `filter` attribute is provided, the player renders an input field with
a live preview showing the number of matching tiddlers. Type your filter, see
the count update, and hit **Load** to populate the track list.

 <img width="1274" height="1003" alt="vivaldi_1hdZSIM8KH" src="https://github.com/user-attachments/assets/426410a3-179f-4baa-835a-46fa2a65aab3" />


#### Transport Controls

| Control | Behaviour |
|---------|-----------|
| ▶ / ⏸ | Play / Pause |
| ⏪ / ⏩ | Skip ±10 seconds |
| ⏮ / ⏭ | Previous / Next chapter *(audiobook mode only)* |
| 🔄 Speed | Cycle 0.5× → 0.75× → 1× → 1.25× → 1.5× → 1.75× → 2× |
| 📝 Capture | Tap = point capture, Hold = range capture |
| ⬅ Back | Navigate to previous track/position from history stack |

<img width="1206" height="1149" alt="vivaldi_6ZL89wJBzV" src="https://github.com/user-attachments/assets/0a2a994f-575e-453d-81ef-30b551f9df21" />


#### Position Persistence

Your playback position is saved to the track tiddler's `audio-track-position`
field:

- **Periodically** while playing (default: every 5 seconds)
- **On pause** and **on capture**
- **On `beforeunload`** (closing the browser tab)

When you return and load the same track, AudioSuite restores your position
automatically. When a track finishes, the saved position is cleared so it
starts fresh next time.

For virtual tracks (see [Audiobook Mode](#audiobook-mode)), positions are
stored as a JSON blob in the book tiddler's `audio-track-positions` field
since virtual tracks don't have their own tiddler.

#### Media Session Integration

On supported browsers (Android Chrome, macOS Safari, desktop Chrome), AudioSuite
registers with the [Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API).
You get lock-screen / notification-shade controls with:

- Track title (from `caption` field, falling back to tiddler title)
- Artist (from `artist` or `author` field)
- Album art (from `cover` field, resolved through canonical URI)
- Play, Pause, Seek Forward/Backward, Next/Previous Track, Seek To

In audiobook mode, the notification title is prefixed with the book name:
*"My Book: Chapter 3"*.

---

### `<$sound-effect>`

A lightweight widget for one-shot audio playback. Wrap it around any content
and it becomes an audio trigger. Designed to be the inline "play this clip"
button for notation entries, but useful anywhere.

```html
<$sound-effect tiddler="My Recording" startTime="272" endTime="295" trigger="click">
  <$button class="tc-btn-invisible">▶ Play clip</$button>
</$sound-effect>
```

#### Attributes

| Attribute | Default | Description |
|-----------|---------|-------------|
| `src` | `""` | Direct audio URL. Takes priority over `tiddler`. |
| `tiddler` | `""` | Tiddler to resolve audio from via the [source resolution chain](#audio-source-resolution). |
| `volume` | `"1"` | Playback volume, `0` to `1`. |
| `trigger` | `"click"` | `"click"`, `"event"`, or `"none"`. |
| `autoplay` | `"no"` | `"yes"` to play immediately on render. |
| `startTime` | `""` | Start time in seconds. |
| `endTime` | `""` | End time in seconds. |
| `event` | `""` | Named event to listen for when `trigger="event"`. |

#### Trigger Modes

**`click`** — Clicking anywhere inside the widget fires playback. Also
attaches handlers directly to nested `<button>` elements for reliable event
propagation with TiddlyWiki's `<$button>`.

**`event`** — Listens on AudioSuite's event bus. The event payload can
override the audio source and time range, so the emitting widget only needs to
know the tiddler title:

```javascript
utils.emit('play-annotation-clip', {
  audioSource: "My Podcast Episode",
  startSeconds: 272,
  endSeconds: 295
});
```

**`autoplay`** — Plays immediately when the widget renders. Browser autoplay
policies apply.

#### Point Capture Fallback

If `startTime` equals `endTime` (a point capture), the widget automatically
expands the playback window to **20 seconds** past the start time so you hear
actual audio. The expansion is clamped to the file's duration.

```html
<!-- Point capture at 4:32 — plays 272s → 292s -->
<$sound-effect tiddler="lecture" startTime="272" endTime="272" trigger="click">
  <$button>▶ 04:32</$button>
</$sound-effect>
```

#### Cleanup

When the widget is removed from the DOM, it pauses audio, releases the media
resource (removes `src` and calls `load()`), and detaches all listeners. An
internal `_isDestroyed` flag ensures async callbacks (like `loadedmetadata`)
exit early if the widget has already been torn down.

---

### `<$waveform-editor>`

A visual, canvas-based editor for precisely adjusting the start and end times
of an annotation. Renders the full audio waveform with draggable boundary
handles, a minimap, and several precision tools.

<img width="1206" height="1333" alt="YC9zMb9UeG" src="https://github.com/user-attachments/assets/91b0cbed-054d-4a2d-bd32-acde65ad9709" />


#### Capabilities

| Feature | Description |
|---------|-------------|
| **Full waveform rendering** | Decodes audio via Web Audio API, computes peaks, caches result. Device-pixel-ratio aware for crisp Retina display. |
| **Draggable handles** | Drag start/end boundaries. Keyboard nudge with `←`/`→` (±1s) and `Shift+←`/`→` (±5s). |
| **Minimap** | Always shows the full track with a viewport indicator so you don't lose context when zoomed in. |
| **Zoom to Region / Full Track** | Toggle between zoomed view of the annotation region and full-track overview. |
| **Snap to Silence** | Automatically moves handles to the nearest silence boundaries — ideal for trimming speech clips. |
| **Amplitude scaling** | Slider to boost quiet waveforms up to 4× so subtle detail becomes visible. |
| **Pre-roll / Post-roll preview** | Listen to a few seconds before/after a handle position to verify your edit by ear. |
| **Loop playback** | Loop the selected region for continuous auditioning. Adjust handles in real time while looping. |
| **Set Start / Set End (listen mode)** | Plays the audio and lets you tap to place a boundary at the precise moment you hear. |
| **Whisper transcription** | Extracts the selected audio region and sends it to OpenAI's Whisper API for speech-to-text. |


<img width="1208" height="1340" alt="hWIb9PcgAX" src="https://github.com/user-attachments/assets/4fb1d515-4da1-4487-9e85-29859f96abb9" />


---

### `<$audio-notation>`

The notation widget displays all timestamped annotations for a track (or across
all tracks in the playlist) and handles creation, editing, seeking, and
organization of note tiddlers.

```html
<$audio-notation
  tiddler="My Podcast Episode"
  editable="yes"
  scope="track"
  bookTiddler="My Podcast Series"
/>
```

#### Attributes

| Attribute | Default | Description |
|-----------|---------|-------------|
| `tiddler` | `<<currentTiddler>>` | The parent track tiddler whose annotations are displayed. |
| `editable` | `"yes"` | Enable inline editing on double-click. |
| `class` | `""` | Additional CSS class for the container. |
| `extraTags` | `""` | Extra tags to apply to new notation tiddlers. |
| `bookTiddler` | `""` | Book tiddler for audiobook context. |
| `updateParent` | `"yes"` | Whether to write timecode links back into the parent tiddler. |
| `scope` | `"track"` | `"track"` shows notes for the current track; `"all"` aggregates notes across all playlist tracks. |

#### Notation Tiddlers

Each captured note becomes its own tiddler with these fields:

| Field | Example | Description |
|-------|---------|-------------|
| `title` | `$:/annotations/My-Episode/272-295` | Generated from a configurable template |
| `tags` | `My Podcast Episode` | Tagged with the parent track tiddler |
| `parent-tiddler` | `My Podcast Episode` | Back-reference to the track |
| `audio-source` | `podcast-audio-file` | Resolved audio source tiddler/URI |
| `start-seconds` | `272` | Numeric start time |
| `end-seconds` | `295` | Numeric end time |
| `start-timecode` | `04:32` | Formatted start time |
| `end-timecode` | `04:55` | Formatted end time |
| `indent` | `0` | Outline indentation level |
| `text` | `Key insight about...` | Your note content |

Title generation uses a configurable template tiddler at
`$:/plugins/NoteStreams/AudioSuite/notationTitleTemplate`. The default
template is `$:/annotations/{safeParent}/{start}-{end}`. Supported placeholders:

| Placeholder | Value |
|-------------|-------|
| `{parent}` | Raw parent tiddler title |
| `{safeParent}` | Sanitized title (unsafe characters replaced with `-`) |
| `{start}` | Start time in seconds |
| `{end}` | End time in seconds |
| `{start_time}` | Formatted start time (`MM:SS` or `HH:MM:SS`) |
| `{end_time}` | Formatted end time |

Automatic deduplication appends `-1`, `-2`, etc. if a title already exists.

#### Entry Display

Each notation entry shows:

- **Timecode badge** — clickable, seeks the player to that point
- **📄 Open button** — opens the notation tiddler in the story river via
  `tm-navigate`
- **Note content** — rendered as paragraphs with support for outline-style
  indentation (4 spaces per level, rendered as 24px left margin)

Double-click an entry to open an inline editor.

#### Scope Toggle

When the playlist contains more than one track, a toggle button appears in
the header. Switch between:

- **📄 Current Track** — shows only the current track's annotations
- **📋 All Tracks** — aggregates annotations from every track in the playlist,
  grouped by track with section headers

<img width="1299" height="861" alt="vivaldi_BjpqA8C2eu" src="https://github.com/user-attachments/assets/4efb5379-6e20-4a4e-9800-4a193d16dd36" />


#### Parent Timecode Links

When `updateParent="yes"`, AudioSuite inserts clickable timecode links back
into the parent tiddler's text. A global click handler (registered once)
listens for clicks on `.AudioSuite-parent-timecode` elements and emits
`AudioSuite:seek` events, so timecodes work anywhere the parent tiddler is
transcluded. Clicking a timecode in the parent resolves the current
`start-seconds` from the notation tiddler dynamically, so edits to time
boundaries are always reflected.

#### Migration from Legacy Format

If you previously used a single-tiddler format (inline `[MM:SS] Note text`
lines in the parent tiddler), the notation widget detects this on first render
and migrates entries into individual notation tiddlers. The old-format parser
is retained only for this one-time migration path.

---

## The Capture Workflow

This is the core interaction loop that makes AudioSuite useful for active
listening.

### Tap Capture (Point)

Quick-tap the **📝 Capture Note** button. A point-in-time annotation is
created at the current playback position. You'll see a brief
**"✓ Captured at 04:32"** flash confirmation.

### Hold Capture (Range)

Press and hold the capture button for more than 300ms. The button changes to
**"🔴 Recording…"** — audio keeps playing. When you release, a range
annotation is created from the moment you pressed to the moment you released:
**"✓ Captured 05:10 → 05:38"**.


### Auto-Pause and Rewind-on-Resume

When a note is captured (with `autoPause="yes"`), audio pauses automatically
so you can write your note. When you finish and close the editor, audio
**resumes with a configurable rewind** (default 3 seconds) so you don't lose
the thread of what you were listening to.

The coordination works through the event bus:
1. Capture emits `AudioSuite:timecode-captured`
2. The notation widget creates the tiddler and opens the editor
3. On editor close, `AudioSuite:notation-editor-closed` is emitted
4. The audio service receives the event, rewinds, and resumes playback



### Capture Event Payload

The `AudioSuite:timecode-captured` event carries everything downstream widgets
need:

```javascript
{
  startSeconds: 272,
  endSeconds: 295,           // same as startSeconds for point captures
  startTimecode: "04:32",
  endTimecode: "04:55",
  trackTitle: "My Episode",
  audioSource: "episode-audio",
  isVirtualTrack: false,
  bookTiddler: "",
  openEditor: true
}
```

---

## Audio Source Resolution

AudioSuite has a flexible, multi-strategy source resolver that finds the actual
audio URL from a tiddler. The `resolveAudioSrc()` utility checks in
this order:

```
1. srcField pointer → resolve that tiddler's URI fields
2. _canonical_uri / canonical_uri / canonicalUri
3. src / url fields
4. Inline base64 audio (tiddler type is audio/*, text is base64 content)
```

If a `srcField` is configured (e.g., `srcField="audio-file"`), the resolver
first reads that field. If the value is a tiddler title, it follows the
pointer and resolves *that* tiddler's canonical URI. If the value looks like a
URL (contains `://` or starts with `/`), it's used directly.

This means AudioSuite works with:
- **External files** via `_canonical_uri`
- **TiddlyWiki's native audio tiddlers** (inline base64)
- **Pointer fields** referencing shared audio tiddlers
- **Virtual tracks** from data dictionaries (see below)
- **Direct URLs** in `src` or `url` fields

---

## Audiobook Mode

Set `mode="audiobook"` and `bookTiddler="My Book"` to unlock audiobook-specific
behaviour.

### Chapter Navigation

- **⏮ / ⏭ buttons** appear in the transport controls for previous/next chapter
- **Auto-advance**: when a chapter ends, the next one loads and plays
  automatically
- **Current chapter** is saved to the book tiddler's `audio-current-track`
  field, so reopening the wiki resumes at the right chapter

### Weighted Progress

In audiobook mode, the player displays overall progress across all chapters:

> *Overall: 34.2% (Track 2 of 6)*


### Virtual Tracks

If you have an `application/x-tiddler-dictionary` tiddler tagged with your book
tiddler, AudioSuite merges those key→URI entries into the playlist. This lets
you define an entire chapter list without creating individual tiddlers for
each audio file:

```
Chapter 1: https://example.com/ch01.mp3
Chapter 2: https://example.com/ch02.mp3
Chapter 3: https://example.com/ch03.mp3
```

Positions for virtual tracks are stored as a JSON blob in the book tiddler's
`audio-track-positions` field (since the tracks don't exist as real tiddlers).

### Track History and Back Button

Every track change is pushed onto a history stack (max 20 entries). The
**⬅ Back** button pops the stack and restores both the track and your exact
playback position — even resuming playback if you were playing when you
navigated away.

---

## Keyboard Shortcuts

When the player has focus:

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` | Skip back 10s |
| `→` | Skip forward 10s |
| `Shift + ←` | Skip back 30s |
| `Shift + →` | Skip forward 30s |
| `[` | Decrease playback speed |
| `]` | Increase playback speed |
| `N` | Capture note at current time |
| `B` | Navigate back (history) |

In the waveform editor:

| Key | Action |
|-----|--------|
| `←` / `→` | Nudge selected handle ±1s |
| `Shift + ←` / `→` | Nudge selected handle ±5s |
| `T` | Transcribe selected region (Whisper) |

---

## Event Bus

AudioSuite uses a simple publish/subscribe event bus (in `audio-utils.js`) for
decoupled communication between widgets and the service.

### Core Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `AudioSuite:timecode-captured` | Player → Notation | `{ startSeconds, endSeconds, startTimecode, endTimecode, trackTitle, audioSource, isVirtualTrack, bookTiddler, openEditor }` |
| `AudioSuite:notation-editor-closed` | Notation → Service | `{ entryTitle, skipEditor }` |
| `AudioSuite:seek` | Any → Service | `{ seconds, track, audioSource }` |
| `service:timeupdate` | Service → Widgets | `{ currentTime, duration }` |
| `service:statechange` | Service → Widgets | `{ playing, track, rate }` |
| `service:trackchanged` | Service → Widgets | `{ track, playlist }` |
| `service:ended` | Service → Widgets | `{ track }` |
| `service:error` | Service → Widgets | `{ error }` |

### Using the Event Bus

```javascript
var utils = require("$:/plugins/NoteStreams/AudioSuite/js/audio-utils.js");

// Listen
utils.on('AudioSuite:timecode-captured', function(data) {
  console.log('Captured at', data.startTimecode);
});

// Emit
utils.emit('AudioSuite:seek', { seconds: 120, track: 'My Episode' });

// Unlisten
utils.off('AudioSuite:timecode-captured', myHandler);
```

---

## Configuration

### Service Configuration

The player widget calls `service.configure()` with its attributes. You can also
configure the service directly:

```javascript
$tw.AudioSuite.service.configure({
  persistPosition: true,     // Save/restore playback position
  saveInterval: 5,           // Seconds between position saves (min: 2)
  autoPause: true,           // Pause on note capture
  rewindOnResume: 3,         // Seconds to rewind on auto-resume
  mode: 'podcast',           // 'podcast' or 'audiobook'
  bookTiddler: '',           // Book tiddler for audiobook mode
  srcField: ''               // Field name for audio source pointer
});
```

### Notation Title Template

Create a tiddler at `$:/plugins/NoteStreams/AudioSuite/notationTitleTemplate`
with your preferred pattern:

```
$:/annotations/{safeParent}/{start_time}-{end_time}
```

Default: `$:/annotations/{safeParent}/{start}-{end}`

---


## License

Copyright © 2026 Thomas E. Tuoti (~well-noted)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
