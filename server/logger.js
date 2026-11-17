// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Tiny dependency-free rotating file logger.
// Writes timestamped, leveled lines to logs/app.log (and echoes to console),
// so ongoing issues (serial drops, decoder errors, crashes) leave a paper
// trail that survives across launchd restarts, independent of the raw
// stdout/stderr capture launchd also keeps.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const events = new EventEmitter();

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const MAX_BYTES = 5 * 1024 * 1024; // 5MB per file
const MAX_BACKUPS = 5;

fs.mkdirSync(LOG_DIR, { recursive: true });

function rotateIfNeeded() {
    let size = 0;
    try {
        size = fs.statSync(LOG_FILE).size;
    } catch {
        return; // file doesn't exist yet
    }
    if (size < MAX_BYTES) return;

    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
        const from = `${LOG_FILE}.${i}`;
        const to = `${LOG_FILE}.${i + 1}`;
        if (fs.existsSync(from)) {
            fs.renameSync(from, to);
        }
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
}

// In-memory ring buffer of recent warn/error lines, so diagnostics.html can
// show "recent issues" on connect without re-reading the file from disk.
const RECENT_MAX = 50;
const recentIssues = [];

function write(level, message, context) {
    const line = {
        ts: new Date().toISOString(),
        level,
        message,
        ...(context !== undefined ? { context } : {})
    };
    const text = `[${line.ts}] [${level.toUpperCase()}] ${message}${context !== undefined ? ' ' + JSON.stringify(context) : ''}`;

    if (level === 'error') {
        console.error(text);
    } else if (level === 'warn') {
        console.warn(text);
    } else {
        console.log(text);
    }

    try {
        rotateIfNeeded();
        fs.appendFileSync(LOG_FILE, text + '\n');
    } catch (err) {
        console.error('logger: failed to write log file:', err.message);
    }

    if (level === 'warn' || level === 'error') {
        recentIssues.push(line);
        if (recentIssues.length > RECENT_MAX) recentIssues.shift();
        events.emit('issue', line);
    }
}

module.exports = {
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    getRecentIssues: () => recentIssues.slice(),
    onIssue: (listener) => events.on('issue', listener),
    LOG_FILE
};
