// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Keeps the audio sources that must never go on air muted, and checks the one
// that should be live.
//
// Audio is meant to come only from a USB sound card. So, in OBS:
//   * every camera source (macos-avcapture - this includes the GoPro's mic and
//     the Mac's own camera mic) is kept MUTED;
//   * every audio input set to the macOS "Default" device, or to the Mac's
//     built-in microphone, is kept MUTED (the default input is the built-in
//     microphone whenever the sound card isn't plugged in, and can change);
//   * any other audio input (the USB sound card, picked by name in OBS) is left
//     alone, but checked: present on the Mac, and not muted.
// Muting is re-applied on every connection to OBS and every 10 seconds, so
// nobody un-muting by accident (or OBS being reset) leaves a mic open.
// Extra inputs to always mute can be listed in config/audio.json:
//   { "alwaysMuted": ["Some Input Name"] }

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('./logger.js');

const AUDIO_KINDS = new Set(['macos-avcapture', 'coreaudio_input_capture']);

function config() {
    try { return { alwaysMuted: [], ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'audio.json'), 'utf8')) }; } catch { return { alwaysMuted: [] }; }
}

// 'camera' | 'internal' | 'soundcard' | 'config' (explicitly listed) | null (not ours to touch)
function roleOf(input, settings, cfg) {
    if ((cfg.alwaysMuted || []).includes(input.inputName)) return 'config';
    if (input.inputKind === 'macos-avcapture') return 'camera';
    if (input.inputKind === 'coreaudio_input_capture') {
        const id = String((settings && settings.device_id) || '');
        if (!id || id === 'default' || /built-?in|macbook/i.test(id)) return 'internal';
        return 'soundcard';
    }
    return null;
}

// Look at every audio-capable input in OBS; mute (and report) any that must be.
// Returns { mustBeMuted: [{name, role, wasMuted, nowMuted}], soundcards: [{name, deviceId, muted}], changed: [names], errors: [] }
async function enforce(obs, { apply = true } = {}) {
    const cfg = config();
    const out = { mustBeMuted: [], soundcards: [], changed: [], errors: [] };
    const list = (await obs.request('GetInputList')).inputs || [];
    for (const input of list) {
        if (!AUDIO_KINDS.has(input.inputKind) && !(cfg.alwaysMuted || []).includes(input.inputName)) continue;
        let settings = {};
        try { settings = (await obs.request('GetInputSettings', { inputName: input.inputName })).inputSettings || {}; } catch { /* leave empty */ }
        const role = roleOf(input, settings, cfg);
        if (!role) continue;
        let muted;
        try { muted = (await obs.request('GetInputMute', { inputName: input.inputName })).inputMuted; }
        catch (e) { out.errors.push(`${input.inputName}: ${e.message}`); continue; }
        if (role === 'soundcard') { out.soundcards.push({ name: input.inputName, deviceId: settings.device_id, muted }); continue; }
        const entry = { name: input.inputName, role, wasMuted: muted, nowMuted: muted };
        if (!muted && apply) {
            try {
                await obs.request('SetInputMute', { inputName: input.inputName, inputMuted: true });
                entry.nowMuted = (await obs.request('GetInputMute', { inputName: input.inputName })).inputMuted;
                out.changed.push(input.inputName);
                logger.info('audio: muted an input that must stay muted', { input: input.inputName, role });
            } catch (e) { out.errors.push(`${input.inputName}: could not mute - ${e.message}`); }
        }
        out.mustBeMuted.push(entry);
    }
    return out;
}

// Names of audio input devices the Mac currently sees.
function macInputDevices() {
    return new Promise((resolve) => {
        execFile('system_profiler', ['SPAudioDataType', '-json'], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
            if (err) return resolve([]);
            try {
                const items = (JSON.parse(stdout).SPAudioDataType || []).flatMap((g) => g._items || []);
                resolve(items.filter((i) => i.coreaudio_device_input).map((i) => i._name));
            } catch { resolve([]); }
        });
    });
}

// Going on air: switch ON the mixer / sound card input(s) that are plugged in (it is the stream's
// sound, and is normally left muted until then). Returns the names it switched on.
async function unmuteSoundcards(obs) {
    const a = await enforce(obs, { apply: false });
    const mac = await macInputDevices();
    const switched = [];
    for (const c of a.soundcards) {
        if (!c.muted || !mac.some((n) => (c.deviceId || '').includes(n))) continue;
        try {
            await obs.request('SetInputMute', { inputName: c.name, inputMuted: false });
            switched.push(c.name);
            logger.info('audio: switched on the mixer / sound card input for going live', { input: c.name });
        } catch (e) { logger.warn('audio: could not unmute the mixer input', { input: c.name, error: e.message }); }
    }
    return switched;
}

module.exports = { enforce, macInputDevices, roleOf, unmuteSoundcards };
