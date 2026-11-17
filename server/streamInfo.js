// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Suggested stream title, description and YouTube chapter list.
//
// Chapters come from logs/stream-sessions.jsonl (see sessionLog.js): the time the
// stream started and every heat change, turned into timestamps relative to the
// stream start - which is what YouTube's timeline uses. YouTube turns timestamp
// lines in the description into chapters if: the first is 0:00, there are at
// least three, and each lasts at least ten seconds.

const MIN_GAP = 10; // seconds - YouTube's minimum chapter length

// Each stream in the log: { start, stop|null, startMs, stopMs|null }, oldest first.
function listStreams(entries) {
    const streams = [];
    let open = null;
    for (const e of entries) {
        const ms = Date.parse(e.t);
        if (!Number.isFinite(ms)) continue;
        if (e.kind === 'stream-start') {
            if (open) { open.stop = e.t; open.stopMs = ms; } // never stopped cleanly (crash/restart)
            open = { start: e.t, stop: null, startMs: ms, stopMs: null };
            streams.push(open);
        } else if (e.kind === 'stream-stop' && open) {
            open.stop = e.t; open.stopMs = ms; open = null;
        }
    }
    return streams;
}

function stripStart(name) { return String(name || '').replace(/^Start - /, ''); }

// m:ss under an hour, h:mm:ss after.
function formatTimestamp(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// Chapters for one stream. `shift` (seconds, can be negative) nudges every
// timestamp, since YouTube's timeline can start a few seconds after OBS does.
function buildChapters(entries, stream, shift = 0, nowMs = Date.now()) {
    if (!stream) return [];
    const endMs = stream.stopMs || nowMs;
    const heats = entries.filter((e) => e.kind === 'heat').map((e) => ({ ms: Date.parse(e.t), name: stripStart(e.name) })).filter((h) => Number.isFinite(h.ms)).sort((a, b) => a.ms - b.ms);
    const list = [];
    // The heat being shown when the stream started is the first chapter.
    const before = heats.filter((h) => h.ms <= stream.startMs + 1500).pop();
    list.push({ offset: 0, label: before ? before.name : 'Start of the stream' });
    for (const h of heats) {
        if (h.ms <= stream.startMs + 1500 || h.ms > endMs) continue;
        list.push({ offset: Math.max(1, (h.ms - stream.startMs) / 1000 + shift), label: h.name });
    }
    // Drop consecutive repeats of the same heat (e.g. flicking back and forth).
    const deduped = list.filter((c, i) => i === 0 || c.label !== list[i - 1].label);
    // Enforce ten seconds per chapter: a chapter that was replaced within ten
    // seconds was only briefly on screen, so it is dropped (the first one's
    // slot, 0:00, passes to whatever replaces it).
    const out = deduped.slice();
    for (let i = 0; i < out.length - 1;) {
        if (out[i + 1].offset - out[i].offset < MIN_GAP) {
            out.splice(i, 1);          // too brief: the next chapter replaces it
            if (i === 0) out[0].offset = 0;
        } else i++;
    }
    if (out.length) out[0].offset = 0;
    return out.map((c) => ({ offsetSeconds: Math.round(c.offset), time: formatTimestamp(c.offset), label: c.label }));
}

function chaptersText(chapters) {
    // consistent width isn't required, but h:mm:ss everywhere once any chapter passes an hour
    const long = chapters.some((c) => c.offsetSeconds >= 3600);
    return chapters.map((c) => `${long && c.offsetSeconds < 3600 ? `0:${String(Math.floor(c.offsetSeconds / 60)).padStart(2, '0')}:${String(c.offsetSeconds % 60).padStart(2, '0')}` : c.time} ${c.label}`).join('\n');
}

function validate(chapters, streamRunning) {
    const problems = [];
    if (chapters.length < 3) problems.push(`YouTube needs at least 3 chapters (there ${chapters.length === 1 ? 'is' : 'are'} ${chapters.length} so far${streamRunning ? ' - more appear as heats change' : ''}).`);
    for (let i = 0; i < chapters.length - 1; i++) {
        if (chapters[i + 1].offsetSeconds - chapters[i].offsetSeconds < MIN_GAP) problems.push(`"${chapters[i].label}" lasts under ${MIN_GAP}s.`);
    }
    return { ok: problems.length === 0, problems };
}

function suggestTitle({ meetName, driveMeetName, session }) {
    const meet = (meetName || '').trim() || (driveMeetName || '').trim() || 'Live swimming';
    return session ? `${meet} – Session ${session}` : meet;
}

const DEFAULT_INTRO = 'Live swimming with live times and results on screen.';

function descriptionText({ title, dateText, intro, chapters }) {
    const parts = [title, dateText].filter(Boolean).join('\n');
    const body = [parts, intro || DEFAULT_INTRO].filter(Boolean).join('\n\n');
    return chapters && chapters.length ? `${body}\n\nChapters\n${chaptersText(chapters)}` : body;
}

module.exports = { listStreams, buildChapters, chaptersText, validate, suggestTitle, descriptionText, formatTimestamp, DEFAULT_INTRO, MIN_GAP };
