#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Builds config/clubs.json (club code -> name, county, region) from the Meet
// Manager club database "gbclub.sdb". Each record is 53 characters:
//   [0..12) short name  [12..16) club code  [16..48) club name  [48..52) county code
// County code -> county name is in config/counties.json. The club code's last
// letter is the Swim England region (key from
// https://www.swimming.org/swimengland/swim-england-club-codes/).
//
//   node scripts/import-clubs.js                 (downloads gbclub.sdb from the shared Drive Meets folder)
//   node scripts/import-clubs.js path/to/gbclub.sdb
//
// Hand-written overrides/additions go in config/clubs.local.json (same shape,
// keys are club codes or club names) and win over this generated file.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const REGION_BY_LETTER = {
    M: 'West Midlands', N: 'North West', L: 'London', W: 'South West', X: 'Scotland',
    E: 'North East', A: 'East Midlands', T: 'East', S: 'South East', Y: 'Wales'
};

async function getBuffer() {
    const local = process.argv[2];
    if (local) return fs.readFileSync(local);
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'drive.json'), 'utf8'));
    const { listFolder } = require('../server/driveSync.js');
    const files = await listFolder(cfg.rootFolderId);
    const f = files.find((x) => !x.isFolder && x.name.toLowerCase() === 'gbclub.sdb');
    if (!f) throw new Error('gbclub.sdb not found in the Drive Meets folder');
    const res = await fetch(`https://drive.google.com/uc?export=download&id=${f.id}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
}

(async () => {
    const text = (await getBuffer()).toString('latin1');
    const counties = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'counties.json'), 'utf8'));
    const R = 53;
    if (text.length % R !== 0) console.warn(`Warning: file length ${text.length} is not a multiple of ${R} - layout may have changed.`);
    const clubs = {};
    const unknownCounty = {};
    let n = 0;
    for (let i = 0; i + 52 <= text.length; i += R) {
        const rec = text.slice(i, i + R);
        const code = rec.slice(12, 16).trim();
        const name = rec.slice(16, 48).trim();
        const lsc = rec.slice(48, 52);
        if (!/^[A-Z0-9]{3,4}$/.test(code) || !name) continue;
        const county = counties[lsc];
        if (!county) unknownCounty[lsc] = (unknownCounty[lsc] || 0) + 1;
        clubs[code] = { name, county: county || '', region: REGION_BY_LETTER[code.slice(-1)] || '', lsc };
        n++;
    }
    fs.mkdirSync(path.join(ROOT, 'config'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'config', 'clubs.json'), JSON.stringify(clubs, null, 1) + '\n');
    console.log(`Wrote config/clubs.json: ${n} clubs.`);
    const withCounty = Object.values(clubs).filter((c) => c.county).length;
    console.log(`  ${withCounty} have a county; codes with no county name in config/counties.json: ${JSON.stringify(unknownCounty)}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
