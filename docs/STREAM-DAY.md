# Stream day: OBS, GoPro, YouTube and the control room

*macOS only. Everything here is optional - the scoreboard works without OBS or a camera.*

The stream path is: **GoPro (USB webcam) + scoreboard overlay page -> OBS -> Restream -> YouTube**, with a
second OBS output to a TV over HDMI. The control room is the one page that gets you there and keeps an eye on it.

## One-time setup

1. `npm install`, then `./scripts/install.sh` (puts launcher icons on the Desktop).
2. In OBS, make a scene (default name **Live Stream**) with a **GoPro camera source** (default name
   **Camera (GoPro)**) and two **browser sources** on top of it: `http://localhost:8080/scores.html` (the lanes panel)
   and `http://localhost:8080/timer.html` (the slim event/heat bar). For the TV, a second scene with a browser
   source for `http://localhost:8080/tv.html`. Output 1920x1080 at 25 fps, and your Restream stream key. The names
   can be changed in `config/obs.json`.
3. Install the GoPro Webcam app and enable USB webcam mode.
4. A USB sound card/mixer as the *only* audio source: add it as its own **Audio Input Capture**.
5. Put the Mac's firewall on, and plug in ethernet at the venue.

## The day

Double-click **Start Stream Day.command**. It:

1. starts the scoreboard service (under `launchd`, so it restarts itself if it ever crashes),
2. asks which meet to use ([MEET-FILES.md](MEET-FILES.md)),
3. starts the GoPro Webcam app, waits for the camera, points OBS at it, sets the camera's anti-flicker to
   PAL/50 Hz over its USB API, and switches on OBS remote control (localhost only),
4. opens OBS, then opens `http://localhost:8080/control.html`.

It **never starts the stream or a recording** - that is a separate, confirmed step in the control room.

## The control room

`control.html` shows: the scoreboard (the TV page), a live preview of what OBS is sending, OBS health (fps, CPU,
dropped frames, disk), a **Go live / Stop** button with a two-step confirmation, a recording chapter log, and
**green-tick checks**:

| Group | Checks |
|---|---|
| Computer | power, internet over ethernet (not Wi-Fi), Restream reachable, HDMI display / TV |
| Scoreboard | link to the console, meet file loaded, console matches the meet file |
| Camera | GoPro connected, Webcam app running, PAL (50 Hz) set |
| OBS | connected, 1080p25, camera source on the current camera id, picture arriving (not black or frozen), audio muted correctly, sound card present, disk space, not already streaming |

*Re-run checks* repeats them; `/api/checks` has the last results as JSON.

Things it handles for you:

- **GoPro replugged mid-event.** macOS gives the GoPro Webcam a new random camera id on each connect, and OBS only
  finds cameras by id, so the control room re-points OBS at the current id (checked every 10 s).
- **Audio.** Camera microphones and the Mac's built-in mic are always kept muted in OBS (re-applied on connect,
  every 10 s and just before Go live). The sound card is checked, and switched on at Go live.
- **TV.** Makes sure the TV shows OBS's full-screen projector of the scoreboard scene.
- **Not black, not frozen.** The picture check samples frames from OBS and looks at them.

OBS remote control (obs-websocket, port 4455) can only be switched on while OBS is closed, which the
start icon does. It listens on all interfaces but is password-protected: keep the firewall on at venues.

## Title, description and chapters

`stream-info.html` ("Title & chapters") suggests a **stream title** (meet name + session), a **description**
(title, date, an intro you can edit, then the chapters) and a **chapter list**, each with a Copy button. Chapters
come from the log of the stream start and every heat change (`logs/stream-sessions.jsonl`), as timestamps
counted from pressing Go live; repeats are merged and anything on screen for under 10 s is dropped (YouTube's
minimum chapter length). You can pick an earlier stream or nudge the timestamps.

The "What viewers see" panel lists your channel's recent videos and marks the live one, read from YouTube's
public feed (no API key). Set `channelHandle` (e.g. `@yourclub`) in `config/stream.json` or in the control
room. It is unofficial scraping: if YouTube changes things the list says so and pasting a link still works.

## Protecting the stream

Everything optional gives way before the stream does - see [NETWORK.md](NETWORK.md#protecting-the-stream)
for the live view's network budget and back-off.

## Tips learned the hard way

- Use **ethernet**, not Wi-Fi, for the Mac. The checks warn about it.
- Do not restart the service or edit `public/` while streaming. The pages never reload themselves while
  OBS is streaming or recording, but a restart drops the scoreboard link for a few seconds.
- Set the GoPro to the resolution/field of view you want in the Webcam app's menu-bar icon; this project holds
  only the anti-flicker setting.
