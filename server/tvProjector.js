// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Puts the OBS "Scoreboard TV" scene full screen on the TV.
//
// The TV shows OBS's own full-screen projector of the scoreboard scene (tv.html). That window
// has to be opened by hand ("Fullscreen Projector (Scene)" and pick the display) - this does it
// for us: it finds the TV (the external display, preferring one called SAMSUNG), looks for an
// OBS window already covering it, and if there is none asks OBS to open the projector there.
//
// Looking at windows uses macOS's window list through osascript (no permissions needed for
// sizes and positions), so nothing here depends on anything being visible on the TV.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const JXA = `
ObjC.import('Cocoa'); ObjC.import('CoreGraphics');
var out = { windows: [], screens: [] };
var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID)));
list.forEach(function (w) {   // front to back
  var b = w.kCGWindowBounds; out.windows.push({ owner: String(w.kCGWindowOwnerName), layer: w.kCGWindowLayer, name: String(w.kCGWindowName || ''), x: b.X, y: b.Y, w: b.Width, h: b.Height });
});
var scr = $.NSScreen.screens;
for (var i = 0; i < scr.count; i++) { var s = scr.objectAtIndex(i), f = s.frame; out.screens.push({ name: ObjC.unwrap(s.localizedName), x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height }); }
JSON.stringify(out);`;

function config() {
    try { return { scene: '', display: '', ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tv.json'), 'utf8')) }; } catch { return { scene: '', display: '' }; }
}

function look() {
    return new Promise((resolve) => {
        execFile('osascript', ['-l', 'JavaScript', '-e', JXA], { timeout: 8000 }, (err, stdout) => {
            if (err) return resolve(null);
            try { resolve(JSON.parse(String(stdout).trim())); } catch { resolve(null); }
        });
    });
}

// The display the TV is: config/tv.json {"display": "name"} if given, else one called SAMSUNG/TV,
// else the first external display. Screens come with the main display first.
function pickTv(screens, cfg) {
    const want = (cfg.display || '').toLowerCase();
    return (want && screens.find((s) => s.name.toLowerCase().includes(want)))
        || screens.find((s) => /samsung|\btv\b/i.test(s.name))
        || screens.slice(1)[0]
        || null;
}

// window list uses top-left origin on the main display; screen frames use bottom-left
function cgRect(screen, mainHeight) { return { x: screen.x, y: mainHeight - (screen.y + screen.h), w: screen.w, h: screen.h }; }
const near = (a, b) => Math.abs(a - b) <= 3;

async function status() {
    const seen = await look();
    if (!seen || !seen.screens.length) return { known: false, display: null, open: false };
    const tv = pickTv(seen.screens, config());
    if (!tv || seen.screens.length < 2) return { known: true, display: null, open: false };
    const r = cgRect(tv, seen.screens[0].h);
    const isObs = (w) => /obs/i.test(w.owner);
    const open = seen.windows.some((w) => isObs(w) && near(w.x, r.x) && near(w.y, r.y) && near(w.w, r.w) && near(w.h, r.h));
    return { known: true, display: tv.name, tvIsMain: tv === seen.screens[0], mainName: seen.screens[0].name, open, rect: r, intruders: intruders(seen.windows, r, isObs) };
}

// Anything that is drawn over the picture on the TV: a window or a notification banner that is NOT OBS and
// is in front of the full-screen OBS window (or, if that is not open, simply on the TV). Menu-bar-sized
// bits at the very top and desktop-level windows (the wallpaper) do not count.
function intruders(windows, r, isObs) {
    const cover = windows.findIndex((w) => isObs(w) && near(w.x, r.x) && near(w.y, r.y) && near(w.w, r.w) && near(w.h, r.h));
    const inFront = cover >= 0 ? windows.slice(0, cover) : windows;
    return inFront.filter((w) => {
        if (isObs(w) || w.layer < 0) return false;
        const ix = Math.min(w.x + w.w, r.x + r.w) - Math.max(w.x, r.x);
        const iy = Math.min(w.y + w.h, r.y + r.h) - Math.max(w.y, r.y);
        if (ix < 40 || iy < 40) return false;                        // not really on the TV
        if (w.y <= r.y + 2 && w.h <= 40 && w.layer >= 20) return false; // menu bar items
        return true;
    }).map((w) => ({ owner: w.owner, name: w.name, w: Math.round(w.w), h: Math.round(w.h) }));
}

// The scene to show: config/tv.json {"scene": "..."}, else the scene holding the tv.html browser source.
async function findScene(obs) {
    const cfg = config();
    if (cfg.scene) return cfg.scene;
    const scenes = (await obs.request('GetSceneList')).scenes || [];
    for (const sc of scenes) {
        const items = (await obs.request('GetSceneItemList', { sceneName: sc.sceneName })).sceneItems || [];
        for (const it of items) {
            if (it.inputKind !== 'browser_source') continue;
            try {
                const s = (await obs.request('GetInputSettings', { inputName: it.sourceName })).inputSettings || {};
                if (/\/tv\.html/.test(String(s.url || ''))) return sc.sceneName;
            } catch { /* next */ }
        }
    }
    return (scenes.find((s) => /scoreboard|tv/i.test(s.sceneName)) || {}).sceneName || '';
}

const recentOpens = [];
// Make sure the scene is full screen on the TV. { ok, state: 'already'|'opened'|'no-display'|'no-scene'|'failed', display, scene, error }
async function ensure(obs, { force = false } = {}) {
    const st = await status();
    if (!st.known) return { ok: false, state: 'failed', error: 'Could not look at the displays' };
    if (!st.display) return { ok: false, state: 'no-display' };
    if (st.open) return { ok: true, state: 'already', display: st.display };
    const now = Date.now();
    while (recentOpens.length && now - recentOpens[0] > 5 * 60000) recentOpens.shift();
    if (!force && recentOpens.length >= 2) return { ok: false, state: 'failed', display: st.display, error: 'Opened twice already in the last few minutes but it is still not showing' };
    const scene = await findScene(obs);
    if (!scene) return { ok: false, state: 'no-scene', display: st.display };
    const mons = (await obs.request('GetMonitorList')).monitors || [];
    const mon = mons.find((m) => m.monitorName.replace(/\(\d+\)$/, '') === st.display) || mons.find((m) => m.monitorPositionX === st.rect.x && m.monitorWidth === st.rect.w);
    if (!mon) return { ok: false, state: 'failed', display: st.display, scene, error: `OBS does not list a monitor called ${st.display}` };
    try { await obs.request('OpenSourceProjector', { sourceName: scene, monitorIndex: mon.monitorIndex }); }
    catch (e) { return { ok: false, state: 'failed', display: st.display, scene, error: e.message }; }
    recentOpens.push(now);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await status();
    logger.info('tv: opened the scoreboard scene full screen on the TV', { scene, display: st.display, nowShowing: after.open });
    return after.open ? { ok: true, state: 'opened', display: st.display, scene } : { ok: false, state: 'failed', display: st.display, scene, error: 'Asked OBS to open it, but no full-screen window appeared' };
}

module.exports = { status, ensure, findScene, intruders };
