# Qualifying-time badges (CT / RT / NT)

When a swimmer beats a **County**, **Regional** or **National** qualifying time, a small yellow badge
(`CT`, `RT`, `NT` - the highest one beaten) appears between their time and their place, next to the PB badge.
It is off until you give it some standards.

## Before you import anything: the data is not ours

Qualifying standards belong to the counties and regions that publish them, and some ask that they are
not re-published or processed by third-party or AI tools (Swim Cumbria, for one). **This repository
contains none of them** (`qualtimes/*.txt` is git-ignored). The import scripts download them to *your*
computer for *your* use; check each county's terms first and never commit the files.

## How it decides

For each swimmer (matched by name to the meet file, which has sex, date of birth and club):

1. Their **club** is looked up in `config/clubs.json` (club code -> county, region); a `CT` standard only
   applies to clubs in that county, an `RT` one to clubs in that region, `NT` to everyone.
2. Their **age** is worked out from the date of birth *as at the standard's date* (`ageAsAt`), because
   that is how the age bands are defined.
3. The standard must be in its **window** (`from` / `to`): outside it the standard is ignored, so a badge
   switches itself off when the window closes.
4. The rule is **"faster than"** (strict: an equal time does not qualify) unless the source says otherwise.
5. Age bands such as `10-11`, `17/Over` and `15/OV` are understood.

## Setting it up

```bash
# 1. who is in which county / region (needs the Swim England club database file, gbclub.sdb)
node scripts/import-clubs.js

# 2. qualifying times
node scripts/import-senw-times.js SW26 --level RT                          # Swim England North West regionals
node scripts/import-senw-times.js LC27 --level CT --county Lancashire      # a North West county
node scripts/import-county-times.js <slug>                                 # others, from swimming-times.com
node scripts/import-all-2027.js                                            # every county's 2027 short-course times
```

Each import writes `qualtimes/<name>-<course>.txt` and registers it in `config/qualifying.json`
(start from `config/qualifying.example.json`). Standards you are unsure about can be switched off with
`"disabled": true, "disabledReason": "..."`. Hand-written club entries go in `config/clubs.local.json`.

Check it: the data check on `meet.html` lists any club with no county/region.

## Keeping it current

Standards have windows. When the window of, say, the Winter Regionals ends, the `RT` badge stops by itself;
import the next regional when it is published. Summer regionals are long course and ignored at short-course meets.
