// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// SerialSupervisor owns the lifecycle of the Gen7Scbd decoder + its underlying
// serial device: auto-detecting which /dev/cu.* port to use, reconnecting
// with backoff on error/close, and force-reconnecting if data goes stale
// (covers half-dead USB/RS-485 links that never fire an 'error' or 'close').
//
// index.js should only ever talk to a SerialSupervisor instance, never touch
// SerialPort/Gen7Scbd directly - that way listeners only need to be attached
// once, not re-attached on every reconnect.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { SerialPort } = require('serialport');
const { Gen7Scbd } = require('./decoder.js');
const logger = require('./logger.js');

const LAST_GOOD_PORT_FILE = path.join(__dirname, '..', 'logs', 'last-good-port.json');
const STALE_MS = 8000;
// A bit more grace than STALE_MS for the very first byte after opening -
// the console may still be powering up - but if we've genuinely gone this
// long since opening the port with zero bytes ever received, the open
// succeeded at the OS level without the link actually being alive (seen in
// practice with the CH340 adapter), and just sitting on it forever waiting
// for data that will never come is wrong. Treat it the same as a stale
// connection: close and retry.
const INITIAL_DATA_TIMEOUT_MS = 10000;
const WATCHDOG_INTERVAL_MS = 2000;
const BACKOFF_STEPS_MS = [1000, 2000, 5000, 10000];

// Known USB-serial chip vendor IDs, best-effort ranking only - any port not
// listed here is still a candidate, just ranked lower.
const KNOWN_VENDOR_IDS = new Set([
    '1a86', // QinHeng / CH340 - the adapter currently in use
    '0403', // FTDI
    '10c4', // Silicon Labs CP210x
    '067b'  // Prolific
]);

function loadLastGoodPort() {
    try {
        const raw = fs.readFileSync(LAST_GOOD_PORT_FILE, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function saveLastGoodPort(info) {
    try {
        fs.mkdirSync(path.dirname(LAST_GOOD_PORT_FILE), { recursive: true });
        fs.writeFileSync(LAST_GOOD_PORT_FILE, JSON.stringify(info, null, 2));
    } catch (err) {
        logger.warn('serialSupervisor: failed to persist last-good-port.json', { error: err.message });
    }
}

function isExcluded(portInfo) {
    const p = (portInfo.path || '').toLowerCase();
    return p.includes('bluetooth') || p.includes('debug-console');
}

async function listCandidatePorts() {
    let ports;
    try {
        ports = await SerialPort.list();
    } catch (err) {
        logger.error('serialSupervisor: SerialPort.list() failed', { error: err.message });
        return [];
    }
    return ports.filter((p) => !isExcluded(p));
}

class SerialSupervisor extends EventEmitter {
    // opts.devicePath: if provided, pin to exactly this path (no auto-detect
    // across other candidates - only retries against this same path).
    constructor(opts = {}) {
        super();
        this.pinnedPath = opts.devicePath || null;
        this.decoder = null;
        this.currentPath = null;
        this.connected = false;
        this.lastDataAt = null;
        this.candidatePorts = [];
        this._backoffIndex = 0;
        this._reconnectTimer = null;
        this._watchdogTimer = null;
        this._stopped = true;
        this._connectInFlight = false;
        this._attemptStartedAt = null;
    }

    get current() {
        return this.connected ? this.decoder : null;
    }

    get status() {
        return {
            connected: this.connected,
            path: this.currentPath,
            lastDataAt: this.lastDataAt,
            candidatePorts: this.candidatePorts.map((p) => p.path)
        };
    }

    start() {
        this._stopped = false;
        this._watchdogTimer = setInterval(() => this._checkStale(), WATCHDOG_INTERVAL_MS);
        this._connect();
    }

    stop() {
        this._stopped = true;
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        if (this._watchdogTimer) clearInterval(this._watchdogTimer);
        this._teardownDecoder();
    }

    async _pickPath() {
        const candidates = await listCandidatePorts();
        this.candidatePorts = candidates;

        if (this.pinnedPath) {
            return this.pinnedPath;
        }

        if (candidates.length === 0) {
            return null;
        }

        const lastGood = loadLastGoodPort();
        if (lastGood) {
            const stillPresent = candidates.find((p) => p.path === lastGood.path);
            if (stillPresent) return stillPresent.path;
        }

        const known = candidates.find((p) => p.vendorId && KNOWN_VENDOR_IDS.has(p.vendorId.toLowerCase()));
        if (known) return known.path;

        return candidates[0].path;
    }

    async _connect() {
        if (this._stopped || this._connectInFlight) return;
        this._connectInFlight = true;

        const targetPath = await this._pickPath();

        if (!targetPath) {
            logger.warn('serialSupervisor: no candidate serial ports found, will retry', {
                pinned: this.pinnedPath || null
            });
            this._connectInFlight = false;
            this._scheduleReconnect();
            return;
        }

        logger.info('serialSupervisor: attempting to open serial port', {
            path: targetPath,
            selection: this.pinnedPath ? 'pinned (--dev)' : (loadLastGoodPort()?.path === targetPath ? 'last-good hint' : 'auto-detected')
        });

        this._teardownDecoder();

        let decoder;
        try {
            decoder = new Gen7Scbd(targetPath);
        } catch (err) {
            logger.error('serialSupervisor: failed to construct decoder', { path: targetPath, error: err.message });
            this._connectInFlight = false;
            this._scheduleReconnect();
            return;
        }

        this.decoder = decoder;
        this.currentPath = targetPath;
        this._attemptStartedAt = Date.now();

        decoder.on('data', (buffer) => {
            this.lastDataAt = Date.now();
            if (!this.connected) {
                this.connected = true;
                this._backoffIndex = 0;
                logger.info('serialSupervisor: serial link confirmed alive (first data received)', { path: targetPath });
                saveLastGoodPort({ path: targetPath, vendorId: this._vendorIdFor(targetPath) });
                this.emit('status', this.status);
            }
            this.emit('data', buffer);
        });

        decoder.on('EventChange', (data) => this.emit('EventChange', data));
        decoder.on('HeatChange', (data) => this.emit('HeatChange', data));
        decoder.on('packet', (cmd) => this.emit('packet', cmd));
        decoder.on('nextRace', (data) => this.emit('nextRace', data));

        decoder.on('error', (err) => {
            logger.error('serialSupervisor: decoder/serial error', { path: targetPath, error: err.message });
            this.emit('error', err);
            this._handleDisconnect('error');
        });

        decoder.on('close', () => {
            logger.warn('serialSupervisor: serial port closed', { path: targetPath });
            this._handleDisconnect('close');
        });

        this._connectInFlight = false;
    }

    _vendorIdFor(targetPath) {
        const match = this.candidatePorts.find((p) => p.path === targetPath);
        return match ? match.vendorId : undefined;
    }

    _handleDisconnect(cause) {
        if (this._stopped) return;
        const wasConnected = this.connected;
        this.connected = false;
        // Without this the never-connected check in _checkStale keeps seeing
        // the old attempt's start time while a reconnect is pending (or no
        // port is present to reconnect to) and re-fires every 2s, which
        // spammed the log for weeks when the adapter was unplugged.
        this._attemptStartedAt = null;
        this.emit('status', this.status);
        if (wasConnected) {
            logger.warn('serialSupervisor: link down, will attempt to reconnect', { path: this.currentPath, cause });
        }
        this._scheduleReconnect();
    }

    _checkStale() {
        if (this._stopped) return;

        if (this.connected) {
            if (this.lastDataAt && Date.now() - this.lastDataAt > STALE_MS) {
                logger.warn('serialSupervisor: no data for >8s while nominally connected, forcing reconnect', {
                    path: this.currentPath,
                    idleMs: Date.now() - this.lastDataAt
                });
                this._handleDisconnect('staleness-timeout');
            }
            return;
        }

        // Port opened (no error/close fired) but never received a single
        // byte - the open() succeeded without the link actually being
        // alive. Without this check nothing ever retries in this case.
        if (this.decoder && this._attemptStartedAt && Date.now() - this._attemptStartedAt > INITIAL_DATA_TIMEOUT_MS) {
            logger.warn('serialSupervisor: port opened but no data ever received, forcing reconnect', {
                path: this.currentPath,
                openMs: Date.now() - this._attemptStartedAt
            });
            this._handleDisconnect('never-connected-timeout');
        }
    }

    _scheduleReconnect() {
        if (this._stopped || this._reconnectTimer) return;
        const delay = BACKOFF_STEPS_MS[Math.min(this._backoffIndex, BACKOFF_STEPS_MS.length - 1)];
        this._backoffIndex++;
        logger.info('serialSupervisor: scheduling reconnect attempt', { delayMs: delay });
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connect();
        }, delay);
    }

    _teardownDecoder() {
        if (this.decoder) {
            try {
                this.decoder.removeAllListeners();
                this.decoder.closePort();
            } catch {
                // best-effort cleanup
            }
        }
        this.decoder = null;
    }
}

module.exports = { SerialSupervisor };
