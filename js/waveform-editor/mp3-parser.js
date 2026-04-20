/*\
title: $:/plugins/NoteStreams/AudioSuite/js/waveform-editor/mp3-parser.js
type: application/javascript
module-type: library
\*/
(function(){
"use strict";

/**
 * MP3 Parsing and Seeking Utilities
 * 
 * This module provides functions for parsing MP3 file headers, detecting
 * VBR (Variable Bit Rate) metadata (Xing/VBRI headers), and calculating
 * byte offsets for time-based seeking.
 */

// Find first valid MP3 frame sync in a Uint8Array
function findFirstFrameSync(uint8Array, startOffset) {
    for (var i = (startOffset || 0); i < uint8Array.length - 1; i++) {
        if (uint8Array[i] === 0xFF && (uint8Array[i + 1] & 0xE0) === 0xE0) {
            if (i + 3 < uint8Array.length) {
                var bitrateIdx = (uint8Array[i + 2] >> 4) & 0x0F;
                var srIdx = (uint8Array[i + 2] >> 2) & 0x03;
                if (bitrateIdx !== 0x0F && bitrateIdx !== 0x00 && srIdx !== 0x03) {
                    return i;
                }
            }
        }
    }
    return -1;
}

// Parse MP3 header bytes (first few KB) and return basic info or null
function parseMp3Info(headerBuffer) {
    try {
        if (!headerBuffer || headerBuffer.byteLength < 4) return null;
        var u8 = new Uint8Array(headerBuffer);
        var offset = 0;
        
        // Skip ID3v2 tag if present
        if (u8.length >= 3 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
            // synchsafe int at 6..9
            if (u8.length >= 10) {
                var size = (u8[6] & 0x7F) << 21 | (u8[7] & 0x7F) << 14 | (u8[8] & 0x7F) << 7 | (u8[9] & 0x7F);
                offset = 10 + size;
            } else {
                return null;
            }
        }

        var frameStart = findFirstFrameSync(u8, offset);
        if (frameStart < 0 || frameStart + 4 > u8.length) return null;

        // Read 4-byte header
        var b0 = u8[frameStart];
        var b1 = u8[frameStart + 1];
        var b2 = u8[frameStart + 2];
        var b3 = u8[frameStart + 3];

        var versionBits = (b1 >> 3) & 0x03; // 00 MPEG2.5, 10 MPEG2, 11 MPEG1
        var layerBits = (b1 >> 1) & 0x03; // 01 Layer III, 10 Layer II, 11 Layer I
        var protection = b1 & 0x01;
        var bitrateIdx = (b2 >> 4) & 0x0F;
        var srIdx = (b2 >> 2) & 0x03;
        var padding = (b2 >> 1) & 0x01;
        var channelMode = (b3 >> 6) & 0x03; // 3 = mono

        // Map versionBits to human-friendly id
        var mpegVersion;
        if (versionBits === 3) mpegVersion = 1; // MPEG1
        else if (versionBits === 2) mpegVersion = 2; // MPEG2
        else if (versionBits === 0) mpegVersion = 2.5; // MPEG2.5
        else return null;

        // Layer mapping: 3->Layer I, 2->Layer II, 1->Layer III
        var layer;
        if (layerBits === 3) layer = 1; else if (layerBits === 2) layer = 2; else if (layerBits === 1) layer = 3; else return null;

        // Sample rate table
        var sampleRateTable = {
            '1': [44100, 48000, 32000],
            '2': [22050, 24000, 16000],
            '2.5': [11025, 12000, 8000]
        };
        var sampleRates = sampleRateTable[String(mpegVersion)];
        if (!sampleRates || srIdx >= sampleRates.length) return null;
        var sampleRate = sampleRates[srIdx];

        // Bitrate tables (kbps)
        var mp1_layer1 = [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448, null];
        var mp1_layer2 = [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384, null];
        var mp1_layer3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320, null];
        var mp2_layer1 = [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256, null];
        var mp2_layer2_3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160, null];

        var bitrateKbps = null;
        if (mpegVersion === 1) {
            if (layer === 1) bitrateKbps = mp1_layer1[bitrateIdx];
            else if (layer === 2) bitrateKbps = mp1_layer2[bitrateIdx];
            else if (layer === 3) bitrateKbps = mp1_layer3[bitrateIdx];
        } else {
            if (layer === 1) bitrateKbps = mp2_layer1[bitrateIdx];
            else bitrateKbps = mp2_layer2_3[bitrateIdx];
        }
        if (!bitrateKbps || bitrateIdx === 0 || bitrateIdx === 15) return null;
        var bitrate = bitrateKbps * 1000;

        // Frame length
        var frameLength = 0;
        if (layer === 1) {
            frameLength = Math.floor((12 * bitrate) / sampleRate + padding) * 4;
        } else {
            frameLength = Math.floor((144 * bitrate) / sampleRate) + padding;
        }

        // Side info size for Xing detection
        var sideInfoSize = 0;
        var isMono = (channelMode === 3);
        if (mpegVersion === 1) {
            sideInfoSize = isMono ? 17 : 32;
        } else {
            sideInfoSize = isMono ? 9 : 17;
        }

        var firstFrameEnd = frameStart + frameLength;
        if (firstFrameEnd > u8.length) firstFrameEnd = u8.length;

        var isVBR = false;
        var totalBytes = null;
        var totalFrames = null;
        var tocEntries = null;

        // Search for Xing/Info tag inside first frame
        try {
            var xingOffset = frameStart + 4 + sideInfoSize;
            if (xingOffset + 4 < u8.length) {
                var tag = String.fromCharCode(u8[xingOffset], u8[xingOffset+1], u8[xingOffset+2], u8[xingOffset+3]);
                if (tag === 'Xing' || tag === 'Info') {
                    isVBR = true;
                    var flagsOff = xingOffset + 4;
                    var flags = (u8[flagsOff] << 24) | (u8[flagsOff+1] << 16) | (u8[flagsOff+2] << 8) | (u8[flagsOff+3]);
                    var ptr = flagsOff + 4;
                    if (flags & 0x0001) { // frames
                        if (ptr + 4 <= u8.length) {
                            totalFrames = (u8[ptr] << 24) | (u8[ptr+1] << 16) | (u8[ptr+2] << 8) | (u8[ptr+3]);
                        }
                        ptr += 4;
                    }
                    if (flags & 0x0002) { // bytes
                        if (ptr + 4 <= u8.length) {
                            totalBytes = (u8[ptr] << 24) | (u8[ptr+1] << 16) | (u8[ptr+2] << 8) | (u8[ptr+3]);
                        }
                        ptr += 4;
                    }
                    if (flags & 0x0004) { // TOC
                        if (ptr + 100 <= u8.length) {
                            tocEntries = new Uint8Array(100);
                            for (var ti = 0; ti < 100; ti++) tocEntries[ti] = u8[ptr + ti];
                        }
                        ptr += 100;
                    }
                }
            }
        } catch(e) { /* ignore */ }

        // VBRI check at offset 36 from frame start
        try {
            var vbOff = frameStart + 36;
            if (vbOff + 4 < u8.length) {
                var vbTag = String.fromCharCode(u8[vbOff], u8[vbOff+1], u8[vbOff+2], u8[vbOff+3]);
                if (vbTag === 'VBRI') {
                    isVBR = true;
                    if (vbOff + 14 + 4 <= u8.length) {
                        totalBytes = (u8[vbOff+10] << 24) | (u8[vbOff+11] << 16) | (u8[vbOff+12] << 8) | (u8[vbOff+13]);
                        totalFrames = (u8[vbOff+14] << 24) | (u8[vbOff+15] << 16) | (u8[vbOff+16] << 8) | (u8[vbOff+17]);
                    }
                }
            }
        } catch(e) { /* ignore */ }

        // Estimate duration if possible
        var duration = null;
        try {
            if (totalFrames && sampleRate) {
                var samplesPerFrame = (layer === 3) ? ((mpegVersion === 1) ? 1152 : 576) : 1152;
                duration = totalFrames * samplesPerFrame / sampleRate;
            }
        } catch(e) {}

        return {
            bitrate: bitrate,
            sampleRate: sampleRate,
            isVBR: !!isVBR,
            dataStart: frameStart,
            totalBytes: totalBytes || null,
            totalFrames: totalFrames || null,
            tocEntries: tocEntries || null,
            duration: duration || null
        };
    } catch (e) {
        return null;
    }
}

// Given mp3Info and time in seconds, estimate byte offset using Xing TOC
function xingSeekByte(mp3Info, timeSec) {
    try {
        if (!mp3Info || !mp3Info.tocEntries || !mp3Info.duration || !mp3Info.totalBytes) return null;
        var percent = Math.max(0, Math.min(100, (timeSec / mp3Info.duration) * 100));
        var tocIndex = Math.min(99, Math.floor(percent));
        var tocFrac = percent - tocIndex;
        var tocVal;
        if (tocIndex >= 99) {
            tocVal = mp3Info.tocEntries[99];
        } else {
            tocVal = mp3Info.tocEntries[tocIndex] + tocFrac * (mp3Info.tocEntries[tocIndex + 1] - mp3Info.tocEntries[tocIndex]);
        }
        return Math.floor((tocVal / 256) * mp3Info.totalBytes) + (mp3Info.dataStart || 0);
    } catch (e) { return null; }
}

// Parse an MP3 frame header at a given position in a Uint8Array
function parseMp3HeaderAt(u8, pos) {
    try {
        if (!u8 || pos + 4 > u8.length) return null;
        var b0 = u8[pos];
        var b1 = u8[pos + 1];
        var b2 = u8[pos + 2];
        var b3 = u8[pos + 3];
        if (b0 !== 0xFF || (b1 & 0xE0) !== 0xE0) return null;

        var versionBits = (b1 >> 3) & 0x03;
        var layerBits = (b1 >> 1) & 0x03;
        var bitrateIdx = (b2 >> 4) & 0x0F;
        var srIdx = (b2 >> 2) & 0x03;
        var padding = (b2 >> 1) & 0x01;

        var mpegVersion;
        if (versionBits === 3) mpegVersion = 1;
        else if (versionBits === 2) mpegVersion = 2;
        else if (versionBits === 0) mpegVersion = 2.5;
        else return null;
        
        var layer;
        if (layerBits === 3) layer = 1;
        else if (layerBits === 2) layer = 2;
        else if (layerBits === 1) layer = 3;
        else return null;

        var sampleRateTable = {
            '1': [44100, 48000, 32000],
            '2': [22050, 24000, 16000],
            '2.5': [11025, 12000, 8000]
        };
        var sampleRates = sampleRateTable[String(mpegVersion)];
        if (!sampleRates || srIdx >= sampleRates.length) return null;
        var sampleRate = sampleRates[srIdx];

        var mp1_layer1 = [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448, null];
        var mp1_layer2 = [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384, null];
        var mp1_layer3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320, null];
        var mp2_layer1 = [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256, null];
        var mp2_layer2_3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160, null];

        var bitrateKbps = null;
        if (mpegVersion === 1) {
            if (layer === 1) bitrateKbps = mp1_layer1[bitrateIdx];
            else if (layer === 2) bitrateKbps = mp1_layer2[bitrateIdx];
            else if (layer === 3) bitrateKbps = mp1_layer3[bitrateIdx];
        } else {
            if (layer === 1) bitrateKbps = mp2_layer1[bitrateIdx];
            else bitrateKbps = mp2_layer2_3[bitrateIdx];
        }
        if (!bitrateKbps || bitrateIdx === 0 || bitrateIdx === 15) return null;
        var bitrate = bitrateKbps * 1000;

        var frameLength = 0;
        if (layer === 1) {
            frameLength = Math.floor((12 * bitrate) / sampleRate + padding) * 4;
        } else {
            frameLength = Math.floor((144 * bitrate) / sampleRate) + padding;
        }

        var samplesPerFrame = (layer === 3) ? ((mpegVersion === 1) ? 1152 : 576) : 1152;

        return { bitrate: bitrate, sampleRate: sampleRate, frameLength: frameLength, samplesPerFrame: samplesPerFrame };
    } catch (e) { return null; }
}

// Scan MP3 frames from a Uint8Array and estimate byte offsets for padded start/end seconds
function estimateByteRangeByFrameScan(arrayBuffer, padStartSec, padEndSec, maxBytesScan) {
    try {
        var u8 = new Uint8Array(arrayBuffer);
        var totalLen = u8.length;

        // Skip ID3v2 tag if present
        var scanStart = 0;
        try {
            if (totalLen >= 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
                var id3Size = (u8[6] & 0x7F) << 21 | (u8[7] & 0x7F) << 14 |
                              (u8[8] & 0x7F) << 7 | (u8[9] & 0x7F);
                scanStart = 10 + id3Size;
                if (scanStart >= totalLen) return null;
            }
        } catch(e) {}

        var firstSync = findFirstFrameSync(u8, scanStart);
        if (firstSync < 0) return null;
        var i = firstSync;
        var cumTime = 0;
        var startByte = null;
        var endByte = null;
        var scanned = 0;
        var framesFound = 0;
        var resyncBytes = 0;
        maxBytesScan = maxBytesScan || u8.length;

        while (i + 4 <= totalLen && scanned < maxBytesScan) {
            var hdr = parseMp3HeaderAt(u8, i);
            if (!hdr || hdr.frameLength <= 0) {
                i++;
                scanned++;
                resyncBytes++;
                continue;
            }
            var frameStart = i;
            var frameEnd = i + hdr.frameLength;
            if (frameEnd > totalLen) frameEnd = totalLen;
            var fdur = hdr.samplesPerFrame / hdr.sampleRate;
            var nextCum = cumTime + fdur;

            if (startByte === null && nextCum >= padStartSec) {
                startByte = frameStart;
            }
            if (endByte === null && nextCum >= padEndSec) {
                endByte = frameEnd;
                break;
            }

            cumTime = nextCum;
            scanned += hdr.frameLength;
            framesFound++;
            i += hdr.frameLength;
        }

        if (startByte !== null && endByte === null) endByte = totalLen - 1;
        if (startByte === null || endByte === null) return null;
        
        return { startByte: startByte, endByte: endByte };
    } catch (e) { return null; }
}

// Neutralize Xing/Info/VBRI header in a combined MP3 buffer
function neutralizeVbrHeaders(combined, mp3Info) {
    try {
        if (!mp3Info || mp3Info.dataStart < 0) return;
        
        var channelMode = (combined[mp3Info.dataStart + 3] >> 6) & 0x03;
        var isMono = (channelMode === 3);
        var vBits = (combined[mp3Info.dataStart + 1] >> 3) & 0x03;
        var mpgVer = (vBits === 3) ? 1 : 2;
        var sideInfoSize = 0;
        if (mpgVer === 1) sideInfoSize = isMono ? 17 : 32;
        else sideInfoSize = isMono ? 9 : 17;

        var xOff = mp3Info.dataStart + 4 + sideInfoSize;
        if (xOff + 4 <= combined.length) {
            var tagId = String.fromCharCode(combined[xOff], combined[xOff+1], combined[xOff+2], combined[xOff+3]);
            if (tagId === 'Xing' || tagId === 'Info') {
                combined[xOff] = 0; combined[xOff+1] = 0; combined[xOff+2] = 0; combined[xOff+3] = 0;
            }
        }
        
        var vbriOff = mp3Info.dataStart + 36;
        if (vbriOff + 4 <= combined.length) {
            var vbriTag = String.fromCharCode(combined[vbriOff], combined[vbriOff+1], combined[vbriOff+2], combined[vbriOff+3]);
            if (vbriTag === 'VBRI') {
                combined[vbriOff] = 0; combined[vbriOff+1] = 0; combined[vbriOff+2] = 0; combined[vbriOff+3] = 0;
            }
        }
    } catch(e) {}
}

// Exports
exports.findFirstFrameSync = findFirstFrameSync;
exports.parseMp3Info = parseMp3Info;
exports.xingSeekByte = xingSeekByte;
exports.parseMp3HeaderAt = parseMp3HeaderAt;
exports.estimateByteRangeByFrameScan = estimateByteRangeByFrameScan;
exports.neutralizeVbrHeaders = neutralizeVbrHeaders;

})();
