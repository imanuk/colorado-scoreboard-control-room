// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// A friendly address for the scoreboard on the local network: other computers can
// type  http://scoreboard.local  instead of an IP address that changes from
// network to network.
//
// It uses macOS's own Bonjour tool (`dns-sd -P`) to advertise an extra name that
// points at this Mac's main address. Nothing about the Mac's own settings or
// name is changed: the advertisement lives only while this server runs, and is
// re-pointed automatically if the Mac's main connection changes (e.g. Wi-Fi at
// home, ethernet at the pool). macOS and current Windows resolve ".local" names
// out of the box; some other systems need the IP address instead.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function loadConfig() {
    const defaults = { friendlyName: 'scoreboard', extraPorts: [80] };
    try { return { ...defaults, ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'network.json'), 'utf8')) }; } catch { return defaults; }
}

function create({ networkInfo, logger, port }) {
    const cfg = loadConfig();
    const host = `${String(cfg.friendlyName).replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'scoreboard'}.local`;
    let child = null;
    let ip = null;
    let timer = null;

    function stop() {
        if (child) { try { child.kill(); } catch { /* already gone */ } }
        child = null; ip = null;
    }

    async function sync() {
        const info = await networkInfo.describe(port);
        const main = info.addresses[0]; // main connection first
        const want = main ? main.address : null;
        if (!want) { stop(); return; }
        if (child && ip === want) return;
        stop();
        child = spawn('dns-sd', ['-P', 'Scoreboard', '_http._tcp', 'local', String(port), host, want, 'path=/control.html'], { stdio: 'ignore' });
        const mine = child;
        child.on('exit', () => { if (child === mine) { child = null; ip = null; } });
        ip = want;
        logger.info('friendly name: advertising', { name: host, address: want });
    }

    // An advertiser left behind by a crashed earlier run would keep pointing at an old
    // address. Find our own leftovers precisely: processes whose program IS dns-sd and
    // whose arguments start with ours - never anything that merely mentions it.
    function killLeftovers(done) {
        execFile('pgrep', ['-x', 'dns-sd'], (err, out) => {
            const pids = String(out || '').split(/\s+/).filter(Boolean);
            let pending = pids.length;
            if (!pending) return done();
            for (const pid of pids) {
                execFile('ps', ['-o', 'command=', '-p', pid], (e, cmd) => {
                    if (!e && String(cmd).trim().startsWith('dns-sd -P Scoreboard ')) { try { process.kill(Number(pid)); } catch { /* gone */ } }
                    if (--pending === 0) done();
                });
            }
        });
    }

    function start() {
        killLeftovers(() => {
            sync().catch(() => {});
            timer = setInterval(() => sync().catch(() => {}), 15000);
            if (timer.unref) timer.unref();
        });
        process.on('exit', stop);
    }

    return { start, stop, host, extraPorts: cfg.extraPorts || [], status: () => ({ host, address: ip, advertised: !!child }) };
}

module.exports = { create };
