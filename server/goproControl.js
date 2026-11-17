// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Talks to a USB-connected GoPro over its Open GoPro HTTP API.
//
// Over USB the camera appears as a network adapter; its address is derived
// from the last three digits of its serial number: serial ...XYZ -> 172.2X.1YZ.51
// (e.g. serial C3531325197242 -> 172.22.142.51).
//
// Only used for light-touch things: finding the camera, reading its state and
// setting the anti-flicker frequency (50Hz for UK mains lighting - avoids
// banding under pool lights). Webcam mode itself (resolution, field of view)
// is started and held by the GoPro Webcam app; we don't fight it.

const { execFile } = require('child_process');
const logger = require('./logger.js');

const GOPRO_VENDOR_ID = '0x2672';
// Open GoPro setting 134 "Anti-Flicker". The HERO13 offers exactly two options
// (the camera lists them when you try an invalid one): 0 = NTSC (60Hz),
// 1 = PAL (50Hz). UK mains lighting flickers at 100Hz, so PAL is the right one.
const ANTI_FLICKER_SETTING = 134;
const ANTI_FLICKER_50HZ = 1; // PAL

function run(cmd, args, timeout = 20000) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
    });
}

// {serial, ip} of the first GoPro on USB, or null.
async function findCamera() {
    const out = await run('system_profiler', ['SPUSBDataType']);
    const blocks = out.split(/\n(?=\s{6,}[^\s].*:\n)/);
    for (const b of blocks) {
        if (!new RegExp(`Vendor ID:\\s*${GOPRO_VENDOR_ID}`, 'i').test(b)) continue;
        const serial = (b.match(/Serial Number:\s*(\S+)/) || [])[1];
        const name = (b.match(/^\s*([^\n:]+):\s*$/m) || [])[1];
        const d = serial && serial.match(/(\d)(\d)(\d)$/);
        return { name: name ? name.trim() : 'GoPro', serial: serial || null, ip: d ? `172.2${d[1]}.1${d[2]}${d[3]}.51` : null };
    }
    return null;
}

async function api(ip, path, timeoutMs = 6000) {
    let res;
    try {
        res = await fetch(`http://${ip}:8080${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
        // "fetch failed" on its own is useless - say why (e.g. EHOSTUNREACH,
        // which on macOS usually means "Local Network" access was denied).
        const code = err.cause && (err.cause.code || err.cause.message);
        throw new Error(`${err.message}${code ? ` (${code})` : ''}`);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { ok: res.ok, status: res.status, json };
}

// Camera state, retried a couple of times - the camera is sometimes slow to
// answer for a moment while it is starting or stopping webcam mode. Throws
// with the real reason if it never answers.
async function getState(ip) {
    let last = 'no answer';
    for (let i = 0; i < 3; i++) {
        try {
            const r = await api(ip, '/gopro/camera/state', 8000);
            if (r.ok && r.json) return r.json;
            last = `HTTP ${r.status}${r.json ? '' : ' (not JSON)'}`;
        } catch (e) { last = e.message; }
        await new Promise((res) => setTimeout(res, 800));
    }
    throw new Error(last);
}

async function getInfo(ip) {
    const r = await api(ip, '/gopro/camera/info');
    return r.ok && r.json ? r.json.info || r.json : null;
}

async function getWebcamStatus(ip) {
    try { const r = await api(ip, '/gopro/webcam/status'); return r.json; } catch { return null; }
}

// Make sure the camera is on PAL (50Hz) anti-flicker. Returns {changed, from, to, ok, error}.
async function ensureAntiFlicker50(ip) {
    let state;
    try { state = await getState(ip); } catch (e) { return { ok: false, error: `could not read camera state - ${e.message}` }; }
    const from = state.settings ? state.settings[String(ANTI_FLICKER_SETTING)] : undefined;
    if (from === ANTI_FLICKER_50HZ) return { ok: true, changed: false, from, to: from };
    const r = await api(ip, `/gopro/camera/setting?setting=${ANTI_FLICKER_SETTING}&option=${ANTI_FLICKER_50HZ}`);
    if (!r.ok) return { ok: false, from, error: `camera refused the change (HTTP ${r.status})` };
    const after = await getState(ip).catch(() => null);
    const to = after && after.settings ? after.settings[String(ANTI_FLICKER_SETTING)] : undefined;
    logger.info('gopro: anti-flicker set', { from, to });
    return { ok: to === ANTI_FLICKER_50HZ, changed: true, from, to, error: to === ANTI_FLICKER_50HZ ? undefined : `camera reports ${to} after the change` };
}

module.exports = { findCamera, getState, getInfo, getWebcamStatus, ensureAntiFlicker50, ANTI_FLICKER_50HZ };
