# Running it, logs and troubleshooting

## Starting and stopping (macOS)

`./scripts/install.sh` once, then double-click **Start Scoreboard.command** (service + browser) or
**Start Stream Day.command** (everything). **Stop Scoreboard.command** stops it and takes it out of supervision. It does not
start at login. While running, `launchd` restarts it within seconds of any crash.

By hand (any OS):

```bash
npm install
node server/index.js -7 -u 50     # Gen7 serial mode, auto-detect the USB adapter
node server/index.js -t           # test mode: invented race data, no console needed
```

| Flag | Meaning |
|---|---|
| `-7` | Gen7 / WA-2 serial (RS-485) mode |
| `-d <path>` | use exactly this serial device instead of auto-detecting |
| `-p <port>` | HTTP port (default 8080) |
| `-u <ms>` | update rate (default 500 by flag, 50 as installed) |
| `-v` | verbose event/heat logging |
| `-t` | test mode |

## Serial auto-detect

With no `-d`, every (re)connect attempt scans the serial ports, ignores Bluetooth/debug entries, and picks (1) the
port that last worked (`logs/last-good-port.json`) if still present, (2) a port from a known USB-serial chip vendor
(CH340, FTDI, Silicon Labs, Prolific), (3) the first remaining candidate. `-d` pins to one path.

## Update rate

Default **50 ms (20 Hz)**. The console reports to hundredths of a second, and browsers redraw at ~60 Hz, so
faster than that only repeats values. Try another rate live with the slider in `diagnostics.html` (20-500 ms); change
the default with `-u` in `scripts/install.sh` or `package.json`.

## Logs

- `logs/app.log` - structured, timestamped; rotates at 5 MB, keeps 5. Server start/stop, which serial port and why, every
  serial connect/disconnect/retry with its cause, decoder errors, uncaught exceptions before a restart, client
  counts, meet syncs, live-view events. *The first place to look.* The diagnostics page has a "Recent issues" tail.
- `logs/launchd.*.log` - raw stdout/stderr that launchd captures (useful if the process fails before the logger starts).
- `logs/stream-sessions.jsonl` - stream start/stop and every heat change (feeds the chapters).

## Troubleshooting

| Symptom | Look at |
|---|---|
| "No data from the timing console" | adapter plugged in? console on? cable pins ([HARDWARE.md](HARDWARE.md)); `diagnostics.html` |
| Names or titles missing | is the meet loaded and does the console event exist in it? (control-room check, `meet.html` data check) |
| Phone cannot open the control room | same network? try the IP instead of `scoreboard.local`; Wi-Fi saturated? use ethernet ([NETWORK.md](NETWORK.md)) |
| Live view choppy or paused | the network budget or governor is protecting the stream: the page says why |
| GoPro picture black | the camera id changed: re-run checks; replug; the control room re-points OBS |
| Pages not updating | reload; the server may have restarted (they reconnect themselves) |

The launchd service label defaults to `com.otters.coloradoscoreboard` (the original club's reverse-domain name); run `SCOREBOARD_LABEL=uk.org.myclub.scoreboard ./scripts/install.sh` to use your own.
