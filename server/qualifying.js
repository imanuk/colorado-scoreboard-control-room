// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// County / Regional / National qualifying-time badges (CT / RT / NT).
//
// Standards are NEVER built in - they change every year and differ by
// gender, age and course - so they come from files in qualtimes/, in the
// layout Meet Manager's "Meet Qualifying Times Report" prints:
//
//   Meet Qualifying Times Report     Fri 18  September 2026 08:47 pm
//   <name of the qualifying set>
//   Female Short CourseUpper Limit Time
//   Event<TAB>09<TAB>10<TAB>11<TAB>12<TAB>13<TAB>14<TAB>15/OV
//   50 Freestyle<TAB>00:38.00<TAB>00:32.00<TAB>...
//   200 Freestyle<TAB>NOTIME<TAB>02:30.00<TAB>...      (NOTIME / blank = no standard)
//   Male
//   Event<TAB>09<TAB>...
//
// config/qualifying.json says which file is which level and who it applies to:
//   { "course": "SC",
//     "standards": [
//       { "level": "CT", "name": "Lancashire County", "file": "Lancashire-County.txt", "county": "Lancashire" },
//       { "level": "RT", "name": "North West Region", "file": "NorthWest-Region.txt", "region": "North West" },
//       { "level": "NT", "name": "National",          "file": "National.txt" } ] }
// A standard with "county" / "region" only applies to swimmers whose club
// (config/clubs.json: club code -> county, region) is in it; one with neither
// applies to everyone. A swimmer is shown the HIGHEST level (NT > RT > CT)
// whose time they have beaten or equalled.

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'qualifying.json');
const CLUBS_PATH = path.join(__dirname, '..', 'config', 'clubs.json');
const CLUBS_LOCAL_PATH = path.join(__dirname, '..', 'config', 'clubs.local.json');
const QUALTIMES_DIR = path.join(__dirname, '..', 'qualtimes');

const LEVEL_RANK = { CT: 1, RT: 2, NT: 3 };

let config = { course: 'SC', standards: [] };
let clubs = {};
let clubsLower = new Map(); // lower-cased club code / name -> {county, region}
let standards = []; // loaded, ready to use
let loadProblems = [];
let disabledList = [];

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function parseTime(str) {
    if (!str) return null;
    const t = str.trim();
    if (!t || /^no\s*time$/i.test(t) || /^notime$/i.test(t)) return null;
    const parts = t.split(':');
    let secs;
    if (parts.length === 2) secs = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    else if (parts.length === 1) secs = parseFloat(parts[0]);
    else return null;
    return Number.isFinite(secs) ? secs : null;
}

// "200 Individual Medley" / "200 IM" / "100 Free" -> "200 im" etc.
function eventKey(distance, stroke) {
    const s = stroke.toLowerCase();
    let key;
    if (s.startsWith('free')) key = 'free';
    else if (s.startsWith('back')) key = 'back';
    else if (s.startsWith('breast')) key = 'breast';
    else if (s.startsWith('fly') || s.startsWith('butter')) key = 'fly';
    else if (s === 'im' || s.startsWith('individual') || s.startsWith('indiv') || s.startsWith('medley')) key = 'im';
    else return null;
    return `${Number(distance)} ${key}`;
}

// Event title ("Mixed 09 Yrs/Over 100m IM", "Mixed 12/OV 800 Meter Freestyle")
// -> key, or null (relays, 25m events with no standard, unrecognised text).
function eventKeyFromTitle(title) {
    if (!title || /relay/i.test(title)) return null;
    const m = title.match(/(\d+)\s*(?:m|meters?|metres?)?\s+(freestyle|free|backstroke|back|breaststroke|breast|butterfly|fly|(?:individual|indiv\.?)\s+medley|medley|im)\b/i);
    return m ? eventKey(m[1], m[2].replace(/\s+/g, ' ')) : null;
}

// Parse the Meet Manager report text -> { setName, course, tables }.
// tables: { F|M: { eventKey: { bands:[{min,open}], times:[seconds|null] } } }
function parseReport(text) {
    const lines = text.split(/\r?\n/);
    const setName = (lines[1] || '').trim();
    const course = /long\s*course/i.test(text) ? 'LC' : (/short\s*course/i.test(text) ? 'SC' : null);
    const tables = { F: {}, M: {} };
    let sex = null;
    let bands = null;
    let rows = 0;
    for (const line of lines) {
        const l = line.trim();
        if (!l) continue;
        const sexMatch = l.match(/^(Female|Male)\b/i);
        if (sexMatch) { sex = sexMatch[1][0].toUpperCase(); bands = null; continue; }
        if (!sex) continue;
        const cols = line.split('\t').map((c) => c.trim());
        if (cols[0].toLowerCase() === 'event') {
            // Age columns: "09" (exactly 9), "10/11" or "10-11" (10 to 11), "15/OV"
            // or "17/Over" (that age and over), "9/U" (9 and under).
            bands = cols.slice(1).filter(Boolean).map((label) => {
                const m = label.match(/^(\d+)(?:\s*[\/-]\s*(\d+|ov|over|u|un|under))?/i);
                const first = m ? parseInt(m[1], 10) : NaN;
                const tail = m && m[2] ? m[2].toLowerCase() : '';
                if (/^\d+$/.test(tail)) return { label, min: first, max: parseInt(tail, 10) };
                if (tail === 'ov' || tail === 'over') return { label, min: first, max: Infinity };
                if (tail) return { label, min: 0, max: first }; // u / un / under
                return { label, min: first, max: first };
            });
            continue;
        }
        if (!bands) continue;
        const dm = cols[0].match(/^(\d+)\s+(.+)$/);
        if (!dm) continue;
        const key = eventKey(dm[1], dm[2]);
        if (!key) continue;
        tables[sex][key] = { bands, times: bands.map((_, i) => parseTime(cols[i + 1])) };
        rows++;
    }
    return { setName, course, tables, rows };
}

function load() {
    config = { course: 'SC', standards: [], ...readJson(CONFIG_PATH, {}) };
    // clubs.json is generated from gbclub.sdb (scripts/import-clubs.js); clubs.local.json
    // holds hand-written additions/overrides and wins.
    clubs = { ...readJson(CLUBS_PATH, {}), ...readJson(CLUBS_LOCAL_PATH, {}) };
    buildClubLookup();
    standards = [];
    loadProblems = [];
    disabledList = [];
    for (const def of config.standards || []) {
        if (def.disabled) { disabledList.push(`${def.name || def.file}: switched off - ${def.disabledReason || 'disabled in config'}`); continue; }
        try {
            const text = fs.readFileSync(path.join(QUALTIMES_DIR, def.file), 'utf8');
            const parsed = parseReport(text);
            if (!LEVEL_RANK[def.level]) throw new Error(`level must be CT, RT or NT (got "${def.level}")`);
            if (!parsed.rows) throw new Error('no event rows found - is it a Meet Qualifying Times Report?');
            standards.push({ ...def, parsed, course: def.course || parsed.course || config.course });
            logger.info('qualifying: loaded standard', { level: def.level, name: def.name, file: def.file, events: parsed.rows, course: standards[standards.length - 1].course });
        } catch (err) {
            loadProblems.push(`${def.name || def.file}: ${err.message}`);
            logger.warn('qualifying: could not load standard', { file: def.file, error: err.message });
        }
    }
}

function start() {
    fs.mkdirSync(QUALTIMES_DIR, { recursive: true });
    load();
    let t = null;
    const reload = () => { clearTimeout(t); t = setTimeout(load, 500); };
    for (const target of [QUALTIMES_DIR, CONFIG_PATH, CLUBS_PATH, CLUBS_LOCAL_PATH]) {
        try { fs.watch(target, reload); } catch { /* config file may not exist yet */ }
    }
}

function bandIndex(parsedEvent, age) {
    if (!Number.isFinite(age)) return -1;
    return parsedEvent.bands.findIndex((b) => age >= b.min && age <= b.max);
}

// Age on a given date (YYYY-MM-DD) from a date of birth (YYYY-MM-DD).
function ageAsAt(dob, asAt) {
    const d = (dob || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    const a = (asAt || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!d || !a) return NaN;
    let age = Number(a[1]) - Number(d[1]);
    if (Number(a[2]) < Number(d[2]) || (Number(a[2]) === Number(d[2]) && Number(a[3]) < Number(d[3]))) age--;
    return age;
}

// The age a standard should use for this swimmer: age on the standard's own
// "age as at" date when configured (computed from date of birth - the heat
// sheet's age is as at the meet's own date and can be a year out), else the
// heat sheet's age.
function ageFor(std, swimmer) {
    if (std.ageAsAt && swimmer.dob) {
        const a = ageAsAt(swimmer.dob, std.ageAsAt);
        if (Number.isFinite(a)) return a;
    }
    return parseInt(swimmer.age, 10);
}

// Standards with a qualifying window only count while today is inside it.
function inWindow(std, now = new Date()) {
    const w = std.window;
    if (!w) return true;
    const day = now.toISOString().slice(0, 10);
    return (!w.from || day >= w.from) && (!w.to || day <= w.to);
}

// Club -> {county, region} by club code (e.g. EXAM) or club name as printed
// on the heat sheet (e.g. "ExampleTown"), case-insensitive.
function buildClubLookup() {
    clubsLower = new Map();
    for (const [key, v] of Object.entries(clubs)) {
        clubsLower.set(key.toLowerCase(), v);
        if (v && v.name) clubsLower.set(String(v.name).toLowerCase(), v);
    }
}

function clubFor(swimmer) {
    const get = (k) => (k ? clubsLower.get(String(k).trim().toLowerCase()) || null : null);
    return get(swimmer.code) || get(swimmer.club);
}

function standardApplies(std, club) {
    if (std.county && !(club && club.county && club.county.toLowerCase() === std.county.toLowerCase())) return false;
    if (std.region && !(club && club.region && club.region.toLowerCase() === std.region.toLowerCase())) return false;
    return true;
}

// swimmer: { sex: 'B'|'G', age: number|string, code: club code }
// Returns 'NT' | 'RT' | 'CT' | '' (highest level achieved).
function qualify(swimmer, eventTitle, raceSeconds) {
    if (!standards.length || raceSeconds === null || !swimmer) return '';
    const key = eventKeyFromTitle(eventTitle);
    if (!key) return '';
    const sexKey = swimmer.sex === 'G' ? 'F' : (swimmer.sex === 'B' ? 'M' : null);
    if (!sexKey) return '';
    const club = clubFor(swimmer);
    let best = '';
    for (const std of standards) {
        if (std.course !== config.course) continue;
        if (!inWindow(std)) continue;
        if (!standardApplies(std, club)) continue;
        const ev = std.parsed.tables[sexKey][key];
        if (!ev) continue;
        const i = bandIndex(ev, ageFor(std, swimmer));
        if (i < 0) continue;
        const limit = ev.times[i];
        if (limit === null) continue;
        // "Faster than" (the usual Swim England rule) is strict; equal doesn't count.
        const beaten = std.rule === 'faster-than' ? raceSeconds < limit - 1e-9 : raceSeconds <= limit + 1e-9;
        if (beaten && (!best || LEVEL_RANK[std.level] > LEVEL_RANK[best])) best = std.level;
    }
    return best;
}

// What's loaded, plus gaps for the data check. `swimmers` is every swimmer
// in the loaded meet: [{sex, age, code, eventTitle}].
function check(swimmers = []) {
    const usable = standards.filter((s) => s.course === config.course);
    const skippedCourse = standards.filter((s) => s.course !== config.course).map((s) => `${s.name} (${s.course})`);
    const unmapped = new Set();
    const noBand = new Set();
    const noStandardEvents = new Set();
    for (const sw of swimmers) {
        const club = clubFor(sw);
        if ((sw.code || sw.club) && !club) unmapped.add(`${sw.club || ''}${sw.code ? ' (' + sw.code + ')' : ''}`.trim());
        const key = eventKeyFromTitle(sw.eventTitle);
        if (!key) { noStandardEvents.add(sw.eventTitle); continue; }
        const sexKey = sw.sex === 'G' ? 'F' : (sw.sex === 'B' ? 'M' : null);
        for (const std of usable) {
            if (!sexKey || !standardApplies(std, club)) continue;
            const ev = std.parsed.tables[sexKey][key];
            const age = ageFor(std, sw);
            if (ev && bandIndex(ev, age) < 0) noBand.add(`${std.level} ${Number.isFinite(age) ? age : '?'}`);
        }
    }
    return {
        course: config.course,
        standards: standards.map((s) => ({
            level: s.level, name: s.name, file: s.file, course: s.course,
            scope: s.county ? `county ${s.county}` : (s.region ? `region ${s.region}` : 'everyone'),
            ageAsAt: s.ageAsAt || null,
            rule: s.rule || 'equal-or-faster',
            window: s.window || null,
            events: s.parsed.rows
        })),
        problems: [
            ...loadProblems,
            ...disabledList,
            ...usable.filter((x) => !inWindow(x)).map((x) => `${x.name}: today is outside its qualifying window (${x.window.from || '…'} to ${x.window.to || '…'}) - not used`),
            ...skippedCourse.map((n) => `${n}: course doesn't match the configured course "${config.course}" - not used`),
            ...(unmapped.size ? [`Club(s) with no county/region in config/clubs.json: ${[...unmapped].join(', ')} - county/region-only standards can't be applied to them`] : []),
            ...(noBand.size ? [`No standard for these age(s) (no badge): ${[...noBand].sort().join(', ')}`] : [])
        ],
        eventsWithoutStandards: [...noStandardEvents]
    };
}

// Test hook: inject standards/clubs without touching config/ files.
function _setForTest(cfg, clubsMap, stds) { config = { course: 'SC', standards: [], ...cfg }; clubs = clubsMap; buildClubLookup(); standards = stds; }

module.exports = { start, load, qualify, check, parseReport, eventKeyFromTitle, ageAsAt, LEVEL_RANK, _setForTest };
