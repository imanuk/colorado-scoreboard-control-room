// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Heat timing engine for the athlete / team manager / marshal pages.
//
// Pure functions, no I/O, written as a UMD module so the SAME code runs in Node
// (require) and in the browser (<script>): the laptop, the remote site and every
// phone work out times identically from a few tiny live facts.
//
// A "heat" here: { event, heat, title, back: bool, durationSec, lanes: [...] }
//   in running order (the order they will be swum).
// Live state:     { currentIndex, phase: 'waiting'|'racing'|'finished',
//                   heatLoadedMs, raceStartMs, finishedMs }
//   'waiting'  - the console is on this heat and the race has not started
//   'racing'   - the race is running
//   'finished' - the race is over (results showing), console not yet advanced
// Settings:       { gapSeconds, backstrokeGapSeconds, reportLeadMinutes, heatsAhead, minHeatsReady,
//                   fillLeadMinutes, meetStartTime, defaultHeatSeconds, borrowedExtraSeconds,
//                   marshalAdvanceOn: 'start'|'finish' }
//
// How the times are worked out
//   * A heat takes as long as its slowest swimmer's entry time. A heat with no
//     times borrows the next LATER heat in the same event that has one (plus a few
//     seconds), else the default. This part is resolved once, on the server, into durationSec.
//   * Between heats there is a gap: 20s, or 40s before a backstroke heat
//     (swimmers have to get in the water).
//   * Everything is re-anchored to the real clock: the current heat's real start
//     (or "about to start") is the anchor, and each later heat follows it. So an
//     early or late heat corrects itself at the next race start, and errors never
//     pile up across the session.
//   * Before any heat has started, the first heat is assumed to start at the meet start time
//     (a setting); the first real start replaces that guess.
//   * When swimmers must report: marshalling should always hold at least `minHeatsReady` heats
//     (counting the swimmer's own), at most `heatsAhead` (the marshal positions), and otherwise
//     as many as fit in `reportLeadMinutes`. A swimmer reports when the heat that many places in
//     front of theirs starts. The first heats - those that would have to report before the meet
//     starts - all report together `fillLeadMinutes` before the first heat.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ScheduleCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEFAULTS = {
        gapSeconds: 20,
        backstrokeGapSeconds: 40,
        reportLeadMinutes: 15,       // the most minutes before the dive-in a swimmer is asked to report
        heatsAhead: 10,              // the most heats marshalling can hold (= marshal positions)
        minHeatsReady: 2,            // marshalling always holds at least this many heats, however long they are
        fillLeadMinutes: 10,         // the first heats all report this long before the meet starts
        showTimes: true,             // show the scoreboard's time for finished races (unofficial)
        meetStartTime: '',           // 'HH:MM' - when the first heat is expected to start (until it really does)
        defaultHeatSeconds: 60,
        borrowedExtraSeconds: 30,   // added when a heat with no times borrows its length from a later heat in the event
        marshalAdvanceOn: 'start',
        // How often phones ask the remote site for news (seconds) - only used when the pages are
        // hosted remotely and poll; the local pages get pushed updates instantly.
        pollMarshalSeconds: 5,
        pollTeamSeconds: 60,
        pollAthleteSeconds: 120,
        pollMeetSeconds: 60
    };
    const SOON_MS = 5000; // "any second now" - the earliest a not-yet-started heat is shown as starting

    function withDefaults(s) { return Object.assign({}, DEFAULTS, s || {}); }

    function isBackstroke(title) { return /back/i.test(title || ''); }

    // Resolve each heat's duration (seconds) from its slowest entry time. rawSeconds[i] is the
    // slowest entry time in heat i, or null if nobody in it has a time. A heat with no times
    // borrows from the next LATER heat in the SAME event that has one (later heats hold the faster
    // swimmers, so a little extra is added); if there is none, the default is used. `events` is the
    // event number of each heat (omit it to treat everything as one event).
    function resolveDurations(rawSeconds, defaultSeconds, events, extraSeconds) {
        const extra = extraSeconds == null ? DEFAULTS.borrowedExtraSeconds : extraSeconds;
        const out = rawSeconds.map((r, i) => {
            if (r != null) return r;
            for (let j = i + 1; j < rawSeconds.length; j++) {
                if (events && events[j] !== events[i]) break;      // never borrow across events
                if (rawSeconds[j] != null) return rawSeconds[j] + extra;
            }
            return defaultSeconds;
        });
        return out.map((s) => Math.max(1, Math.round(s)));
    }

    function gapMs(heat, s) { return (heat && heat.back ? s.backstrokeGapSeconds : s.gapSeconds) * 1000; }

    // "10:00" -> that wall-clock time on the same day as nowMs (null if not a valid time)
    function meetStartMs(text, nowMs) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
        if (!m || +m[1] > 23 || +m[2] > 59) return null;
        const d = new Date(nowMs); d.setHours(+m[1], +m[2], 0, 0);
        return d.getTime();
    }

    // Expected start/end of every heat. Returns { valid, preStart, etas: [{index, status, startMs,
    // endMs, reportMs, readyHeats, fillGroup}] }.   status: 'done' | 'racing' | 'next' | 'upcoming'
    // preStart: no heat has started yet, so the times come from the meet start time setting.
    function computeETAs(heats, state, settings, nowMs) {
        const s = withDefaults(settings);
        const etas = heats.map((h, i) => ({ index: i, status: 'upcoming', startMs: null, endMs: null, reportMs: null, readyHeats: null, fillGroup: false }));
        let c = state && Number.isInteger(state.currentIndex) ? state.currentIndex : -1;
        const meetStart = meetStartMs(s.meetStartTime, nowMs);
        let preStart = false;
        if (c >= heats.length || !heats.length) return { valid: false, etas };
        if (c < 0) {
            if (meetStart == null) return { valid: false, etas };
            // the meet has not begun: assume heat 1 starts at the meet start time (or, if that has gone by,
            // a couple of minutes from now, in whole minutes so the predictions do not creep every second)
            c = 0; preStart = true;
            state = { currentIndex: 0, phase: 'waiting', heatLoadedMs: null, raceStartMs: null, finishedMs: null };
        }

        for (let i = 0; i < c; i++) etas[i].status = 'done';

        const cur = heats[c];
        const curDur = cur.durationSec * 1000;
        let start, end;
        if (state.phase === 'racing') {
            start = state.raceStartMs || nowMs;
            end = Math.max(start + curDur, nowMs + SOON_MS);       // slower than expected: assume it is about to finish
            etas[c].status = 'racing';
        } else if (state.phase === 'finished') {
            end = state.finishedMs || nowMs;
            start = state.raceStartMs || (end - curDur);
            etas[c].status = 'done';
        } else {
            if (c === 0 && meetStart != null && (preStart || meetStart > nowMs + SOON_MS)) {
                preStart = true;
                start = meetStart > nowMs + SOON_MS ? meetStart : Math.ceil((nowMs + 2 * 60000) / 60000) * 60000;
            } else {
                start = Math.max(nowMs + SOON_MS, (state.heatLoadedMs || nowMs) + gapMs(cur, s));
            }
            end = start + curDur;
            etas[c].status = 'next';
        }
        etas[c].startMs = start; etas[c].endMs = end;

        let prevEnd = end;
        for (let k = c + 1; k < heats.length; k++) {
            const h = heats[k];
            let st = prevEnd + gapMs(h, s);
            if (k === c + 1 && etas[c].status !== 'next') {
                st = Math.max(st, nowMs + SOON_MS);                  // the next heat can't be in the past
                etas[k].status = 'next';
            }
            etas[k].startMs = st;
            etas[k].endMs = st + h.durationSec * 1000;
            prevEnd = etas[k].endMs;
        }

        // ---- when each swimmer must report ----------------------------------------------------
        // offs[i] = how long after heat 0 heat i would start on the plan (durations + gaps only, so
        // the answer does not wobble with the live clock).
        const P = Math.max(1, Math.round(s.heatsAhead));
        const minK = Math.min(P, Math.max(1, Math.round(s.minHeatsReady)));
        const limitMs = s.reportLeadMinutes * 60000;
        const offs = [0];
        for (let i = 1; i < heats.length; i++) offs[i] = offs[i - 1] + heats[i - 1].durationSec * 1000 + gapMs(heats[i], s);
        // heats before the first one don't exist; for the count they are assumed to be like heat 1
        const step0 = heats[0].durationSec * 1000 + gapMs(heats[0], s);
        const off = (x) => x >= 0 ? offs[x] : x * step0;
        const pastMs = Math.min(nowMs, etas[c].startMs);              // "already time to be there"
        const fillMs = etas[0].startMs != null ? etas[0].startMs - s.fillLeadMinutes * 60000 : pastMs;
        for (let i = 0; i < heats.length; i++) {
            if (etas[i].startMs == null) continue;
            let fit = 0;                                              // how many heats fit in the time limit
            while (fit < P && off(i) - off(i - fit - 1) <= limitMs) fit++;
            const k = Math.min(P, Math.max(minK, fit));
            const j = i - k;
            etas[i].readyHeats = k;
            etas[i].fillGroup = j < 0;
            etas[i].reportMs = j < 0 ? fillMs : (etas[j].startMs != null ? etas[j].startMs : pastMs);
        }
        return { valid: true, preStart, lateStart: preStart && meetStart != null && meetStart <= nowMs + SOON_MS, etas };
    }

    // Index of the heat that marshal position 0 ("next in the pool") should show.
    // Positions 1, 2, ... are the heats after it. With marshalAdvanceOn 'start' the screen moves
    // on as soon as a race starts (the next swimmers line up while it is swum); 'finish' waits
    // until the race is over.
    function marshalBase(state, settings) {
        const s = withDefaults(settings);
        const c = state && Number.isInteger(state.currentIndex) ? state.currentIndex : -1;
        if (c < 0) return null;
        if (state.phase === 'waiting') return c;
        if (state.phase === 'racing') return s.marshalAdvanceOn === 'finish' ? c : c + 1;
        return c + 1;
    }

    // "14:32" in the viewer's local time
    function clock(ms) {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    // "in 12 min", "in 1 h 05", "now", "5 min ago"
    function relative(ms, nowMs) {
        const diff = Math.round((ms - nowMs) / 1000);
        const abs = Math.abs(diff);
        if (abs < 45) return 'now';
        const mins = Math.round(abs / 60);
        const text = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')}`;
        return diff > 0 ? `in ${text}` : `${text} ago`;
    }

    return { DEFAULTS, withDefaults, isBackstroke, resolveDurations, computeETAs, marshalBase, clock, relative, gapMs, meetStartMs };
}));
