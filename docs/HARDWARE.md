# Hardware and cabling

## What you need

| Part | Notes |
|---|---|
| A Colorado Time Systems **Gen7 / WA-2** console with the **RS-485 scoreboard output** | Older RS-232-only consoles are handled by the upstream project |
| A **USB to RS-485** adapter and a cable to the console's scoreboard socket | see wiring below |
| A computer to run it | The scoreboard itself runs anywhere Node.js runs. The stream-day automation (launchd, GoPro webcam, OBS checks, `scoreboard.local`) is written for **macOS**; it has only been tested on an Apple-silicon Mac |
| For streaming: **OBS Studio** (32+), a **GoPro** (HERO13 tested) or any camera OBS can use, a **USB sound card/mixer** for sound | all optional |
| A **TV** on HDMI | optional second screen |
| Ethernet to the venue network | strongly recommended for streaming - see [STREAM-DAY.md](STREAM-DAY.md) |

## RS-485 wiring (Gen7 serial)

Credit: this wiring and parts list is from the upstream project
(fabriziobertocci/coloradoScoreboard).

Parts used there:

- CONXALL / SWITCHCRAFT **3280-4PG-315** male plug (mates with the console's RS-485 socket)
- FTDI **USB-RS485-WE-1800-BT** USB-to-RS-485 converter

The converter's wires go to the plug's pins like this; leave the other wires trimmed and unused:

```
FTDI wire         Plug pin
BLACK  (GND)   -> 4
YELLOW (Data-) -> 3
ORANGE (Data+) -> 2
```

Pin positions on the console's **female** socket, seen from the back of the console (wire the *male* plug
to the matching pins):

```
        TOP
     .---v---.
    /         \
   |  o 1  o 4 |
   |           |
   |  o 2  o 3 |
    \         /
     '-------'
```

This project has also been used with a CH340-based USB-RS485 adapter (chip vendor `1a86`). The program
recognises FTDI, CH340, Silicon Labs and Prolific adapters automatically; on macOS you may need the
vendor's driver for CH340 chips. Whatever adapter you use, it only has to *receive*.

Tip: before a meet, plug it in and open `http://localhost:8080/diagnostics.html`. When the console is
switched on you should see packets arriving.

## The network link, and why it is not used

Newer Gen7 software can talk to the console over the network. We looked at this on our own equipment
(read-only: the console's advertised service, and the traffic the Colorado software and console exchange):

- The console announces itself with mDNS/Bonjour as service `_ctsGen7Swim._tcp` ("Gen7 Swimming Server") on
  TCP **7105**, and is an embedded ARM Linux device.
- The data channel is a single TLS 1.2 connection on port 7105 (it appears to be a SignalR hub) with
  **mutual authentication**: the console and the Colorado software authenticate each other using
  certificates issued by Colorado's own private certificate authority. Nothing is readable on the wire.

So a third-party program cannot use it without credentials from Colorado, and **we do not try to get round
that**. The supported, documented way to read the scoreboard data is the RS-485 output this project uses. If
Colorado publishes integration details or offers credentials for third-party software, this page will be
updated - and if you have a contact there, a documented interface would help every club.

## Don't point it at anything you shouldn't

The program only listens to the RS-485 output; it never sends anything to the console. Keep it that
way when you modify it - a timing system is not the place for experiments in the middle of a meet.
