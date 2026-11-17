#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Builds the folder to upload to the web host (your GoDaddy site) for the live heat sheet.
//
//   node scripts/build-remote.js --url https://example.org/heats/
//
// Makes  remote-site/  (and remote-site.zip) containing the phone pages, update.php and the
// hash of the secret key. The key itself stays on this Mac in config/publish.json (made here the
// first time) - it is never put in the upload.
// Run it again whenever the live pages change; upload the new copy over the old one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'live');
const OUT = path.join(ROOT, 'remote-site');
const CONFIG = path.join(ROOT, 'config', 'publish.json');
const SKIP = new Set(['admin.html', 'live-config.js']); // admin stays on the Mac

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* first run */ }
if (urlArg) cfg.url = urlArg.replace(/\/+$/, '') + '/';
if (!cfg.url) { console.error('Tell me the address the pages will live at, e.g.\n  node scripts/build-remote.js --url https://example.org/heats/'); process.exit(1); }
if (!cfg.key) cfg.key = crypto.randomBytes(24).toString('base64url');
if (cfg.enabled === undefined) cfg.enabled = true;
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });

// the release id is a hash of everything uploaded, so phones with the page open can reload themselves
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const hash = crypto.createHash('sha1');
const files = fs.readdirSync(SRC).filter((f) => fs.statSync(path.join(SRC, f)).isFile() && !SKIP.has(f)).sort();
const bodies = {};
for (const f of files) {
    let body = fs.readFileSync(path.join(SRC, f), 'utf8');
    if (f.endsWith('.html')) {
        body = body.replace(/<script src="\/socket\.io\/socket\.io\.js"><\/script>/g, '').replace(/<script src="\/autoreload\.js"><\/script>/g, '');
    }
    bodies[f] = body; hash.update(f + '\0' + body);
}
const liveConfig = "window.LIVE_CONFIG = { mode: 'poll', dataBase: 'data/' };\n";
hash.update(liveConfig);
const release = hash.digest('hex').slice(0, 10);

for (const f of files) {
    let body = bodies[f];
    if (f.endsWith('.html')) body = body.replace(/(href|src)="((?!https?:|\/)[^"?]+\.(?:css|js))"/g, `$1="$2?v=${release}"`);
    fs.writeFileSync(path.join(OUT, f), body);
}
fs.writeFileSync(path.join(OUT, 'live-config.js'), liveConfig);
fs.writeFileSync(path.join(OUT, 'release.txt'), release + '\n');
fs.copyFileSync(path.join(ROOT, 'remote', 'update.php'), path.join(OUT, 'update.php'));
fs.copyFileSync(path.join(ROOT, 'remote', 'htaccess.txt'), path.join(OUT, '.htaccess'));
const keyHash = crypto.createHash('sha256').update(cfg.key).digest('hex');
fs.writeFileSync(path.join(OUT, 'update-config.php'), `<?php\n// Made by scripts/build-remote.js - the SHA-256 of the secret key, not the key.\ndefine('LIVE_KEY_SHA256', '${keyHash}');\n`);

const zip = path.join(ROOT, 'remote-site.zip');
fs.rmSync(zip, { force: true });
try { execFileSync('zip', ['-qr', zip, '.'], { cwd: OUT }); } catch { /* zip is optional */ }

console.log(`Built ${files.length + 5} files for ${cfg.url}  (release ${release})`);
console.log('  folder: ' + OUT + (fs.existsSync(zip) ? '\n  zip:    ' + zip : ''));
console.log('Upload the CONTENTS of the folder (including the hidden .htaccess) to that address, then on the Mac:');
console.log('  Live heat sheet admin page -> "Test connection"');
