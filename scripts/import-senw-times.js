#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Imports an event's qualifying times from the official Swim England North
// West events site (https://events.swimnorthwest.org/entry-system/MeetQTs.php)
// into qualtimes/, in the layout the scoreboard reads, and registers it in
// config/qualifying.json.
//
//   node scripts/import-senw-times.js SW26 --level RT          (Winter Regionals 2026, short course)
//   node scripts/import-senw-times.js LC27 --level CT --county Lancashire
//
// The page states everything that matters and it is copied across as-is:
// course (SC/LC), "Age at <date>", the date window the times must be set in,
// and the QT rule ("Faster than" = strictly faster than the listed time).
// Meet codes are on https://events.swimnorthwest.org/ ("QTs" links).
//
// NOTE: some counties ask that their own published qualifying documents are
// not re-published or processed by third-party / AI tools (Swim Cumbria's
// page says so). Only import a county's times if you are happy that applies
// to your use.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const code = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
if (!code) { console.error('Usage: import-senw-times.js <MeetCode, e.g. SW26 or LC27> [--level CT|RT|NT] [--county Name] [--region "North West"]'); process.exit(1); }
const level = opt('level', 'CT').toUpperCase();
const county = opt('county', '');
const region = opt('region', '');
const url = `https://events.swimnorthwest.org/entry-system/MeetQTs.php?MeetCode=${encodeURIComponent(code)}`;

const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const dmyToIso = (s) => { const m = (s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) { console.error(`Could not fetch ${url} (HTTP ${res.status})`); process.exit(1); }
    const html = await res.text();

    const title = strip((html.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1] || code);
    const pills = (html.match(/<span class="qt-pill">([\s\S]*?)<\/span>/g) || []).map(strip);
    const course = pills.includes('LC') ? 'LC' : (pills.includes('SC') ? 'SC' : null);
    const ageAsAt = dmyToIso((pills.find((p) => /^Age At/i.test(p)) || ''));
    const from = dmyToIso((pills.find((p) => /^Times From/i.test(p)) || ''));
    const to = dmyToIso((pills.find((p) => /^Times To/i.test(p)) || ''));
    const note = strip((html.match(/<div class="qt-note">([\s\S]*?)<\/div>/) || [])[1] || '');
    const strict = /faster than/i.test(note) && !/equal|or faster/i.test(note.replace(/faster than/i, ''));
    if (!course) { console.error('Could not tell whether these are short or long course - nothing written.'); process.exit(1); }

    const groups = html.split('<section class="qt-group">').slice(1);
    const out = [`Imported from ${url} on ${new Date().toISOString().slice(0, 10)}`, `${title} (${code}) - ${note}`, `Age at ${ageAsAt || '?'}; times from ${from || '?'} to ${to || '?'}`];
    let total = 0;
    for (const g of groups) {
        const heading = strip((g.match(/<h2>([\s\S]*?)<\/h2>/) || [])[1] || '');
        const sex = /female/i.test(heading) ? 'Female' : (/male|open/i.test(heading) ? 'Male' : null);
        if (!sex) continue;
        const heads = (g.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0].match(/<th[^>]*>([\s\S]*?)<\/th>/g).map(strip).slice(1);
        out.push(`${sex} ${course === 'SC' ? 'Short Course' : 'Long Course'}`);
        out.push(['Event', ...heads].join('\t'));
        for (const row of g.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
            const ev = row.match(/<td class="qt-event">([\s\S]*?)<\/td>/);
            if (!ev) continue;
            const times = (row.match(/<td class="qt-time">([\s\S]*?)<\/td>/g) || []).map(strip);
            if (!times.length) continue;
            total += times.filter((t) => /^\d/.test(t)).length;
            out.push([strip(ev[1]).replace(/^(\d+)m\s+/i, '$1 '), ...times.map((t) => (/^\d/.test(t) ? t : 'NOTIME'))].join('\t'));
        }
    }
    if (!total) { console.error('No qualifying times found on the page - nothing written.'); process.exit(1); }

    const fileName = `${code.toUpperCase()}-${course}.txt`;
    fs.mkdirSync(path.join(ROOT, 'qualtimes'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'qualtimes', fileName), out.join('\r\n') + '\r\n');
    console.log(`Wrote qualtimes/${fileName}: ${total} ${course} times for "${title}".`);
    console.log(`  Age as at ${ageAsAt}; times must be set ${from} to ${to}; rule: ${strict ? 'strictly faster than' : 'see note: ' + note}`);

    const cfgPath = path.join(ROOT, 'config', 'qualifying.json');
    let cfg = { course: 'SC', standards: [] };
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* new */ }
    const entry = { level, name: title, file: fileName, course, rule: strict ? 'faster-than' : 'equal-or-faster' };
    if (county) entry.county = county;
    if (region) entry.region = region;
    if (ageAsAt) entry.ageAsAt = ageAsAt;
    if (from || to) entry.window = { from, to };
    cfg.standards = (cfg.standards || []).filter((s) => s.file !== fileName && !(s.file || '').startsWith('Lancashire-2027'));
    cfg.standards.push(entry);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`Registered in config/qualifying.json: ${JSON.stringify(entry)}`);
})().catch((err) => { console.error(err.message); process.exit(1); });
