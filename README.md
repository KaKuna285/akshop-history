# akshop-history

The code and data pipeline behind **[ak.athansson.com](https://ak.athansson.com)**,
a set of Arknights (EN server) tools. It started as a trimmed fork of the
"Shop Operator History" chart from
[akgcc.github.io](https://akgcc.github.io/shoplist/) and has grown from
there.

| Page | Path | What it is | Main code |
|---|---|---|---|
| Home | `/` | Landing page, account sync, backup/restore of saved data | `index.html`, `js/account-sync.js`, `js/backup.js` |
| Shop history | `/store/` | Which operators have rotated through the Purchase Certificate shop, and when | `js/shoplist.js` |
| Event calendar | `/calendar/` | Past and upcoming EN events - confirmed, announced or estimated dates, new operators and skins | `js/calendar.js` |
| Planner | `/planner/` | Materials needed to raise a roster of operators, minus your depot | `js/planner.js`, `js/operator-edit-modal.js` |
| Operator details | `/operator/` | Release info, stats, talents, skills, modules and skins (full art and animated chibis) per operator | `js/operator-page.js`, `js/chibi-viewer.js` |
| Account | `/account/` | Your synced roster and medal progress | `js/account-page.js` |

Everything is a static site (no build step) plus a daily data pipeline:

- **`akgcc-extra-data/`** - the Python scripts that scrape and build the
  site's data (`shop_operators.py`, `operator_online.py`, `events.py`,
  `game_data.py`, with `health.py` / `name_check.py` checking the result
  and `common.py` holding shared helpers), and their output in `json/`
  and `images/`. The pages fetch that output straight from this repo on
  GitHub (`EXTRA_DATA_REPO_RAW_BASE` in `js/config.js`), so new data needs
  no redeploy.
- **`.github/workflows/banner_history_update.yml`** - runs the pipeline
  once a day and commits the results (see "Knowing when the update
  breaks" and "Hands-off forever" below).
- **`cloudflare/`** - two small Cloudflare Workers: the account sync
  endpoint (`depot-import/`) and the daily trigger for the workflow
  (`dispatch-cron/`). See "Deploying the Cloudflare Workers".
- **`js/`, `css/`, `*/index.html`** - the site itself, served by a third
  Worker (`wrangler.jsonc` at the root). That Worker's own code,
  `worker/index.js`, only handles `/mirror/*`: a permanent copy, in
  Cloudflare R2, of the skin art and animated chibis the operator page
  shows - from myrtle.moe (`/mirror/myrtle/`), and for CN-only operators
  and skins, which myrtle.moe doesn't have, the CN client's assets in the
  ArknightsAssets2 dump on GitHub (`/mirror/aa2/`) - so each source gets
  one request per file ever rather than one per visitor.

`js/`, `css/`, `webfonts/`, `images/`, `LICENSE` and `UPSTREAM_README.md`
originally came from
[akgcc/akgcc.github.io](https://github.com/akgcc/akgcc.github.io)
@ `e51a17c62db332f19f1b031095c3cd6d2472d5c4` and `akgcc-extra-data/` from
[akgcc/akgcc-extra-data](https://github.com/akgcc/akgcc-extra-data)
@ `c3bcc0cf3ef107f44294568d21d5d46f84f4bcea` - only what the shop page
needed out of a ~3.7 GB repo. The first commit is those files unmodified,
so `git log -p` shows everything changed since.

## Shop history (`/store/`)

The original chart has all native Chart.js interactivity turned off
(`events: []`, `tooltip: {enabled: false}`), because the portrait bubbles
on each bar are drawn by a custom canvas plugin rather than being real
chart data points — so there was no way to see exact dates without
cross-referencing a wiki. This fork adds:

- **Hover tooltips.** Every portrait bubble's on-screen position gets
  recorded when it's drawn; a `mousemove` listener hit-tests the cursor
  against those positions and shows the operator name, whether it's a
  first release or a shop-rotation appearance (and which pool — Limited
  or Kernel), and the exact date.
- **A small legend** above the chart explaining what the ring colors and
  the translucent fill mean.
- **Layout tweaks for readability**: the chart sits in a centered,
  max-width card instead of running edge-to-edge, rows have a bit more
  breathing room, and faint alternating row bands make it easier to
  track a row across the full width.

All of that lives in `js/shoplist.js` (search for "hover tooltip") and
the new `css/shoplist-extra.css` (kept separate from the shared
`css/style2.css` so it can't affect anything else on the original site).

## Running it locally

It's a static site — no build step. From this folder:

```
python3 -m http.server 8000
```

then open <http://localhost:8000/>. (Opening an `index.html`
directly as a `file://` URL won't work — the page fetches `/js/...` and
`/css/...` as root-relative paths, which need an actual server.)

You'll need normal internet access for the pages to load data (they
fetch JSON straight from `raw.githubusercontent.com` and images from
`cdn.jsdelivr.net` — see below), same as the live site.

## How the data works

`js/shoplist.js` fetches, in order:

1. `akgcc-extra-data/json/banner_history.json` — per-operator shop/banner
   appearance dates for both EN and CN servers. Generated by
   `akgcc-extra-data/shop_operators.py`, which scrapes
   [Arknights Terra Wiki](https://arknights.wiki.gg) and
   [PRTS Wiki](https://prts.wiki) (the Chinese wiki, which is where CN's
   "Kernel pool" vs "Limited pool" shop/banner distinction comes from).
2. `character_table.json` / `char_patch_table.json` for each server
   (via `js/util.js`'s `get_char_table`) — the slim copies described in
   "Game data" below, built from the
   [ArknightsAssets/ArknightsGamedata](https://github.com/ArknightsAssets/ArknightsGamedata)
   mirror — this is what resolves an operator name to a charId, rarity,
   class, etc.
3. `akgcc-extra-data/json/operator_release_dates.json` — adds
   `isLimited` / online-date flags, generated by
   `akgcc-extra-data/operator_online.py`.
4. Character portraits, from jsDelivr's mirror of `akgcc/arkdata`.

To regenerate any of the data yourself, run the scripts from inside
`akgcc-extra-data/` (they import `common.py` from there and write to
`json/`), in the same order as the workflow: `shop_operators.py`,
`operator_online.py`, `events.py`, `game_data.py`, then `health.py`. They
need `requests` and `pillow` (`pip install -r requirements.txt` in that folder, pinned versions).

## Game data (slim copies)

Every page that shows operators reads the game's own data tables
(characters, skills, modules, skins, items, medals), for both EN and CN.
The full tables from the mirror are huge - loading them directly cost the
operator page ~100 MB of JSON per visit and the calendar ~49 MB, almost
all of it fields no page reads. So `akgcc-extra-data/game_data.py` (a step
in the daily workflow) builds slim copies into
`akgcc-extra-data/json/gamedata/<en|cn>/<table>.json`: the same top-level
shape, field names and value formats as the originals, keeping only the
rows and fields some page actually reads. The CN copies go further: every
page merges EN and CN with EN winning, so CN only needs what EN doesn't
have yet (CN-only operators and their skills, modules, skins, items),
plus the handful of character fields the shop page reads from CN for
everyone (CN shop history is keyed by Chinese name). Result: ~11 MB for
EN and ~0.7 MB for CN in total (~1.3 MB gzipped over the wire), instead of
~107 MB; the operator page now loads ~11 MB, the calendar ~4 MB.

Module lore (each module's flavour text, about 80% of the module table)
is split out into its own `uniequip_lore.json`: only the operator page
shows it, and only when you open a module's lore, so it's downloaded then
rather than with every page that lists modules.

`gameDataFetch()` in `js/util.js` is the only way pages load these: it
tries the slim copy and, if it's missing or the request fails, falls back
to the full table on the mirror (a superset, so the page still works).
All the existing client-side processing (the char_patch merge, rarity and
class names, Amiya's forms, the EN/CN merges, module grouping) is
unchanged.

Two things to know:

- **A new field must be added in two places.** The field lists in
  `game_data.py` (`CHARACTER`, `SKILL`, `BATTLE_EQUIP`, ...) are a
  whitelist traced from every read in `js/*.js`. If a page starts reading
  a field that isn't on the list, it simply won't be in the slim file -
  add it there too.
- **New game content appears with the daily run.** The slim copies are
  rebuilt once a day, so after a game update new operators show up after
  the next run (or a manual one from the Actions tab), not the moment the
  mirror updates. Files are only rewritten when the content changed, so a
  day without a game update adds no commit.

The script also normalises the game data's habit of writing an empty list
as `{}`: a few operators (Lancet-2, Castle-3 and the other robots) have
`skills: {}`, which made the planner fail to load entirely if one was in
your roster (`.forEach` on an object). A step that produces suspiciously
few rows fails instead of writing, leaving yesterday's files in place, and
`health.py` tracks the operator counts like the other data.

## The EN event calendar (`/calendar/`)

Past and upcoming EN server events. `js/calendar.js` fetches
`akgcc-extra-data/json/events.json`, generated by
`akgcc-extra-data/events.py` (a step in the same daily workflow).

Yostar (the EN publisher) only ever confirms an event's actual EN date a
week or two ahead of release - there's no source anywhere for genuinely
confirmed EN dates months out, because that information doesn't exist
yet. So for an event that's run on CN (developed and published there by
Hypergryph) but has no confirmed EN date yet, `events.py` estimates one:
its own CN date plus the median CN&rarr;Global lag observed from the
last 10 confirmed events, ordered by when each one actually went live on
Global (not by CN date), recalculated fresh on every run. A CN/Global
pair with a non-positive lag is dropped before that median is computed,
since that's the wiki recording the same (or an inverted) date for both
servers rather than a real observation. A trailing window by event count
(rather than a fixed number of calendar days) tracks a genuine change in
Yostar's localization pace fast, without going quiet or noisy just
because events happened to ship faster or slower than usual recently.
The all-time median (across every confirmed event ever) is also
reported, purely as a reference point - it isn't used to build any
estimate. `events.py` also runs a self-backtest on every update:
rebuilding the same 10-event model at each past confirmed event using
only what would've been known at the time, and comparing that estimate
to what actually happened, to report how accurate this approach has
been historically (median/p75/p90/max absolute error in days). Each
event in the output carries a `globalConfirmed: true/false` flag (plus
`announced: true` for the tier described next) so the page can visibly
distinguish "this actually is the date" from "this is an estimate" - a
green "CONFIRMED" badge, a blue "ANNOUNCED" one, a yellow "ESTIMATED"
one, or a red "CN EXCLUSIVE" one for an event whose estimated window
closed 30+ days ago with still no Global confirmation or announcement
(likely not coming to Global at all, or running unusually late).

Sometimes Yostar announces or teases a Global date before the wiki has
picked it up. `akgcc-extra-data/overrides.json` is a small hand-edited
file (starts out as just `{}`) for exactly that case - a manually
pinned date that `events.py` uses in place of a computed estimate,
without needing to wait on the wiki. It's keyed by event name, matching
the `event` field elsewhere in the pipeline:

```json
{
  "Some Upcoming Event": {
    "globalStart": "2026-11-01",
    "globalEnd": "2026-11-15",
    "source": "Official Yostar Twitter announcement",
    "note": "Optional extra detail, shown as a tooltip on the list view"
  }
}
```

`globalEnd` and `note` are optional (`globalEnd` falls back to the CN
run's own duration if omitted); `source` is shown directly on the page
so readers know why a date is pinned instead of computed. An override
only ever applies to an event that already has a CN date tracked (there's
nothing to anchor an end date to otherwise), and never overrides an
actual wiki-confirmed date once the wiki catches up - confirmed always
wins.

`akgcc-extra-data/operator_online.py` has an equivalent, sibling
mechanism for individual operators' EN/Global release dates:
`akgcc-extra-data/operator_overrides.json` (also starts out as just
`{}`). It exists because some operators are given out through an
event's activity rewards, shop, or as an outright gift rather than
through a gacha banner - and for several of those, confirmed live,
arknights.wiki.gg's `EventServerDetails` Cargo table has *zero* rows at
all for their event, under any server. That's not a join bug on this
project's side to fix; the wiki simply never recorded a Global date for
that event in the table this pipeline reads, so there is nothing for
any amount of join-logic to find. For exactly those operators,
`operator_overrides.json` lets a release date be entered by hand. It's
keyed by `charId` (open the operator's page on the site and copy the id
out of the `?id=` URL in the address bar) and looks like:

```json
{
  "char_4064_rockr": {
    "onlineTime": "2024-06-01 16:00:00",
    "source": "Yostar patch notes / personal observation",
    "note": "optional, for whoever edits this file next"
  }
}
```

`onlineTime` accepts either a plain `YYYY-MM-DD` or the full
`YYYY-MM-DD HH:MM:SS` the wiki's own dates use; `source` and `note` are
optional and are for whoever next edits this file - the site itself only
reads `onlineTime`.

Unlike the event overrides above, an operator override here **always**
wins, even over an onlineTime the scrape did find. That's a deliberate
difference: an event override only ever fills a gap because a
wiki-confirmed event date is reliably correct once it exists, but the
operator scrape has been confirmed live to sometimes pick up the wrong
data entirely for a shared name - e.g. an alternate version of an
operator (Amiya's various alters) landing on the base operator's charId.
A hand-verified entry in `operator_overrides.json` needs to be able to
correct that, not just fill a blank, so there's no "silently ignored"
case here - whatever's in the file is what ships. This also means it's
worth double-checking the charId before adding an entry (the `?id=` URL
again), since a typo'd charId will silently attach the date to the
wrong operator instead of failing loudly.

Separately, `operator_online.py` also corrects one specific wiki data
error at the source rather than through the override file: the wiki
records the entire Day 1 operator roster's Global release as
`2020-02-05 17:00:00` (confirmed live, ~90 operators, all the same exact
timestamp), but Arknights' actual EN/Global launch date is January 16,
2020. Any onlineTime that exactly matches that one wrong wiki value is
corrected in bulk rather than needing ~90 individual override entries.

`events.py` also pulls each event's banner art, shown when you click an
event to open its preview panel - the wiki filename comes from `image`,
just another field on the same `EventServerDetails` Cargo table already
queried for dates, so finding it costs no extra request. Each event can
have a different banner per server (CN vs Global often use different key
art for the same event), so `pick_image()` prefers the Global server's
own art but falls back to CN's when Global's isn't known yet - which is
exactly the case (an estimated or announced event) where a preview image
is most useful.

That art is *mirrored into this repo* (`akgcc-extra-data/images/`, a
separate folder from the site's own top-level `images/`) rather than
linked straight to `arknights.wiki.gg` - confirmed live, the wiki's image
host sends a `Cross-Origin-Resource-Policy` header that makes a browser
refuse to embed it from another site at all, so a direct link to the
image works fine but an `<img>` on this site doesn't load at all
(`NS_ERROR_DOM_CORP_FAILED` in Firefox's network log; other browsers show
the same failure differently). `download_image()` fetches each banner
server-side instead, resolving its real CDN URL via MediaWiki's
`imageinfo` API on `api.php` rather than `Special:FilePath` - confirmed
live, every `Special:FilePath` request from a GitHub Actions IP came back
a 403 with an HTML bot-protection page, even though `api.php` calls from
that same run succeeded normally (`robots.txt` singles out the `Special:`
namespace specifically). CORP only restricts a *browser* embedding a
cross-origin resource in the first place, not a plain server-side
request, so none of this is affected by it - `localize_images()` then
rewrites the event's `image` field to point at this repo's own copy.
Every run asks the wiki for each image's current SHA-1 (in the same
batched `imageinfo` calls), and `images/manifest.json` records which wiki
file and SHA-1 each local copy came from - so an image is only downloaded
when it's new, or when someone uploaded new art over the same wiki file
name. A wiki name with characters the local name can't keep (non-ASCII
letters, say) gets a short hash added, so two such names can't share a
file. `images/` only grows by what's new or changed on any given run, and
the workflow's commit step picks it up alongside `json/*.json`.

Mirrored images are stored as **WebP, scaled down to at most 1280 px
wide** (`to_webp()` / `write_mirrored_image()`, using Pillow). The wiki's
banners are 1560x500 PNGs of ~1.2 MB each, which added up to ~233 MB -
downloaded in full by every daily Action checkout, and ~1.2 MB per banner
for anyone opening a preview. The preview shows a banner at most ~640 CSS
px wide, so 1280 px stays sharp on 2x screens, and the WebP is ~5% of the
original size (the whole folder: 233 MB -> ~22 MB). Operator icons are
only re-encoded, never upscaled. Images mirrored before this change were
converted in place by the first run after it - `download_image()` finds
the old PNG under its old name (`legacy_image_name()`), converts it, and
deletes it, with no new download - and any image that can't be converted
is kept as the original and reported as a degraded run. Old PNGs remain
in git history, so the `.git` folder itself doesn't shrink; the checkout
and every page load do.

The same preview panel also lists any new operators introduced by that
event, each with a small portrait icon, rarity, and class. This comes
from the wiki's `Operators` Cargo table (`fetch_event_operators()`),
which maintains its own `event` field linking an operator to whichever
event introduced (or granted) them - the same link
`operator_online.py`'s `scrape_wiki()` already relies on to get each
operator's Global release date, so it's a trusted, wiki-maintained
association rather than a guess based on matching up dates. A rerun's
event page is a separate name on this wiki from the original event (e.g.
"X" vs "X - Rerun"), and operators are only ever linked to the original,
so a rerun naturally lists no operators - which is correct, since a rerun
doesn't introduce anyone new. Operator portrait icons are mirrored into
`akgcc-extra-data/images/` exactly like event banners, resolved in the
same batched `imageinfo` call as the banners rather than a separate one.

The preview panel also lists any new skins tied to that event, each
linking straight to that operator's page. Unlike operators, neither wiki
has a structured *field* linking a skin to the event that introduced it
(confirmed live: `arknights.wiki.gg`'s own `Skins` Cargo table has no
`event` column, and no usable `id`/`skinGroup` either - both come back
empty on every row checked; `prts.wiki` has no skins-related Cargo table
at all), so `attach_event_skins()` reads two wiki *pages* instead, in
order of trust:

1. **The outfit brand pages** (`Outfit/Test Collection`, `Outfit/EPOQUE`,
   `Outfit/Made by 0011`, ... - discovered dynamically with one batched
   `generator=allpages` query, so a new brand page is picked up with no
   code change). Each lists every outfit released under that brand as an
   `{{Outfit cell}}` whose `release` field names the event it came out
   with and whose `model` field names the operator. This is the primary,
   authoritative source: it covers minor events whose own page never lists
   their outfit (e.g. Greyy's "My Fellow Newsboy" with "Vector
   Breakthrough Trial from Misery"), and it overrides an event page that
   claims an outfit belonging to a different event. A `release` can be a
   plain link, a link with an "(available from ...)" suffix, or several
   region lines (`*CN: ...` / `*Global: ...`, `*[EN and KR] ...`); when a
   Global/EN line exists only that is used. An outfit whose *every* line
   is CN-marked (`{{Color|[CN]}}`) is out on CN but not confirmed for
   Global - either "not here *yet*" or "never" (a CN-exclusive collab), and
   the page can't say which. So it is kept only when its event is tracked
   and its Global run hasn't ended yet (ongoing or upcoming - which is how
   an upcoming event shows the skins it's expected to bring), and it's
   flagged `cnOnly`, which the calendar renders as a dashed chip with a
   "CN" tag. If the event's own page also names it as new, that
   corroborates it and the flag is dropped. A CN-marked outfit tied to an
   event that already ran on Global without it, or to one we don't track,
   is never shown. The pages spell a rerun or multi-part event as
   "X Rerun" / "X Part 2" where `wikiPage` is "X/Rerun" / "X/Part 2", so
   events are matched through `normalize_event_key()` (lowercase, drop all
   punctuation and spacing).
2. **The event's own `==Outfits==` section**, used only for outfits *no*
   brand page lists at all (e.g. one too new for its brand page to have
   caught up) - the event page names any newly-added paid outfit directly
   (e.g. "Crossing" lists "Lorem Ipsum, The Next Side Quest, The
   Bloodwing Rose"). An outfit a brand page assigned to a *different*
   event is dropped from this list rather than trusted twice.

Brand-page outfits resolve to a charId through their `model` (operator
name → charId via `OperatorFiles`, the same table `operator_online.py`
already trusts for that exact mapping). Event-page names resolve through
two Cargo queries - `Skins` (skin name → operator name), then
`OperatorFiles`. The two wikis aren't always edited consistently, so a
few slips are handled on that path: a comma inside a skin's own name is
written `&comma;` and decoded back; one event page's Outfits list read
"Unstained Unshaken" while the `Skins` table has "Unstained, Unshaken", so
a name that doesn't match `Skins.name` exactly is retried through
`normalize_skin_name()`; and one page wrote "Caelum Aeternum, Sankta
Miksaparato" (skin, then its own operator) as if it were two skins, so a
leftover fragment that is identical to a sibling skin's operator name is
dropped.

The same outfit can also be spelled slightly differently on the two pages
("Summer Flowers FA240" on the brand page, "Summer Flower FA240" on the
event page), which would list it twice, so "already claimed by a brand
page" and "the event page corroborates this CN-marked outfit" both use
`skin_keys_match()`: same operator, identical digits, and at least 90%
similar once punctuation and spacing are stripped. The digits rule matters
because numbered outfits ("Holiday HD91" vs "HD92") are different outfits
that otherwise look nearly identical.

The brand pages are one cheap batched request, re-read on every run. The
per-event page scrape is meaningfully heavier (one request per event), so
it's cached: `akgcc-extra-data/json/skin_outfit_cache.json` (generated
automatically, not hand-edited) keeps each event's own scraped skin-name
list keyed by wiki page, and `event_outfits_are_final()` decides when
it's safe to trust that cache forever - only once an event's Global date
is wiki-*confirmed* (an estimate can still shift) and its run actually
ended at least a couple of days ago. Anything not yet final is re-scraped
every run - cheap, since only a handful of events are ever in that state
at once. An outfit neither source ties to an event (a routine shop
rotation with no tied SideStory) is simply left off the calendar, rather
than guessed at: an earlier version had `js/calendar.js` fall back to a
nearest-event date match, but that produced real wrong associations (an
unrelated skin landing on the same calendar day as a SideStory, e.g.
"Yet Another Autumn (Savage)" on "Critical Phase Transition"), so it was
removed rather than tuned. If the brand-page request itself fails, the
run falls back to event pages alone instead of losing skins. Like the
rest of this step, any failure is caught and logged rather than taking
down the whole run.

**Integrated Strategies and Reclamation Algorithm** are game modes, not
SideStory events, so they have no `EventServerDetails` rows - but the
outfits tied to a theme (e.g. "Sui's Garden of Grotesqueries") need an
event to attach to. Each mode's own page (`Integrated Strategies`,
`Reclamation Algorithm`) lists every theme in a `{{Game mode themes
cell}}` with a `cn date` and a `global date`, read in one batched request
by `fetch_game_mode_theme_rows()` and turned into the same row shape
`build_events()` already consumes - so an upcoming theme gets an
*estimated* Global date from its CN one exactly like any other event
(e.g. Reclamation Algorithm's "Relaunch Anchor", CN-only so far). The wiki
gives a date *range* for only the oldest themes; every other theme is a
single release day, so a window with no end of its own is shown as
`GAME_MODE_THEME_DAYS` (7) days - a display length, not a real one, since a
theme stays playable afterwards. Themes are tagged `mode` in `events.json`:
the preview says why it's only a week, and `js/calendar.js` /
`js/operator-page.js` skip them when matching operators to events by
release date (a theme often drops the same day as a SideStory whose
operators they aren't). They are also kept out of the CN→Global lag model
and its backtest, so they don't shift the estimates or accuracy figures
for regular events. If the request fails, the run just builds without them.

`events.py`'s Cargo queries (against the same `arknights.wiki.gg` API the
other scripts use) target the `EventServerDetails` and `Operators`
tables, whose exact field names were confirmed against each table's own
`Template:<TableName>/CargoDeclare` page (`Special:CargoTables` itself,
like `api.php` directly, is blocked by the wiki's robots.txt to this
project's own research tooling, but a plain `Template:` page isn't). This
project's own tooling still can't reach `api.php` directly to test a
query before it ships, though - so a new or changed query here is
verified with a mocked-request test harness first, then confirmed for
real once it runs in the workflow's own Action log. If `json/events.json`
isn't showing up after a workflow run, or the calendar page shows
nothing, check that step's own log in the Actions tab first; the daily
workflow runs this step with `continue-on-error: true` specifically so a
problem here doesn't take down the shop tracker's own data update.

**Date changes.** An estimate isn't fixed: it follows the CN date and the
trailing-window lag (both can move), and Yostar can announce or the wiki
can confirm the real date later, or reschedule a confirmed one. Without a
record of that, a date just silently differs from what someone saw last
week. So `update_date_history()` compares each run against the previous
`events.json` (read at the very start of the run, before it's
overwritten) and gives every event that hasn't finished yet a
`dateHistory`: a short list (newest `DATE_HISTORY_MAX_ENTRIES`, 6) of
`{at, start, status, reason}` entries, one per recorded state. `reason` says
why it moved - `estimate` (same CN date, so the lag model moved), `cn` (its
CN date changed), `announced` / `confirmed` (it just became that), or
`rescheduled` (an announced/confirmed date moved). Moves are measured
against the last *recorded* entry rather than the previous run, and an
estimate has to move at least `DATE_HISTORY_MIN_SHIFT_DAYS` (2) days to
count: the lag is a median that nudges by a day or so from run to run,
which would otherwise put a "moved" note on nearly every estimated event,
while measuring against the last recorded entry means a slow drift still
shows up once it adds up. A change of *status* is always recorded, and a
finished event's history is dropped. The calendar shows the latest move
for 14 days (`RECENT_CHANGE_DAYS` in `js/calendar.js`) as a line on the
event's card and preview - "Estimate moved 4 days later (CN→Global lag
updated)", "Now confirmed - 3 days later than the estimate", "Rescheduled -
7 days later" - and the preview lists the whole history. An event the
previous `events.json` already had, but with no history yet (the first run
after this shipped), is seeded from that previous state, so that very
first run already reports moves since the run before it.

## Knowing when the update breaks

Every part of this pipeline is wrapped so that one failure doesn't cost the
site everything else - which also means a scraper that breaks (the wiki
changes a template, an API starts erroring) can leave the site quietly
serving old or incomplete data while the run stays green. Three layers
make that visible:

- **`events.py` reports what it had to skip.** The game-mode themes, the
  skin step, a pattern of failed image downloads, and the date tracking
  each fail on their own without ending the run; `note_degraded()` collects
  them into events.json's `warnings`. Related fix: a failed event-page
  fetch used to come back as `[]`, which was cached as "this event has no
  outfits" and, once the event was finished, trusted forever.
  `fetch_event_outfit_skin_names()` now returns `None` for a failed
  request (a missing page or no Outfits section is still `[]`), and a
  `None` never touches the cache. An empty result from the Outfit brand
  pages is also reported, since ~25 pages yielding nothing means the layout
  changed under the parser, not that nothing was released.
- **`health.py` writes `json/meta.json` after every run.** The workflow
  gives each update step an `id` and `continue-on-error`, so the three
  (shop history, operator dates, events) are independent and the commit
  still happens for whatever worked; `health.py` then gets each step's
  outcome and records, per step, the outcome and `lastSuccess` (carried
  over from the previous file when this run's step failed), how many
  records each file holds, and a list of warnings: failed steps, events.py's
  own, and any count that dropped below 80% of its previous value (when it
  was at least 20) - the check that catches a scraper that still exits 0
  but now parses nothing. `problemRuns` counts consecutive runs that had
  any warning. The run is still made to fail at the end if a step did, so a
  broken scraper is a red run, not a swallowed one.
- **The scrapers never write an empty file.** `shop_operators.py` used to
  open `banner_history.json` for writing *before* checking it had scraped
  anything, so a wiki that came back with nothing parseable emptied the
  file, exited 0, and the empty file was committed (breaking the shop
  page). Now, if either server's list is empty, it leaves the file as it
  was and exits 1; `operator_online.py` does the same when PRTS returns no
  operators. Both write through a temp file and swap it in, so a crash
  mid-write can't leave a truncated file either. `health.py` also reports
  any data file that is missing or doesn't parse, and any count that the
  previous run had but this one doesn't - not only counts that shrank.
- **Operator names the shop page can't place.** `banner_history.json` is
  keyed by the name the wikis use, and the shop page turns it into a
  charId through game data (`name` / `appellation` in the EN and CN
  `character_table.json`) plus three alias maps in `js/util.js`
  (`GAMEPRESS_NAME_MAP`, `CN_ID_MAP`, `SHORT_NAMES`). A name that matches
  nothing is quietly left off the chart, with only a console message in
  the visitor's browser - and that's the one job here that needs a person
  (a new operator spelled differently on the wiki than in game data needs
  an alias). `name_check.py`, run at the end of `shop_operators.py`, does
  the same lookup against the same game-data mirror, reading the alias
  maps straight out of `util.js` so there's still only one list to edit,
  and records any misses in `banner_history.json` as `unmatchedNames`.
  `health.py` turns them into a warning naming the operators. To fix one,
  add the wiki spelling -> game-data spelling to `GAMEPRESS_NAME_MAP` in
  `js/util.js` (or to `ALIAS` in `shop_operators.py`, which rewrites the
  name before it's saved). If the check itself can't run (the mirror is
  down), the data is still written and the warning says the check failed.
- **A GitHub issue for a problem that lasts.** When `problemRuns` reaches 2
  the workflow opens one "Data update problem" issue (listing the warnings
  and linking the run); the first healthy run comments and closes it. Two
  runs rather than one so a single wiki timeout doesn't open and close an
  issue by itself. This needs the workflow's `issues: write` permission,
  which is declared at the top of the workflow file.

On the site, `js/data-health.js` turns `meta.json` into the muted footer
line on the calendar and shop pages: "Updated 6 hours ago", or in amber
"Updated 6 hours ago - some details may be incomplete" (hover for the
reasons) when there are warnings, or "Last updated 3 days ago - automatic
updates may be delayed" when the run itself hasn't happened in 36 hours
(`DataHealth.STALE_HOURS`) - which is what the Cloudflare cron or GitHub
being down looks like. Until the first run writes `meta.json`, the line
falls back to the page's own data timestamp.

## Running your own daily-refreshed copy on your own domain (Cloudflare)

This fork no longer depends on akgcc's own refresh schedule (their GitHub
Action only runs twice a week — see `akgcc-extra-data/.github/workflows/`
upstream). Instead, `js/config.js`'s `EXTRA_DATA_REPO_RAW_BASE` constant controls
where the pages fetch the pipeline's JSON from, and this repo's own copy of
the scraper workflow (`.github/workflows/banner_history_update.yml` — at
the repo root, since that's the only place GitHub Actions looks for
workflow files, even though the scripts it runs live under
`akgcc-extra-data/`) runs the scraper daily instead of twice a week.

That workflow has no `schedule:` trigger of its own, though — see "Hands-off
forever" below for why, and what actually fires it every day instead.
To get this actually
running end to end, on your own domain, under your own Cloudflare account:

1. **Create a GitHub repo for this** (e.g. `github.com/new` →
   `akshop-history`) and make sure it's set to **public**. This has to be
   public, not just "public or private, doesn't matter" — the page fetches
   its JSON straight from `raw.githubusercontent.com` with no
   authentication, and that endpoint 404s on a private repo. Then, from
   this folder: `git remote add origin <the repo's URL>` and
   `git push -u origin main`.
2. **Check `EXTRA_DATA_REPO_RAW_BASE` in `js/config.js` matches that repo.**
   It's currently set to
   `https://raw.githubusercontent.com/KaKuna285/akshop-history/main/akgcc-extra-data/json/`
   as a guess at your GitHub username and a repo name matching this
   folder's — if either is different, update that one constant (it's the
   only place this is hardcoded) and commit.
3. **Confirm Actions is enabled** on that new repo (Settings → Actions →
   General, and while you're there set "Workflow permissions" to "Read and
   write permissions" — the scraper commits its own output back to the
   repo, so it needs that) and trigger the workflow once manually from the
   Actions tab (`workflow_dispatch`) to confirm it commits updated JSON
   successfully. See "Hands-off forever" below for how this actually gets
   triggered daily going forward (not GitHub's own `schedule:` — a
   Cloudflare Worker).
4. **Deploy the site itself via Cloudflare**: in the Cloudflare dashboard,
   Workers & Pages → Create application → Connect GitHub → pick this repo.
   No build command — this is a static site with no build step. This repo
   includes a `wrangler.jsonc` at its root that tells Cloudflare exactly
   how to serve it (assets straight from the repo root, real 404s instead
   of single-page-app-style fallback behavior, and `/store` /`/store/`
   both resolving to `store/index.html`) — without it, Cloudflare's
   auto-detection can guess wrong and serve broken/unstyled pages. It'll
   deploy at `<project-name>.workers.dev`, with the actual chart at
   `/store/` and a landing page listing this and any future Arknights
   projects at the root.
5. **Point your domain at it**: in that same project, the **Domains** tab
   → add the (sub)domain you want. Since your domain's already in your
   Cloudflare account, Cloudflare sets up the DNS for you automatically.
6. **Create the R2 bucket for the skin art / chibi mirror**: dashboard →
   R2 → Create bucket, named `akshop-mirror` (it's bound to the site
   Worker as `MIRROR` in `wrangler.jsonc`; the deploy fails until it
   exists). The Worker fills it on its own as visitors open skin previews.
   `MYRTLE_MIRROR_BASE` in `js/config.js` points the pages at it - set it
   to `https://<your domain>/mirror/myrtle/`, or blank to load from
   myrtle.moe directly.
7. **Optional: turn on Image Transformations** for the skin previews:
   dashboard → Images → Transformations → enable it for your domain's
   zone, and add your own domain to its allowed source origins (the art
   is read from the mirror above). Set `IMAGE_TRANSFORM_BASE` in
   `js/config.js` to `https://<your domain>/cdn-cgi/image/` (or blank to
   skip this). Each skin's art is then served as WebP/AVIF at preview
   size, and the page falls back to the mirror's PNG if transformations
   fail. The free plan's 5,000 unique transformations a month is several
   times the number of skins.

After that initial setup, everything is hands-off: the daily Action commits
fresh JSON to your repo, and the site (wherever it's deployed) fetches that
JSON live from GitHub on every page load — no redeploy needed for new shop
data. The site's Worker redeploys itself (Workers Builds, on push) only
when the site's own code changes - its build watch paths exclude
`akgcc-extra-data/*` and `cloudflare/*`. The two standalone Workers are
set up the same way; see "Deploying the Cloudflare Workers" below.

## Hands-off forever: why the scraper doesn't use GitHub's own schedule

GitHub Actions supports a native `schedule:` cron trigger, and earlier
versions of this workflow used one. The problem: GitHub auto-disables a
scheduled workflow after 60 days with no activity on the repo at all. In
practice the scraper's own daily commit resets that clock whenever the
data actually changes, but "probably fine" isn't the same as "hands-off
forever" — so instead, the workflow only has a `workflow_dispatch:`
trigger (fireable via the API, with no schedule of its own), and a small
Cloudflare Worker with its own Cron Trigger — running entirely on
Cloudflare's infrastructure, nothing to do with GitHub's uptime or
activity rules — calls the GitHub API once a day to fire it.

That Worker's code is at `cloudflare/dispatch-cron/index.js` and its
schedule (`0 7 * * *`, daily 07:00 UTC) is in that folder's
`wrangler.jsonc`. It needs two secrets, set once in the dashboard: a
`GITHUB_PAT` (a fine-grained GitHub token scoped only to this repo's
Actions: Read and write — nothing broader) and a `TRIGGER_KEY` (any random
string, used only to gate the manual `/trigger?key=...` test route). It
deploys itself from this repo - see the next section. If the dispatch
fails it retries twice (a few minutes apart) for errors that might pass,
then fails the scheduled run, so it shows as an error in the Worker's
logs/Cron Events rather than looking fine; a bad or revoked token fails
straight away. Either way the site's footer turns into "automatic updates
may be delayed" after 36 hours.

## Deploying the Cloudflare Workers

There are three Workers, all deployed by Cloudflare's **Workers Builds**
straight from this repo on every push to `main`, so nothing is ever pasted
into the dashboard:

| Worker | Root directory | What it is |
|---|---|---|
| `akshop-history` | (repo root) | The site itself (`wrangler.jsonc` at the root serves the static files; `worker/index.js` runs the R2 mirror at `/mirror/*`) |
| `akshop-depot-import` | `cloudflare/depot-import` | The account-sync endpoint (`index.js`) |
| `akshop-history-cron` | `cloudflare/dispatch-cron` | The daily trigger for the data workflow (`index.js`) |

Each folder's `wrangler.jsonc` holds the Worker's `name` (which must match
the dashboard name exactly, or the build fails), its `compatibility_date`
(kept at the date the Worker was originally created with, so behaviour
doesn't shift), `workers_dev: true` (the pages call each Worker on its
`*.workers.dev` URL), and `keep_vars: true`, so a deploy never touches the
variables and secrets set in the dashboard (`ALLOWED_ORIGIN`,
`ACCESS_KEY_HASH`, `GITHUB_PAT`, `TRIGGER_KEY` - secrets are never in this
repo). The cron Worker's schedule lives in its config too: a deploy
replaces the dashboard's cron triggers with the config's, so change the
schedule there. Likewise the account-sync Worker's rate limits
(`ratelimits` in `cloudflare/depot-import/wrangler.jsonc`: login-code
emails and code attempts, per IP and per email address) - its Origin
check only stops other websites, not scripts, so those limits are what
keep it from being used to spam Yostar code emails or guess codes.

One-time setup per Worker, in the dashboard: Workers & Pages -> the
Worker -> Settings -> Build -> Connect -> pick this GitHub repo, branch
`main`, set **Root directory** to the folder in the table, leave the
deploy command as `npx wrangler deploy`, and under **Build watch paths**
set Include to that folder (`cloudflare/depot-import/*` or
`cloudflare/dispatch-cron/*`), so a Worker only rebuilds when its own
code changes. The site Worker excludes `akgcc-extra-data/*` (the daily
data commits don't change anything it serves) and `cloudflare/*`.
