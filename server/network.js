// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// The addresses other computers can use to reach this scoreboard, and which one
// is the main connection (the interface the Mac uses to reach the internet -
// at a venue that should be the ethernet adapter).

const os = require('os');
const { execFile } = require('child_process');

let cache = null;
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 8000 }, (e, out) => resolve(e ? '' : out)));

async function describe(port) {
    if (cache && Date.now() - cache.at < 10000) return cache.data;
    const route = await run('route', ['-n', 'get', 'default']);
    const mainIface = (route.match(/interface:\s*(\S+)/) || [])[1] || null;
    const ports = await run('networksetup', ['-listallhardwareports']);
    const kindOf = (iface) => {
        for (const block of ports.split(/\n\n/)) {
            if (new RegExp(`Device:\\s*${iface}\\b`).test(block)) {
                const name = (block.match(/Hardware Port:\s*(.+)/) || [])[1] || '';
                if (/wi-?fi|airport/i.test(name)) return 'Wi-Fi';
                if (/ethernet|lan/i.test(name)) return 'Ethernet';
                return name || 'Network';
            }
        }
        return 'Network';
    };
    const addresses = [];
    for (const [iface, list] of Object.entries(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family !== 'IPv4' || a.internal) continue;
            if (/^169\.254\./.test(a.address)) continue; // link-local: not useful to share
            addresses.push({ iface, address: a.address, kind: kindOf(iface), main: iface === mainIface });
        }
    }
    addresses.sort((x, y) => (y.main ? 1 : 0) - (x.main ? 1 : 0));
    const local = (await run('scutil', ['--get', 'LocalHostName'])).trim();
    const data = { port, hostname: local ? `${local}.local` : null, addresses };
    cache = { at: Date.now(), data };
    return data;
}

module.exports = { describe };
