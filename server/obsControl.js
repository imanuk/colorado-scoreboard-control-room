// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Minimal OBS remote-control client (obs-websocket v5, built into OBS 28+).
// Uses Node's built-in WebSocket - no extra dependency. Localhost only.
//
// OBS keeps running whether or not this is connected: if this process
// restarts, the stream and recording are unaffected.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('./logger.js');

const CONFIG_FILE = process.env.OBS_WEBSOCKET_CONFIG
    || path.join(os.homedir(), 'Library', 'Application Support', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');

function readConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}

const sha256b64 = (s) => crypto.createHash('sha256').update(s).digest('base64');

class ObsControl extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.identified = false;
        this.pending = new Map();
        this.seq = 0;
        this.timer = null;
        this.stopped = true;
        this.attempt = 0;
        this.lastError = '';
        this.version = null;
    }

    get connected() { return this.identified; }

    // Why we're not connected, in words - for the checks list.
    explain() {
        const cfg = readConfig();
        if (!cfg) return 'OBS remote control has not been set up yet';
        if (!cfg.server_enabled) return 'OBS remote control is switched off (the start icon turns it on while OBS is closed)';
        return this.lastError || 'not connected yet';
    }

    start() {
        this.stopped = false;
        this._connect();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.timer);
        if (this.ws) try { this.ws.close(); } catch { /* ignore */ }
    }

    _scheduleReconnect() {
        if (this.stopped) return;
        clearTimeout(this.timer);
        this.attempt++;
        this.timer = setTimeout(() => this._connect(), Math.min(10000, 1000 + this.attempt * 1000));
        if (this.timer.unref) this.timer.unref();
    }

    _connect() {
        if (this.stopped) return;
        const cfg = readConfig();
        if (!cfg || !cfg.server_enabled) { this.lastError = this.explain(); this._scheduleReconnect(); return; }
        let ws;
        try { ws = new WebSocket(`ws://127.0.0.1:${cfg.server_port || 4455}`); } catch (err) { this.lastError = err.message; this._scheduleReconnect(); return; }
        this.ws = ws;
        let opened = false;
        ws.onopen = () => { opened = true; };
        ws.onmessage = (ev) => this._onMessage(ev.data, cfg);
        ws.onerror = () => { if (!opened) this.lastError = 'OBS is not running (or remote control port is closed)'; };
        ws.onclose = () => {
            const was = this.identified;
            this.identified = false;
            for (const [, p] of this.pending) p.reject(new Error('OBS connection closed'));
            this.pending.clear();
            if (was) { logger.warn('obs: remote control disconnected'); this.emit('disconnected'); }
            this._scheduleReconnect();
        };
    }

    _onMessage(raw, cfg) {
        let msg;
        try { msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
        const { op, d } = msg;
        if (op === 0) { // Hello -> Identify
            const ident = { rpcVersion: 1, eventSubscriptions: 0 };
            if (d.authentication) {
                const secret = sha256b64((cfg.server_password || '') + d.authentication.salt);
                ident.authentication = sha256b64(secret + d.authentication.challenge);
            }
            this.version = d.obsWebSocketVersion;
            this.ws.send(JSON.stringify({ op: 1, d: ident }));
        } else if (op === 2) { // Identified
            this.identified = true;
            this.attempt = 0;
            this.lastError = '';
            logger.info('obs: remote control connected', { obsWebSocketVersion: this.version });
            this.emit('connected');
        } else if (op === 7) { // RequestResponse
            const p = this.pending.get(d.requestId);
            if (!p) return;
            this.pending.delete(d.requestId);
            clearTimeout(p.timer);
            if (d.requestStatus && d.requestStatus.result) p.resolve(d.responseData || {});
            else p.reject(new Error(`${d.requestType}: ${(d.requestStatus && d.requestStatus.comment) || 'failed'}`));
        }
    }

    request(type, data = {}, timeoutMs = 6000) {
        return new Promise((resolve, reject) => {
            if (!this.identified) return reject(new Error('OBS remote control is not connected'));
            const id = `r${++this.seq}`;
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${type}: timed out`)); }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data } }));
        });
    }
}

module.exports = { ObsControl, readConfig, CONFIG_FILE };
