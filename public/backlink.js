// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// "<- Control room" pill, top-left, for the tool pages (never the overlay
// pages that OBS or the TV display).
(function () {
    var style = document.createElement('style');
    style.textContent = '.backlink{position:fixed;top:10px;left:10px;z-index:50;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:#1c2127;border:1px solid #3a424a;color:#e8eef2;font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.35)}.backlink:hover{border-color:#3b82f6}';
    document.head.appendChild(style);
    var a = document.createElement('a');
    a.className = 'backlink';
    a.href = '/control.html';
    a.textContent = '\u2190 Control room';
    document.body.insertBefore(a, document.body.firstChild);
    // keep the page's own content clear of the pill
    var pad = parseInt(getComputedStyle(document.body).paddingTop, 10) || 0;
    if (pad < 52) document.body.style.paddingTop = '52px';
})();
