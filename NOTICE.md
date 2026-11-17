# Notices

## This project

Copyright (C) 2026 imanuk and contributors.
Licensed under the **GNU Affero General Public License, version 3 or (at your option) any later
version** (AGPL-3.0-or-later). The full text is in [LICENSE](LICENSE).

## Where it came from

This project is a fork of, and builds on, **coloradoScoreboard** by Fabrizio Bertocci:
<https://github.com/fabriziobertocci/coloradoScoreboard> - a small Node.js program that reads the
serial data a Colorado Time Systems console sends to its scoreboard and turns it into a web page.
The serial protocol decoder (`server/decoder.js`, from `src/ctsScoreboardasync.js`), the first
version of the server (`server/index.js`, from `src/coloradoScoreboard.js`) and the original web
assets (`public/overpassMono.css`, `public/OverpassMonoFont.ttf`, `public/pool.jpg`) come from that
project, which is released under the MIT licence:

```
MIT License

Copyright (c) 2018 

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

(The upstream licence file leaves the name after the year blank; the work is by Fabrizio Bertocci
and the contributors to that repository.) The upstream author in turn credits
[CTS_Scoreboard](https://github.com/STU940652/CTS_Scoreboard),
[vCTS](https://github.com/hwbrill/vsCTS) and
[Marco's Corner](https://marcoscorner.walther-family.org/2015/07/colorado-timing-console-scoreboard-protocol/)
for help with the protocol. Thank you to all of them.

MIT-licensed code can be included in an AGPL project; the MIT notice above stays with the parts
that came from upstream, and everything added or changed here is AGPL-3.0-or-later.

## Other things used

- **Overpass Mono** font (`public/OverpassMonoFont.ttf`): SIL Open Font License 1.1.
- **npm packages** (express, serialport, socket.io, sprintf-js): each under its own licence, see `package-lock.json`.
- **OBS Studio** and **obs-websocket**, **GoPro Open API**, **Restream**, **YouTube**, **Google Drive**:
  used only through their public interfaces; no code from them is included.

## Not affiliated

This is an independent, unofficial project. It is **not** made, endorsed or supported by Colorado
Time Systems, Swim England, Sportsys (Meet Manager), OBS, GoPro, Restream, Google or YouTube. Those
names and logos belong to their owners and are used only to say what this software works with.
The serial protocol was worked out by the community from what a console sends to a scoreboard
(see the credits above); no Colorado software was copied, decompiled or modified.

## Data

No swimmer data, club database, or qualifying-time tables are included. Meet files (names,
entries) belong to the clubs that created them and may contain personal data about children:
keep them out of version control (the `heatsheets/` folder is git-ignored). Qualifying standards
belong to the counties and regions that publish them; the import scripts fetch them for your own
use, and some counties ask that they are not re-published - do not commit them.
