// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Reads a public YouTube channel WITHOUT an API key, for the control room's
// "what viewers see" panel:
//   * the channel's recent videos from its public Atom feed
//     (youtube.com/feeds/videos.xml?channel_id=...), newest first;
//   * whether the channel is live right now, from the channel's /live page
//     (YouTube serves the live video's page there, flagged "isLiveNow").
// Exactly one video is ever marked live. This is scraping of public pages, not
// an official API, so it can stop working if YouTube changes them - callers
// get the last good answer (marked stale) or an error, and the panel's manual
// link box still works either way.

const logger = require('./logger.js');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
// cookies that skip the EU consent interstitial
const HEADERS = { 'User-Agent': UA, Cookie: 'CONSENT=YES+1; SOCS=CAI', 'Accept-Language': 'en-GB,en;q=0.9' };
const TTL_MS = 20000;

const idCache = new Map();   // handle -> channelId
let cache = null;            // {handle, at, data}
let inflight = null;

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function get(url) {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

function cleanHandle(handle) {
    const h = String(handle || '').trim().replace(/^https?:\/\/(www\.)?youtube\.com\//i, '').replace(/\/.*$/, '');
    return h.startsWith('@') ? h : `@${h}`;
}

async function resolveChannelId(handle) {
    if (idCache.has(handle)) return idCache.get(handle);
    const html = await get(`https://www.youtube.com/${handle}`);
    const m = html.match(/channel\/(UC[\w-]{22})/);
    if (!m) throw new Error(`could not find the channel id for ${handle}`);
    idCache.set(handle, m[1]);
    return m[1];
}

async function recentVideos(channelId) {
    const xml = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    return entries.slice(0, 12).map((e) => {
        const id = (e.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/) || [])[1];
        return {
            id,
            title: decode((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || 'Untitled'),
            published: (e.match(/<published>(.*?)<\/published>/) || [])[1] || '',
            thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
            live: false
        };
    }).filter((v) => v.id);
}

// The video currently live on the channel, or null.
async function liveNow(handle) {
    const html = await get(`https://www.youtube.com/${handle}/live`);
    if (!/"isLiveNow":true/.test(html)) return null;
    const id = (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/) || [])[1];
    if (!id) return null;
    const title = decode(((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || 'Live').replace(/\s*-\s*YouTube\s*$/, ''));
    return { id, title };
}

async function fetchChannel(handle) {
    const channelId = await resolveChannelId(handle);
    const [videos, live] = await Promise.all([recentVideos(channelId), liveNow(handle).catch((e) => { logger.warn('youtube: live check failed', { error: e.message }); return null; })]);
    if (live) {
        const found = videos.find((v) => v.id === live.id);
        if (found) found.live = true;
        else videos.unshift({ id: live.id, title: live.title, published: new Date().toISOString(), thumb: `https://i.ytimg.com/vi/${live.id}/mqdefault.jpg`, live: true }); // not in the feed yet
    }
    // the live one first, then newest first; at most one flagged live
    videos.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || String(b.published).localeCompare(String(a.published)));
    return { handle, channelId, live: live ? live.id : null, videos: videos.slice(0, 10) };
}

// Cached for TTL_MS so the control room can poll without hammering YouTube.
async function getChannel(handleIn, { force = false } = {}) {
    const handle = cleanHandle(handleIn);
    if (!force && cache && cache.handle === handle && Date.now() - cache.at < TTL_MS) return cache.data;
    if (inflight && inflight.handle === handle) return inflight.promise;
    const promise = (async () => {
        try {
            const data = await fetchChannel(handle);
            cache = { handle, at: Date.now(), data };
            return data;
        } catch (err) {
            logger.warn('youtube: channel read failed', { handle, error: err.message });
            if (cache && cache.handle === handle) return { ...cache.data, stale: true, error: err.message };
            return { handle, channelId: idCache.get(handle) || null, live: null, videos: [], error: err.message };
        } finally { inflight = null; }
    })();
    inflight = { handle, promise };
    return promise;
}

module.exports = { getChannel, cleanHandle };
