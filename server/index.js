#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later AND MIT
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Derived in part from coloradoScoreboard by Fabrizio Bertocci (MIT) - see NOTICE.md.

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const logger = require('./logger.js');
const { SerialSupervisor } = require('./serialSupervisor.js');
const heatsheetStore = require('./heatsheetStore.js');
const driveSync = require('./driveSync.js');
const qualifying = require('./qualifying.js');
const { ObsControl } = require('./obsControl.js');
const startupChecks = require('./startupChecks.js');
const gopro = require('./goproControl.js');
const sessionLog = require('./sessionLog.js');
const audioGuard = require('./audioGuard.js');
const streamInfo = require('./streamInfo.js');
const youtubeChannel = require('./youtubeChannel.js');
const liveViewFactory = require('./liveView.js');
const networkInfo = require('./network.js');
const friendlyNameFactory = require('./friendlyName.js');
const liveFeedFactory = require('./liveFeed.js');
const livePublisherFactory = require('./livePublisher.js');

// Crash-only design: launchd supervises this process (KeepAlive), so on any
// unexpected error we log the full context and exit cleanly rather than
// limping on in a possibly-corrupted state. launchd restarts us in seconds.
process.on('uncaughtException', (err) => {
    logger.error('uncaughtException - exiting so launchd can restart cleanly', { error: err.message, stack: err.stack });
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandledRejection - exiting so launchd can restart cleanly', { error: err.message, stack: err.stack });
    process.exit(1);
});

// Command line argument parsing
const args = process.argv.slice(2);
let verbose = false;
let quiet = false;
let testMode = false;
let gen7Mode = false;
let devicePath = null; // null = auto-detect; explicit -d pins to that exact path
// 50ms (20Hz) is the sensible default: the console reports race time to
// hundredths of a second, so anything faster than ~10ms brings no real extra
// precision, and displays/browsers don't benefit past normal frame rates
// (60Hz = ~16.7ms). 50ms reads as fluid live counting without wasting CPU on
// redundant re-renders. Adjustable via -u, or live from diagnostics.html.
let updateRate = 50;
let httpPort = 8080;

function showHelp() {
    console.log('Usage: index.js [options]');
    console.log('Options:');
    console.log('  -h, --help              Show this help');
    console.log('  -v, --verbose           Verbose output');
    console.log('  -q, --quiet             Quiet mode (no console display)');
    console.log('  -t, --test              Test mode');
    console.log('  -7, --gen7              Use Gen7 protocol (RS485)');
    console.log('  -d, --dev <device>      Pin to a specific serial device (default: auto-detect)');
    console.log('  -u, --update <ms>       Update rate in milliseconds [default=500]');
    console.log('  -p, --port <port>       HTTP server port [default=8080]');
    process.exit(0);
}

// Parse arguments
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
        showHelp();
    } else if (arg === '-v' || arg === '--verbose') {
        verbose = true;
    } else if (arg === '-q' || arg === '--quiet') {
        quiet = true;
    } else if (arg === '-t' || arg === '--test') {
        testMode = true;
    } else if (arg === '-7' || arg === '--gen7') {
        gen7Mode = true;
    } else if (arg === '-d' || arg === '--dev') {
        devicePath = args[++i];
    } else if (arg === '-u' || arg === '--update') {
        updateRate = parseInt(args[++i]);
    } else if (arg === '-p' || arg === '--port') {
        httpPort = parseInt(args[++i]);
    }
}

// Scoreboard data object
const theScoreboard = {
    event_heat: 'Event 00 Heat 0',
    event_name: '',
    event_title: '',
    race_time: '00:00.00',
    console_time: '00:00:00',

    // State flags for overlays
    display_state: 'start', // 'start', 'timer', 'result'

    // Touch tracking data
    touch_data: [],
    touch_distance: 0,
    touch_total_distance: 0,

    // Serial link health - surfaced on diagnostics.html (and available to any page)
    serial_connected: false,
    serial_port: '',
    serial_last_data_ms: null,

    lane_place1: '', lane_time1: '', lane_name1: '',
    lane_place2: '', lane_time2: '', lane_name2: '',
    lane_place3: '', lane_time3: '', lane_name3: '',
    lane_place4: '', lane_time4: '', lane_name4: '',
    lane_place5: '', lane_time5: '', lane_name5: '',
    lane_place6: '', lane_time6: '', lane_name6: '',
    lane_place7: '', lane_time7: '', lane_name7: '',
    lane_place8: '', lane_time8: '', lane_name8: '',

    // PB badges - only populated once display_state is 'result' (final
    // times), from heatsheetStore's entry (seed) times. Empty if not a PB,
    // "PB" if the swimmer had no prior time on record for this event.
    lane_pb1: '', lane_pb2: '', lane_pb3: '', lane_pb4: '',
    lane_pb5: '', lane_pb6: '', lane_pb7: '', lane_pb8: '',

    // Qualification badges ('CT' / 'RT' / 'NT' - highest achieved), same
    // result-state-only rule as PB. Standards come from qualtimes/ files.
    lane_qual1: '', lane_qual2: '', lane_qual3: '', lane_qual4: '',
    lane_qual5: '', lane_qual6: '', lane_qual7: '', lane_qual8: '',

    // "Get ready" prompt for officials - the next race's event/heat/title,
    // as soon as the console broadcasts it. Always reflects live state even
    // while the main display is holding the previous heat's result.
    next_race: ''
};

// State tracking
let previousRaceTime = '';
let previousEventHeat = '';
let previousEventTitle = '';
let raceTimeChangeCount = 0;
let resultShowStartTime = 0;
let eventJustChanged = false; // Flag to track fresh event change
let touchHistory = new Map(); // lane -> [touch1Time, touch2Time, ...]
let currentTouchState = new Map(); // lane -> {name, time, touchCount}
let lastLaneTimes = new Array(9).fill('');
let laneDifferentCount = new Array(9).fill(0);
const CHANGING_THRESHOLD = 2;
const TOUCH_THRESHOLD = 2;
// When the operator advances to the next heat, keep showing the outgoing
// heat's full display for at least this long (or until the new race
// actually starts running, if that happens sooner) instead of jumping
// straight to the still-blank next heat the instant they click forward.
const RESULT_DISPLAY_MIN_DURATION = 15000;
let heldSnapshot = null;
let holdUntil = 0;
// A single-tick misread of module 12 (event/heat digits) briefly reporting
// "Event 0 Heat 0" was being treated as a real heat change - triggering a
// hold-snapshot of the CORRECT result's lane times but with event/title
// already blanked by that same glitch, then freezing that broken snapshot
// on screen (no PB badge, no name/title) for the full 15s. Debounced the
// same way race-time changes already are (CHANGING_THRESHOLD): a new
// event/heat string must read the same for 2 consecutive ticks before
// it's accepted as real, filtering out single-tick glitches.
let pendingEventHeat = null;
let pendingEventHeatCount = 0;
// The "get ready" prompt for officials. Driven by the console advancing to a
// new heat (module 12 change) - NOT by the console's cmd2=2 "lookahead"
// packet: real meet logs show session-2 events never send one at all, and
// when one does arrive it is just the current heat re-broadcast every ~10s,
// so relying on it meant the bar never appeared. A genuinely different
// lookahead packet (if a console ever sends one) is also honoured.
// {eventNumber, heatNumber} | null - the title is resolved live at render
// time since a heat's title packet can land a moment after the change.
let nextRaceTarget = null;
// The next-race TEXT is only shown for this long after each genuine change
// - the black bar itself is a permanent fixture (see tv.html), only its
// text content appears/clears. Reuses the same 15s the result hold uses,
// per the user's own reference to "the duration of the change 15s".
const NEXT_RACE_TEXT_DURATION_MS = 15000;
let nextRaceTextUntil = 0;

// Raw lane readings carried over from the heat that just ended. The
// physical scoreboard's lane modules (1-8) are NOT cleared when the operator
// advances to the next heat - the old times/places stay in the digits until
// the next race starts and overwrites them (confirmed in real meet
// recordings: new names beside the previous heat's times and places). So
// reading "whatever is in the module" is wrong for a heat that hasn't
// raced yet. Each field is suppressed while it still reads exactly what it
// did at the changeover, released per-field as soon as it shows a different
// non-blank value, and dropped entirely once the new race is running.
let staleReadings = null; // {time: string[9], place: string[9]} | null

// The console ships a factory-default placeholder title ("100 Meter" - no
// stroke, no age group) for its default event. It is not a real event name
// and must never reach the screen: treated as "no title" so the heat sheet
// fallback (or nothing) is used instead.
const PLACEHOLDER_TITLE_RE = /^\s*\d+\s*(m|metre|meter)s?\s*$/i;
function cleanTitle(title) {
    const t = (title || '').trim();
    return t && !PLACEHOLDER_TITLE_RE.test(t) ? t : '';
}

// Title for an event: the console's own (non-placeholder) title, else the
// uploaded heat sheet's, else nothing.
function resolveEventTitle(decoder, eventNum) {
    if (!eventNum || eventNum <= 0) return '';
    let consoleTitle = '';
    const pool = decoder && decoder.Gen7SwimmingData && decoder.Gen7SwimmingData[0];
    if (pool && pool.Events) {
        const ev = pool.Events.get(eventNum);
        if (ev) consoleTitle = ev.EventTitle || '';
    }
    return cleanTitle(consoleTitle) || heatsheetStore.getEventTitle(eventNum) || '';
}

function announceNextRace(eventNumber, heatNumber, force) {
    if (!force && nextRaceTarget &&
        nextRaceTarget.eventNumber === eventNumber && nextRaceTarget.heatNumber === heatNumber) {
        return; // repeat of what's already announced - don't restart the 15s window
    }
    nextRaceTarget = { eventNumber, heatNumber };
    nextRaceTextUntil = Date.now() + NEXT_RACE_TEXT_DURATION_MS;
    logger.info('next race announced', nextRaceTarget);
}

// DIAGNOSTIC: flag to trigger a data dump on next update cycle
let diagnosticPending = false;

// Setup Express and Socket.IO
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// The control room is the home page; everything else is reached from it.
app.get(['/', '/index.html'], (req, res) => res.redirect('/control.html'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

// Other computers on the network may VIEW everything (control room, TV page, live view,
// heat sheets) but anything that changes something only works from this Mac.
const requireLocal = (req, res, next) => (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')
    ? next() : res.status(403).json({ error: 'Only from the scoreboard Mac.' }));

// Meet selection (Google Drive "Meets" folder -> heatsheets/). See driveSync.js.
// Near-real-time local view of what OBS sends (see liveView.js), and the addresses other
// computers can use to reach this Mac (shown in the control room's Share box).
// (`obs` is created further down, so it is looked up per request.)
const liveView = liveViewFactory.create({ getObs: () => obs, logger, getLinkKind: async () => {
    const n = await networkInfo.describe(httpPort);
    const main = (n.addresses || []).find((a) => a.main) || (n.addresses || [])[0];
    return main ? main.kind : 'Network';
} });
app.get('/live.mjpg', (req, res) => liveView.stream(req, res));
app.get('/live.jpg', (req, res) => liveView.still(req, res));
const friendlyName = friendlyNameFactory.create({ networkInfo, logger, port: httpPort });
app.get('/api/liveview', (req, res) => res.json(liveView.status()));
app.get('/api/network', async (req, res) => res.json({ ...(await networkInfo.describe(httpPort)), friendly: { ...friendlyName.status(), port80: extraPortsUp.includes(80) } }));

// What the viewers see: the YouTube link of the live broadcast, remembered so the
// control room can show it back (see control.html). Only this Mac can change it.
const STREAM_CONFIG = path.join(__dirname, '..', 'config', 'stream.json');
app.get('/api/stream-config', (req, res) => {
    try { res.json(JSON.parse(require('fs').readFileSync(STREAM_CONFIG, 'utf8'))); } catch { res.json({ viewerUrl: '' }); }
});
function readStreamConfig() {
    try { return JSON.parse(require('fs').readFileSync(STREAM_CONFIG, 'utf8')); } catch { return {}; }
}
app.post('/api/stream-config', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'only from the scoreboard Mac' });
    const body = req.body || {};
    const cfg = readStreamConfig();
    if (typeof body.viewerUrl === 'string') cfg.viewerUrl = body.viewerUrl.trim().slice(0, 300);
    if (typeof body.descriptionIntro === 'string') cfg.descriptionIntro = body.descriptionIntro.slice(0, 2000);
    if (typeof body.channelHandle === 'string') cfg.channelHandle = body.channelHandle.trim().slice(0, 100);
    require('fs').mkdirSync(path.dirname(STREAM_CONFIG), { recursive: true });
    require('fs').writeFileSync(STREAM_CONFIG, JSON.stringify(cfg, null, 2));
    res.json(cfg);
});

// The club's YouTube channel: recent videos and which one (at most one) is live now.
// Handle comes from config/stream.json ("channelHandle", e.g. "@yourclub"); empty = feature off.
app.get('/api/channel', async (req, res) => {
    const handle = readStreamConfig().channelHandle || '';
    if (!handle) return res.json({ handle: '', channelId: null, live: null, videos: [], error: 'No YouTube channel set - type your channel handle (e.g. @yourclub) into the box, or set channelHandle in config/stream.json.' });
    res.json(await youtubeChannel.getChannel(handle, { force: req.query.refresh === '1' }));
});

// Suggested title, description and chapter list for the stream (see streamInfo.js).
// ?stream=<index>|latest picks which recorded stream; ?shift=<seconds> nudges timestamps.
app.get('/api/stream-info', (req, res) => {
    const entries = sessionLog.readAll();
    const streams = streamInfo.listStreams(entries);
    const idx = (req.query.stream === undefined || req.query.stream === 'latest') ? streams.length - 1 : parseInt(req.query.stream, 10);
    const stream = streams[idx] || null;
    const shift = Number(req.query.shift) || 0;
    const chapters = stream ? streamInfo.buildChapters(entries, stream, shift) : [];

    const m = (theScoreboard.event_heat || '').match(/Event (\d+)/);
    const decoderForTitle = supervisor.current;
    const session = (m && heatsheetStore.sessionOfEvent(Number(m[1]))) || heatsheetStore.sessions()[0] || null;
    const driveSel = driveSync.getStatus().selected;
    const title = streamInfo.suggestTitle({ meetName: theScoreboard.event_name, driveMeetName: driveSel && driveSel.name, session });
    const when = stream ? new Date(stream.startMs) : new Date();
    const dateText = when.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const intro = readStreamConfig().descriptionIntro || streamInfo.DEFAULT_INTRO;
    res.json({
        title,
        titleParts: { meet: theScoreboard.event_name || (driveSel && driveSel.name) || '', session, sessions: heatsheetStore.sessions() },
        dateText,
        intro,
        streams: streams.map((st, i) => ({ index: i, start: st.start, stop: st.stop, running: !st.stopMs })),
        selected: stream ? idx : null,
        chapters,
        chaptersText: streamInfo.chaptersText(chapters),
        validation: stream ? streamInfo.validate(chapters, !stream.stopMs) : { ok: false, problems: ['No stream has been started from the control room yet - chapters appear once you go live.'] },
        description: streamInfo.descriptionText({ title, dateText, intro, chapters })
    });
});

app.get('/api/meets', async (req, res) => {
    try {
        const meets = await driveSync.listMeets({ force: req.query.refresh === '1' });
        res.json({ meets, status: driveSync.getStatus() });
    } catch (err) {
        logger.warn('meet list failed', { error: err.message });
        res.status(502).json({ error: err.message, status: driveSync.getStatus() });
    }
});
app.get('/api/meets/check', (req, res) => {
    const check = heatsheetStore.check();
    check.qualifying = qualifying.check(heatsheetStore.allSwimmers());
    res.json(check);
});
app.get('/api/meets/status', (req, res) => res.json(driveSync.getStatus()));
app.post('/api/meets/select', requireLocal, async (req, res) => {
    try {
        const status = await driveSync.selectMeet(String((req.body || {}).id || ''));
        res.json(status);
    } catch (err) {
        res.status(400).json({ error: err.message, status: driveSync.getStatus() });
    }
});
app.post('/api/meets/sync', requireLocal, async (req, res) => {
    const status = await driveSync.syncSelected();
    res.json(status || driveSync.getStatus());
});

server.on('error', (err) => {
    logger.error('HTTP server error', { error: err.message, port: httpPort });
    if (err.code === 'EADDRINUSE') {
        logger.error(`Port ${httpPort} is already in use - is another instance already running?`);
        process.exit(1);
    }
});

// Sockets that identified as diagnostics.html viewers (via 'diag:subscribe').
// The per-module channel snapshot and raw-hex encoding are only worth the
// CPU when someone is actually watching them, so update rate can be pushed
// higher without that cost scaling up in the common case (nobody has
// diagnostics.html open).
const diagnosticsSockets = new Set();
const controlSockets = new Set();
let lastManualRunAt = 0;

// Version announced to display pages (see public/autoreload.js): boot id +
// newest file time under public/. Changes on restart or when a page/style
// file is edited, making open pages reload themselves.
const BOOT_ID = Date.now().toString(36);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
function computeServerVersion() {
    let newest = 0;
    try {
        for (const f of require('fs').readdirSync(PUBLIC_DIR)) {
            try {
                const st = require('fs').statSync(path.join(PUBLIC_DIR, f));
                // files only: a sub-folder's own change time moves whenever anything is added to
                // it, which would reload every open page (including the on-air overlays)
                if (st.isFile()) newest = Math.max(newest, st.mtimeMs);
            } catch { /* skip */ }
        }
    } catch { /* keep 0 */ }
    return `${BOOT_ID}-${Math.floor(newest)}`;
}
let serverVersion = computeServerVersion();
setInterval(() => {
    // Never tell pages to reload while OBS is streaming - the overlays on air would blank.
    // The change is announced on the first check after the stream stops.
    if (obsState.streaming) return;
    const v = computeServerVersion();
    if (v !== serverVersion) {
        serverVersion = v;
        logger.info('public files changed - telling open pages to reload', { version: v });
        io.emit('server:version', v);
    }
}, 3000).unref();

let socketClientCount = 0;
io.on('connection', (socket) => {
    socket.emit('server:version', serverVersion);
    socketClientCount++;
    logger.info('client connected', { totalClients: socketClientCount });
    socket.emit('scoreboard', theScoreboard);
    socket.emit('diag:updateRate', currentUpdateRate);

    socket.on('diag:subscribe', () => {
        diagnosticsSockets.add(socket.id);
        // Diagnostics clients get the recent packet/raw/log history on
        // subscribe, so the page isn't blank until the next live event.
        socket.emit('diag:packetHistory', recentPackets);
        socket.emit('diag:rawHistory', recentRawChunks);
        socket.emit('diag:issueHistory', logger.getRecentIssues());
        socket.emit('diag:status', supervisor.status);
        socket.emit('diag:heatsheets', heatsheetStore.status());
    });

    socket.on('diag:setUpdateRate', (ms) => { if (isLoopback(socket)) setUpdateRate(ms); });

    // Control room (control.html): start-up checks, live preview and status.
    socket.on('ctl:subscribe', () => {
        controlSockets.add(socket.id);
        { const r = remoteSettings(); socket.emit('ctl:role', { canControl: isLoopback(socket), remoteControl: !isLoopback(socket) && r.allow, needsPin: !isLoopback(socket) && r.allow && !!r.pin }); } // other devices: view only unless remote control is switched on
        socket.emit('ctl:checkList', startupChecks.listChecks());
        socket.emit('ctl:checkState', lastCheckResults);
        if (!checksRunning && !(obsState.streaming || obsState.recording) && Date.now() - lastFullAt > 60000) runControlChecks('full');
    });
    socket.on('ctl:runChecks', () => {
        if (Date.now() - lastManualRunAt < 10000) return; // a tap-happy phone must not keep the Mac busy
        lastManualRunAt = Date.now();
        runControlChecks('full');
    });
    socket.on('ctl:goLive', async (opts, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        const v = controlVerdict(socket, (opts || {}).pin);
        if (!v.ok) { logger.warn('on air: go-live refused', { from: socket.handshake.address, why: v.error }); return reply({ ok: false, error: v.error, needsPin: v.needsPin }); }
        reply(await goLive(opts || {}, v.by));
    });
    socket.on('ctl:stopOnAir', async (opts, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        const v = controlVerdict(socket, (opts || {}).pin);
        if (!v.ok) { logger.warn('on air: stop refused', { from: socket.handshake.address, why: v.error }); return reply({ ok: false, error: v.error, needsPin: v.needsPin }); }
        reply(await stopOnAir(opts || {}, v.by));
    });

    socket.on('disconnect', () => {
        socketClientCount--;
        diagnosticsSockets.delete(socket.id);
        controlSockets.delete(socket.id);
        logger.info('client disconnected', { totalClients: socketClientCount });
    });
});

// ---- Diagnostics raw-data relay ------------------------------------------
// Named, human-readable packets (meet title / event title / swimmer / end
// marker) - low volume, always relayed immediately.
const PACKET_HISTORY_MAX = 200;
const recentPackets = [];

function describePacket(cmd) {
    if (!cmd || cmd.length <= 1 || cmd[0] !== 18) return null;
    const cmd1 = cmd[1];
    const cmd2 = cmd[2];
    let desc = '';
    switch (cmd2) {
        case 1: desc = 'MEET TITLE'; break;
        case 2: desc = `EVENT TITLE (pool=${cmd1}) event=${(cmd[3] << 8) | cmd[4]} heat=${(cmd[5] << 8) | cmd[6]}`; break;
        case 3: desc = `SWIMMER (pool=${cmd1}) lane=${cmd[3]}`; break;
        case 4: desc = `END MARKER (pool=${cmd1})`; break;
        default: desc = `UNKNOWN cmd2=${cmd2}`;
    }
    let text = '';
    try {
        if (cmd2 === 1 && cmd.length > 4) {
            text = Buffer.from(cmd.slice(4, 4 + cmd[3])).toString('utf8').trim();
        } else if (cmd2 === 2 && cmd.length > 8) {
            text = Buffer.from(cmd.slice(8, 8 + cmd[7])).toString('utf8').trim();
        } else if (cmd2 === 3 && cmd.length > 7) {
            const lastNameLen = cmd[4];
            const teamLen = cmd[5];
            const lastName = Buffer.from(cmd.slice(7, 7 + lastNameLen)).toString('utf8').trim();
            const team = Buffer.from(cmd.slice(7 + lastNameLen, 7 + lastNameLen + teamLen)).toString('utf8').trim();
            text = `"${lastName}" (${team})`;
        }
    } catch {
        text = '(decode error)';
    }
    const hex = Array.from(cmd).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return { ts: Date.now(), desc, text, hex, len: cmd.length };
}

// Raw, unfiltered byte stream - much higher volume, batched/throttled so it
// doesn't flood the socket. Client-side toggle decides whether to show it.
const RAW_HISTORY_MAX = 200;
const recentRawChunks = [];
let rawByteAccumulator = [];
let rawFlushTimer = null;

function flushRawAccumulator() {
    rawFlushTimer = null;
    if (rawByteAccumulator.length === 0) return;
    if (diagnosticsSockets.size === 0) {
        // Nobody's watching - drop the buffered bytes without spending time
        // hex-encoding them.
        rawByteAccumulator = [];
        return;
    }
    const bytes = Buffer.concat(rawByteAccumulator);
    rawByteAccumulator = [];
    const preview = bytes.subarray(0, 256);
    const entry = {
        ts: Date.now(),
        byteCount: bytes.length,
        hex: Array.from(preview).map((b) => b.toString(16).padStart(2, '0')).join(' ') + (bytes.length > 256 ? ' ...' : '')
    };
    recentRawChunks.push(entry);
    if (recentRawChunks.length > RAW_HISTORY_MAX) recentRawChunks.shift();
    io.emit('diag:raw', entry);
}

// ---- Serial device supervisor --------------------------------------------
const supervisor = new SerialSupervisor({ devicePath });

// theScoreboard.serial_* only changes at connect/disconnect time (see the
// 'status' handler below), but serial_last_data_ms needs to reflect "how
// long ago" on every tick - so pull the live value each update cycle too.
function syncSerialStatus() {
    const status = supervisor.status;
    theScoreboard.serial_connected = status.connected;
    theScoreboard.serial_port = status.path || '';
    theScoreboard.serial_last_data_ms = status.lastDataAt;
}

supervisor.on('status', (status) => {
    syncSerialStatus();
    io.emit('diag:status', status);
});

supervisor.on('EventChange', (data) => {
    if (verbose) {
        logger.info('Event changed', data);
    }
});

supervisor.on('HeatChange', (data) => {
    if (verbose) {
        logger.info('Heat changed', data);
    }
});

supervisor.on('error', () => {
    // already logged inside serialSupervisor.js with full context
});

// Console "lookahead" packet (cmd2=2). Mostly just the current heat
// re-broadcast on a ~10s idle loop, so only a packet naming a DIFFERENT
// event/heat than the live one is treated as a next-race announcement; the
// usual trigger is the heat change itself (see updateScoreboardFromGen7).
supervisor.on('nextRace', (data) => {
    if (!data.eventNumber || !data.heatNumber) return;
    const decoder = supervisor.current;
    const liveEventNum = decoder ? decoder.CurrentEventNumber[data.poolNumber] || 0 : 0;
    const liveHeatNum = decoder ? decoder.CurrentHeatNumber[data.poolNumber] || 0 : 0;
    if (data.eventNumber === liveEventNum && data.heatNumber === liveHeatNum) return;
    announceNextRace(data.eventNumber, data.heatNumber, false);
});

supervisor.on('packet', (cmd) => {
    const described = describePacket(cmd);
    if (!described) return;
    recentPackets.push(described);
    if (recentPackets.length > PACKET_HISTORY_MAX) recentPackets.shift();
    io.emit('diag:packet', described);
});

supervisor.on('data', (buffer) => {
    rawByteAccumulator.push(Buffer.from(buffer));
    if (!rawFlushTimer) {
        rawFlushTimer = setTimeout(flushRawAccumulator, 300);
    }
});

logger.onIssue((line) => io.emit('diag:issue', line));

// Helper to check if race time is zero
function isRaceTimeZero(raceTime) {
    if (!raceTime) return true;
    const cleaned = raceTime.replace(/[:.\s]/g, '');
    return cleaned === '' || /^0+$/.test(cleaned);
}

// Helper to check if we have valid times
function hasValidTimes() {
    for (let lane = 1; lane <= 8; lane++) {
        const time = theScoreboard[`lane_time${lane}`];
        if (time && time !== '.' && time.length > 1 && !isRaceTimeZero(time)) {
            return true;
        }
    }
    return false;
}

// Helper to extract race distance from event title
function extractDistance(eventTitle) {
    if (!eventTitle) return 0;
    const match = eventTitle.match(/\b(50|100|200|400|800|1500)\s*(m|meter)/i);
    if (match) {
        return parseInt(match[1]);
    }
    return 0;
}

// Update touch tracking
function updateTouchTracking() {
    const raceTime = theScoreboard.race_time;
    const eventTitle = theScoreboard.event_title;
    const isZero = isRaceTimeZero(raceTime);

    // Update race distance if event changed
    if (eventTitle !== previousEventTitle) {
        theScoreboard.touch_total_distance = extractDistance(eventTitle);
        previousEventTitle = eventTitle;
        touchHistory.clear();
        currentTouchState.clear();
        lastLaneTimes.fill('');
        laneDifferentCount.fill(0);
    }

    const raceRunning = (raceTimeChangeCount >= CHANGING_THRESHOLD);

    // Clear everything if race stopped or at zero
    if (!raceRunning || isZero) {
        currentTouchState.clear();
        touchHistory.clear();
        laneDifferentCount.fill(0);
        lastLaneTimes.fill('');
        theScoreboard.touch_data = [];
        theScoreboard.touch_distance = 0;
        return;
    }

    // Check each lane for touches - only when race is running
    if (raceRunning && !isZero) {
        for (let lane = 1; lane <= 8; lane++) {
            const laneTime = theScoreboard[`lane_time${lane}`] || '';
            const name = theScoreboard[`lane_name${lane}`] || '';

            const validLaneTime = laneTime &&
                laneTime !== '.' &&
                laneTime.length > 1 &&
                !isRaceTimeZero(laneTime);

            const isDifferent = validLaneTime && laneTime !== raceTime;

            // If lane time is same as last update and different from race time
            if (isDifferent && laneTime === lastLaneTimes[lane]) {
                laneDifferentCount[lane]++;

                if (laneDifferentCount[lane] >= TOUCH_THRESHOLD) {
                    // Lane has stopped (touched)
                    if (!currentTouchState.has(lane)) {
                        // New touch - record it in history
                        if (!touchHistory.has(lane)) {
                            touchHistory.set(lane, []);
                        }
                        touchHistory.get(lane).push(laneTime);

                        const touchCount = touchHistory.get(lane).length;
                        currentTouchState.set(lane, {
                            lane: lane,
                            name: name,
                            time: laneTime,
                            touchCount: touchCount
                        });
                    }
                }
            } else if (validLaneTime && laneTime !== lastLaneTimes[lane]) {
                // Lane time changed - swimmer is moving again
                laneDifferentCount[lane] = 0;

                if (currentTouchState.has(lane)) {
                    currentTouchState.delete(lane);
                }
            } else if (!validLaneTime) {
                laneDifferentCount[lane] = 0;
            }

            lastLaneTimes[lane] = laneTime;
        }
    }

    // Calculate current leading touch count
    let maxTouches = 0;
    for (const touch of currentTouchState.values()) {
        if (touch.touchCount > maxTouches) {
            maxTouches = touch.touchCount;
        }
    }

    const currentDistance = maxTouches * 50;
    theScoreboard.touch_distance = currentDistance;

    // Don't show if we're at the final distance
    if (theScoreboard.touch_total_distance > 0 &&
        currentDistance >= theScoreboard.touch_total_distance) {
        theScoreboard.touch_data = [];
        return;
    }

    // Sort by touch count (descending), then by lane
    const sortedTouches = Array.from(currentTouchState.values())
        .sort((a, b) => {
            if (b.touchCount !== a.touchCount) {
                return b.touchCount - a.touchCount;
            }
            return a.lane - b.lane;
        });

    theScoreboard.touch_data = sortedTouches.map((t, index) => ({
        position: index + 1,
        lane: t.lane,
        name: t.name,
        time: t.time,
        touchCount: t.touchCount
    }));
}

// Determine display state
function determineDisplayState() {
    const raceTime = theScoreboard.race_time;
    const eventHeat = theScoreboard.event_heat;
    const isZero = isRaceTimeZero(raceTime);

    // Check if event/heat changed
    if (eventHeat !== previousEventHeat) {
        if (previousEventHeat !== '') {
            // Force to 'start' state and set flag
            eventJustChanged = true;
            resultShowStartTime = 0;
            raceTimeChangeCount = 0;
            theScoreboard.display_state = 'start';
            previousRaceTime = raceTime;

            // DIAGNOSTIC: schedule a data dump on the next update cycle
            diagnosticPending = true;
        }
        previousEventHeat = eventHeat;
        return;
    }

    // Track race time changes
    const raceTimeChanged = (raceTime !== previousRaceTime && !isZero);

    if (raceTimeChanged) {
        raceTimeChangeCount++;

        // Clear the event change flag when race starts
        if (raceTimeChangeCount >= CHANGING_THRESHOLD) {
            if (eventJustChanged) {
                eventJustChanged = false;
            }
            resultShowStartTime = 0; // Race started, clear result timer
        }
    } else if (isZero && raceTime === previousRaceTime) {
        // Race time stable at zero
        raceTimeChangeCount = 0;
    }
    previousRaceTime = raceTime;

    const raceRunning = (raceTimeChangeCount >= CHANGING_THRESHOLD);

    // CRITICAL: If event just changed, LOCK on 'start' until race actually starts
    if (eventJustChanged) {
        theScoreboard.display_state = 'start';
        return;
    }

    // Normal state logic (only runs if eventJustChanged is false)
    if (raceRunning) {
        theScoreboard.display_state = 'timer';
    } else if (!raceRunning && isZero && hasValidTimes()) {
        if (resultShowStartTime === 0) {
            resultShowStartTime = Date.now();
        }
        theScoreboard.display_state = 'result';
    } else if (!raceRunning && isZero && !hasValidTimes()) {
        theScoreboard.display_state = 'start';
        resultShowStartTime = 0;
    } else {
        theScoreboard.display_state = 'start';
    }
}

// Update scoreboard from Gen7 data
function updateScoreboardFromGen7() {
    syncSerialStatus();
    const decoder = supervisor.current;
    if (!decoder) {
        // No live link right now - still push the (stale) scoreboard + link
        // status so display pages can show a "no signal" indicator instead
        // of freezing silently. Keep showing whatever was already on screen,
        // held snapshot included.
        io.emit('scoreboard', heldSnapshot || theScoreboard);
        return;
    }

    const poolNumber = 0;

    // DIAGNOSTIC: dump the full Gen7 data structure when an event change is detected
    if (diagnosticPending) {
        diagnosticPending = false;
        try {
            logger.info('GEN7 DATA DUMP (event change detected)', JSON.parse(JSON.stringify(decoder.Gen7SwimmingData, (key, value) =>
                value instanceof Map ? Object.fromEntries(value) : value
            )));
        } catch (err) {
            logger.warn('failed to serialise Gen7SwimmingData for diagnostic dump', { error: err.message });
        }
    }

    // Update Event/Heat
    const eventNum = decoder.CurrentEventNumber[poolNumber] || 0;
    const heatNum = decoder.CurrentHeatNumber[poolNumber] || 0;
    const newEventHeat = `Event ${eventNum} Heat ${heatNum}`;

    // Snapshot the outgoing heat's full display BEFORE any field below gets
    // overwritten with the new heat's (still blank) data, so it can be held
    // on screen briefly instead of vanishing the instant the operator
    // clicks forward. Debounced (2 consecutive matching ticks, same
    // CHANGING_THRESHOLD pattern as race-time stability below) so a
    // single-tick misread of module 12 can't masquerade as a real heat
    // change and freeze a broken snapshot for the full hold duration.
    let justConfirmedHeatChange = false;
    if (newEventHeat !== theScoreboard.event_heat) {
        if (newEventHeat === pendingEventHeat) {
            pendingEventHeatCount++;
        } else {
            pendingEventHeat = newEventHeat;
            pendingEventHeatCount = 1;
        }
        if (pendingEventHeatCount >= CHANGING_THRESHOLD) {
            // Skip on the very first confirmed change (still showing the
            // startup placeholder - nothing worth holding onto yet).
            // "Startup" = nothing real on screen yet (placeholder, or the
            // console hadn't reported an event/heat yet) - nothing to hold,
            // and the heat it lands on isn't a "next" race.
            const isStartup = !/^Event [1-9]\d* Heat [1-9]/.test(theScoreboard.event_heat);
            if (!isStartup) {
                heldSnapshot = { ...theScoreboard };
                holdUntil = Date.now() + RESULT_DISPLAY_MIN_DURATION;
            }
            theScoreboard.event_heat = newEventHeat;
            justConfirmedHeatChange = true;
            // Not on the first read after a server (re)start - that's just
            // the heat we're already on, not a "next" race.
            if (!isStartup && eventNum > 0 && heatNum > 0) { announceNextRace(eventNum, heatNum, true); markHeat(eventNum, heatNum); }
            pendingEventHeat = null;
            pendingEventHeatCount = 0;
        }
    } else {
        pendingEventHeat = null;
        pendingEventHeatCount = 0;
    }

    // Change seen but not yet confirmed (first tick of a real change, or a
    // single-tick glitch): the names/title below are keyed off the live
    // event/heat, so carrying on here would flash the NEW heat's names over
    // the old heat's times for a tick. Re-send the last good state instead.
    if (newEventHeat !== theScoreboard.event_heat) {
        io.emit('scoreboard', heldSnapshot || theScoreboard);
        return;
    }

    // Update Meet Title as event name
    if (decoder.Gen7SwimmingData[poolNumber]) {
        theScoreboard.event_name = decoder.Gen7SwimmingData[poolNumber].MeetTitle || '';
    }

    // Get current event and heat data
    let currentHeat = null;
    if (decoder.Gen7SwimmingData[poolNumber] &&
        decoder.Gen7SwimmingData[poolNumber].Events &&
        eventNum > 0) {
        const currentEvent = decoder.Gen7SwimmingData[poolNumber].Events.get(eventNum);
        if (currentEvent && currentEvent.Heats && heatNum > 0) {
            currentHeat = currentEvent.Heats.get(heatNum);
        }
    }

    // The console never sends a title for session-2 events at all (see
    // decoder.js), and ships a placeholder for its default event - so use the
    // console's own title only when it's a real one, else fall back to the
    // authoritative heat sheet file the user uploads to the timing system.
    theScoreboard.event_title = resolveEventTitle(decoder, eventNum);

    // Update race time (module 0)
    const raceTimeStr = decoder.GetTime(poolNumber, 0, 4, 6, false) || '00:00.00';
    theScoreboard.race_time = raceTimeStr;

    // Raw lane readings (modules 1-8). Blank modules read back as "." - treat
    // those as empty rather than drawing a stray dot.
    const rawTime = [];
    const rawPlace = [];
    for (let lane = 1; lane <= 8; lane++) {
        const t = decoder.GetTime(poolNumber, lane, 4, 6, true) || '';
        rawTime[lane] = /^[\s.:]*$/.test(t) ? '' : t;
        const placeDigit = decoder.GetDigit(poolNumber, lane, 3);
        rawPlace[lane] = (placeDigit && placeDigit.trim()) ? placeDigit.trim() : '';
    }

    // The lane modules keep the previous heat's times/places after the
    // operator advances (see staleReadings above) - remember what they read
    // at the changeover so they can be held back from the new heat's names.
    if (justConfirmedHeatChange) {
        staleReadings = { time: rawTime.slice(), place: rawPlace.slice() };
    } else if (staleReadings && theScoreboard.display_state === 'timer') {
        staleReadings = null; // new race is running - modules show live data now
    }

    // Update lanes 1-8
    for (let lane = 1; lane <= 8; lane++) {
        let laneTime = rawTime[lane];
        let lanePlace = rawPlace[lane];
        if (staleReadings) {
            if (staleReadings.time[lane] !== null) {
                if (laneTime === staleReadings.time[lane]) laneTime = '';
                else if (laneTime) staleReadings.time[lane] = null; // genuinely new value
            }
            if (staleReadings.place[lane] !== null) {
                if (lanePlace === staleReadings.place[lane]) lanePlace = '';
                else if (lanePlace) staleReadings.place[lane] = null;
            }
        }
        theScoreboard[`lane_time${lane}`] = laneTime;
        theScoreboard[`lane_place${lane}`] = lanePlace;

        // Get swimmer name from Gen7 data
        let swimmerName = '';
        if (currentHeat && lane <= currentHeat.length) {
            const laneData = currentHeat[lane - 1];
            if (laneData && laneData.LastName) {
                const firstName = laneData.FirstName || '';
                const lastName = laneData.LastName || '';
                const team = laneData.Team || '';

                if (firstName || lastName) {
                    swimmerName = `${firstName} ${lastName}`.trim();
                    if (team) {
                        swimmerName += ` (${team})`;
                    }
                }
            }
        }
        if (!swimmerName && eventNum > 0 && heatNum > 0) {
            const backup = heatsheetStore.getLaneInfo(eventNum, heatNum, lane);
            if (backup && backup.name) {
                swimmerName = backup.name;
                if (backup.code || backup.club) {
                    swimmerName += ` (${backup.code || backup.club})`;
                }
            }
        }
        theScoreboard[`lane_name${lane}`] = swimmerName;
    }

    // Update console time from module 22
    const consoleTime = decoder.GetDigits(poolNumber, 22, 5, 6, -1, -1);
    if (consoleTime) {
        theScoreboard.console_time = consoleTime;
    }

    // Determine display state
    determineDisplayState();
    liveFeed.observe({
        eventNum, heatNum, displayState: theScoreboard.display_state,
        lanes: theScoreboard.display_state === 'result'
            ? [1, 2, 3, 4, 5, 6, 7, 8].map((lane) => ({ lane, time: theScoreboard[`lane_time${lane}`], place: theScoreboard[`lane_place${lane}`] }))
            : null
    });

    // Update touch tracking
    updateTouchTracking();

    // PB badges: only meaningful once times are final for this heat, using
    // the heat sheet's entry (seed) time as the "previous best" to beat.
    // A swimmer with no entry time on record is treated as a first-ever
    // time (PB by definition).
    for (let lane = 1; lane <= 8; lane++) {
        let badge = '';
        let qual = '';
        if (theScoreboard.display_state === 'result' && eventNum > 0 && heatNum > 0) {
            const raceSeconds = heatsheetStore.parseTimeToSeconds(theScoreboard[`lane_time${lane}`]);
            const backup = heatsheetStore.getLaneInfo(eventNum, heatNum, lane);
            // Lanes known only from a .scb file have no entry data at all
            // (hasEntryData false) - that's "unknown", not "no previous time".
            if (backup && backup.hasEntryData !== false && raceSeconds !== null) {
                if (backup.entrySeconds === null) {
                    badge = 'PB';
                } else if (raceSeconds < backup.entrySeconds) {
                    badge = `-${(backup.entrySeconds - raceSeconds).toFixed(2)}`;
                }
                // County/regional/national standard: needs the swimmer's sex,
                // age and club from the heat sheet.
                qual = qualifying.qualify(backup, heatsheetStore.getEventTitle(eventNum) || theScoreboard.event_title, raceSeconds);
            }
        }
        theScoreboard[`lane_pb${lane}`] = badge;
        theScoreboard[`lane_qual${lane}`] = qual;
    }

    // Release the hold once the new race actually starts running, or the
    // minimum hold time has passed - whichever comes first. Until then,
    // keep emitting the outgoing heat's frozen snapshot instead of the
    // (already-updated-underneath) live data below.
    if (heldSnapshot && (theScoreboard.display_state === 'timer' || Date.now() >= holdUntil)) {
        heldSnapshot = null;
    }
    const outgoing = heldSnapshot || theScoreboard;
    // The get-ready prompt is time-sensitive for officials and should never
    // be frozen by the result hold above - always show the live value even
    // while the rest of the display is showing a held snapshot. Text shows
    // for 15s after the console advances, or until that race starts.
    if (theScoreboard.display_state === 'timer') nextRaceTextUntil = 0;
    theScoreboard.next_race = '';
    if (nextRaceTarget && Date.now() < nextRaceTextUntil) {
        const title = resolveEventTitle(decoder, nextRaceTarget.eventNumber);
        theScoreboard.next_race = `Event ${nextRaceTarget.eventNumber} Heat ${nextRaceTarget.heatNumber}${title ? ' - ' + title : ''}`;
    }
    outgoing.next_race = theScoreboard.next_race;

    // Emit to all clients
    io.emit('scoreboard', outgoing);

    // Periodic per-module channel snapshot for diagnostics.html - lets raw
    // bytes be visually mapped to specific scoreboard fields. Skipped when
    // nobody has diagnostics.html open, so a fast update rate doesn't pay
    // for 31 GetDigits() calls + a broadcast every tick for nothing.
    if (diagnosticsSockets.size > 0) {
        const moduleSnapshot = [];
        for (let module = 0; module <= 30; module++) {
            try {
                const digits = decoder.GetDigits(poolNumber, module, 1, 10, -1, -1);
                if (digits && digits.trim()) {
                    moduleSnapshot.push({ module, digits });
                }
            } catch {
                // module not populated yet - skip
            }
        }
        io.emit('diag:modules', moduleSnapshot);
    }

    // Display on console if not quiet - mirrors what's actually on screen
    // (outgoing), including while a held snapshot is showing.
    if (!quiet) {
        console.clear();
        console.log('=== SCOREBOARD STATE ===');
        console.log(`Event/Heat: ${outgoing.event_heat}${heldSnapshot ? '  [HELD]' : ''}`);
        console.log(`Event Title: ${outgoing.event_title}`);
        console.log(`Meet Title: ${outgoing.event_name}`);
        console.log(`Race Time: ${outgoing.race_time}`);
        console.log(`Display State: ${outgoing.display_state.toUpperCase()}`);
        console.log(`Serial: ${theScoreboard.serial_connected ? 'CONNECTED (' + theScoreboard.serial_port + ')' : 'DISCONNECTED'}`);
        console.log('');
        for (let i = 1; i <= 8; i++) {
            const name = outgoing[`lane_name${i}`] || '-';
            const place = outgoing[`lane_place${i}`] || '-';
            const time = outgoing[`lane_time${i}`] || '-';
            console.log(`Lane ${i}: ${name.padEnd(35)} Place: ${place.padStart(2)} Time: ${time.padStart(10)}`);
        }
    }
}

// Test mode
function testMode_run() {
    logger.info('Running in TEST mode');

    let testCounter = 0;
    let racePhase = 0;
    let raceStartCounter = 0;

    setInterval(() => {
        testCounter++;

        // Cycle through race phases
        if (testCounter % 100 < 10) {
            racePhase = 0; // Start/ready
        } else if (testCounter % 100 < 60) {
            racePhase = 1; // Running
        } else if (testCounter % 100 < 90) {
            racePhase = 2; // Finished - show results
        } else {
            racePhase = 0; // Back to start
        }

        theScoreboard.event_heat = `Event ${(testCounter % 50) + 1} Heat ${(testCounter % 5) + 1}`;
        theScoreboard.event_title = 'Test Event - 50m Freestyle';

        if (racePhase === 0) {
            theScoreboard.race_time = '00:00.00';
            for (let i = 1; i <= 8; i++) {
                theScoreboard[`lane_name${i}`] = `Swimmer ${i} (TEAM)`;
                theScoreboard[`lane_place${i}`] = '';
                theScoreboard[`lane_time${i}`] = '';
            }
        } else if (racePhase === 1) {
            raceStartCounter++;
            const seconds = Math.floor(raceStartCounter / 2);
            const centiseconds = (raceStartCounter % 2) * 50;
            theScoreboard.race_time = `0${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;

            for (let i = 1; i <= 8; i++) {
                theScoreboard[`lane_name${i}`] = `Swimmer ${i} (TEAM)`;
                theScoreboard[`lane_place${i}`] = '';
                const laneSeconds = seconds + (i * 0.2);
                theScoreboard[`lane_time${i}`] = `${String(Math.floor(laneSeconds / 60)).padStart(2, '0')}:${String(Math.floor(laneSeconds % 60)).padStart(2, '0')}.${String(Math.floor((laneSeconds % 1) * 100)).padStart(2, '0')}`;
            }
        } else if (racePhase === 2) {
            theScoreboard.race_time = '00:00.00';

            for (let i = 1; i <= 8; i++) {
                theScoreboard[`lane_name${i}`] = `Swimmer ${i} (TEAM)`;
                theScoreboard[`lane_place${i}`] = String(i);
                const finalTime = 25 + i * 0.5;
                theScoreboard[`lane_time${i}`] = `${String(Math.floor(finalTime / 60)).padStart(2, '0')}:${String(Math.floor(finalTime % 60)).padStart(2, '0')}.${String(Math.floor((finalTime % 1) * 100)).padStart(2, '0')}`;
            }
        }

        determineDisplayState();
        updateTouchTracking();
        io.emit('scoreboard', theScoreboard);

        if (!quiet) {
            console.clear();
            console.log('=== TEST MODE ===');
            console.log(`Phase: ${racePhase === 0 ? 'START' : racePhase === 1 ? 'RUNNING' : 'FINISHED'}`);
            console.log(`Display State: ${theScoreboard.display_state.toUpperCase()}`);
            console.log(`Event/Heat: ${theScoreboard.event_heat}`);
            console.log(`Race Time: ${theScoreboard.race_time}`);
        }
    }, updateRate);
}

// Live-adjustable update rate (Gen7 mode only) - lets the update cadence be
// tuned from diagnostics.html without restarting the server, to balance
// smooth-looking race times against CPU/network load on the day.
const MIN_UPDATE_RATE_MS = 20;
const MAX_UPDATE_RATE_MS = 2000;
let currentUpdateRate = updateRate;
let updateIntervalHandle = null;

function setUpdateRate(ms) {
    if (!gen7Mode) return; // test mode runs its own independent interval
    const clamped = Math.min(MAX_UPDATE_RATE_MS, Math.max(MIN_UPDATE_RATE_MS, Math.round(Number(ms))));
    if (!Number.isFinite(clamped) || clamped === currentUpdateRate) return;
    currentUpdateRate = clamped;
    if (updateIntervalHandle) clearInterval(updateIntervalHandle);
    updateIntervalHandle = setInterval(updateScoreboardFromGen7, currentUpdateRate);
    logger.info('update rate changed', { updateRateMs: currentUpdateRate });
    io.emit('diag:updateRate', currentUpdateRate);
}

// ---- Control room (phase 1: checks, preview, status) ----------------------
// OBS keeps running whether or not any of this is connected.
const obs = new ObsControl();
// The moment OBS connects, make sure the GoPro and Mac microphones are muted.
obs.on('connected', () => { audioGuard.enforce(obs).catch(() => {}); });
let checksRunning = false;
let lastCheckRunAt = 0;
const lastCheckResults = {};

function emitToControl(event, payload, volatile = false) {
    for (const id of controlSockets) {
        const sock = io.sockets.sockets.get(id);
        if (sock) (volatile ? sock.volatile : sock).emit(event, payload);
    }
}

function scoreboardForChecks() {
    const decoder = supervisor.current;
    const eventNum = decoder ? decoder.CurrentEventNumber[0] || 0 : 0;
    const heatNum = decoder ? decoder.CurrentHeatNumber[0] || 0 : 0;
    const consoleNames = [];
    try {
        const ev = decoder && decoder.Gen7SwimmingData[0].Events.get(eventNum);
        const heat = ev && ev.Heats.get(heatNum);
        for (let i = 0; i < 8; i++) consoleNames.push(heat && heat[i] ? (heat[i].LastName || '') : '');
    } catch { /* no names yet */ }
    return { serial: supervisor.status, eventNum, heatNum, consoleNames };
}

let lastFullAt = 0;
// mode 'full': everything, shown as a cascade. mode 'live': just the cheap checks, silently, only
// reporting what changed - used to keep every open control room (phones included) up to date.
async function runControlChecks(mode = 'full') {
    if (checksRunning) return;
    checksRunning = true;
    const live = mode === 'live';
    let changed = false;
    if (!live) emitToControl('ctl:checksStarted', {});
    try {
        const summary = await startupChecks.runAll(
            { obs, scoreboard: scoreboardForChecks, driveStatus: () => driveSync.getStatus(), isLive: () => obsState.streaming || obsState.recording },
            (id, res) => {
                if (live) {
                    if (JSON.stringify(lastCheckResults[id]) === JSON.stringify(res)) return;
                    changed = true;
                }
                lastCheckResults[id] = res;
                emitToControl('ctl:check', { id, ...res });
            },
            live ? { only: startupChecks.LIVE_IDS, silent: true } : {}
        );
        lastCheckRunAt = Date.now();
        if (!live) lastFullAt = lastCheckRunAt;
        if (!live || changed) emitToControl('ctl:checksDone', { failed: summary.failed, warned: summary.warned, ready: summary.ready });
        if (!live) logger.info('start-up checks finished', { failed: summary.failed, warned: summary.warned });
    } catch (err) {
        logger.warn('start-up checks crashed', { error: err.message });
    } finally {
        checksRunning = false;
    }
}

// Keep the ticks fresh for ANYONE who has a control room open (the Mac or a phone), not just when
// the Mac's own page asks: idle = a full run each minute; on air = the cheap checks every 20s and
// a full run only every 5 minutes, so watching from a phone never loads the Mac during a stream.
setInterval(() => {
    if (controlSockets.size === 0 || checksRunning) return;
    const now = Date.now();
    if (obsState.streaming || obsState.recording) {
        if (now - lastFullAt > 300000) runControlChecks('full');
        else if (now - lastCheckRunAt > 20000) runControlChecks('live');
    } else if (now - lastFullAt > 60000) runControlChecks('full');
}, 5000).unref();

// Camera watcher (every 10s):
//  - a NEW camera id means the camera was (re)connected or swapped, so apply the
//    PAL (50Hz) setting to it again (retrying for a minute while its USB link
//    comes up);
//  - keep OBS's camera source on the camera's current id. macOS gives the GoPro
//    a new id whenever it is reconnected, so a cable knocked out mid-event would
//    otherwise leave OBS showing nothing until someone re-picked the camera;
//  - keep our idea of "is OBS recording?" in step, for the heat chapter markers.
let cameraWatchBusy = false;
let lastCameraId = null;
let palAttempts = 0;
const obsState = { recording: false, streaming: false };
setInterval(async () => {
    if (cameraWatchBusy || checksRunning) return;
    cameraWatchBusy = true;
    try {
        const id = await startupChecks.currentCameraId();
        if (id && id !== lastCameraId) {
            if (lastCameraId !== null || palAttempts === 0) logger.info('camera: new or reconnected GoPro detected', { cameraId: id });
            const cam = await gopro.findCamera().catch(() => null);
            let applied = false;
            if (cam && cam.ip) {
                const r = await gopro.ensureAntiFlicker50(cam.ip).catch((e) => ({ ok: false, error: e.message }));
                applied = r.ok;
                if (r.ok && r.changed) logger.info('camera: set to PAL (50Hz)', { from: r.from });
                else if (!r.ok) logger.warn('camera: could not set PAL yet', { error: r.error });
            }
            palAttempts++;
            if (applied || palAttempts >= 6) { lastCameraId = id; palAttempts = 0; }
        }
        if (obs.connected) {
            if (id) {
                const r = await startupChecks.ensureObsCamera(obs, id).catch(() => null);
                if (r && r.changed) logger.info('obs: camera source re-pointed at the current GoPro id', { cameraId: id });
            }
            const [st, rec] = await Promise.all([obs.request('GetStreamStatus'), obs.request('GetRecordStatus')]);
            obsState.streaming = st.outputActive;
            obsState.recording = rec.outputActive;
            await audioGuard.enforce(obs).catch(() => {}); // keep the GoPro / Mac mics muted
        }
    } catch { /* OBS or the camera not ready - try again later */ } finally { cameraWatchBusy = false; }
}, 10000).unref();

// ---- Go live / Stop (from the control room) ---------------------------------
// Starting and stopping what goes out is only ever done from the control page
// on THIS Mac (a loopback connection) - anyone else on the venue network can
// reach the scoreboard pages but cannot start or stop the stream. Both are
// two-step on the page (confirm dialog); nothing here ever starts by itself.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
let liveBusy = false;
const isLoopback = (socket) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.handshake.address);
// Go live / Stop from another device (a phone) is OFF unless config/network.json says
// {"allowRemoteControl": true}; "remoteControlPin" then makes the device enter a PIN first.
// The confirm dialogs still apply either way.
function remoteSettings() {
    try { const c = JSON.parse(require('fs').readFileSync(process.env.SCOREBOARD_NETWORK_CONFIG || path.join(__dirname, '..', 'config', 'network.json'), 'utf8')); return { allow: c.allowRemoteControl === true, pin: c.remoteControlPin ? String(c.remoteControlPin) : '' }; } catch { return { allow: false, pin: '' }; }
}
function controlVerdict(socket, pin) {
    if (isLoopback(socket)) return { ok: true, by: 'control room' };
    const r = remoteSettings();
    if (!r.allow) return { ok: false, error: 'Only the control room on the scoreboard Mac can do this.' };
    if (r.pin && String(pin || '') !== r.pin) return { ok: false, needsPin: true, error: 'Wrong or missing PIN.' };
    return { ok: true, by: `remote control room (${socket.handshake.address})` };
}

function chapterName(eventNum, heatNum) {
    const title = resolveEventTitle(supervisor.current, eventNum);
    const base = `Event ${eventNum} Heat ${heatNum}`;
    return (title ? `${base} - ${title}` : base).slice(0, 100);
}

// A heat change: noted in the session log (the stream's chapter list is built
// from it afterwards) and, while recording, added as a chapter marker in the
// recording file (OBS "Hybrid MP4/MOV" recordings support chapters).
async function markHeat(eventNum, heatNum, prefix = '') {
    const name = `${prefix}${chapterName(eventNum, heatNum)}`;
    sessionLog.log('heat', { event: eventNum, heat: heatNum, name, streaming: obsState.streaming, recording: obsState.recording });
    if (!(obsState.recording && obs.connected)) return;
    try { await obs.request('CreateRecordChapter', { chapterName: name }); }
    catch (err) { logger.warn('obs: could not add a recording chapter', { name, error: err.message }); }
}

async function onAirStatus() {
    const [st, rec] = await Promise.all([obs.request('GetStreamStatus'), obs.request('GetRecordStatus')]);
    obsState.streaming = st.outputActive;
    obsState.recording = rec.outputActive;
    return { streaming: st.outputActive, recording: rec.outputActive };
}

async function goLive({ stream = true, record = true } = {}, who = '') {
    if (liveBusy) return { ok: false, error: 'Already working on a start/stop - wait a moment.' };
    if (!obs.connected) return { ok: false, error: 'OBS is not connected - nothing was started.' };
    if (!stream && !record) return { ok: false, error: 'Nothing selected to start.' };
    liveBusy = true;
    const result = { ok: false, record: null, stream: null, errors: [] };
    try {
        // what goes out is the pool camera scene (the TV shows the scoreboard scene on its own projector)
        try {
            const want = startupChecks.CONFIG.scene;
            const cur = (await obs.request('GetCurrentProgramScene')).currentProgramSceneName;
            if (cur !== want) { await obs.request('SetCurrentProgramScene', { sceneName: want }); result.scene = `switched to ${want}`; logger.info('on air: switched OBS to the stream scene', { from: cur, to: want }); }
        } catch (e) { logger.warn('on air: could not check/switch the OBS scene', { error: e.message }); }
        await audioGuard.enforce(obs).catch(() => {}); // belt and braces: no stray mic on air
        const switchedOn = await audioGuard.unmuteSoundcards(obs).catch(() => []); // ... and the mixer is on
        if (switchedOn.length) result.audio = `switched on ${switchedOn.join(', ')}`;
        let now = await onAirStatus();
        const meta = { event_heat: theScoreboard.event_heat, meet: theScoreboard.event_name, by: who };
        // Recording first, so nothing at the start of the stream is missed.
        if (record) {
            if (now.recording) result.record = 'already recording';
            else {
                try {
                    await obs.request('StartRecord');
                    result.record = 'started';
                    sessionLog.log('record-start', meta);
                    logger.info('on air: recording started', meta);
                } catch (e) { result.errors.push(`Recording: ${e.message}`); }
            }
        }
        if (stream) {
            if (now.streaming) result.stream = 'already live';
            else {
                try {
                    const streamAskedAt = new Date().toISOString(); // chapter times count from here, not from when we finished checking
                    await obs.request('StartStream');
                    // OBS accepts the request straight away and stops the output
                    // itself if it can't connect (wrong key, no internet) - so
                    // watch it for a few seconds before saying it worked.
                    let held = true;
                    for (let i = 0; i < 6 && held; i++) { await sleepMs(1000); held = (await onAirStatus()).streaming; }
                    if (held) {
                        result.stream = 'started';
                        sessionLog.log('stream-start', { ...meta, t: streamAskedAt });
                        // the heat on screen as the stream starts is its first chapter
                        const cur = theScoreboard.event_heat.match(/Event (\d+) Heat (\d+)/);
                        if (cur && Number(cur[1]) > 0) sessionLog.log('heat', { event: Number(cur[1]), heat: Number(cur[2]), name: `Start - ${chapterName(Number(cur[1]), Number(cur[2]))}`, streaming: true, recording: obsState.recording, t: streamAskedAt });
                        logger.info('on air: stream started', meta);
                    }
                    else result.errors.push('Stream: OBS started it but then stopped it again - it could not connect. Check the internet and the stream key in OBS.');
                } catch (e) { result.errors.push(`Stream: ${e.message}`); }
            }
        }
        now = await onAirStatus();
        result.streaming = now.streaming;
        result.recording = now.recording;
        result.ok = (!stream || now.streaming) && (!record || now.recording) && result.errors.length === 0;
        if (now.recording && result.record === 'started') {
            const ev = theScoreboard.event_heat.match(/Event (\d+) Heat (\d+)/);
            if (ev && Number(ev[1]) > 0) setTimeout(() => markHeat(Number(ev[1]), Number(ev[2]), 'Start - '), 1500);
        }
    } catch (err) {
        result.errors.push(err.message);
    } finally { liveBusy = false; }
    return result;
}

async function stopOnAir({ stream = true, record = true } = {}, who = '') {
    if (liveBusy) return { ok: false, error: 'Already working on a start/stop - wait a moment.' };
    if (!obs.connected) return { ok: false, error: 'OBS is not connected - nothing was stopped.' };
    liveBusy = true;
    const result = { ok: false, stream: null, record: null, errors: [], file: null };
    try {
        const now = await onAirStatus();
        if (stream) {
            if (!now.streaming) result.stream = 'was not live';
            else try { await obs.request('StopStream'); result.stream = 'stopped'; sessionLog.log('stream-stop', { by: who }); logger.info('on air: stream stopped', { by: who }); } catch (e) { result.errors.push(`Stream: ${e.message}`); }
        }
        if (record) {
            if (!now.recording) result.record = 'was not recording';
            else try {
                const r = await obs.request('StopRecord');
                result.record = 'stopped';
                result.file = r.outputPath || null;
                sessionLog.log('record-stop', { by: who, file: result.file });
                logger.info('on air: recording stopped', { by: who, file: result.file });
            } catch (e) { result.errors.push(`Recording: ${e.message}`); }
        }
        const after = await onAirStatus();
        result.streaming = after.streaming;
        result.recording = after.recording;
        result.ok = result.errors.length === 0 && (!stream || !after.streaming) && (!record || !after.recording);
    } catch (err) {
        result.errors.push(err.message);
    } finally { liveBusy = false; }
    return result;
}

app.get('/api/checks', (req, res) => res.json({ running: checksRunning, at: lastCheckRunAt, results: lastCheckResults }));

// Status line (every 2s) and live preview (about 4 frames a second) - only
// while at least one control page is open, so they cost nothing otherwise.
let programScene = '';
let programSceneAt = 0;
let previewBusy = false;
setInterval(async () => {
    if (controlSockets.size === 0) return;
    const status = { liveView: liveView.status(), obsConnected: obs.connected, obsNote: obs.connected ? '' : obs.explain(), serialConnected: supervisor.status.connected, eventHeat: theScoreboard.event_heat };
    if (obs.connected) {
        try {
            const [stats, st, rec] = await Promise.all([obs.request('GetStats'), obs.request('GetStreamStatus'), obs.request('GetRecordStatus')]);
            Object.assign(status, {
                cpu: stats.cpuUsage, fps: stats.activeFps, renderSkipped: stats.renderSkippedFrames, outputSkipped: stats.outputSkippedFrames,
                freeDiskGB: stats.availableDiskSpace / 1024,
                streaming: st.outputActive, streamSeconds: Math.round((st.outputDuration || 0) / 1000), congestion: st.outputCongestion,
                recording: rec.outputActive, recordSeconds: Math.round((rec.outputDuration || 0) / 1000)
            });
        } catch { /* next tick */ }
    }
    emitToControl('ctl:status', status);
}, 2000).unref();

setInterval(async () => {
    if (controlSockets.size === 0 || !obs.connected || previewBusy) return;
    if (liveView.level() >= 2) return; // OBS is under strain while on air: the previews are the first thing to give way
    previewBusy = true;
    try {
        if (!programScene || Date.now() - programSceneAt > 5000) {
            programScene = (await obs.request('GetCurrentProgramScene')).sceneName || (await obs.request('GetCurrentProgramScene')).currentProgramSceneName;
            programSceneAt = Date.now();
        }
        const r = await obs.request('GetSourceScreenshot', { sourceName: programScene, imageFormat: 'jpeg', imageWidth: 640, imageHeight: 360, imageCompressionQuality: 50 }, 3000);
        emitToControl('ctl:preview', r.imageData, true);
    } catch { /* skip a frame */ } finally { previewBusy = false; }
}, 250).unref();

// ---- Live heat feed for the athlete / team / marshal pages (see liveFeed.js) -----
const liveFeed = liveFeedFactory.create({
    heatsheetStore,
    getMeetName: () => theScoreboard.event_name || (driveSync.getStatus().selected || {}).name || '',
    logger
});
const isLoopbackReq = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
liveFeed.attach(app, io, isLoopbackReq);

// ---- Publishing the live feed to the web host (see livePublisher.js) ----------------------
const livePublisher = livePublisherFactory.create({ liveFeed, logger });
livePublisher.start();
const localOnly = (req, res, next) => isLoopbackReq(req) ? next() : res.status(403).json({ error: 'Only from the scoreboard Mac.' });
app.get('/api/live/publish', localOnly, (req, res) => res.json(livePublisher.getStatus()));
app.post('/api/live/publish/test', localOnly, async (req, res) => res.json(await livePublisher.test()));
app.post('/api/live/publish/send-meet', localOnly, (req, res) => { livePublisher.sendMeetAgain(); res.json({ ok: true }); });
app.post('/api/live/publish/wipe', localOnly, async (req, res) => res.json(await livePublisher.wipe()));
app.post('/api/live/publish/resume', localOnly, (req, res) => res.json({ ok: livePublisher.resume() }));

// Main execution
logger.info('Colorado Scoreboard Server v2 starting', {
    mode: gen7Mode ? 'Gen7 (RS485)' : (testMode ? 'Test' : 'unset'),
    httpPort,
    updateRate,
    devicePath: devicePath || 'auto-detect'
});

heatsheetStore.start();
obs.start();
qualifying.start();
// Not awaited: a slow/absent internet connection must never delay the
// scoreboard coming up - existing heatsheets/ files are used meanwhile.
driveSync.start(() => { /* heatsheetStore's own file watcher reloads on change */ });

if (testMode) {
    testMode_run();
} else if (gen7Mode) {
    supervisor.start();
    updateIntervalHandle = setInterval(updateScoreboardFromGen7, currentUpdateRate);
} else {
    logger.error('No mode selected. Use -7 for Gen7 mode or -t for test mode.');
    process.exit(1);
}

// Extra ports (config/network.json, default 80) so the address needs no ":8080" - best effort,
// the scoreboard works the same if one can't be opened.
const extraPortsUp = [];
for (const extra of friendlyName.extraPorts) {
    if (!Number.isInteger(extra) || extra === httpPort) continue;
    const srv = http.createServer(app);
    io.attach(srv);
    srv.on('error', (err) => logger.warn(`could not also listen on port ${extra} - use :${httpPort}`, { code: err.code }));
    srv.listen(extra, () => { extraPortsUp.push(extra); logger.info(`also listening on port ${extra}`); });
}
friendlyName.start();
// launchd stops us with SIGTERM: exit normally so the name advertiser is cleaned up too
process.on('SIGTERM', () => process.exit(0));

server.listen(httpPort, () => {
    logger.info(`HTTP server listening`, { url: `http://localhost:${httpPort}` });
});
