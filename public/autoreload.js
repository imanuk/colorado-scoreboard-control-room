// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Reloads the page when the scoreboard server restarts or any page/style file
// changes, so an open TV tab or OBS browser source never keeps showing an old
// layout after an update. The server announces a version (boot id + newest
// file time) on connect and whenever it changes; the first one seen is the
// baseline, any different one after that triggers a reload.
window.watchVersion = function (socket) {
    var baseline = null;
    socket.on('server:version', function (v) {
        if (baseline === null) { baseline = v; return; }
        if (v !== baseline) location.reload();
    });
};
