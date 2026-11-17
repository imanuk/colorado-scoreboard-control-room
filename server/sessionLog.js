// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Append-only log of what happened on air, in logs/stream-sessions.jsonl:
// when the stream/recording started and stopped and every heat change. One JSON
// object per line: {"t":"<ISO time>","kind":"stream-start"|"record-start"|"heat"|...,...}
// It is what the stream's chapter list (timestamps relative to the stream
// start) is built from after the event.

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const FILE = process.env.SESSION_LOG_FILE || path.join(__dirname, '..', 'logs', 'stream-sessions.jsonl');

function log(kind, data = {}) {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.appendFileSync(FILE, JSON.stringify({ t: new Date().toISOString(), kind, ...data }) + '\n');
    } catch (err) {
        logger.warn('sessionLog: could not write', { error: err.message });
    }
}

// All entries (newest last). Corrupt lines are skipped.
function readAll() {
    try {
        return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
}

module.exports = { log, readAll, FILE };
