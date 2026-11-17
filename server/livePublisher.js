// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Pushes the live heat feed to the web host (remote/update.php) so phones can read it there.
//
//   * the draw (meet.json)  - sent when it changes, and again whenever the host says it has a
//                             different one (first run, after a wipe, after a site restore);
//   * the state (state.json) - sent when the console moves on (a few seconds' pause lets bursts
//                             of changes travel together) and every minute as a heartbeat, so
//                             phones can tell "quiet" from "the Mac has gone away".
//
// Failures are retried with a growing pause; only the latest state is ever worth sending, so
// nothing queues up. The key lives in config/publish.json (never committed, never shown).

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.LIVE_PUBLISH_CONFIG || path.join(__dirname, '..', 'config', 'publish.json');
const HEARTBEAT_MS = 60000;
const MIN_GAP_MS = 3000;
const TIMEOUT_MS = 12000;

function create({ liveFeed, logger = console }) {
    let config = readConfig();
    let timer = null, heartbeat = null, inFlight = false, dirty = false, dirtyMeet = false;
    let sentMeetKey = null, sentResultsSeq = null;
    let lastSendAt = 0, backoffStep = 0;
    const status = { enabled: false, host: '', lastOkAt: null, lastError: '', failures: 0, sends: 0, meetSentAt: null, remoteMeetVersion: null, lastAction: '' };

    function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; } }

    function refreshConfig() {
        config = readConfig();
        const ok = !!(config && config.url && config.key && config.enabled !== false);
        status.enabled = ok;
        status.host = ok ? safeHost(config.url) : '';
        if (ok && !/^https:\/\//i.test(config.url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(config.url)) {
            status.enabled = false; status.lastError = 'The address must start with https:// (the key would travel unprotected otherwise).';
        }
        return status.enabled;
    }
    // for one-off actions (test / wipe) the on-off switch does not matter, only that there is an address and a key
    function configuredForActions() {
        refreshConfig();
        return !!(config && config.url && config.key && (/^https:\/\//i.test(config.url) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(config.url)));
    }
    function safeHost(u) { try { return new URL(u).host; } catch { return ''; } }
    function endpoint() { return config.url.replace(/\/+$/, '') + '/update.php'; }

    async function post(body) {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(endpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Live-Key': config.key }, body: JSON.stringify(body), signal: ctl.signal });
            let json = null;
            try { json = await res.json(); } catch { /* not JSON */ }
            if (!res.ok || !json || !json.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
            return json;
        } finally { clearTimeout(to); }
    }

    const meetKey = (m) => `${m.version}|${m.meetName}`;

    async function sendNow() {
        if (inFlight || !refreshConfig()) return;
        inFlight = true; dirty = false;
        try {
            const meet = liveFeed.meetPayload();
            const needMeet = dirtyMeet || sentMeetKey !== meetKey(meet);
            if (needMeet) {
                status.lastAction = 'meet';
                await post({ action: 'meet', ...meet });
                sentMeetKey = meetKey(meet); dirtyMeet = false; status.meetSentAt = Date.now(); status.remoteMeetVersion = meet.version;
                logger.info('Live publish: draw sent', { heats: meet.heats.length, version: meet.version });
            }
            const res = liveFeed.resultsPayload();
            if (sentResultsSeq !== res.seq) {
                status.lastAction = 'results';
                await post({ action: 'results', seq: res.seq, heats: res.heats });
                sentResultsSeq = res.seq;
            }
            status.lastAction = 'state';
            const r = await post({ action: 'state', state: liveFeed.getState(), settings: liveFeed.getSettings(), drawVersion: meet.version, resultsSeq: res.seq, macNowMs: Date.now() });
            // the host holds something different from what we think (wiped, restored, first run): send it next
            if ((r.meetVersion || null) !== meet.version) { sentMeetKey = null; dirty = true; }
            else status.remoteMeetVersion = r.meetVersion;
            if ((r.resultsSeq ?? null) !== res.seq) { sentResultsSeq = null; dirty = true; }
            status.lastOkAt = Date.now(); status.lastError = ''; status.failures = 0; status.sends++; backoffStep = 0;
        } catch (e) {
            status.failures++; status.lastError = String(e && e.message || e);
            if (status.failures === 1 || status.failures % 10 === 0) logger.warn('Live publish failed', { error: status.lastError, failures: status.failures });
            dirty = true; backoffStep = Math.min(backoffStep + 1, 5);
        } finally {
            inFlight = false; lastSendAt = Date.now();
            if (dirty) schedule();
        }
    }

    // wait at least MIN_GAP_MS since the last send (longer after failures), then send the latest
    function schedule() {
        if (timer || !refreshConfig()) return;
        const gap = backoffStep ? Math.min(60000, 5000 * 2 ** (backoffStep - 1)) : MIN_GAP_MS;
        const wait = Math.max(300, lastSendAt + gap - Date.now());
        timer = setTimeout(() => { timer = null; sendNow(); }, wait);
        timer.unref();
    }

    function start() {
        refreshConfig();
        liveFeed.events.on('state', () => { dirty = true; schedule(); });
        liveFeed.events.on('settings', () => { dirty = true; schedule(); });
        liveFeed.events.on('draw', () => { dirty = true; schedule(); });
        liveFeed.events.on('results', () => { dirty = true; schedule(); });
        heartbeat = setInterval(() => { if (refreshConfig()) { dirty = true; schedule(); } }, HEARTBEAT_MS);
        heartbeat.unref();
        if (status.enabled) { logger.info('Live publishing to the web host is on', { host: status.host }); dirty = true; schedule(); }
    }

    // ---- actions from the admin page --------------------------------------------------------
    async function test() {
        if (!configuredForActions()) return { ok: false, error: status.lastError || 'Not set up yet - run scripts/build-remote.js --url https://your-site/heats/' };
        try {
            const r = await post({ action: 'ping' });
            return { ok: true, php: r.php, writable: r.writable, remoteMeetVersion: r.meetVersion };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }
    function sendMeetAgain() { sentMeetKey = null; sentResultsSeq = null; dirtyMeet = true; dirty = true; schedule(); }
    async function wipe() {
        if (!configuredForActions()) return { ok: false, error: 'Not set up yet' };
        try {
            await post({ action: 'wipe' });
            sentMeetKey = null; sentResultsSeq = null; status.remoteMeetVersion = null; status.meetSentAt = null; status.lastOkAt = null;
            pause(true); // stay off until switched back on, or the next heartbeat would publish it all again
            logger.info('Live publish: published data wiped from the host; publishing paused');
            return { ok: true };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }
    // Wiping is a deliberate act: stop sending until the user asks again (otherwise the next heartbeat would republish).
    function pause(on) {
        try {
            const c = readConfig(); if (!c) return false;
            c.enabled = !on; fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); refreshConfig(); return true;
        } catch { return false; }
    }

    function resume() { const ok = pause(false); if (ok) { sentMeetKey = null; sentResultsSeq = null; dirty = true; schedule(); } return ok; }

    function getStatus() { refreshConfig(); return { ...status, pending: dirty || !!timer }; }

    return { start, getStatus, test, sendMeetAgain, wipe, pause, resume };
}

module.exports = { create };
