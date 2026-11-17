# Meet files

The scoreboard can show names, event titles, entry times (for PB badges) and "next race" from the files
your meet software writes, so it does not depend on the console sending them. It understands two files:

| File | Where it comes from | What it has |
|---|---|---|
| `*_SCB.TXT` | Meet Manager "scoreboard" report (tab-delimited), usually in the meet's `reports/` folder | events in swimming order, heats, lanes, names, clubs, entry times |
| `DLinkHSL/<Session>/E###.scb` | Meet Manager's scoreboard link files, one per event | event title, name + club per lane (**no times**) |

`*_SCB.TXT` wins; `.scb` fills any event, heat or lane the text file does not have. A lane known only
from a `.scb` never gets a PB badge (there is no entry time, so "unknown", not "no previous time").

**The running order follows the order of events in the `*_SCB.TXT`**, not the event numbers - if you swap
events 501 and 502 in Meet Manager and save the report again, the scoreboard, live heat sheets and marshalling follow.

> These files contain **children's names and dates of birth**. They stay on your computer: the
> `heatsheets/` folder is git-ignored and never served over the web.

## Option 1: drop files in a folder

Put the files in `heatsheets/` (the `.scb` files in `heatsheets/DLinkHSL/`). New, changed or removed files
are picked up within a second or two. Keep only the current meet's files there: files are merged, so an
old meet with the same event numbers can show the wrong names.

## Option 2: a shared Google Drive folder (recommended)

The person running Meet Manager saves each meet into a shared Drive folder; the scoreboard computer
fetches the meet you pick. No Google account or software is needed on the scoreboard computer: the
folder is shared as "anyone with the link" and read through Drive's public folder view.

Layout:

```
Meets/                       <- the folder whose id you put in config/drive.json
  MyMeet26/                  <- one folder per meet
    reports/
      Session1_SCB.TXT
    DLinkHSL/
      Session 01/
        E101.scb ...
  Past/                      <- ignored (see ignoreFolders)
```

Set it up:

1. Share the folder: *Anyone with the link can view*.
2. Copy `config/drive.example.json` to `config/drive.json` and put the folder's id (the last part of its
   link) in `rootFolderId`.
3. Open `http://localhost:8080/meet.html` (or use the launcher's meet picker). Meets are listed newest
   first; pick one. The scoreboard downloads its files and re-checks every 2 minutes (a file is only
   rewritten if its content changed). The choice is remembered in `config/selected-meet.json`.

Good to know:

- Only files fetched from Drive are replaced or removed (tracked in `heatsheets/.drive-synced.json`);
  files you add by hand are left alone.
- No internet? The last downloaded files stay in use.
- A meet appears as selectable once it has a `*_SCB.TXT` in `reports/`.
- Google only reports modified times to the day, so content is compared instead.

## The data check

`meet.html` (and `/api/meets/check`) show a completeness check: events, swimmers, how many have an entry
time, and any heat, lane or name that is missing from or disagrees between the two sources. Run it before
the meet. The control room also has a check that the **console is on an event that is in the meet file**
(if not, it tells you where the meet really starts).
