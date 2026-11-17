// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Near-real-time local view of what OBS is sending (the program scene), for
// other computers on the network - NOT the YouTube feed (which is 15-30s
// behind). It is Motion-JPEG: OBS hands over a JPEG of the program output many
// times a second (about 13 ms per 1080p frame) and the browser shows it as a
// continuously updating picture. Video only - no sound. One capture loop per
// size/rate combination is shared by every viewer of it, so more viewers cost
// network, not OBS time. At most 3 viewers, and it backs off by itself the moment
// OBS shows strain while on air (see liveGovernor.js): the stream comes first.
//
//   /live.mjpg?size=720|1080&fps=1..25   continuous stream (<img src=...>, VLC, ...)
//   /live.jpg?size=720|1080              a single frame

const fs = require('fs');
const path = require('path');
const { Governor } = require('./liveGovernor.js');

// At most this many streams at once (config/network.json "maxLiveViewers"): every viewer
// costs the Mac network and CPU, and the stream to YouTube comes first.
function maxViewers() {
    try { const n = parseInt(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'network.json'), 'utf8')).maxLiveViewers, 10); if (n >= 1 && n <= 20) return n; } catch { /* default */ }
    return 3;
}
const SIZES = { 720: [1280, 720, 60], 1080: [1920, 1080, 60] };

// All viewers share one network budget, so a weak link (Wi-Fi) is never filled by the live
// view: it would starve the YouTube upload and make every other device drop out. The picture
// gets fewer frames a second rather than more bytes. Megabits per second in total:
// config/network.json "liveViewMaxMbps", otherwise 12 on Wi-Fi and 60 on Ethernet.
function configuredMbps() {
    try { const n = Number(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'network.json'), 'utf8')).liveViewMaxMbps); if (n >= 1) return n; } catch { /* default */ }
    return null;
}

function create({ getObs, logger, getLinkKind = async () => 'Network' }) {
    const O = () => getObs(); // OBS connection, looked up when needed (it is created after this)
    const profiles = new Map(); // "size@fps" -> { size, fps, clients:Set(res), running }
    let scene = '';
    let sceneAt = 0;
    let lastFrameAt = 0;
    let budgetBps = 12 * 125000;   // bytes a second for everyone together
    let linkKind = 'Wi-Fi';
    let sent = [];                 // [time, bytes] for the last few seconds, to report the real rate
    async function refreshBudget() {
        try { linkKind = await getLinkKind(); } catch { /* keep */ }
        const mbps = configuredMbps() || (linkKind === 'Ethernet' ? 60 : 12);
        budgetBps = mbps * 125000;
    }
    refreshBudget(); setInterval(refreshBudget, 30000).unref();
    function rateMbps() {
        const cut = Date.now() - 4000;
        sent = sent.filter((x) => x[0] > cut);
        return Math.round(sent.reduce((a, x) => a + x[1], 0) / 4 / 125000 * 10) / 10;
    }
    const governor = new Governor({ recoverMs: Number(process.env.LIVEVIEW_RECOVER_MS) || 30000 }); // (override only for testing)
    let prev = null; // previous OBS counters, to see what is NEW since the last look
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function programScene() {
        if (!scene || Date.now() - sceneAt > 5000) {
            const r = await O().request('GetCurrentProgramScene');
            scene = r.sceneName || r.currentProgramSceneName;
            sceneAt = Date.now();
        }
        return scene;
    }

    async function frame(size) {
        const [w, h, q] = SIZES[Math.min(size, governor.caps().maxSize)];
        const r = await O().request('GetSourceScreenshot', { sourceName: await programScene(), imageFormat: 'jpeg', imageWidth: w, imageHeight: h, imageCompressionQuality: q }, 3000);
        return Buffer.from(r.imageData.slice(r.imageData.indexOf(',') + 1), 'base64');
    }

    function parse(req) {
        const size = String(req.query.size) === '720' ? 720 : 1080; // default: 1080p at 25fps, the same as the stream
        const fps = Math.min(25, Math.max(1, parseInt(req.query.fps, 10) || 25));
        return { size, fps };
    }

    async function loop(p) {
        p.running = true;
        let next = Date.now();
        while (p.clients.size) {
            if (governor.caps().paused) { await sleep(500); next = Date.now(); continue; } // protecting the stream: no frames for now
            try {
                const buf = await frame(p.size);
                lastFrameAt = Date.now();
                const head = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`;
                for (const res of p.clients) {
                    if (res.writableLength > buf.length * 3) continue; // a slow viewer: skip frames for them, don't queue
                    res.write(head); res.write(buf); res.write('\r\n');
                    sent.push([Date.now(), buf.length]);
                }
                p.lastLen = buf.length;
            } catch { await sleep(500); next = Date.now(); }
            // pace to a fixed timetable (not "sleep a fixed time after each frame") so 25 fps really is 25 fps
            const people = Math.max(1, viewerCount());
            const affordable = p.lastLen ? budgetBps / (people * p.lastLen) : p.fps;   // frames a second each person can have
            next += 1000 / Math.max(2, Math.min(p.fps, governor.caps().fps, affordable));
            const wait = next - Date.now();
            if (wait < -250) next = Date.now(); // fell badly behind: skip ahead rather than rush
            await sleep(Math.max(1, wait));
        }
        p.running = false;
    }

    function viewerCount() { let n = 0; for (const p of profiles.values()) n += p.clients.size; return n; }

    function stream(req, res) {
        if (!O().connected) return res.status(503).type('text/plain').send('OBS is not connected - nothing to show yet.');
        if (governor.caps().paused) return res.status(503).type('text/plain').send('The live view is paused to protect the stream to YouTube - it will return when OBS is back to normal.');
        if (viewerCount() >= maxViewers()) return res.status(503).type('text/plain').send(`The live view is limited to ${maxViewers()} viewers to protect the stream - try again in a moment.`);
        const { size, fps } = parse(req);
        const key = `${size}@${fps}`;
        let p = profiles.get(key);
        if (!p) { p = { size, fps, clients: new Set(), running: false }; profiles.set(key, p); }
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Pragma: 'no-cache',
            Connection: 'close'
        });
        p.clients.add(res);
        logger.info('live view: viewer connected', { from: req.socket.remoteAddress, size, fps, viewers: viewerCount() });
        req.on('close', () => { p.clients.delete(res); logger.info('live view: viewer left', { viewers: viewerCount() }); });
        if (!p.running) loop(p);
    }

    async function still(req, res) {
        if (!O().connected) return res.status(503).type('text/plain').send('OBS is not connected.');
        if (governor.caps().paused) return res.status(503).type('text/plain').send('Paused to protect the stream.');
        try {
            const buf = await frame(parse(req).size);
            res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).send(buf);
        } catch (e) { res.status(502).type('text/plain').send(e.message); }
    }

    // Every 2s while anyone is watching (or a limit is still in force): look at how OBS is
    // coping and let the governor decide whether the live view must back off.
    async function watchHealth() {
        try {
            const o = O();
            if (!o.connected) return;
            const [stats, st, rec] = await Promise.all([o.request('GetStats'), o.request('GetStreamStatus'), o.request('GetRecordStatus')]);
            const sample = {
                now: Date.now(),
                onAir: !!(st.outputActive || rec.outputActive),
                renderSkippedDelta: prev ? Math.max(0, stats.renderSkippedFrames - prev.render) : 0,
                outputSkippedDelta: prev ? Math.max(0, stats.outputSkippedFrames - prev.output) : 0,
                congestion: st.outputActive ? (st.outputCongestion || 0) : 0,
                reconnecting: !!st.outputReconnecting,
                cpu: stats.cpuUsage || 0
            };
            prev = { render: stats.renderSkippedFrames, output: stats.outputSkippedFrames };
            const r = governor.evaluate(sample);
            if (r.changed) {
                logger.warn(r.level ? 'live view: backing off to protect the stream' : 'live view: back to normal', { level: r.level, reason: governor.reason, viewers: viewerCount() });
                if (governor.caps().paused) { /* loops stop sending; viewers see "paused" on the page */ }
            }
        } catch { /* OBS busy - look again next time */ }
    }
    const healthTimer = setInterval(() => { if (viewerCount() > 0 || governor.level > 0) watchHealth(); else prev = null; }, 2000);
    if (healthTimer.unref) healthTimer.unref();

    // for the viewer page: is OBS there, how many are watching, how long since a frame went out
    const status = () => ({ obs: !!O().connected, viewers: viewerCount(), max: maxViewers(), level: governor.level, paused: governor.caps().paused, reason: governor.reason, link: linkKind, mbps: rateMbps(), budgetMbps: Math.round(budgetBps / 125000), lastFrameAgoMs: lastFrameAt ? Date.now() - lastFrameAt : null });

    return { stream, still, viewerCount, status, level: () => governor.level, maxViewers };
}

module.exports = { create };
