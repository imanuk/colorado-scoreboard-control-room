#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Imports a county's qualifying times from swimming-times.com into qualtimes/
// in the Meet Manager report layout the scoreboard reads (see
// qualtimes/README.txt), and registers it in config/qualifying.json.
//
//   node scripts/import-county-times.js lancashire-2027 [--course SC|LC] [--level CT] [--county Lancashire] [--no-register]
//
// The page is a normal server-rendered HTML page (one table per age group and
// gender). Only the "QT" (qualifying time) column for the chosen course is
// taken; the site's own "CT" (consideration time) column is ignored - it is a
// different thing from the CT (county time) badge. Times are a third party's
// transcription of the county's published standards: check them against the
// county's own document before relying on them.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
if (!slug) { console.error('Usage: import-county-times.js <slug, e.g. lancashire-2027> [--course SC|LC] [--level CT] [--county Name] [--no-register]'); process.exit(1); }
const course = (opt('course', 'SC')).toUpperCase();
const level = opt('level', 'CT').toUpperCase();
const county = opt('county', slug.replace(/-\d{4}$/, '').split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));
const url = `https://swimming-times.com/qualifying-times/${slug}/`;

const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
function isoDate(text) {
    const m = (text || '').match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
    if (!m || !MONTHS[m[2].toLowerCase()]) return null;
    return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) { console.error(`Could not fetch ${url} (HTTP ${res.status})`); process.exit(1); }
    const html = await res.text();

    const fact = (label) => { const m = html.match(new RegExp(`<dt>${label}</dt>\\s*<dd>([\\s\\S]*?)</dd>`, 'i')); return m ? strip(m[1]) : ''; };
    const championship = fact('Championship');
    const windowText = fact('Qualifying window');
    const asAtText = fact('Age as at');
    const ageAsAt = isoDate(asAtText);
    const [fromText, toText] = windowText.split(/\s+to\s+/i);
    const window = { from: isoDate(fromText), to: isoDate(toText) };

    // h2 "... - Female" / "... - Male / Open", h3 age band, then its table.
    const colIndex = course === 'SC' ? 3 : 1; // QT LC, CT LC, QT SC, CT SC (after the event name)
    const data = { Female: {}, Male: {} }; // sex -> band -> event -> time
    const bandOrder = { Female: [], Male: [] };
    let sex = null;
    const tokens = html.match(/<h2[\s\S]*?<\/h2>|<h3[\s\S]*?<\/h3>|<table[\s\S]*?<\/table>/g) || [];
    let band = null;
    for (const t of tokens) {
        if (t.startsWith('<h2')) {
            const h = strip(t);
            sex = /female/i.test(h) ? 'Female' : (/male/i.test(h) ? 'Male' : null);
        } else if (t.startsWith('<h3')) {
            band = strip(t).split(/\s+[—-]\s+/)[0].trim();
        } else if (sex && band) {
            if (!bandOrder[sex].includes(band)) bandOrder[sex].push(band);
            data[sex][band] = data[sex][band] || {};
            for (const row of t.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
                const name = row.match(/<th scope="row">([\s\S]*?)<\/th>/);
                if (!name) continue;
                const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map(strip);
                const time = cells[colIndex - 1];
                const event = strip(name[1]).replace(/^(\d+)m\s+/i, '$1 ');
                data[sex][band][event] = /^\d/.test(time || '') ? time : 'NOTIME';
            }
            band = null;
        }
    }

    const total = Object.values(data).reduce((n, b) => n + Object.values(b).reduce((m, e) => m + Object.values(e).filter((x) => x !== 'NOTIME').length, 0), 0);
    if (!total) { console.error(`No ${course} qualifying times found on ${url} - nothing written.`); process.exit(1); }

    const courseName = course === 'SC' ? 'Short Course' : 'Long Course';
    const out = [`Imported from ${url} on ${new Date().toISOString().slice(0, 10)}`, `${county} ${championship || 'county'} (QT)`, `Qualifying window: ${windowText || 'not stated'}   Age as at: ${asAtText || 'not stated'}`];
    for (const sx of ['Female', 'Male']) {
        const bands = bandOrder[sx];
        if (!bands.length) continue;
        const events = [];
        for (const b of bands) for (const e of Object.keys(data[sx][b])) if (!events.includes(e)) events.push(e);
        out.push(`${sx} ${courseName}`);
        out.push(['Event', ...bands].join('\t'));
        for (const e of events) out.push([e, ...bands.map((b) => (data[sx][b] && data[sx][b][e]) || 'NOTIME')].join('\t'));
    }
    const fileName = `${county.replace(/[^A-Za-z0-9]+/g, '')}-${slug.match(/(\d{4})$/)?.[1] || 'times'}-${course}.txt`;
    fs.mkdirSync(path.join(ROOT, 'qualtimes'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'qualtimes', fileName), out.join('\r\n') + '\r\n');
    console.log(`Wrote qualtimes/${fileName}: ${total} ${course} qualifying times (${championship}).`);
    console.log(`  Age as at: ${asAtText || '?'}   Window: ${windowText || '?'}`);

    if (args.includes('--no-register')) return;
    const cfgPath = path.join(ROOT, 'config', 'qualifying.json');
    let cfg = { course: 'SC', standards: [] };
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* new */ }
    const entry = { level, name: `${county} County ${slug.match(/(\d{4})$/)?.[1] || ''}`.trim(), file: fileName, county, course };
    if (ageAsAt) entry.ageAsAt = ageAsAt;
    if (window.from || window.to) entry.window = window;
    cfg.standards = (cfg.standards || []).filter((s) => s.file !== fileName);
    cfg.standards.push(entry);
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`Registered in config/qualifying.json as ${level} (${JSON.stringify(entry)})`);
})().catch((err) => { console.error(err.message); process.exit(1); });
