// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Live heat feed for the athlete / team manager / marshal pages.
//
// Holds three small things, and nothing else:
//   * the DRAW   - every heat in running order with who swims where, with each heat's
//                  duration already worked out (changes only when the meet files do);
//   * SETTINGS   - gaps, report lead, heats ahead ... (set on the local admin page);
//   * STATE      - which heat the console is on and whether it is waiting / racing /
//                  finished, with the times those things happened.
// The pages work out every expected time themselves from those (public/live/schedule-core.js),
// so a live update is just a tiny state message. The same payloads are what will be
// pushed to the remote site.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const ScheduleCore = require('../public/live/schedule-core.js');

const SETTINGS_FILE = path.join(__dirname, '..', 'config', 'live.json');
const RESULTS_FILE = process.env.LIVE_RESULTS_FILE || path.join(__dirname, '..', 'logs', 'live-results.json');
const CLUBS_FILE = path.join(__dirname, '..', 'config', 'clubs.json');
// A version of the /live pages themselves (their files only), so an open page picks up a new
// release by itself - kept separate from the scoreboard overlays' reload signal on purpose.
const LIVE_DIR = path.join(__dirname, '..', 'public', 'live');
function liveFilesVersion() {
    try {
        const parts = fs.readdirSync(LIVE_DIR).sort().map((f) => { const st = fs.statSync(path.join(LIVE_DIR, f)); return st.isFile() ? `${f}:${Math.floor(st.mtimeMs)}:${st.size}` : ''; });
        return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);
    } catch { return ''; }
}
const NUMERIC = { gapSeconds: [0, 600], backstrokeGapSeconds: [0, 600], reportLeadMinutes: [0, 180], heatsAhead: [1, 99], minHeatsReady: [1, 20], fillLeadMinutes: [0, 120], defaultHeatSeconds: [10, 900], borrowedExtraSeconds: [0, 300],
    pollMarshalSeconds: [2, 120], pollTeamSeconds: [10, 600], pollAthleteSeconds: [10, 900], pollMeetSeconds: [10, 600] };

// 65.43 -> "1:05.43", 38.5 -> "38.50"; '' when the source has no entry data at all, 'NT' when it has
// entry data but this swimmer has no time.
function formatEntry(seconds, hasData) {
    if (!hasData) return '';
    if (seconds == null) return 'NT';
    const m = Math.floor(seconds / 60), sec = seconds - m * 60;
    return m ? `${m}:${sec.toFixed(2).padStart(5, '0')}` : sec.toFixed(2);
}

// "00:41.23" -> "41.23", "01:05.32" -> "1:05.32"; '' when it is not a real time (blank, all zeros, a dot)
function formatResultTime(raw) {
    const t = String(raw == null ? '' : raw).replace(/\s/g, '');
    const m = /^(?:(\d+):)?(\d{1,2})\.(\d{2})$/.exec(t);
    if (!m) return '';
    const min = Number(m[1] || 0), sec = Number(m[2]), cs = m[3];
    if (min === 0 && sec === 0 && cs === '00') return '';
    return min > 0 ? `${min}:${String(sec).padStart(2, '0')}.${cs}` : `${sec}.${cs}`;
}

function create({ heatsheetStore, getMeetName = () => '', logger = console }) {
    let settings = ScheduleCore.withDefaults(readJson(SETTINGS_FILE, {}));
    let clubNames = null;
    let draw = { version: '', heats: [] };
    let index = new Map();
    let state = { currentIndex: -1, phase: 'waiting', heatLoadedMs: null, raceStartMs: null, finishedMs: null, seq: 0 };
    let io = null;
    // Scoreboard times, as shown when each race finished: { 'event:heat': { lane: [time, place] } }.
    // Unofficial - the console's own display, not a confirmed result. Kept on disk so a restart keeps them.
    let results = readJson(RESULTS_FILE, null);
    if (!results || typeof results !== 'object' || typeof results.heats !== 'object') results = { fingerprint: '', seq: 0, heats: {} };
    const events = new EventEmitter(); // 'state' | 'draw' | 'settings' - used by the remote publisher

    function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

    function clubName(code, given) {
        if (given) return given;
        if (!clubNames) { clubNames = readJson(CLUBS_FILE, {}); }
        const c = clubNames[code];
        return (c && c.name) || code || '';
    }

    function buildDraw() {
        const raw = heatsheetStore.listHeats();
        const rawSeconds = raw.map((h) => {
            const times = h.lanes.map((l) => l.entrySeconds).filter((x) => x != null);
            return times.length ? Math.max(...times) : null;
        });
        const durations = ScheduleCore.resolveDurations(rawSeconds, settings.defaultHeatSeconds, raw.map((h) => h.event), settings.borrowedExtraSeconds);
        const perEvent = new Map();
        raw.forEach((h) => perEvent.set(h.event, (perEvent.get(h.event) || 0) + 1));
        const heats = raw.map((h, i) => ({
            i, event: h.event, heat: h.heat, title: h.title,
            back: ScheduleCore.isBackstroke(h.title),
            durationSec: durations[i],
            heatsInEvent: perEvent.get(h.event),
            // lane, name, club and entry (seed) time - as on a printed heat sheet. Never dates of
            // birth or member numbers.
            lanes: h.lanes.map((l) => ({ lane: l.lane, name: l.name, club: clubName(l.code, l.club), code: l.code, entry: formatEntry(l.entrySeconds, l.hasEntryData) }))
        }));
        const version = crypto.createHash('sha1').update(JSON.stringify(heats)).digest('hex').slice(0, 10);
        return { version, heats };
    }

    function refreshDraw(force) {
        const next = buildDraw();
        if (!force && next.version === draw.version) return false;
        draw = next;
        index = new Map(draw.heats.map((h) => [`${h.event}:${h.heat}`, h.i]));
        // the console may already be on a heat of the new draw
        if (state.currentIndex >= 0 || state.lastKey) {
            const i = index.get(state.lastKey);
            if (i !== undefined && i !== state.currentIndex) { state.currentIndex = i; state.seq++; }
        }
        if (io) io.emit('live:draw', { version: draw.version });
        events.emit('draw', meetPayload());
        checkFingerprint();
        return true;
    }

    // What the remote site needs to show the draw. (Names, clubs, lanes, seed times - nothing else.)
    function meetPayload() { return { meetName: getMeetName(), version: draw.version, heats: draw.heats }; }

    function saveResults() {
        try { fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true }); fs.writeFileSync(RESULTS_FILE, JSON.stringify(results)); }
        catch (e) { logger.warn && logger.warn('live results: could not save', { error: e.message }); }
    }
    function resultsPayload() { return { seq: results.seq, heats: settings.showTimes === false ? {} : results.heats }; }
    function resultsChanged() { results.seq++; saveResults(); if (io) io.emit('live:results', resultsPayload()); events.emit('results', resultsPayload()); }
    function clearResults() { results.heats = {}; resultsChanged(); }

    // a new meet has different events: results of the old one must not show against the new draw
    function checkFingerprint() {
        if (!draw.heats.length) return;
        const fp = crypto.createHash('sha1').update([...new Set(draw.heats.map((h) => `${h.event}|${h.title}`))].join('\n')).digest('hex').slice(0, 10);
        if (results.fingerprint === fp) return;
        const hadOld = results.fingerprint !== '' && Object.keys(results.heats).length > 0;
        results.fingerprint = fp;
        if (hadOld) { results.heats = {}; if (logger.info) logger.info('live results: a different meet was loaded, earlier scoreboard times cleared'); }
        resultsChanged();
    }

    

    function publicState() { return { ...state, serverNowMs: Date.now() }; }

    // Called every scoreboard tick with what the console is showing.
    function observe({ eventNum, heatNum, displayState, lanes }) {
        const now = Date.now();
        const key = `${eventNum}:${heatNum}`;
        const idx = index.has(key) ? index.get(key) : -1;
        let changed = false;
        if (idx !== state.currentIndex || key !== state.lastKey) {
            state = { currentIndex: idx, lastKey: key, phase: 'waiting', heatLoadedMs: now, raceStartMs: null, finishedMs: null, seq: state.seq + 1 };
            changed = true;
        }
        if (idx >= 0) {
            if (displayState === 'timer' && state.phase !== 'racing') {
                state.phase = 'racing'; state.raceStartMs = now; state.finishedMs = null; changed = true;
                if (results.heats[key]) { delete results.heats[key]; resultsChanged(); }   // a re-run replaces the old times
            }
            else if (displayState === 'result' && state.phase !== 'finished') { state.phase = 'finished'; state.finishedMs = now; changed = true; }
            else if (displayState === 'start' && state.phase === 'racing') { state.phase = 'waiting'; state.heatLoadedMs = now; state.raceStartMs = null; changed = true; } // race called back
        }
        // scoreboard times: take what the console shows once the race is over
        if (idx >= 0 && displayState === 'result' && Array.isArray(lanes)) {
            const cur = results.heats[key] || {};
            let got = false;
            for (const l of lanes) {
                const t = formatResultTime(l.time);
                if (!t) continue;
                const p = String(l.place == null ? '' : l.place).replace(/\D/g, '').slice(0, 3);
                const old = cur[l.lane];
                if (!old || old[0] !== t || old[1] !== p) { cur[l.lane] = [t, p]; got = true; }
            }
            if (got) { results.heats[key] = cur; resultsChanged(); }
        }
        if (changed) { state.seq++; if (io) io.emit('live:state', publicState()); events.emit('state', publicState()); }
    }

    function saveSettings(patch) {
        const next = { ...settings };
        for (const [k, [lo, hi]] of Object.entries(NUMERIC)) {
            if (patch[k] === undefined) continue;
            const v = Number(patch[k]);
            if (Number.isFinite(v)) next[k] = Math.min(hi, Math.max(lo, Math.round(v)));
        }
        if (typeof patch.showTimes === 'boolean') next.showTimes = patch.showTimes;
        if (typeof patch.meetStartTime === 'string') { const t = patch.meetStartTime.trim(); if (t === '' || ScheduleCore.meetStartMs(t, Date.now()) !== null) next.meetStartTime = t; }
        if (patch.marshalAdvanceOn === 'start' || patch.marshalAdvanceOn === 'finish') next.marshalAdvanceOn = patch.marshalAdvanceOn;
        const durationChanged = next.defaultHeatSeconds !== settings.defaultHeatSeconds || next.borrowedExtraSeconds !== settings.borrowedExtraSeconds;
        settings = next;
        fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        if (durationChanged) refreshDraw(true);
        if (io) io.emit('live:settings', settings);
        if (next.showTimes !== undefined && patch.showTimes !== undefined) resultsChanged();   // hide/show goes out with the results
        events.emit('settings', settings);
        return settings;
    }

    function attach(app, ioServer, isLoopbackReq) {
        io = ioServer;
        refreshDraw(true);
        setInterval(() => refreshDraw(false), 5000).unref();
        let liveVersion = liveFilesVersion();
        setInterval(() => { const v = liveFilesVersion(); if (v && v !== liveVersion) { liveVersion = v; if (io) io.emit('live:version', v); } }, 5000).unref();
        setInterval(() => { if (io) io.emit('live:state', publicState()); }, 5000).unref(); // heartbeat

        app.get('/api/live/meet', (req, res) => res.json({ meetName: getMeetName(), version: draw.version, heats: draw.heats, settings, serverNowMs: Date.now() }));
        app.get('/api/live/state', (req, res) => res.json(publicState()));
        app.get('/api/live/results', (req, res) => res.json(resultsPayload()));
        app.post('/api/live/results/clear', (req, res) => {
            if (!isLoopbackReq(req)) return res.status(403).json({ error: 'Only from the scoreboard Mac.' });
            clearResults(); res.json({ ok: true });
        });
        app.get('/api/live/settings', (req, res) => res.json(settings));
        app.post('/api/live/settings', (req, res) => {
            if (!isLoopbackReq(req)) return res.status(403).json({ error: 'The settings can only be changed from the scoreboard Mac.' });
            res.json(saveSettings(req.body || {}));
        });
        io.on('connection', (socket) => { socket.emit('live:state', publicState()); socket.emit('live:settings', settings); socket.emit('live:results', resultsPayload()); socket.emit('live:version', liveVersion); });
    }

    return { events, meetPayload, resultsPayload, clearResults, attach, observe, refreshDraw, getSettings: () => settings, getDraw: () => draw, getState: publicState, saveSettings };
}

module.exports = { create, formatResultTime };
