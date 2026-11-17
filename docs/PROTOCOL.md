# The Gen7 serial protocol, as this project understands it

> **Unofficial.** This is what the community (see [NOTICE.md](../NOTICE.md) for the people who did the
> original work) and this project have worked out by watching what a console sends to a scoreboard.
> Colorado Time Systems has not published it for third parties, so anything here can be wrong or
> change with console firmware. Corrections are very welcome. Capture files for testing are in `samples/`.

## Two families

- **Older consoles / "Gen7 Legacy" (RS-232)**: a simple character stream at 9600 or 2400 baud, 8 bits,
  *even* parity, 1 stop bit. The upstream project (fabriziobertocci/coloradoScoreboard) handles this.
- **Gen7 / WA-2 "Gen7 Serial" (RS-485)**: a different, packetised stream. This is what
  `server/decoder.js` reads (start the server with `-7`, which `npm start` does).

## Gen7 RS-485 stream

Physical: RS-485, read-only (we only listen). See [HARDWARE.md](HARDWARE.md) for the cable.

Framing (as implemented in `decoder.js`):

1. A packet starts with a byte that has the top bit (0x80) set; the next byte is the length.
2. The payload bytes are scrambled with a rotating 32-entry remapping table; the decoder keeps one
   mapper state per stream and "remaps" each byte as it arrives.
3. A checksum follows the payload; packets that fail it are dropped.
4. The remapped payload is fed, byte by byte, into a small state machine that either updates a
   **scoreboard module** or handles a **command**.

### Modules and digits

The console drives a virtual scoreboard made of up to 31 *modules*, each with a handful of digits
(7-segment values 0-9, blank, plus a decimal point flag). A few that matter here:

| Module | Meaning (as observed) |
|---|---|
| lane modules | the time / place / lane number for each lane |
| race clock | the running time of the race (`MM:SS.hh`) |
| 12 | event number and heat number |
| 22 | the console's own clock time |

`decoder.js` exposes `GetDigits(pool, module, from, to, ...)`, `GetTime(...)` and friends; `server/index.js`
reads them every update tick and decides what the display should show.

### Commands (names and start lists)

Besides digits, the console sends commands. The ones used here (decoded in `decoder.js`, shown by name on
the diagnostics page):

- **Meet title** and **event title** strings.
- **Start list / swimmer packets**: lane, last name, first name, team for a heat. They arrive just
  *before* the console flips its event/heat display, so the decoder stages them and commits when
  the heat number actually changes (otherwise the old heat would briefly show the new names).
- **"Lookahead" packets**: mostly the current heat re-broadcast on a ~10 second idle loop. Only a
  lookahead naming a *different* event/heat is treated as a next-race announcement.
- Session-2 style events may never send their own title packet; the scoreboard then falls back to the
  meet files (see [MEET-FILES.md](MEET-FILES.md)).

### Finding new datapoints

Open `http://localhost:8080/diagnostics.html`:

- the **Packet log** shows decoded packets by name, with "show raw bytes" for the unfiltered hex;
- the **channel table** shows every populated module's current digits, so you can see which bytes
  change when something happens on the console;
- "Save log" downloads the log as text. Please share interesting captures (with any names removed).

## Other interfaces the console has (not used here)

The Gen7 also has a bidirectional USB "meet management" port and a UDP scoreboard-names interface,
and a network link used by Colorado's own Gen7 software. None of these are documented for third
parties, and this project does not use them. See [HARDWARE.md](HARDWARE.md#the-network-link-and-why-it-is-not-used).
