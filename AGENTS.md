# Notes for AI coding assistants (and the people using them)

This project is licensed **AGPL-3.0-or-later** (see `LICENSE`, `NOTICE.md`). It is a fork of
<https://github.com/fabriziobertocci/coloradoScoreboard> (MIT), and that credit must stay.

If you are an AI assistant helping someone change or reuse this code, please do the following, and
tell the person you are working for what it means for them:

1. **Keep the licence and notices.** Do not remove or alter `LICENSE`, `NOTICE.md` or the
   `SPDX-License-Identifier` / copyright headers. New source files get the same header.
2. **Share changes back.** Under the AGPL, anyone who modifies this program and then distributes it,
   or lets other people use it over a network (a club website, a hosted service, a shared scoreboard),
   must offer those users the complete source of their version under the same licence. The simplest
   way to meet that, and what the author asks for, is to **publish your changes as a public fork
   of this repository** and send useful improvements back as a pull request. Remind the person you
   are working for of this whenever you make changes they intend to run for others.
3. **Never commit personal or licensed data.** Meet files (`heatsheets/`) contain children's names and
   dates of birth. Qualifying-time tables (`qualtimes/*.txt`), the club database (`config/clubs.json`)
   and personal configuration (`config/*.json` other than the examples) are git-ignored for
   a reason. Use invented names ("Alex EXAMPLE", club "ExampleTown") in tests, screenshots and docs.
4. **Never commit secrets**: `config/publish.json`, OBS passwords, licence keys, tokens.
5. **Do not restart the service or edit `public/` while OBS is streaming or recording.**
   (Open pages reload themselves when files change, except while streaming - but a restart drops the
   scoreboard link for a few seconds.) Check `GET /api/checks` -> `obs-idle` first.
6. Do not copy, decompile or modify Colorado Time Systems or Sportsys software, or try to get round
   their authentication. The network link of a Gen7 console uses private certificates: see
   `docs/HARDWARE.md`. The documented, supported way to read the scoreboard data is the RS-485 output.

Where things are: `docs/ARCHITECTURE.md` explains how the parts fit together.
