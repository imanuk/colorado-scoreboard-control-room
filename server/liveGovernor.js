// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Protects the YouTube stream (and the recording) from the local live view.
//
// While OBS is on air, any sign of strain makes the live view back off, one step
// at a time; it never makes the stream back off. Strain =
//   * OBS skipped frames while rendering or encoding (new ones since the last look),
//   * the stream output reporting congestion, or reconnecting,
//   * OBS using a lot of CPU.
// Steps (level):  0 normal | 1 at most 15 frames/s | 2 at most 10 frames/s and 720p |
//                 3 paused (no frames sent, new viewers refused)
// It steps down at most once every few seconds while strain continues, and back up one
// step after 30 quiet seconds. Nothing is limited while OBS is not on air (apart from
// the viewer cap).

const STEPS = [
    { fps: Infinity, maxSize: 1080, paused: false },
    { fps: 15, maxSize: 1080, paused: false },
    { fps: 10, maxSize: 720, paused: false },
    { fps: 0, maxSize: 720, paused: true }
];

class Governor {
    constructor({ recoverMs = 30000, escalateGapMs = 4000, cpuLimit = 75 } = {}) {
        this.recoverMs = recoverMs;
        this.escalateGapMs = escalateGapMs;
        this.cpuLimit = cpuLimit;
        this.level = 0;
        this.reason = '';
        this.lastStressAt = 0;
        this.lastChangeAt = 0;
    }

    // s: { now, onAir, renderSkippedDelta, outputSkippedDelta, congestion, reconnecting, cpu }
    evaluate(s) {
        const before = this.level;
        if (!s.onAir) {
            if (this.level) { this.level = 0; this.reason = 'OBS is not on air'; this.lastChangeAt = s.now; }
            return { level: this.level, changed: this.level !== before };
        }
        const why = [];
        if (s.renderSkippedDelta > 0) why.push(`OBS skipped ${s.renderSkippedDelta} frame(s) rendering`);
        if (s.outputSkippedDelta > 0) why.push(`OBS skipped ${s.outputSkippedDelta} frame(s) encoding/sending`);
        if (s.congestion >= 0.05) why.push(`stream congestion ${(s.congestion * 100).toFixed(0)}%`);
        if (s.reconnecting) why.push('stream is reconnecting');
        if (s.cpu > this.cpuLimit) why.push(`OBS CPU ${s.cpu.toFixed(0)}%`);
        if (why.length) {
            this.lastStressAt = s.now;
            if (this.level < 3 && s.now - this.lastChangeAt >= this.escalateGapMs) {
                this.level++;
                this.lastChangeAt = s.now;
                this.reason = why.join(', ');
            }
        } else if (this.level > 0 && s.now - this.lastStressAt >= this.recoverMs && s.now - this.lastChangeAt >= this.recoverMs) {
            this.level--;
            this.lastChangeAt = s.now;
            this.reason = this.level ? 'recovering' : '';
        }
        return { level: this.level, changed: this.level !== before };
    }

    caps() { return STEPS[this.level]; }
}

module.exports = { Governor, STEPS };
