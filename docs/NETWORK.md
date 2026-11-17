# Other computers on the network

The server listens on every network interface (port 8080, and port 80 too if the OS allows it), so any
computer or phone on the same network can open the control room and the other pages. **There is no password and
no encryption: this is for a private network. Never expose ports 8080 or 80 to the internet.**

## What other devices can do

They can **watch everything**. Anything that changes something - Go live / Stop, choosing the meet, re-running checks
on demand beyond a rate limit, saving links, the update rate, the live heat sheet settings - only works from the
scoreboard computer itself, and the control room shows **VIEW ONLY** elsewhere. The *Share...* button lists
the addresses to type (also `/api/network`).

### Letting a phone press Go live (off by default)

On a trusted closed network you can allow it, ideally with a PIN. In `config/network.json`:

```json
{ "allowRemoteControl": true, "remoteControlPin": "1234" }
```

The confirmation dialogs still apply and the session log records "remote control room (address)". Choosing the
meet and saving settings stay local-only either way.

## Friendly name

The server advertises `scoreboard.local` with macOS's `dns-sd -P` (`server/friendlyName.js`), pointing at the
computer's main connection and re-pointing when that changes (Wi-Fi at home, ethernet at the pool). Nothing about the
computer's own name or settings is changed. macOS, iOS and recent Windows resolve `.local` names; if yours does
not, type the IP address. Change the name and extra ports in `config/network.json`.

## Local live view

`/watch.html` (press **F** for full screen) and `/live.mjpg?size=1080&fps=25` show what OBS is sending, a
fraction of a second behind - not the YouTube feed, and **video only, no sound**. It is a Motion-JPEG stream built
from OBS's own screenshots (`server/liveView.js`). One shared capture per size/rate, which stops when the last
viewer leaves. Presets: Smooth (1080p25), Balanced (1080p15), Light (720p10).

## Protecting the stream

A full-quality 1080p25 live view is about 60 Mbit/s per viewer - far more than a weak Wi-Fi link carries, and it
will starve the stream's own upload. So:

- **Network budget.** All viewers together share **12 Mbit/s on Wi-Fi and 60 Mbit/s on ethernet**
  (`liveViewMaxMbps` in `config/network.json` overrides it). Over budget, the picture gets fewer frames a second,
  never more data.
- **At most 3 viewers** (`maxLiveViewers`). A 4th is told it is full and gets in when someone leaves.
- **The stream comes first** (`server/liveGovernor.js`). While OBS is streaming or recording, any new skipped
  or dropped frames, stream congestion, reconnecting, or OBS CPU over 75% makes the live view back off one step at a
  time: 25 fps -> 15 fps -> 10 fps at 720p -> paused (the control room's own preview pauses at the last two steps).
  It steps back up one level after 30 quiet seconds. Nothing is limited when not on air.
- **Phones and other devices see live check results.** The server refreshes the checks itself while any control
  room is open: a full run each minute when idle; while on air only the cheap checks every 20 s and a full run every
  5 minutes.
