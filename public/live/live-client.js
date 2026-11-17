// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Shared by the athlete / team / marshal / admin pages. Loads the draw once, then
// listens for tiny live state messages and works out every expected time locally with
// ScheduleCore (the same code the server uses), re-computing every second so the
// countdowns tick. Clock differences between this phone and the server are corrected.
//
// Two transports, chosen by live-config.js:
//   socket - the scoreboard Mac's own server pushes every change at once (local network);
//   poll   - the pages sit on an ordinary web host; the Mac uploads data/meet.json and
//            data/state.json whenever something changes and each page asks for state.json every
//            few seconds (marshals) to a couple of minutes (swimmers), only while it is on screen.
(function () {
    var CONFIG = Object.assign({ mode: 'socket', dataBase: 'data/', staleAfterSeconds: 180 }, window.LIVE_CONFIG || {});
    var Live = { meet: null, state: null, settings: ScheduleCore.DEFAULTS, offsetMs: 0, lastStateAt: 0, computed: null, stale: false, staleWhy: '', noData: false, publishedMs: 0, results: {}, resultsSeq: null, role: 'meet', handlers: [], socket: null, config: CONFIG };
    Live.now = function () { return Date.now() + Live.offsetMs; };
    Live.onChange = function (fn) { Live.handlers.push(fn); };
    function emit() { Live.handlers.forEach(function (fn) { try { fn(Live); } catch (e) { console.error(e); } }); }

    function recompute() {
        if (Live.meet && Live.state) Live.computed = ScheduleCore.computeETAs(Live.meet.heats, Live.state, Live.settings, Live.now());
        else Live.computed = null;
        if (CONFIG.mode === 'poll') {
            var age = Live.publishedMs ? Live.now() - Live.publishedMs : 0;
            if (pollFailures >= 2) { Live.stale = true; Live.staleWhy = "Can't reach the live feed - the times below may be out of date."; }
            else if (Live.publishedMs && age > CONFIG.staleAfterSeconds * 1000) { Live.stale = true; Live.staleWhy = 'No update from the pool for ' + Math.round(age / 60000) + ' min - the times below may be out of date.'; }
            else { Live.stale = false; Live.staleWhy = ''; }
        } else {
            Live.stale = !!Live.lastStateAt && (Date.now() - Live.lastStateAt > 20000);
            Live.staleWhy = 'Live feed paused - the times below may be out of date.';
        }
        emit();
    }

    function loadMeet() {
        if (CONFIG.mode === 'poll') return loadMeetPoll();
        return fetch('/api/live/meet').then(function (r) { return r.json(); }).then(function (d) {
            Live.meet = d; Live.settings = Object.assign({}, ScheduleCore.DEFAULTS, d.settings);
            Live.offsetMs = d.serverNowMs - Date.now();
            index(); recompute();
        });
    }

    // swimmers: key -> { key, name, club, code, races: [{ heatIndex, lane }] }
    function index() {
        var map = {};
        Live.meet.heats.forEach(function (h) {
            h.lanes.forEach(function (l) {
                var key = (l.name + '|' + (l.code || l.club)).toLowerCase();
                if (!map[key]) map[key] = { key: key, name: l.name, club: l.club, code: l.code, races: [] };
                map[key].races.push({ heatIndex: h.i, lane: l.lane, entry: l.entry || '' });
            });
        });
        Live.swimmers = map;
        Live.clubs = Object.values(map).reduce(function (acc, s) { acc[s.club] = (acc[s.club] || 0) + 1; return acc; }, {});
    }

    // ---- poll transport ------------------------------------------------------------------------
    var pollFailures = 0, pollTimer = null, polling = false, lastRelease = null, lastReleaseCheck = 0, releaseBaseline = null;

    function getJson(path) {
        var t0 = Date.now();
        return fetch(CONFIG.dataBase + path + '?t=' + t0, { cache: 'no-store' }).then(function (r) {
            if (r.status === 404) return { missing: true };
            if (!r.ok) throw new Error('HTTP ' + r.status);
            var dateHdr = r.headers.get('Date');
            return r.json().then(function (j) { return { json: j, dateMs: dateHdr ? Date.parse(dateHdr) : NaN, at: (t0 + Date.now()) / 2 }; });
        });
    }

    function loadMeetPoll() {
        return getJson('meet.json').then(function (r) {
            if (r.missing || r.json.empty) { Live.meet = null; Live.noData = true; Live.swimmers = {}; Live.clubs = {}; recompute(); return; }
            Live.noData = false;
            Live.meet = r.json; index(); recompute();
        });
    }

    function loadResultsPoll(seq) {
        return getJson('results.json').then(function (r) {
            Live.results = (r.missing || r.json.empty) ? {} : (r.json.heats || {});
            Live.resultsSeq = seq; recompute();
        }).catch(function () { /* keep what we have; the next poll tries again */ });
    }

    function pollState() {
        return getJson('state.json').then(function (r) {
            pollFailures = 0;
            if (r.missing || r.json.empty) { Live.results = {}; Live.resultsSeq = null; Live.state = null; Live.noData = true; Live.meet = null; Live.publishedMs = 0; Live.lastStateAt = Date.now(); recompute(); return; }
            var d = r.json;
            // clock: Mac clock = this server's clock + (macNow - receivedAt); server clock = Date header (+0.5 s: it is truncated)
            if (!isNaN(r.dateMs) && d.macNowMs && d.receivedAtMs) Live.offsetMs = (r.dateMs + 500 - r.at) + (d.macNowMs - d.receivedAtMs);
            Live.state = d.state; Live.settings = Object.assign({}, ScheduleCore.DEFAULTS, d.settings);
            Live.publishedMs = d.macNowMs || 0; Live.lastStateAt = Date.now(); Live.noData = false;
            var more = [];
            if ((d.resultsSeq == null ? null : d.resultsSeq) !== Live.resultsSeq) more.push(d.resultsSeq == null ? (Live.results = {}, Live.resultsSeq = null, undefined) : loadResultsPoll(d.resultsSeq));
            if (!Live.meet || Live.meet.version !== d.drawVersion) more.push(loadMeetPoll().catch(function () {}));
            if (more.length) return Promise.all(more).then(recompute);
            recompute();
        }).catch(function () { pollFailures++; recompute(); });
    }

    // an athlete page can say "someone I follow is about to report" and ask for faster updates
    Live.urgent = function () { return false; };

    function intervalSeconds() {
        if (Live.urgent()) return Math.min(20, CONFIG.pollOverride || 20);
        var s = Live.settings, key = { marshal: 'pollMarshalSeconds', team: 'pollTeamSeconds', athlete: 'pollAthleteSeconds' }[Live.role] || 'pollMeetSeconds';
        return Math.max(2, Number(s[key]) || 60);
    }

    function checkRelease() {
        lastReleaseCheck = Date.now();
        return fetch('release.txt?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (t) {
            if (!t) return; t = t.trim();
            if (releaseBaseline === null) releaseBaseline = t; else if (t !== releaseBaseline) location.reload();
        }).catch(function () {});
    }

    function schedule() {
        clearTimeout(pollTimer);
        if (document.hidden) return;              // nobody is looking: stay quiet until they come back
        var base = intervalSeconds() * 1000;
        var wait = pollFailures ? Math.min(60000, Math.max(base, 5000 * Math.pow(2, pollFailures - 1))) : base;
        wait *= 0.9 + Math.random() * 0.2;        // spread phones out so they do not all arrive together
        pollTimer = setTimeout(tick, wait);
    }

    function tick() {
        if (polling) return schedule();
        polling = true;
        var jobs = [pollState()];
        if (Date.now() - lastReleaseCheck > 10 * 60000) jobs.push(checkRelease());
        Promise.all(jobs).then(function () { polling = false; schedule(); }, function () { polling = false; schedule(); });
    }

    function startPoll() {
        checkRelease();
        loadMeetPoll().catch(function () {}).then(function () { tick(); });
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) { clearTimeout(pollTimer); return; }
            if (Date.now() - Live.lastStateAt > 5000) tick(); else schedule(); // straight back to fresh data
        });
    }

    Live.start = function (opts) {
        Live.role = (opts && opts.role) || 'meet';
        if (CONFIG.mode === 'poll') { startPoll(); setInterval(recompute, 1000); return; }
        loadMeet();
        Live.socket = io();
        if (window.watchVersion) watchVersion(Live.socket);
        Live.socket.on('live:state', function (s) { Live.state = s; Live.offsetMs = s.serverNowMs - Date.now(); Live.lastStateAt = Date.now(); recompute(); });
        Live.socket.on('live:settings', function (s) { Live.settings = Object.assign({}, ScheduleCore.DEFAULTS, s); recompute(); });
        Live.socket.on('live:draw', function () { loadMeet(); });
        Live.socket.on('live:results', function (d) { Live.results = d.heats || {}; Live.resultsSeq = d.seq; recompute(); });
        var liveBaseline = null;
        Live.socket.on('live:version', function (v) { if (liveBaseline === null) { liveBaseline = v; return; } if (v !== liveBaseline) location.reload(); });
        setInterval(recompute, 1000);
    };

    // one-line description of where the meet is now
    Live.statusText = function () {
        if (Live.noData) return 'No meet is published right now - check back on the day.';
        if (!Live.meet) return 'Loading...';
        if (!Live.state || Live.state.currentIndex < 0) return Live.computed && Live.computed.preStart ? (Live.computed.lateStart ? 'Meet running late - now expected to start about ' : 'Waiting for the meet to start - expected about ') + ScheduleCore.clock(Live.computed.etas[0].startMs) : 'Waiting for the meet to start';
        var h = Live.meet.heats[Live.state.currentIndex];
        var verb = Live.state.phase === 'racing' ? 'Racing now' : (Live.state.phase === 'finished' ? 'Just finished' : 'Next up');
        var text = verb + ': Event ' + h.event + ' Heat ' + h.heat;
        if (Live.computed && Live.computed.preStart && Live.state.phase === 'waiting') text += (Live.computed.lateStart ? ' - meet running late, now expected about ' : ' - meet expected to start about ') + ScheduleCore.clock(Live.computed.etas[0].startMs);
        // the Mac sends at least once a minute, so only mention the age when it is getting old
        if (CONFIG.mode === 'poll' && Live.publishedMs && !Live.stale) {
            var a = Math.max(0, Math.round((Live.now() - Live.publishedMs) / 1000));
            if (a >= 90) text += ' \u00b7 last update from the pool ' + Math.round(a / 60) + ' min ago';
        }
        return text;
    };

    // The scoreboard's time for a finished swim: { time, place } or null. Unofficial.
    Live.result = function (heatIndex, lane) {
        if (!Live.meet || Live.settings.showTimes === false) return null;
        var h = Live.meet.heats[heatIndex], m = h && Live.results && Live.results[h.event + ':' + h.heat], r = m && m[lane];
        return r ? { time: r[0], place: r[1] } : null;
    };

    // With "hide finished" on, the last few finished heats stay on screen so their scoreboard
    // times can still be copied down.
    var KEEP_RECENT = 3;
    Live.recentlyDone = function (heatIndex) {
        if (!Live.computed || !Live.computed.valid) return false;
        var last = -1;
        Live.computed.etas.forEach(function (e, i) { if (e.status === 'done') last = i; });
        return last >= 0 && heatIndex > last - KEEP_RECENT;
    };
    Live.resultNote = 'Scoreboard times are copied from the timing console as each race finishes. They are not official - officials can change or overrule them.';

    Live.eta = function (heatIndex) { return Live.computed && Live.computed.valid ? Live.computed.etas[heatIndex] : null; };

    // Ticks ("arrived" / "sent") are kept only in THIS browser - never sent anywhere. One store per
    // page type; keys include the meet name so a new meet starts clean.
    Live.ticks = function (store) {
        var name = 'live.ticks.' + store;
        function read() { try { return JSON.parse(localStorage.getItem(name) || '{}'); } catch (e) { return {}; } }
        function write(m) { try { localStorage.setItem(name, JSON.stringify(m)); } catch (e) {} }
        function key(heatIndex, lane) {
            var h = Live.meet.heats[heatIndex];
            return ((Live.meet.meetName || '') + '|' + h.event + '|' + h.heat + '|' + lane);
        }
        return {
            has: function (heatIndex, lane) { return !!read()[key(heatIndex, lane)]; },
            set: function (heatIndex, lane, on) { var m = read(), k = key(heatIndex, lane); if (on) m[k] = 1; else delete m[k]; write(m); },
            clearAll: function () { write({}); }
        };
    };

    // small DOM helper
    window.el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    window.Live = Live;

    // the banner every page shows
    Live.renderHeader = function (titleEl, statusEl, bannerEl) {
        titleEl.textContent = (Live.meet && Live.meet.meetName) || 'Live heat sheet';
        statusEl.textContent = Live.statusText();
        bannerEl.style.display = Live.stale ? 'block' : 'none';
        bannerEl.textContent = Live.staleWhy || 'Live feed paused - the times below may be out of date.';
    };
}());
