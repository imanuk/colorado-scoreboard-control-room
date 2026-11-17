#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Imports every county's qualifying times for a year (default 2027) listed on
// https://swimming-times.com/qualifying-times/, one request per county with a
// pause between, by running import-county-times.js for each. Counties whose
// official times come from the Swim England North West site (Lancashire,
// Cumbria, Cheshire) are skipped here - use import-senw-times.js for those.
//
//   node scripts/import-all-2027.js [year]
//
// Third-party copies of each county's published standards: check against the
// county's own document before relying on them. Counties with no short-course
// times (or a page that doesn't parse) are reported and skipped.

const { spawnSync } = require('child_process');
const path = require('path');

const year = process.argv[2] || '2027';
const COUNTY_NAMES = {
    'bedfordshire': 'Bedfordshire', 'berkshire-and-south-buckinghamshire': 'Berkshire & South Buckinghamshire',
    'cambridgeshire': 'Cambridgeshire', 'cornwall': 'Cornwall', 'derbyshire': 'Derbyshire', 'devon': 'Devon', 'dorset': 'Dorset',
    'essex': 'Essex', 'gloucestershire': 'Gloucestershire', 'hampshire': 'Hampshire', 'hertfordshire': 'Hertfordshire',
    'kent': 'Kent', 'leicestershire': 'Leicestershire', 'lincolnshire': 'Lincolnshire', 'middlesex': 'Middlesex',
    'norfolk': 'Norfolk', 'northamptonshire': 'Northamptonshire', 'northumberland-and-durham': 'Northumberland & Durham',
    'nottinghamshire': 'Nottinghamshire', 'oxfordshire-and-north-buckinghamshire': 'Oxfordshire & North Buckinghamshire',
    'scotland-east-district': 'Scotland East District', 'scotland-midland-district': 'Scotland Midland District',
    'scotland-north-district': 'Scotland North District', 'shropshire': 'Shropshire', 'somerset': 'Somerset',
    'staffordshire': 'Staffordshire', 'suffolk': 'Suffolk', 'surrey': 'Surrey', 'sussex': 'Sussex', 'warwickshire': 'Warwickshire',
    'wiltshire': 'Wiltshire', 'worcestershire': 'Worcestershire', 'yorkshire': 'Yorkshire'
};
const SKIP = new Set(['lancashire', 'cumbria', 'cheshire']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const html = await (await fetch('https://swimming-times.com/qualifying-times/', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
    const slugs = [...new Set([...html.matchAll(/href="\/qualifying-times\/([a-z0-9-]+-(\d{4}))\/"/g)].filter((m) => m[2] === year).map((m) => m[1]))];
    const results = [];
    for (const slug of slugs) {
        const base = slug.replace(/-\d{4}$/, '');
        if (SKIP.has(base)) continue;
        const county = COUNTY_NAMES[base];
        if (!county) { results.push(`${slug}: no county name known (add it to COUNTY_NAMES) - skipped`); continue; }
        const r = spawnSync(process.execPath, [path.join(__dirname, 'import-county-times.js'), slug, '--county', county], { encoding: 'utf8' });
        const first = (r.stdout || '').split('\n').filter(Boolean);
        results.push(r.status === 0 ? `${county}: ${first[0]} ${first[1] ? '(' + first[1].trim() + ')' : ''}` : `${county}: FAILED - ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
        await sleep(1000);
    }
    console.log(results.join('\n'));
})();
