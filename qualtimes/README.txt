County / Regional / National qualifying times (CT / RT / NT badges)
====================================================================

QUICK START - official Swim England North West times
-----------------------------------------------------
    node scripts/import-senw-times.js SW26 --level RT
    node scripts/import-senw-times.js LC27 --level CT --county Lancashire
Each reads https://events.swimnorthwest.org/entry-system/MeetQTs.php?MeetCode=<code>
(meet codes are on https://events.swimnorthwest.org/ - the "QTs" links), writes
qualtimes/<code>-<course>.txt and registers it in config/qualifying.json. The page's
own course, "age at" date, qualifying window and QT rule ("Faster than" = strictly
faster, equal does not count) are copied across. Re-run to refresh.

 - RT (regional) has no county/club restriction: it applies to everyone.
 - CT (county) only applies to clubs mapped to that county in config/clubs.json
   (keys are the club name as on the heat sheet, e.g. "ExampleTown", or the club code).
 - Standards are ignored outside their window, so when the Winter Regionals window
   (to 31 Oct 2026) ends the RT badge switches itself off - import the next
   short-course regional then. Summer Regionals are long course and are ignored
   at a short-course meet (course in config/qualifying.json).
 - Some counties (Swim Cumbria) ask that their qualifying documents are not
   re-published or processed by third-party/AI tools - only import a county's
   times if that is fine for your use.

Other regions/counties: scripts/import-county-times.js <slug> imports from
swimming-times.com/qualifying-times/<slug>/ (a third party's copy of the county
standards - check them against the county's own document).

Two settings in config/qualifying.json that matter for accuracy:
  "ageAsAt": "2027-12-31"  age is worked out from the swimmer's date of birth on
                           that date (the heat sheet's own age is as at the meet
                           date, which can be a year out for the standard)
  "window": {from, to}     the standard is ignored outside its qualifying window

Manual files
------------
Nothing is built in - standards change every year and differ by gender, age
and course - so each one is a file in THIS folder, in the layout Meet
Manager prints as "Meet Qualifying Times Report" (the same layout as
DB26_QualTimes.txt in the Drive Meets folder):

    Meet Qualifying Times Report     Fri 18  September 2026 08:47 pm
    <name of the qualifying set>
    Female Short Course ...
    Event <TAB> 09 <TAB> 10 <TAB> ... <TAB> 15/OV
    50 Freestyle <TAB> 00:38.00 <TAB> 00:32.00 ...
    200 Freestyle <TAB> NOTIME <TAB> 02:30.00 ...      (NOTIME/blank = no standard)
    Male
    Event ...

Then say what each file is in config/qualifying.json:

    {
      "course": "SC",
      "standards": [
        { "level": "CT", "name": "Lancashire County 2026", "file": "Lancashire-County-2026.txt", "county": "Lancashire" },
        { "level": "RT", "name": "North West Region 2026", "file": "NorthWest-Region-2026.txt", "region": "North West" },
        { "level": "NT", "name": "National 2026",          "file": "National-2026.txt" }
      ]
    }

- "course" is the pool the meet is swum in: SC (25m) or LC (50m). Standards
  whose report says the other course are ignored.
- A standard with "county" or "region" only applies to swimmers from clubs
  that are in that county/region - clubs are listed in config/clubs.json by
  the club CODE used in the heat sheet (e.g. EXAM). A standard with neither
  (national) applies to everyone.
- Age is the age on the heat sheet (age at 31 Dec). The oldest column ("15/OV")
  covers everyone older. Younger than the youngest column = no badge.
- A swimmer sees the HIGHEST level they have beaten or equalled (NT > RT > CT),
  next to the PB badge, only once their final time is up.
- Files are re-read automatically within a second or two of being saved.

http://localhost:8080/meet.html shows what's loaded and flags problems: club
codes with no county/region, ages outside the age columns, files that don't
parse or are for the other course.
