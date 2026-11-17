#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Gets the GoPro ready for OBS, so there is nothing to "initialise" by hand:
//   1. starts the GoPro Webcam app if it isn't running (it puts the camera into
//      webcam mode and provides the "GoPro Webcam" camera to apps)
//   2. waits for the camera to show up (USB + camera list)
//   3. points OBS's GoPro source at the camera's CURRENT id. macOS gives the
//      GoPro Webcam a new random id every time the camera is (re)connected, and
//      OBS can only find a camera by id - so without this OBS says "unable to
//      initialize device" and the camera has to be re-picked in the source's
//      properties each time.
//
// It also switches on OBS's remote-control server (localhost only, password
// protected) which the control room uses to check, preview and, later, start
// and stop OBS. OBS keeps its settings in memory and overwrites them on quit,
// so both changes can only be made while OBS is CLOSED. Once remote control is
// on, a stale camera id no longer needs OBS closed - the control room re-points
// the camera source live.
//
// Exit codes: 0 ready / 2 camera not found / 3 OBS is open and needs a restart
// (remote control still off).

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = 'GoPro Webcam';
const SCENES_DIR = process.env.OBS_SCENES_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'obs-studio', 'basic', 'scenes');
const BACKUP_ROOT = path.join(path.dirname(path.dirname(SCENES_DIR)), 'backups');
const WS_CONFIG = process.env.OBS_WEBSOCKET_CONFIG || path.join(os.homedir(), 'Library', 'Application Support', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(m);

function sh(cmd, args) {
    try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }); } catch { return ''; }
}
const isRunning = (pattern) => spawnSync('pgrep', ['-f', pattern]).status === 0;
const obsRunning = () => spawnSync('pgrep', ['-x', process.env.OBS_PROCESS_NAME || 'OBS']).status === 0;

function goproOnUsb() {
    return /Vendor ID:\s*0x2672/i.test(sh('system_profiler', ['SPUSBDataType']));
}
function goproCameraId() {
    try {
        const d = JSON.parse(sh('system_profiler', ['SPCameraDataType', '-json']));
        const cam = (d.SPCameraDataType || []).find((c) => c._name === APP);
        return cam ? cam['spcamera_unique-id'] : null;
    } catch { return null; }
}


// Make sure OBS's remote-control server is switched on. Returns
// { on, changed, needsRestart }.
function enableRemoteControl() {
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(WS_CONFIG, 'utf8')); } catch { /* none yet */ }
    if (cfg && cfg.server_enabled) return { on: true, changed: false, needsRestart: false };
    if (obsRunning()) return { on: false, changed: false, needsRestart: true };
    cfg = { alerts_enabled: false, auth_required: true, first_load: false, server_port: 4455, ...(cfg || {}), server_enabled: true };
    if (cfg.auth_required && !cfg.server_password) cfg.server_password = require('crypto').randomBytes(12).toString('base64url');
    fs.mkdirSync(path.dirname(WS_CONFIG), { recursive: true });
    try {
        const dir = path.join(BACKUP_ROOT, `${new Date().toISOString().slice(0, 10)}-camera-id`);
        fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(WS_CONFIG)) fs.copyFileSync(WS_CONFIG, path.join(dir, 'obs-websocket-config.json'));
    } catch { /* backup is best effort */ }
    fs.writeFileSync(WS_CONFIG, JSON.stringify(cfg, null, 4));
    return { on: true, changed: true, needsRestart: false };
}

(async () => {
    const remote = enableRemoteControl();
    if (remote.changed) say('Switched on OBS remote control (localhost only) for the control room.');
    if (!goproOnUsb()) {
        say('GoPro not found on USB. Plug it in with the USB-C cable, switch it on, and')
        say('on the camera set Preferences > Connections > USB Connection to "GoPro Connect".');
        process.exit(2);
    }
    say('GoPro found on USB.');

    if (!isRunning(`${APP}.app`)) {
        say(`Starting the ${APP} app...`);
        spawnSync('open', ['-a', APP]);
    }

    let id = null;
    for (let i = 0; i < 20 && !id; i++) {
        id = goproCameraId();
        if (!id) await sleep(1000);
    }
    if (!id) {
        say(`The camera is connected but "${APP}" hasn't appeared in the camera list. Check the`);
        say(`${APP} app is running (menu bar) and unplug/replug the camera, then try again.`);
        process.exit(2);
    }
    say(`Camera ready. Current camera id: ${id}`);

    let files = [];
    try { files = fs.readdirSync(SCENES_DIR).filter((f) => f.endsWith('.json')); } catch { /* none */ }
    let changedAny = false;
    let staleWhileRunning = false;
    for (const f of files) {
        const file = path.join(SCENES_DIR, f);
        let data;
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
        let touched = false;
        // OBS keeps the global audio inputs (Mic/Aux) at the top level of the scene
        // collection, not in "sources" - same rule: the Mac's default/built-in mic stays muted.
        for (const [key, g] of Object.entries(data)) {
            if (!/^AuxAudioDevice\d+$/.test(key) || !g || g.id !== 'coreaudio_input_capture') continue;
            const id = (g.settings && g.settings.device_id) || '';
            if ((!id || id === 'default' || /built-?in|macbook/i.test(id)) && g.muted !== true) {
                g.muted = true;
                touched = true;
                say(`Muted "${g.name || key}" in the OBS scene (built-in / default microphone).`);
            }
        }
        for (const src of data.sources || []) {
            const s = src.settings || {};
            // Camera mics and anything on the Mac's "Default"/built-in input stay
            // muted - audio is meant to come from the USB sound card only.
            const mustMute = src.id === 'macos-avcapture'
                || (src.id === 'coreaudio_input_capture' && (!s.device_id || s.device_id === 'default' || /built-?in|macbook/i.test(s.device_id)));
            if (mustMute && src.muted !== true) {
                src.muted = true;
                touched = true;
                say(`Muted "${src.name}" in the OBS scene (camera / built-in microphone).`);
            }
            if (src.id !== 'macos-avcapture' || s.device_name !== APP) continue;
            if (s.device === id) { say(`OBS source "${src.name}" already points at this camera.`); continue; }
            if (obsRunning()) { staleWhileRunning = true; continue; }
            s.device = id;
            touched = true;
            say(`Pointed OBS source "${src.name}" at the camera.`);
        }
        if (touched) {
            const dir = path.join(BACKUP_ROOT, `${new Date().toISOString().slice(0, 10)}-camera-id`);
            fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(file, path.join(dir, f));
            fs.writeFileSync(file, JSON.stringify(data, null, 4));
            changedAny = true;
        }
    }
    if (remote.needsRestart) {
        say('');
        say('OBS is already open and its remote control is still off, so the control room');
        say('cannot see or fix anything yet. Quit OBS (Cmd+Q) and run this again.');
        process.exit(3);
    }
    if (staleWhileRunning) {
        say('OBS is open with an old camera id - the control room will re-point it live.');
    }
    if (changedAny) say('OBS scene updated (a backup of the old one is in obs-studio/backups).');
    process.exit(0);
})();
