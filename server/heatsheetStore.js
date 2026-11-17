// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Loads and watches heatsheets/*.txt - tab-delimited scoreboard export files
// (the same file already sent to the Gen7 timing system, per the user), used
// as an authoritative backup source when the live RS-485 feed doesn't have
// something: event titles for session-2 events (which the console never
// broadcasts - see decoder.js), swimmer names, and each swimmer's entry
// (seed) time for PB detection.
//
// Format (real sample, tab-delimited, CRLF line endings):
//   Event 301 Mixed 12 Yrs/Over 800m Freestyle
//   Heat Number - 1
//   Lane	Comp.No.	Name	AaD		Club	 Time 	Code	Exception	Sex	Member	ClubFullName	DoB	Country	FGNameSplit
//   3	(2)	Alex EXAMPLE	12		ExampleTown	14:53.88	EXAM		G	1234567	ExampleTown Swimming Club	2014-01-01	E	6
// A blank entry time is 8 literal spaces rather than an empty field.
//
// Second, lower-priority source: heatsheets/DLinkHSL/*.scb - the per-event
// files the timing system's scoreboard link uses. They give the event title
// and each lane's name + club but NO times:
//   #Mixed 09 Yrs/OV 50m Breaststroke Heats        <- title, then 10 lines per heat
//   EXAMPLE,Alex        --EXAM                      <- lane N = line N of the heat block
//   (blank lanes are spaces around the "--")
// The event number comes from the file name (E401.scb -> 401). These only
// fill gaps the *_SCB.TXT doesn't cover, and never count as "has entry time".

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const HEATSHEETS_DIR = path.join(__dirname, '..', 'heatsheets');
const DLINK_DIR = path.join(HEATSHEETS_DIR, 'DLinkHSL');

// eventNumber -> { title, heats: Map<heatNumber, Map<lane, LaneInfo>> }
// LaneInfo: { compNo, name, age, club, entryTime (string, '' if none),
//             entrySeconds (number|null), sex, memberId, dob, sourceFile }
let events = new Map();
let loadedFiles = [];
// Same shape as `events`, from the .scb files (secondary source).
let scbEvents = new Map();
let loadedScbFiles = [];
let watcher = null;

function parseTimeToSeconds(str) {
    if (!str) return null;
    const trimmed = str.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(':');
    let seconds;
    if (parts.length === 2) {
        const mins = parseFloat(parts[0]);
        const secs = parseFloat(parts[1]);
        if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null;
        seconds = mins * 60 + secs;
    } else if (parts.length === 1) {
        seconds = parseFloat(parts[0]);
        if (!Number.isFinite(seconds)) return null;
    } else {
        return null;
    }
    return seconds;
}

function parseFile(filePath) {
    const fileName = path.basename(filePath);
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);

    let currentEvent = null;
    let currentHeat = null;
    let eventCount = 0;
    let laneCount = 0;

    for (const line of lines) {
        if (!line.trim()) continue;

        const eventMatch = line.match(/^Event\s+(\d+)\s+(.*)$/);
        if (eventMatch) {
            const num = parseInt(eventMatch[1], 10);
            currentEvent = { number: num, title: eventMatch[2].trim(), heats: new Map(), sourceFile: fileName };
            events.set(num, currentEvent);
            currentHeat = null;
            eventCount++;
            continue;
        }

        const heatMatch = line.match(/^Heat Number - (\d+)$/);
        if (heatMatch && currentEvent) {
            const num = parseInt(heatMatch[1], 10);
            currentHeat = new Map();
            currentEvent.heats.set(num, currentHeat);
            continue;
        }

        if (line.startsWith('Lane\t')) continue; // column header row

        if (!currentHeat) continue;

        const cols = line.split('\t');
        if (cols.length < 15) continue;
        const lane = parseInt(cols[0], 10);
        if (!Number.isFinite(lane)) continue;

        const entryTime = cols[6].trim();
        currentHeat.set(lane, {
            compNo: cols[1].replace(/[()]/g, '').trim(),
            name: cols[2].trim(),
            age: cols[3].trim(),
            club: cols[5].trim(),
            entryTime,
            entrySeconds: parseTimeToSeconds(entryTime),
            hasEntryData: true,
            code: cols[7].trim(),
            sex: cols[9].trim(),
            memberId: cols[10].trim(),
            dob: cols[12].trim(),
            sourceFile: fileName
        });
        laneCount++;
    }

    return { eventCount, laneCount };
}

// "EXAMPLE,Alex" -> "Alex EXAMPLE" (same order as the *_SCB.TXT names).
function flipName(raw) {
    const t = raw.trim();
    const i = t.indexOf(',');
    if (i < 0) return t;
    const last = t.slice(0, i).trim();
    const first = t.slice(i + 1).trim();
    return `${first} ${last}`.trim();
}

function parseScbFile(filePath) {
    const fileName = path.basename(filePath);
    const numMatch = fileName.match(/E0*(\d+)\.scb$/i);
    if (!numMatch) throw new Error('file name does not look like E###.scb');
    const number = parseInt(numMatch[1], 10);
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    if (!lines[0] || !lines[0].startsWith('#')) throw new Error('missing #title header line');
    const title = lines[0].replace(/^#/, '').replace(/\s+Heats\s*$/i, '').trim();

    const body = lines.slice(1);
    while (body.length && !body[body.length - 1].trim()) body.pop();
    const ev = { number, title, heats: new Map(), sourceFile: fileName };
    let laneCount = 0;
    for (let i = 0; i < body.length; i++) {
        const heatNum = Math.floor(i / 10) + 1;
        const lane = (i % 10) + 1;
        const m = body[i].match(/^(.*?)\s*--(.*)$/);
        const name = m ? m[1].trim() : body[i].trim();
        const club = m ? m[2].trim() : '';
        if (!ev.heats.has(heatNum)) ev.heats.set(heatNum, new Map());
        if (!name) continue;
        ev.heats.get(heatNum).set(lane, {
            name: flipName(name), rawName: name, club: '', code: club,
            entryTime: '', entrySeconds: null, hasEntryData: false, sourceFile: fileName
        });
        laneCount++;
    }
    scbEvents.set(number, ev);
    return { laneCount };
}

function reload() {
    events = new Map();
    loadedFiles = [];
    scbEvents = new Map();
    loadedScbFiles = [];

    let files;
    try {
        files = fs.readdirSync(HEATSHEETS_DIR).filter((f) => f.toLowerCase().endsWith('.txt') && f.toLowerCase() !== 'readme.txt');
    } catch (err) {
        logger.warn('heatsheetStore: could not read heatsheets/ directory', { error: err.message });
        return;
    }

    for (const file of files) {
        try {
            const { eventCount, laneCount } = parseFile(path.join(HEATSHEETS_DIR, file));
            loadedFiles.push(file);
            logger.info('heatsheetStore: loaded heat sheet file', { file, events: eventCount, lanes: laneCount });
        } catch (err) {
            logger.warn('heatsheetStore: failed to parse heat sheet file - skipped', { file, error: err.message });
        }
    }

    let scbFiles = [];
    try {
        scbFiles = fs.readdirSync(DLINK_DIR).filter((f) => f.toLowerCase().endsWith('.scb'));
    } catch { /* no DLinkHSL folder - fine */ }
    for (const file of scbFiles) {
        try {
            const { laneCount } = parseScbFile(path.join(DLINK_DIR, file));
            loadedScbFiles.push(file);
            logger.info('heatsheetStore: loaded .scb file', { file, lanes: laneCount });
        } catch (err) {
            logger.warn('heatsheetStore: failed to parse .scb file - skipped', { file, error: err.message });
        }
    }

    logger.info('heatsheetStore: reload complete', {
        files: loadedFiles.length,
        events: events.size,
        scbFiles: loadedScbFiles.length,
        scbEvents: scbEvents.size
    });
}

function start() {
    fs.mkdirSync(DLINK_DIR, { recursive: true });
    reload();

    let debounceTimer = null;
    for (const dir of [HEATSHEETS_DIR, DLINK_DIR]) {
        try {
            const w = fs.watch(dir, () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(reload, 500);
            });
            if (dir === HEATSHEETS_DIR) watcher = w;
        } catch (err) {
            logger.warn('heatsheetStore: could not watch directory for changes', { dir, error: err.message });
        }
    }
}

function getEvent(eventNumber) {
    return events.get(eventNumber) || scbEvents.get(eventNumber) || null;
}

function getEventTitle(eventNumber) {
    const ev = events.get(eventNumber);
    if (ev && ev.title) return ev.title;
    const scb = scbEvents.get(eventNumber);
    return scb ? scb.title : '';
}

// *_SCB.TXT first (names, clubs AND entry times); .scb fills any lane it
// doesn't cover (name/club only, hasEntryData=false so PB logic skips it).
function getLaneInfo(eventNumber, heatNumber, lane) {
    for (const source of [events, scbEvents]) {
        const ev = source.get(eventNumber);
        if (!ev) continue;
        const heat = ev.heats.get(heatNumber);
        if (!heat) continue;
        const info = heat.get(lane);
        if (info) return info;
    }
    return null;
}

// Loose "same person?" test between a *_SCB.TXT name ("Alex EXAMPLE") and a
// .scb name ("EXAMPLE,Alex" - sometimes just an initial: "EXAMPLE,A").
function sameSwimmer(txtName, scbRaw) {
    const tokens = (x) => x.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
    const [scbLast, scbFirst = ''] = scbRaw.split(',').map((x) => x.trim());
    const tx = tokens(txtName);
    const lastTokens = tokens(scbLast);
    if (!lastTokens.every((t) => tx.includes(t))) return false;
    const txFirst = tx.find((t) => !lastTokens.includes(t)) || '';
    const f = scbFirst.toLowerCase();
    return !f || !txFirst || txFirst[0] === f[0];
}

// Completeness report for the loaded meet data: what each event has, and
// anything missing or inconsistent between the two sources.
function check() {
    const nums = [...new Set([...events.keys(), ...scbEvents.keys()])].sort((a, b) => a - b);
    const out = [];
    const totals = { events: nums.length, swimmers: 0, withEntryTime: 0, noEntryTime: 0, namesOnly: 0 };
    for (const n of nums) {
        const tx = events.get(n);
        const sc = scbEvents.get(n);
        const issues = [];
        const heatNums = [...new Set([...(tx ? tx.heats.keys() : []), ...(sc ? sc.heats.keys() : [])])].sort((a, b) => a - b);
        let swimmers = 0, withTime = 0, noTime = 0, namesOnly = 0;

        for (const h of heatNums) {
            const tHeat = tx && tx.heats.get(h);
            const sHeat = sc && sc.heats.get(h);
            if (tx && sc && (!tHeat) !== (!sHeat)) {
                issues.push(`heat ${h} is only in ${tHeat ? '*_SCB.TXT' : '.scb'}`);
            }
            const lanes = new Set([...(tHeat ? tHeat.keys() : []), ...(sHeat ? sHeat.keys() : [])]);
            for (const lane of lanes) {
                const t = tHeat && tHeat.get(lane);
                const sw = sHeat && sHeat.get(lane);
                if (t) {
                    swimmers++;
                    if (t.entrySeconds !== null) withTime++; else noTime++;
                    if (sc && sHeat && !sw) issues.push(`heat ${h} lane ${lane} (${t.name}) is missing from the .scb`);
                    else if (sw && !sameSwimmer(t.name, sw.rawName)) issues.push(`heat ${h} lane ${lane}: *_SCB.TXT says "${t.name}", .scb says "${sw.rawName}"`);
                } else if (sw) {
                    swimmers++;
                    namesOnly++;
                    if (tx && tHeat) issues.push(`heat ${h} lane ${lane} (${sw.name}) is missing from the *_SCB.TXT`);
                }
            }
        }
        if (!tx) issues.unshift('not in any *_SCB.TXT - names only, so no entry times and no PB badges');
        if (!sc && scbEvents.size > 0) issues.unshift(`not in the DLinkHSL .scb files${tx ? ` (this event comes from ${tx.sourceFile})` : ''}`);
        if (swimmers === 0) issues.push('no swimmers listed');

        totals.swimmers += swimmers;
        totals.withEntryTime += withTime;
        totals.noEntryTime += noTime;
        totals.namesOnly += namesOnly;
        out.push({
            number: n,
            title: (tx && tx.title) || (sc && sc.title) || '',
            inScbTxt: !!tx,
            inDlinkScb: !!sc,
            heats: heatNums.length,
            swimmers, withEntryTime: withTime, noEntryTime: noTime, namesOnly,
            issues
        });
    }
    const problems = [];
    for (const e of out) for (const i of e.issues) problems.push(`Event ${e.number}: ${i}`);
    return { files: loadedFiles.slice(), scbFiles: loadedScbFiles.slice(), totals, events: out, problems };
}

// Every swimmer in the *_SCB.TXT data with the event title - for the
// qualifying-times data check.
function allSwimmers() {
    const out = [];
    for (const ev of events.values()) {
        for (const heat of ev.heats.values()) {
            for (const info of heat.values()) out.push({ sex: info.sex, age: info.age, dob: info.dob, code: info.code, club: info.club, eventTitle: ev.title });
        }
    }
    return out;
}

// Session number an event belongs to: from the DLinkHSL folder the .scb file came
// from ("Session 01__E401.scb" -> 1), else from the *_SCB.TXT name ("CC26S1_SCB.TXT"
// -> 1). null if neither says.
function sessionOfEvent(eventNumber) {
    const scb = scbEvents.get(eventNumber);
    if (scb) {
        const m = (scb.sourceFile || '').match(/^(.+?)__E\d+\.scb$/i);
        const n = m && (m[1].match(/(\d+)/) || [])[1];
        if (n) return parseInt(n, 10);
    }
    const tx = events.get(eventNumber);
    const t = tx && (tx.sourceFile || '').match(/S(\d+)_SCB\.TXT$/i);
    return t ? parseInt(t[1], 10) : null;
}

// Sorted list of session numbers present in the loaded meet files.
function sessions() {
    const set = new Set();
    for (const n of [...events.keys(), ...scbEvents.keys()]) { const s = sessionOfEvent(n); if (s) set.add(s); }
    return [...set].sort((a, b) => a - b);
}

// Every heat of the loaded meet in running order (as listed in the *_SCB.TXT, then heat number):
// [{ event, title, heat, lanes: [{ lane, name, club, code, entrySeconds }] }].
// *_SCB.TXT data wins; .scb fills any event/heat/lane it doesn't cover. Used by the
// athlete / team / marshal pages. (Dates of birth and member numbers are never
// included here - they must not leave this laptop; entry times are, as on a printed heat sheet.)
function runningOrder() {
    // The *_SCB.TXT lists events in the order they are swum, which is not always numeric
    // order (events get swapped in Meet Manager), so follow the file. Events that only have
    // a .scb come after, in number order.
    const fromTxt = [...events.keys()];
    const rest = [...scbEvents.keys()].filter((n) => !events.has(n)).sort((a, b) => a - b);
    return [...fromTxt, ...rest];
}

function listHeats() {
    const out = [];
    const nums = runningOrder();
    for (const n of nums) {
        const tx = events.get(n), sc = scbEvents.get(n);
        const title = (tx && tx.title) || (sc && sc.title) || '';
        const heatNums = [...new Set([...(tx ? tx.heats.keys() : []), ...(sc ? sc.heats.keys() : [])])].sort((a, b) => a - b);
        for (const h of heatNums) {
            const t = tx && tx.heats.get(h), s2 = sc && sc.heats.get(h);
            const laneNums = [...new Set([...(t ? t.keys() : []), ...(s2 ? s2.keys() : [])])].sort((a, b) => a - b);
            const lanes = [];
            for (const l of laneNums) {
                const info = (t && t.get(l)) || (s2 && s2.get(l));
                if (!info || !info.name) continue;
                lanes.push({ lane: l, name: info.name, club: info.club || '', code: info.code || '', entrySeconds: info.entrySeconds != null ? info.entrySeconds : null, hasEntryData: info.hasEntryData !== false });
            }
            if (lanes.length) out.push({ event: n, title, heat: h, lanes });
        }
    }
    return out;
}

function status() {
    return { files: loadedFiles.slice(), eventCount: events.size, scbFiles: loadedScbFiles.slice(), scbEventCount: scbEvents.size };
}

module.exports = { start, getEvent, getEventTitle, getLaneInfo, status, check, allSwimmers, sameSwimmer, sessionOfEvent, sessions, listHeats, parseTimeToSeconds };
