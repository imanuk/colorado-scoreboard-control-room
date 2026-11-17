// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Pulls each meet's scoreboard text file(s) (reports/*_SCB.TXT) from the
// shared Google Drive "Meets" folder into heatsheets/, where heatsheetStore
// picks them up. No Google account, API key or extra software: a folder
// shared as "anyone with the link" can be listed through Drive's public
// embedded folder view and its files fetched through the public download
// URL.
//
// Layout expected in Drive:
//   Meets/<meet name>/reports/<anything>_SCB.TXT      (names, titles, entry times)
//   Meets/<meet name>/DLinkHSL/<Session xx>/E###.scb   (names, titles - no times)
//
// Only files this module downloaded are ever replaced or removed (tracked in
// heatsheets/.drive-synced.json) - anything dropped into heatsheets/ by hand
// is left alone.

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'drive.json');
const SELECTED_PATH = path.join(__dirname, '..', 'config', 'selected-meet.json');
const HEATSHEETS_DIR = path.join(__dirname, '..', 'heatsheets');
const MANIFEST_PATH = path.join(HEATSHEETS_DIR, '.drive-synced.json');

const DEFAULT_CONFIG = {
    // The id of your shared Google Drive "Meets" folder (the last part of its link).
    // Set it in config/drive.json - see docs/MEET-FILES.md.
    rootFolderId: '',
    // Folders in the root that are archives/containers, not meets.
    ignoreFolders: ['Past'],
    reportsFolderName: 'reports',
    scoreboardFilePattern: '_SCB\\.TXT$',
    dlinkFolderName: 'DLinkHSL',
    dlinkFilePattern: '\\.scb$',
    // How often the selected meet's file is re-checked while running (a
    // file is only rewritten if its content actually changed). Drive only
    // reports modified times to the day, so content is compared instead.
    pollMs: 120000
};

const FETCH_TIMEOUT_MS = 20000;
const LIST_CACHE_MS = 30000;

function loadConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return { ...DEFAULT_CONFIG, ...raw };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

async function fetchText(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0]}`);
    return res.text();
}

function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Drive's public embedded view of a folder: one .flip-entry per child.
async function listFolder(folderId) {
    const html = await fetchText(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`);
    const out = [];
    for (const chunk of html.split('<div class="flip-entry" id="entry-').slice(1)) {
        const id = chunk.split('"', 1)[0];
        const title = chunk.match(/flip-entry-title">([\s\S]*?)<\/div>/);
        const modified = chunk.match(/flip-entry-last-modified"><div>([\s\S]*?)<\/div>/);
        const href = chunk.match(/href="([^"]+)"/);
        out.push({
            id,
            name: title ? decodeEntities(title[1]).trim() : '',
            modifiedLabel: modified ? decodeEntities(modified[1]).trim() : '',
            isFolder: !!(href && href[1].includes('/folders/'))
        });
    }
    return out;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Drive shows "6:19 am" (today), "Oct 8" (this year-ish) or "7/21/25".
// Returns a Date (start of that day, or the time today) or null.
function parseModifiedLabel(label, now = new Date()) {
    if (!label) return null;
    let m = label.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
    if (m) {
        let h = Number(m[1]) % 12;
        if (m[3].toLowerCase() === 'pm') h += 12;
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, Number(m[2]));
    }
    m = label.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2})$/);
    if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
        let d = new Date(now.getFullYear(), MONTHS[m[1].toLowerCase()], Number(m[2]));
        if (d.getTime() > now.getTime() + 86400000) d = new Date(now.getFullYear() - 1, d.getMonth(), d.getDate());
        return d;
    }
    m = label.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
        let y = Number(m[3]);
        if (y < 100) y += 2000;
        // Drive uses the viewer's locale; both orderings are plausible, so
        // pick the one that is a valid month.
        const a = Number(m[1]), b = Number(m[2]);
        return a <= 12 ? new Date(y, a - 1, b) : new Date(y, b - 1, a);
    }
    return null;
}

const hasData = (m) => m.files.length > 0 || m.dlink.length > 0;

let listCache = null; // {at, meets}
let listInFlight = null;

// Every meet folder under the root with its reports/scoreboard file(s),
// newest-updated first. Meets without a scoreboard file yet are listed last.
async function listMeets({ force = false } = {}) {
    if (!force && listCache && Date.now() - listCache.at < LIST_CACHE_MS) return listCache.meets;
    if (listInFlight) return listInFlight;
    listInFlight = (async () => {
        const cfg = loadConfig();
        const scbRe = new RegExp(cfg.scoreboardFilePattern, 'i');
        const dlinkRe = new RegExp(cfg.dlinkFilePattern, 'i');
        if (!cfg.rootFolderId) throw new Error('No Google Drive meets folder is set. Put its folder id in config/drive.json (copy config/drive.example.json) - see docs/MEET-FILES.md.');
        const root = await listFolder(cfg.rootFolderId);
        const ignore = new Set(cfg.ignoreFolders.map((n) => n.toLowerCase()));
        const folders = root.filter((e) => e.isFolder && !ignore.has(e.name.toLowerCase()));
        const meets = await Promise.all(folders.map(async (f) => {
            const meet = { id: f.id, name: f.name, hasReports: false, files: [], dlink: [], lastUpdated: null, anyUpdated: null, error: null };
            try {
                const children = await listFolder(f.id);
                const anyDates = children.map((c) => parseModifiedLabel(c.modifiedLabel)).filter(Boolean);
                if (anyDates.length) meet.anyUpdated = new Date(Math.max(...anyDates.map((d) => d.getTime()))).toISOString();
                const reports = children.find((c) => c.isFolder && c.name.toLowerCase() === cfg.reportsFolderName.toLowerCase());
                const dlinkDir = children.find((c) => c.isFolder && c.name.toLowerCase() === cfg.dlinkFolderName.toLowerCase());
                if (reports) {
                    meet.hasReports = true;
                    const files = await listFolder(reports.id);
                    meet.files = files
                        .filter((x) => !x.isFolder && scbRe.test(x.name))
                        .map((x) => ({ id: x.id, name: x.name, modifiedLabel: x.modifiedLabel }));
                }
                if (dlinkDir) {
                    // .scb files sit in per-session subfolders (and possibly directly in DLinkHSL).
                    const top = await listFolder(dlinkDir.id);
                    const add = (entries, session) => entries
                        .filter((x) => !x.isFolder && dlinkRe.test(x.name))
                        .forEach((x) => meet.dlink.push({ id: x.id, name: x.name, session, modifiedLabel: x.modifiedLabel }));
                    add(top, '');
                    await Promise.all(top.filter((x) => x.isFolder).map(async (sub) => add(await listFolder(sub.id), sub.name)));
                }
                const dates = [...meet.files, ...meet.dlink].map((x) => parseModifiedLabel(x.modifiedLabel)).filter(Boolean);
                if (dates.length) meet.lastUpdated = new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString();
            } catch (err) {
                meet.error = err.message;
            }
            return meet;
        }));
        meets.sort((a, b) => {
            const aOk = hasData(a), bOk = hasData(b);
            if (aOk !== bOk) return aOk ? -1 : 1;
            const key = (m) => (aOk ? m.lastUpdated : m.anyUpdated) || '';
            return key(b).localeCompare(key(a)) || a.name.localeCompare(b.name);
        });
        listCache = { at: Date.now(), meets };
        return meets;
    })().finally(() => { listInFlight = null; });
    return listInFlight;
}

async function downloadFile(fileId) {
    const res = await fetch(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading file`);
    const buf = Buffer.from(await res.arrayBuffer());
    // A permissions/virus-scan interstitial comes back as HTML, not the file.
    const head = buf.subarray(0, 200).toString('utf8').toLowerCase();
    if (head.includes('<!doctype html') || head.includes('<html')) throw new Error('Drive returned a web page instead of the file (is it shared with "anyone with the link"?)');
    return buf;
}

const status = {
    selected: null,       // {id, name, selectedAt, auto}
    lastSyncAt: null,
    lastSyncOk: null,
    lastError: null,
    files: []             // [{name, bytes, changed}]
};

let pollTimer = null;
let syncing = null;
let onSynced = null;

// Download the meet's scoreboard file(s) into heatsheets/. Replaces only
// files we synced before; keeps them untouched if Drive can't be reached.
async function syncMeet(meet) {
    const manifest = readJson(MANIFEST_PATH) || { files: [] };
    fs.mkdirSync(HEATSHEETS_DIR, { recursive: true });

    const downloaded = [];
    for (const f of meet.files) {
        downloaded.push({ rel: f.name.replace(/[\\/]/g, '_'), buf: await downloadFile(f.id) });
    }
    for (const f of meet.dlink) {
        // Flat names under DLinkHSL/, session folder kept in the name so the
        // same E###.scb in two sessions can't collide.
        const safe = `${f.session ? f.session + '__' : ''}${f.name}`.replace(/[^\w.\- ]/g, '_');
        downloaded.push({ rel: `DLinkHSL/${safe}`, buf: await downloadFile(f.id) });
    }
    if (downloaded.length === 0) throw new Error(`no scoreboard files (reports/*_SCB.TXT or DLinkHSL/*.scb) in "${meet.name}" yet`);

    const result = [];
    for (const d of downloaded) {
        const dest = path.join(HEATSHEETS_DIR, d.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        let existing = null;
        try { existing = fs.readFileSync(dest); } catch { /* new file */ }
        const changed = !existing || !existing.equals(d.buf);
        if (changed) {
            const tmp = `${dest}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, d.buf);
            fs.renameSync(tmp, dest);
        }
        result.push({ name: d.rel, bytes: d.buf.length, changed });
    }

    // Remove files from a previously synced meet that aren't part of this one.
    const keep = new Set(downloaded.map((d) => d.rel));
    for (const old of manifest.files) {
        if (!keep.has(old)) {
            try { fs.unlinkSync(path.join(HEATSHEETS_DIR, old)); logger.info('driveSync: removed previous meet file', { file: old }); } catch { /* already gone */ }
        }
    }
    writeJson(MANIFEST_PATH, { meetId: meet.id, meetName: meet.name, files: [...keep] });
    return result;
}

async function syncSelected() {
    if (syncing) return syncing;
    if (!status.selected) return null;
    syncing = (async () => {
        try {
            // Re-list this meet (fresh) so newly added reports files are seen.
            const meets = await listMeets({ force: true });
            const meet = meets.find((m) => m.id === status.selected.id);
            if (!meet) throw new Error(`meet "${status.selected.name}" no longer found in the Drive folder`);
            const files = await syncMeet(meet);
            status.files = files;
            status.lastSyncOk = true;
            status.lastError = null;
            const changed = files.filter((f) => f.changed).map((f) => f.name);
            logger.info('driveSync: synced meet', { meet: meet.name, files: files.map((f) => f.name), changed });
            if (onSynced) onSynced(files, meet);
        } catch (err) {
            status.lastSyncOk = false;
            status.lastError = err.message;
            logger.warn('driveSync: sync failed (keeping existing heatsheet files)', { error: err.message });
        } finally {
            status.lastSyncAt = Date.now();
            syncing = null;
        }
        return getStatus();
    })();
    return syncing;
}

async function selectMeet(id, { auto = false } = {}) {
    const meets = await listMeets({ force: true });
    const meet = meets.find((m) => m.id === id);
    if (!meet) throw new Error('unknown meet');
    status.selected = { id: meet.id, name: meet.name, selectedAt: Date.now(), auto };
    writeJson(SELECTED_PATH, status.selected);
    logger.info('driveSync: meet selected', { meet: meet.name, auto });
    await syncSelected();
    return getStatus();
}

function getStatus() {
    return { ...status, config: { rootFolderId: loadConfig().rootFolderId } };
}

// Resume the previously selected meet on (re)start - a crash/restart
// mid-meet must keep the same meet. With no prior choice, default to the
// most recently updated meet that has a scoreboard file.
async function start(callback) {
    onSynced = callback || null;
    status.selected = readJson(SELECTED_PATH);
    const cfg = loadConfig();
    try {
        if (!status.selected) {
            const meets = await listMeets({ force: true });
            const best = meets.find((m) => m.files.length > 0);
            if (best) await selectMeet(best.id, { auto: true });
        } else {
            await syncSelected();
        }
    } catch (err) {
        status.lastSyncOk = false;
        status.lastError = err.message;
        logger.warn('driveSync: startup sync failed (using whatever is already in heatsheets/)', { error: err.message });
    }
    pollTimer = setInterval(() => { syncSelected(); }, cfg.pollMs);
    if (pollTimer.unref) pollTimer.unref();
}

module.exports = { start, listMeets, listFolder, selectMeet, syncSelected, getStatus, parseModifiedLabel };
