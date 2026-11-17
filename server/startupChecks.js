// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// The "is everything ready to go live?" checks shown as ticks on control.html.
//
// Each check returns { status: 'ok' | 'warn' | 'fail' | 'skip', detail, hint }.
//   ok   - good
//   warn - works but you'd want to know (e.g. on Wi-Fi, not ethernet)
//   fail - needs fixing before going live
//   skip - can't be tested yet because something it depends on isn't up
// They run one after another (so the page fills in as a cascade) and never
// start, stop or change anything in OBS - read-only, apart from setting the
// camera's anti-flicker to 50Hz (see goproControl.js).

const { execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const gopro = require('./goproControl.js');
const audioGuard = require('./audioGuard.js');
const heatsheetStore = require('./heatsheetStore.js');
const tvProjector = require('./tvProjector.js');

const CONFIG = (() => {
    const defaults = { scene: 'Live Stream', cameraInput: 'Camera (GoPro)', cameraDeviceName: 'GoPro Webcam', minDiskGB: 20, expectWidth: 1920, expectHeight: 1080, expectFps: 25 };
    try { return { ...defaults, ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'obs.json'), 'utf8')) }; } catch { return defaults; }
})();
const OBS_SERVICE_JSON = path.join(os.homedir(), 'Library', 'Application Support', 'obs-studio', 'basic', 'profiles', 'Untitled', 'service.json');

// A 320x180 q50 JPEG of the real camera picture is ~3,900 characters as base64
// (measured on the live OBS); an all-black frame is ~1,100. Anything under this
// counts as no picture.
const MIN_PICTURE_CHARS = 1600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(cmd, args, timeout = 20000) {
    return new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout)));
}
const ok = (detail) => ({ status: 'ok', detail });
const warn = (detail, hint) => ({ status: 'warn', detail, hint });
const fail = (detail, hint) => ({ status: 'fail', detail, hint });
const skip = (detail) => ({ status: 'skip', detail });

async function cameraList() {
    try {
        const d = JSON.parse(await run('system_profiler', ['SPCameraDataType', '-json']));
        return (d.SPCameraDataType || []).map((c) => ({ name: c._name, id: c['spcamera_unique-id'] }));
    } catch { return []; }
}


// OBS finds a camera only by its id, and macOS gives the GoPro Webcam a new id
// whenever the camera is reconnected. With OBS remote control available the
// source can simply be re-pointed live (only the camera source's device
// setting is touched). Returns { ok, changed, error }.
async function ensureObsCamera(obs, cameraId) {
    const s = await obs.request('GetInputSettings', { inputName: CONFIG.cameraInput });
    const dev = s.inputSettings && s.inputSettings.device;
    if (dev === cameraId) return { ok: true, changed: false };
    await obs.request('SetInputSettings', { inputName: CONFIG.cameraInput, inputSettings: { device: cameraId, device_name: CONFIG.cameraDeviceName }, overlay: true });
    const after = await obs.request('GetInputSettings', { inputName: CONFIG.cameraInput });
    const now = after.inputSettings && after.inputSettings.device;
    return now === cameraId ? { ok: true, changed: true } : { ok: false, changed: false, error: 'OBS did not accept the change' };
}

async function currentCameraId() {
    const cams = await cameraList();
    return (cams.find((c) => c.name === CONFIG.cameraDeviceName) || {}).id || null;
}

function tcpReach(host, port, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const s = net.connect({ host, port });
        const done = (v) => { s.destroy(); resolve(v); };
        s.setTimeout(timeoutMs, () => done(false));
        s.on('connect', () => done(true));
        s.on('error', () => done(false));
    });
}

// ---- the checks ----------------------------------------------------------

const CHECKS = [
    // Power
    {
        id: 'power', group: 'Power', title: 'On mains power',
        async run() {
            const out = await run('pmset', ['-g', 'batt']);
            const pct = (out.match(/(\d+)%/) || [])[1];
            if (/AC Power/i.test(out)) return ok(`Charger connected${pct ? ` (battery ${pct}%)` : ''}`);
            return fail(`Running on battery${pct ? ` (${pct}%)` : ''}`, 'Plug the charger in - a long stream and recording will drain it quickly.');
        }
    },

    // Internet
    {
        id: 'ethernet', group: 'Internet', title: 'Internet over ethernet',
        async run() {
            const route = await run('route', ['-n', 'get', 'default']);
            const iface = (route.match(/interface:\s*(\S+)/) || [])[1];
            if (!iface) return fail('No internet connection', 'Plug in the ethernet adapter, or connect to Wi-Fi.');
            const ports = await run('networksetup', ['-listallhardwareports']);
            let port = '';
            for (const block of ports.split(/\n\n/)) {
                if (new RegExp(`Device:\\s*${iface}\\b`).test(block)) port = (block.match(/Hardware Port:\s*(.+)/) || [])[1] || '';
            }
            if (/wi-?fi|airport/i.test(port)) return warn(`Using Wi-Fi (${iface})`, 'Wi-Fi can drop out mid-stream. Plug in the USB ethernet adapter if you can.');
            return ok(`Using ${port || 'a wired connection'} (${iface})`);
        }
    },
    {
        id: 'restream', group: 'Internet', title: 'Restream reachable',
        async run() {
            let server = '';
            try { server = JSON.parse(fs.readFileSync(OBS_SERVICE_JSON, 'utf8')).settings.server || ''; } catch { /* below */ }
            const m = server.match(/^(rtmps?):\/\/([^/:]+)(?::(\d+))?/i);
            if (!m) return warn('No stream server set in OBS', 'Set the stream service in OBS (Settings > Stream).');
            const port = Number(m[3]) || (m[1].toLowerCase() === 'rtmps' ? 443 : 1935);
            const reach = await tcpReach(m[2], port);
            return reach ? ok(`${m[2]} is reachable`) : fail(`Can't reach ${m[2]}:${port}`, 'Check the internet connection (or a firewall blocking streaming).');
        }
    },

    // TV
    {
        id: 'hdmi', group: 'TV', title: 'HDMI display connected',
        async run() {
            let displays = [];
            try {
                const d = JSON.parse(await run('system_profiler', ['SPDisplaysDataType', '-json']));
                for (const gpu of d.SPDisplaysDataType || []) displays = displays.concat(gpu.spdisplays_ndrvs || []);
            } catch { /* none */ }
            const external = displays.filter((x) => x.spdisplays_connection_type !== 'spdisplays_internal');
            if (external.length) return ok(`${external.map((x) => x._name).join(', ')} connected`);
            return fail('No external display found', 'Connect the HDMI cable to the TV and switch the TV on.');
        }
    },

    {
        id: 'tv-scene', group: 'TV', title: 'Scoreboard full screen on the TV',
        async run(ctx) {
            if (!ctx.obs.connected) return skip('Waiting for OBS');
            const r = await tvProjector.ensure(ctx.obs);
            if (r.state === 'no-display') return skip('No TV display found');
            if (r.state === 'no-scene') return warn('Could not find the scoreboard scene in OBS', 'In OBS, right-click the scoreboard scene > Fullscreen Projector (Scene) > pick the TV.');
            if (r.ok) return ok(r.state === 'opened' ? `Opened the scoreboard on ${r.display} (it was not showing)` : `Scoreboard is full screen on ${r.display}`);
            return warn(`The scoreboard is not showing on the TV${r.error ? ' - ' + r.error : ''}`, 'In OBS, right-click the scoreboard scene > Fullscreen Projector (Scene) > pick the TV.');
        }
    },

    {
        id: 'tv-clear', group: 'TV', title: 'Nothing covering the TV picture',
        async run(ctx) {
            const st = await tvProjector.status();
            if (!st.known) return skip('Could not look at the displays');
            if (!st.display) return skip('No TV display found');
            if (st.tvIsMain) return warn(`The TV is set as the main display, so notifications and new windows will appear on it`, 'System Settings > Displays > Arrange: drag the white bar (menu bar) from the TV onto the laptop screen.');
            const bad = st.intruders || [];
            if (!bad.length) return ok(`Only the scoreboard is on the TV (${st.mainName} is the main display)`);
            const names = [...new Set(bad.map((b) => b.owner))].join(', ');
            const why = bad.map((b) => `${b.owner}${b.name ? ' "' + b.name + '"' : ''} (${b.w}x${b.h})`).join('; ');
            return warn(`${names} is on top of the TV picture: ${why}`, 'Move that window back to the laptop screen, or close it. Turn on Do Not Disturb so notification banners cannot appear.');
        }
    },
    // Scoreboard
    {
        id: 'serial', group: 'Scoreboard', title: 'Scoreboard link live',
        async run(ctx) {
            const sb = ctx.scoreboard();
            if (!sb.serial.connected) return fail('No data from the timing console', 'Check the RS-485 USB adapter is plugged in and the Gen7 console is switched on.');
            const age = sb.serial.lastDataAt ? Date.now() - sb.serial.lastDataAt : null;
            if (age !== null && age > 5000) return warn(`Connected, but no data for ${Math.round(age / 1000)}s`, 'The console may be off or the cable loose.');
            return ok(`Receiving data on ${sb.serial.path}`);
        }
    },
    {
        id: 'meetfile', group: 'Scoreboard', title: 'Meet file loaded',
        async run(ctx) {
            const chk = heatsheetStore.check();
            const meet = ctx.driveStatus().selected;
            if (!chk.totals.events) return warn('No meet file loaded - titles, names and PBs will be missing', 'Choose the meet on the Choose meet page (meet.html).');
            const bad = chk.problems.length;
            const detail = `${meet ? meet.name + ': ' : ''}${chk.totals.events} events, ${chk.totals.swimmers} swimmers, ${chk.totals.withEntryTime} with entry times`;
            return bad ? warn(`${detail} - ${bad} item(s) to look at`, 'See the data check on meet.html.') : ok(detail);
        }
    },
    {
        id: 'match', group: 'Scoreboard', title: 'Console matches the meet file',
        async run(ctx) {
            const sb = ctx.scoreboard();
            if (!sb.serial.connected) return skip('Waiting for the console link');
            if (!sb.eventNum || !sb.heatNum) return warn('The console is not showing an event/heat yet', 'Select the first heat on the Gen7 console.');
            const ev = heatsheetStore.getEvent(sb.eventNum);
            if (!ev || !ev.heats.has(sb.heatNum)) {
                // The meet's events can be swum in a different order from their numbers, so say where it really starts.
                const first = heatsheetStore.listHeats()[0];
                const startsWith = first ? `This meet starts with Event ${first.event} Heat ${first.heat}.` : '';
                const idle = !sb.consoleNames.some(Boolean);
                return warn(`Console is on Event ${sb.eventNum} Heat ${sb.heatNum}${idle ? ' (nothing selected yet)' : ''}, which is not in the loaded meet file`,
                    `${startsWith} Select the first heat on the Gen7 console - if it is already on the right heat, check the right meet is chosen on meet.html.`.trim());
            }
            let agree = 0;
            const differ = [];
            for (let lane = 1; lane <= 8; lane++) {
                const mine = sb.consoleNames[lane - 1];
                const sheet = heatsheetStore.getLaneInfo(sb.eventNum, sb.heatNum, lane);
                if (!mine || !sheet) continue;
                if (heatsheetStore.sameSwimmer(sheet.name, mine)) agree++;
                else differ.push(`lane ${lane}: console "${mine}" vs file "${sheet.name}"`);
            }
            if (differ.length) return warn(`Event ${sb.eventNum} Heat ${sb.heatNum}: ${differ.length} name(s) differ - ${differ[0]}`, 'The console and the meet file are probably from different versions of the meet.');
            if (!agree) return warn(`Event ${sb.eventNum} Heat ${sb.heatNum} found in the file, but the console has not sent names for it yet`);
            return ok(`Event ${sb.eventNum} Heat ${sb.heatNum}: all ${agree} swimmer names agree with the file`);
        }
    },

    // Camera
    {
        id: 'cam-usb', group: 'Camera', title: 'GoPro connected',
        async run(ctx) {
            const cam = await gopro.findCamera();
            ctx.cam = cam;
            if (!cam) return fail('GoPro not found on USB', 'Plug it in with the USB-C cable and switch it on.');
            if (!cam.ip) return warn(`${cam.name} found, but its network address could not be worked out`);
            let apiErr = '';
            const info = await gopro.getInfo(cam.ip).catch((e) => { apiErr = e.message; return null; });
            if (!info) return warn(`${cam.name} found on USB but not answering${apiErr ? ' - ' + apiErr : ''}`, 'On the camera set Preferences > Connections > USB Connection to "GoPro Connect" (and check this app is allowed on the local network).');
            return ok(`${info.model_name || cam.name} (firmware ${info.firmware_version || '?'})`);
        }
    },
    {
        id: 'cam-app', group: 'Camera', title: 'GoPro Webcam running',
        async run(ctx) {
            if (!ctx.cam) return skip('No camera');
            const cams = await cameraList();
            ctx.cameraId = (cams.find((c) => c.name === CONFIG.cameraDeviceName) || {}).id || null;
            if (!ctx.cameraId) return fail('The GoPro Webcam camera is not available', 'Open the GoPro Webcam app (or run the Start Stream Day icon).');
            const st = ctx.cam.ip ? await gopro.getWebcamStatus(ctx.cam.ip) : null;
            return ok(`Webcam mode ready${st && st.status !== undefined ? ` (status ${st.status})` : ''}`);
        }
    },
    {
        id: 'cam-set', group: 'Camera', title: 'Camera set to PAL (50Hz)',
        async run(ctx) {
            if (!ctx.cam || !ctx.cam.ip) return skip('No camera');
            const r = await gopro.ensureAntiFlicker50(ctx.cam.ip);
            if (!r.ok) return warn(`Could not set PAL (50Hz): ${r.error}`, 'Set it on the camera: Preferences > Regional > Anti-Flicker > PAL.');
            return ok(r.changed ? 'Anti-flicker changed to PAL / 50Hz (UK mains)' : 'Anti-flicker is PAL / 50Hz (UK mains)');
        }
    },

    // OBS
    {
        id: 'obs-up', group: 'OBS', title: 'OBS connected',
        async run(ctx) {
            if (!ctx.obs.connected) return fail(ctx.obs.explain(), 'Run the Start Stream Day icon (it opens OBS with remote control on).');
            try {
                const v = await ctx.obs.request('GetVersion');
                return ok(`OBS ${v.obsVersion}`);
            } catch (e) { return fail(e.message); }
        }
    },
    {
        id: 'obs-video', group: 'OBS', title: 'Output 1080p, 25fps',
        async run(ctx) {
            if (!ctx.obs.connected) return skip('Waiting for OBS');
            const v = await ctx.obs.request('GetVideoSettings');
            const fps = v.fpsNumerator / v.fpsDenominator;
            const text = `${v.outputWidth}x${v.outputHeight} at ${Math.round(fps * 100) / 100}fps`;
            return (v.outputWidth === CONFIG.expectWidth && v.outputHeight === CONFIG.expectHeight && Math.round(fps) === CONFIG.expectFps)
                ? ok(text) : warn(`${text} (expected ${CONFIG.expectWidth}x${CONFIG.expectHeight} at ${CONFIG.expectFps}fps)`, 'Check Settings > Video in OBS.');
        }
    },
    {
        id: 'obs-camid', group: 'OBS', title: 'OBS is pointed at the camera',
        async run(ctx) {
            if (!ctx.obs.connected) return skip('Waiting for OBS');
            if (!ctx.cameraId) return skip('Waiting for the camera');
            let r;
            try { r = await ensureObsCamera(ctx.obs, ctx.cameraId); } catch (e) { return fail(`Could not check the camera source: ${e.message}`, `Is there a source called "${CONFIG.cameraInput}" in OBS?`); }
            if (!r.ok) return fail(`"${CONFIG.cameraInput}" is looking for an old camera id`, r.error || 'Re-pick the camera in the source properties.');
            return ok(r.changed ? `"${CONFIG.cameraInput}" had an old camera id - re-pointed it at the current camera` : `"${CONFIG.cameraInput}" uses the current camera`);
        }
    },
    {
        id: 'obs-picture', group: 'OBS', title: 'Camera picture arriving',
        async run(ctx) {
            if (!ctx.obs.connected) return skip('Waiting for OBS');
            const shots = [];
            for (let i = 0; i < 24; i++) { // up to ~8s for the camera to wake up
                const r = await ctx.obs.request('GetSourceScreenshot', { sourceName: CONFIG.cameraInput, imageFormat: 'jpeg', imageWidth: 320, imageHeight: 180, imageCompressionQuality: 50 }).catch(() => null);
                if (r && r.imageData) {
                    shots.push(r.imageData);
                    if (r.imageData.length > MIN_PICTURE_CHARS && shots.length >= 3) break;
                    if (shots.length > 3) shots.shift();
                }
                await sleep(350);
            }
            if (!shots.length) return fail('Could not read the camera source from OBS', `Is there a source called "${CONFIG.cameraInput}" in the scene?`);
            const last = shots.slice(-3);
            const avg = last.reduce((n, s) => n + s.length, 0) / last.length;
            if (avg < MIN_PICTURE_CHARS) return fail('The camera picture is black / empty', 'Check the GoPro is on and in webcam mode, and the OBS camera source is set to it.');
            if (last.length >= 3 && last.every((s) => s === last[0])) return warn('Picture arriving, but it looks frozen', 'Look at the preview - if it is not moving, restart the GoPro Webcam app.');
            // native size of the camera source, via its scene item
            let sizeText = '';
            try {
                const id = (await ctx.obs.request('GetSceneItemId', { sceneName: CONFIG.scene, sourceName: CONFIG.cameraInput })).sceneItemId;
                const t = (await ctx.obs.request('GetSceneItemTransform', { sceneName: CONFIG.scene, sceneItemId: id })).sceneItemTransform;
                if (t && t.sourceWidth) {
                    sizeText = ` at ${t.sourceWidth}x${t.sourceHeight}`;
                    if (t.sourceHeight < 1080) return warn(`Picture arriving${sizeText} - lower than 1080p`, 'Set the GoPro Webcam app to 1080p.');
                }
            } catch { /* size is a nicety */ }
            return ok(`Live picture${sizeText}`);
        }
    },
    {
        id: 'audio-mute', group: 'Audio', title: 'GoPro and Mac microphones muted',
        async run(ctx) {
            if (!ctx.obs.connected) return skip('Waiting for OBS');
            const a = await audioGuard.enforce(ctx.obs);
            ctx.audio = a;
            if (a.errors.length) return fail(a.errors[0], 'Mute them yourself in the OBS audio mixer, and tell me about this error.');
            if (!a.mustBeMuted.length) return ok('No camera or built-in microphone inputs in OBS');
            const stillOpen = a.mustBeMuted.filter((x) => !x.nowMuted);
            if (stillOpen.length) return fail(`Still open: ${stillOpen.map((x) => x.name).join(', ')}`, 'Mute them in the OBS audio mixer.');
            const names = a.mustBeMuted.map((x) => x.name).join(', ');
            return ok(a.changed.length ? `Muted ${a.changed.join(', ')} (it was open). All muted: ${names}` : `All muted: ${names}`);
        }
    },
    {
        id: 'audio-card', group: 'Audio', title: 'Mixer / sound card audio',
        async run(ctx) {
            if (!ctx.obs.connected) return skip('Waiting for OBS');
            const a = ctx.audio || await audioGuard.enforce(ctx.obs, { apply: false });
            if (!a.soundcards.length) return warn('No mixer or USB sound card input in OBS yet - the stream would have no sound', 'In OBS add the mixer / sound card as an "Audio Input Capture" source and pick it by name (not "Default").');
            const mac = await audioGuard.macInputDevices();
            const live = !!(ctx.isLive && ctx.isLive());
            const problems = [];
            const good = [];
            const waiting = [];
            for (const c of a.soundcards) {
                const label = ((c.deviceId || '').split(':')[2] || c.name).trim();
                const present = mac.some((n) => (c.deviceId || '').includes(n));
                if (!present) problems.push(`"${c.name}" (${label}) is not connected to the Mac`);
                else if (c.muted && live) problems.push(`"${c.name}" is muted in OBS while on air`);
                else if (c.muted) waiting.push(`"${c.name}" (${label})`);   // switched on by Go live
                else good.push(`"${c.name}" (${label})`);
            }
            if (problems.length) return warn(problems.concat(good.map((g) => `${g} live`)).join('; '), 'Plug the mixer in and make sure its OBS input is not muted.');
            if (waiting.length && !good.length) return ok(`${waiting.join(', ')} connected - it is switched on when you press Go live`);
            return ok(`${good.concat(waiting).join(', ')} connected${waiting.length ? ' (switched on at Go live)' : ' and unmuted'}`);
        }
    },
    {
        id: 'obs-disk', group: 'OBS', title: 'Room to record',
        async run(ctx) {
            if (!ctx.obs.connected) return skip('Waiting for OBS');
            const s = await ctx.obs.request('GetStats');
            const gb = s.availableDiskSpace / 1024;
            return gb >= CONFIG.minDiskGB ? ok(`${Math.round(gb)} GB free`) : fail(`Only ${Math.round(gb)} GB free`, 'A long recording needs about 10 GB per hour at 20 Mbps - free some space.');
        }
    },
    {
        id: 'obs-scene', group: 'OBS', title: 'Stream is on the pool camera scene',
        async run(ctx) {
            if (!ctx.obs.connected) return skip('Waiting for OBS');
            const want = CONFIG.scene;
            const cur = (await ctx.obs.request('GetCurrentProgramScene')).currentProgramSceneName;
            if (cur === want) return ok(`"${want}" is what OBS sends`);
            const live = !!(ctx.isLive && ctx.isLive());
            if (live) return warn(`OBS is sending "${cur}" instead of "${want}"`, `Click the "${want}" scene in OBS to put the pool camera back on air.`);
            const scenes = (await ctx.obs.request('GetSceneList')).scenes || [];
            if (!scenes.some((x) => x.sceneName === want)) return warn(`There is no "${want}" scene in OBS`, 'Create it (camera, timer, lanes) or set the scene name in config/stream.json.');
            try {
                await ctx.obs.request('SetCurrentProgramScene', { sceneName: want });
                return ok(`Switched OBS to "${want}" (it was on "${cur}")`);
            } catch (e) { return warn(`OBS is on "${cur}", not "${want}" - could not switch: ${e.message}`, `Click the "${want}" scene in OBS.`); }
        }
    },
    {
        id: 'obs-idle', group: 'OBS', title: 'Ready (not live yet)',
        async run(ctx) {
            if (!ctx.obs.connected) return skip('Waiting for OBS');
            const [st, rec] = await Promise.all([ctx.obs.request('GetStreamStatus'), ctx.obs.request('GetRecordStatus')]);
            if (st.outputActive || rec.outputActive) return ok(`${st.outputActive ? 'LIVE' : ''}${st.outputActive && rec.outputActive ? ' and ' : ''}${rec.outputActive ? 'RECORDING' : ''}`);
            return ok('Not streaming or recording - ready to go live');
        }
    }
];

function listChecks() {
    return CHECKS.map((c) => ({ id: c.id, group: c.group, title: c.title }));
}

// Runs every check in order, calling onUpdate(id, result|{status:'running'}) as
// it goes. Resolves with { results, ready } (ready = nothing failed).
// The cheap checks that don't depend on other checks: refreshed often (and silently) while
// someone is looking at the control room, including while on air. The slow/heavier ones
// (display, USB camera, picture, camera id, sound card) get the full run.
const LIVE_IDS = ['power', 'ethernet', 'restream', 'tv-clear', 'serial', 'meetfile', 'match', 'obs-up', 'obs-video', 'obs-scene', 'audio-mute', 'obs-disk', 'obs-idle'];

// opts.only: run just these ids; opts.silent: no "running" states and no cascade delay.
async function runAll(ctx, onUpdate = () => {}, opts = {}) {
    const results = {};
    const state = { ...ctx };
    const only = opts.only ? new Set(opts.only) : null;
    for (const c of CHECKS) {
        if (only && !only.has(c.id)) continue;
        if (!opts.silent) onUpdate(c.id, { status: 'running' });
        let res;
        try { res = await c.run(state); } catch (err) { res = fail(`Check error: ${err.message}`); }
        results[c.id] = res;
        onUpdate(c.id, res);
        if (!opts.silent) await sleep(120); // a little stagger so it reads as a cascade
    }
    const failed = Object.values(results).filter((r) => r.status === 'fail').length;
    const warned = Object.values(results).filter((r) => r.status === 'warn').length;
    return { results, failed, warned, ready: failed === 0 };
}

module.exports = { listChecks, runAll, LIVE_IDS, ensureObsCamera, currentCameraId, CONFIG };
