<?php
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Receives live heat-sheet updates from the scoreboard Mac and stores them as two small JSON
// files that the phones poll:  data/meet.json (the draw)  and  data/state.json (where the meet is).
//
//   POST  update.php            JSON body, header  X-Live-Key: <the key>
//   action "ping"   - check the key and that the data folder can be written
//   action "state"  - the console position + settings         (sent often)
//   action "meet"   - the whole draw                          (sent when the draw changes)
//   action "wipe"   - delete everything that was published
//
// The key itself is never stored here - only its SHA-256 (update-config.php, made by the build
// script). Only whitelisted fields are kept, so nothing else can end up on the public site.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

// a crash should say why, not return an empty page
register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true) && !headers_sent()) {
        http_response_code(500);
        echo json_encode(['ok' => false, 'error' => 'php: ' . $e['message']]);
    }
});

function out(int $code, array $body): void {
    http_response_code($code);
    echo json_encode($body);
    exit;
}

function now_ms(): int { return (int) round(microtime(true) * 1000); }

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') out(405, ['ok' => false, 'error' => 'POST only']);

$configFile = __DIR__ . '/update-config.php';
if (!is_file($configFile)) out(500, ['ok' => false, 'error' => 'update-config.php is missing - upload it from the remote-site folder']);
require $configFile; // defines LIVE_KEY_SHA256

// ---- authentication -------------------------------------------------------------------------
$given = $_SERVER['HTTP_X_LIVE_KEY'] ?? '';
if (!is_string($given) || $given === '' || !hash_equals(LIVE_KEY_SHA256, hash('sha256', $given))) {
    sleep(1); // makes guessing pointless
    out(403, ['ok' => false, 'error' => 'wrong key']);
}

// ---- body -----------------------------------------------------------------------------------
$raw = file_get_contents('php://input', false, null, 0, 6 * 1024 * 1024 + 1);
if ($raw === false || strlen($raw) > 6 * 1024 * 1024) out(413, ['ok' => false, 'error' => 'body too large']);
$in = json_decode($raw, true);
if (!is_array($in)) out(400, ['ok' => false, 'error' => 'body is not JSON']);
$action = $in['action'] ?? '';

// ---- data folder ----------------------------------------------------------------------------
$dir = __DIR__ . '/data';
if (!is_dir($dir) && !@mkdir($dir, 0755, true)) out(500, ['ok' => false, 'error' => 'cannot create the data folder - check permissions']);
$guard = $dir . '/.htaccess';
if (!is_file($guard)) {
    @file_put_contents($guard, "<IfModule mod_headers.c>\nHeader set Cache-Control \"no-store, max-age=0\"\nHeader set X-Robots-Tag \"noindex, nofollow\"\n</IfModule>\n");
    @file_put_contents($dir . '/index.html', '');
}

function write_json(string $file, array $data): bool {
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX) === false) return false;
    return rename($tmp, $file);
}
function read_json(string $file): ?array {
    $t = @file_get_contents($file);
    $d = $t === false ? null : json_decode($t, true);
    return is_array($d) ? $d : null;
}

function int_or_null($v): ?int { return (is_int($v) || (is_float($v) && is_finite($v))) ? (int) $v : null; }
// cut to $max characters (mbstring is not installed on every host, so fall back gracefully)
function str($v, int $max): string {
    if (!is_string($v)) return '';
    if (function_exists('mb_substr')) return mb_substr($v, 0, $max);
    return preg_match('//u', $v) ? implode('', array_slice(preg_split('//u', $v, -1, PREG_SPLIT_NO_EMPTY) ?: [], 0, $max)) : substr($v, 0, $max);
}

$meetFile = $dir . '/meet.json';
$stateFile = $dir . '/state.json';
$resultsFile = $dir . '/results.json';
$received = now_ms();

switch ($action) {
    case 'ping':
        $meet = read_json($meetFile);
        out(200, ['ok' => true, 'receivedAtMs' => $received, 'php' => PHP_VERSION, 'writable' => is_writable($dir), 'meetVersion' => $meet['version'] ?? null]);

    case 'wipe':
        // leave small "empty" markers rather than deleting, so phones can tell "wiped" from "broken"
        foreach ([$meetFile, $stateFile, $resultsFile] as $f) { write_json($f, ['empty' => true, 'receivedAtMs' => $received]); }
        out(200, ['ok' => true, 'receivedAtMs' => $received]);

    case 'meet':
        $heatsIn = $in['heats'] ?? null;
        if (!is_array($heatsIn) || count($heatsIn) > 3000) out(400, ['ok' => false, 'error' => 'bad heats']);
        $heats = [];
        foreach ($heatsIn as $i => $h) {
            if (!is_array($h)) continue;
            $lanes = [];
            foreach (($h['lanes'] ?? []) as $l) {
                if (!is_array($l) || count($lanes) >= 16) continue;
                $lanes[] = [
                    'lane' => int_or_null($l['lane'] ?? null) ?? 0,
                    'name' => str($l['name'] ?? '', 80),
                    'club' => str($l['club'] ?? '', 80),
                    'code' => str($l['code'] ?? '', 12),
                    'entry' => str($l['entry'] ?? '', 12),
                ];
            }
            $heats[] = [
                'i' => count($heats),
                'event' => int_or_null($h['event'] ?? null) ?? 0,
                'heat' => int_or_null($h['heat'] ?? null) ?? 0,
                'title' => str($h['title'] ?? '', 120),
                'back' => !empty($h['back']),
                'durationSec' => int_or_null($h['durationSec'] ?? null) ?? 60,
                'heatsInEvent' => int_or_null($h['heatsInEvent'] ?? null) ?? 1,
                'lanes' => $lanes,
            ];
        }
        $doc = ['meetName' => str($in['meetName'] ?? '', 120), 'version' => str($in['version'] ?? '', 40), 'heats' => $heats, 'receivedAtMs' => $received];
        if (!write_json($meetFile, $doc)) out(500, ['ok' => false, 'error' => 'could not write meet.json']);
        out(200, ['ok' => true, 'receivedAtMs' => $received, 'meetVersion' => $doc['version'], 'heats' => count($heats)]);

    case 'results':
        // scoreboard times: { "event:heat": { "lane": [time, place] } } - validated strictly
        $heatsIn = $in['heats'] ?? [];
        if (!is_array($heatsIn) || count($heatsIn) > 4000) out(400, ['ok' => false, 'error' => 'bad results']);
        $clean = [];
        foreach ($heatsIn as $key => $lanesIn) {
            if (!is_string($key) || !preg_match('/^\d{1,5}:\d{1,4}$/', $key) || !is_array($lanesIn)) continue;
            foreach ($lanesIn as $lane => $tp) {
                if (!is_array($tp) || !preg_match('/^\d{1,2}$/', (string) $lane)) continue;
                $t = (string) ($tp[0] ?? ''); $p = (string) ($tp[1] ?? '');
                if (!preg_match('/^(\d{1,3}:)?\d{1,2}\.\d{2}$/', $t) || !preg_match('/^\d{0,3}$/', $p)) continue;
                $clean[$key][(string) (int) $lane] = [$t, $p];
            }
        }
        $doc = ['seq' => int_or_null($in['seq'] ?? null) ?? 0, 'heats' => (object) $clean, 'receivedAtMs' => $received];
        if (!write_json($resultsFile, $doc)) out(500, ['ok' => false, 'error' => 'could not write results.json']);
        out(200, ['ok' => true, 'receivedAtMs' => $received, 'resultsSeq' => $doc['seq']]);

    case 'state':
        $s = is_array($in['state'] ?? null) ? $in['state'] : [];
        $phase = in_array($s['phase'] ?? '', ['waiting', 'racing', 'finished'], true) ? $s['phase'] : 'waiting';
        $state = [
            'currentIndex' => int_or_null($s['currentIndex'] ?? null) ?? -1,
            'phase' => $phase,
            'heatLoadedMs' => int_or_null($s['heatLoadedMs'] ?? null),
            'raceStartMs' => int_or_null($s['raceStartMs'] ?? null),
            'finishedMs' => int_or_null($s['finishedMs'] ?? null),
            'seq' => int_or_null($s['seq'] ?? null) ?? 0,
        ];
        $settings = [];
        $numeric = ['gapSeconds', 'backstrokeGapSeconds', 'reportLeadMinutes', 'heatsAhead', 'defaultHeatSeconds', 'minHeatsReady', 'fillLeadMinutes',
                    'pollMarshalSeconds', 'pollTeamSeconds', 'pollAthleteSeconds', 'pollMeetSeconds'];
        foreach ($numeric as $k) { $v = int_or_null($in['settings'][$k] ?? null); if ($v !== null) $settings[$k] = $v; }
        $mst = $in['settings']['meetStartTime'] ?? '';
        $settings['meetStartTime'] = (is_string($mst) && preg_match('/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/', $mst)) ? $mst : '';
        $settings['showTimes'] = !array_key_exists('showTimes', $in['settings'] ?? []) || !empty($in['settings']['showTimes']);
        $settings['marshalAdvanceOn'] = (($in['settings']['marshalAdvanceOn'] ?? '') === 'finish') ? 'finish' : 'start';
        $meet = read_json($meetFile);
        $res = read_json($resultsFile);
        $doc = [
            'state' => $state,
            'settings' => $settings,
            'drawVersion' => str($in['drawVersion'] ?? '', 40),
            'resultsSeq' => int_or_null($in['resultsSeq'] ?? null),
            'macNowMs' => int_or_null($in['macNowMs'] ?? null) ?? $received,   // the Mac's clock when it sent this ...
            'receivedAtMs' => $received,                                         // ... and this server's clock when it arrived
        ];
        if (!write_json($stateFile, $doc)) out(500, ['ok' => false, 'error' => 'could not write state.json']);
        out(200, ['ok' => true, 'receivedAtMs' => $received, 'meetVersion' => $meet['version'] ?? null, 'resultsSeq' => $res['seq'] ?? null]);

    default:
        out(400, ['ok' => false, 'error' => 'unknown action']);
}
