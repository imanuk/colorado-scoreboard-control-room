# Contributing

Thanks for wanting to help. Swim clubs everywhere run on volunteers, so small fixes and write-ups of
how it went at *your* venue are as welcome as code.

## The licence, in one paragraph

This project is **AGPL-3.0-or-later**. You may use it, change it and run it for your club for free.
If you change it and either give it to someone or let other people use your version over a network,
you must make your complete source available to them under the same licence. The easy way to do that
is a **public fork of this repository** - and if your change would help others, please open a
**pull request** so everybody gets it. Keep the notices in `NOTICE.md` and the file headers.
(Using it privately, unchanged or changed, with nobody else involved, needs nothing from you.)

## Before you open a pull request

- One change per pull request, with a sentence on *why* (what went wrong at which venue?).
- Use invented swimmer data in tests, screenshots and docs. **Never** commit meet files, qualifying
  tables, club databases, keys or passwords. `git status` should show none of `heatsheets/`,
  `qualtimes/*.txt`, `config/*.json` (except `*.example.json`, `counties.json`).
- Run it: `node server/index.js -t` (test mode, no console needed) and check the page you changed.
  There is no automated test suite yet - if you add one (for `public/live/schedule-core.js` and
  `server/qualifying.js` first), that is a very welcome contribution.
- Match the style of the file you are editing; add the SPDX header to new files:
  `// SPDX-License-Identifier: AGPL-3.0-or-later`.

## Getting help

Open an issue. This is a hobby project run by a volunteer: replies can be slow and nothing is
guaranteed, but questions are welcome - they usually become documentation.
