#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Terminal meet picker used by "Start Scoreboard.command": lists the meets
// in the shared Google Drive folder (newest scoreboard file first), lets you
// pick one, and tells the running server to load it. Enter (or 20s of no
// input) takes the newest. Never fails the launch - if Drive can't be
// reached the previously loaded meet's files simply stay in use.

const readline = require('readline');
const PORT = process.env.SCOREBOARD_PORT || 8080;
const BASE = `http://localhost:${PORT}`;
const AUTO_PICK_SECONDS = 20;

async function api(path, opts) {
    const res = await fetch(BASE + path, { ...opts, signal: AbortSignal.timeout(45000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
}

function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
}

function ask(question, seconds) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const timer = setTimeout(() => { console.log(''); rl.close(); resolve(''); }, seconds * 1000);
        rl.question(question, (answer) => { clearTimeout(timer); rl.close(); resolve(answer.trim()); });
    });
}

(async () => {
    let data;
    try {
        data = await api('/api/meets');
    } catch (err) {
        console.log(`Could not read the Google Drive meets folder (${err.message}).`);
        console.log('Carrying on with the meet files already on this machine.');
        return;
    }

    const hasData = (m) => m.files.length > 0 || (m.dlink || []).length > 0;
    const ready = data.meets.filter(hasData);
    const pending = data.meets.filter((m) => !hasData(m));
    const current = data.status.selected;

    console.log('Meets in Google Drive (newest scoreboard file first):');
    ready.forEach((m, i) => {
        const tags = [m.id === (current && current.id) ? 'currently loaded' : ''].filter(Boolean).join(', ');
        console.log(`  ${i + 1}) ${m.name}  - ${[m.files.length ? m.files.map((f) => f.name).join(', ') : '', (m.dlink || []).length ? `${m.dlink.length} .scb` : ''].filter(Boolean).join(' + ')}, updated ${fmtDate(m.lastUpdated)}${tags ? '  [' + tags + ']' : ''}`);
    });
    pending.forEach((m) => console.log(`     ${m.name}  - no scoreboard files yet`));

    if (ready.length === 0) {
        console.log('No meet has a scoreboard file (reports/*_SCB.TXT) yet - nothing to load.');
        return;
    }

    const answer = await ask(`Choose a meet [1 = ${ready[0].name}, Enter to accept, ${AUTO_PICK_SECONDS}s auto]: `, AUTO_PICK_SECONDS);
    let idx = 0;
    if (answer) {
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= ready.length) idx = n - 1;
        else console.log(`"${answer}" isn't one of the options - using ${ready[0].name}.`);
    }
    const meet = ready[idx];

    try {
        const status = await api('/api/meets/select', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: meet.id })
        });
        if (status.lastSyncOk) {
            console.log(`Loaded ${meet.name}: ${status.files.length} file(s)`);
            await new Promise((r) => setTimeout(r, 1200)); // let the server finish re-reading the files
            try {
                const check = await api('/api/meets/check');
                const t = check.totals;
                console.log(`  ${t.events} events, ${t.swimmers} swimmers, ${t.withEntryTime} with entry times (${t.noEntryTime} without).`);
                if (check.problems.length) {
                    console.log(`  ${check.problems.length} thing(s) to look at (full list: ${BASE}/meet.html):`);
                    check.problems.slice(0, 6).forEach((p) => console.log(`   - ${p}`));
                    if (check.problems.length > 6) console.log(`   ...and ${check.problems.length - 6} more`);
                } else console.log('  Nothing missing - the files agree with each other.');
            } catch { /* summary is a nicety only */ }
        } else console.log(`Selected ${meet.name}, but the file download failed: ${status.lastError}`);
    } catch (err) {
        console.log(`Could not load ${meet.name}: ${err.message}`);
    }
})();
