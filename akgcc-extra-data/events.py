"""Get past + upcoming EN (Global) event dates and write json/events.json.

Yostar (the EN publisher) only ever officially confirms an event's
Global date a week or two ahead of time. There's no source of "confirmed
EN dates months out" because that information doesn't exist yet -- so
"preliminary" here means: once an event has run on CN, arknights.wiki.gg
tracks it, and once Yostar has confirmed its Global date that's tracked
too, but for the (usually many-months) gap in between, we estimate it.

The estimate is "this event's own CN date plus a lag" -- but which lag
matters a lot. The real Global lag drifts over time (Yostar has sped
up localization before and can again), so a flat lag averaged over the
*entire* dataset reacts to that far too slowly: months of schedule
changes get diluted by years of older history sitting in the same
average. Instead, the lag applied to every current estimate is the
median CN->Global lag from just the last RECENT_LAG_WINDOW_EVENTS
*confirmed events* (by Global release order, not calendar days) --
a trailing window recomputed fresh on every run. That's still a median
over several events rather than one single data point, so one unusually
fast or slow event doesn't swing every estimate on the page, but it
tracks a real shift in pace (the schedule speeding up or slowing down)
much faster than an all-time average would, and unlike a fixed-days
window it doesn't go quiet (or noisy) just because events happened to
ship more slowly (or quickly) than usual recently. A CN/Global pair with
a non-positive lag is dropped before any of this is computed -- that's
not a real observation, just the wiki having the same (or an inverted)
date recorded for both servers. The all-time median (across every
confirmed event ever) is also reported in the output, for comparison --
it's not used to build any estimate, just a reference point for how far
the current pace has drifted from the historical one.

To sanity-check the window size, `backtest()` below simulates the same
model against history: at each past confirmed event, it rebuilds the
trailing-window model using only the events that were confirmed earlier,
estimates that event's date the same way the page would have at the
time, and compares the estimate to what actually happened. The
resulting median/p75/p90/max absolute errors (in days) are reported in
the output alongside the current lag, as a running check on how
accurate this approach actually is.

NOTE: this script's field names (EventServerDetails.event/startTime/
endTime/server/image) were confirmed against the live table structure
at Special:CargoTables/EventServerDetails on arknights.wiki.gg -- that
page (like api.php itself) is blocked by the wiki's robots.txt to this
project's own research tooling, so it was checked by hand instead.
EventServerDetails carries one row per (event, server) pair, each with
its own `image` (the page's per-language banner art -- CN and Global
often use different key art for the same event), so the same query
already used for dates also gives us art for free; see pick_image()
below for how a per-event image is chosen from those rows.

Event art is mirrored into this repo (see resolve_image_urls()/
download_image()/localize_images()) rather than linked straight to
arknights.wiki.gg. That's not optional: confirmed live, the wiki's
image host sends a Cross-Origin-Resource-Policy header that makes a
browser refuse to embed it from another site at all
(NS_ERROR_DOM_CORP_FAILED in Firefox) -- a direct link to the same
image loads fine, only *embedding* it cross-site is blocked, so
hotlinking was never going to work no matter how the URL was built. A
plain server-side download isn't affected by CORP (that's a browser
embedding restriction, not a fetch restriction), so this downloads
each banner once into akgcc-extra-data/images/ and serves it from
there from then on -- skipping the download whenever a same-named
file already exists locally, so only a new or changed banner costs a
request on any given run.

The actual bytes are fetched via MediaWiki's imageinfo API (api.php),
not Special:FilePath -- also confirmed live, every single
Special:FilePath request from a GitHub Actions run came back a 403
with an HTML body (a bot-protection page) even though api.php's
cargoquery calls from that same run succeeded normally, which lines up
with robots.txt singling out the Special: namespace specifically. See
resolve_image_urls()'s own docstring.

New operators (fetch_event_operators()/group_operators_by_event()) come
from the wiki's own Operators table, via the `event` field it already
maintains linking an operator to the event that introduced (or
granted) them -- the same link operator_online.py's scrape_wiki()
already joins against to get each operator's Global release date, so
this isn't a new guess, just the same trusted linkage reused here. A
rerun event's own page is a separate event name from the original on
this wiki (see e.g. "X" vs "X - Rerun" in EventServerDetails), and
operators are only ever linked to the original, so a rerun naturally
ends up with no operators listed -- which is correct, since a rerun by
definition doesn't introduce anyone new. Operator portrait icons are
mirrored into the repo exactly like event banner art (see above),
resolved in the same batched imageinfo call as the banners rather than
a separate one.

New skins per event (attach_event_skins() and friends) have no direct
field to join against on either wiki -- confirmed live, arknights.wiki.gg's
own Skins Cargo table carries no event (or even populated id/skinGroup)
column, and prts.wiki has no skins-related Cargo table at all. Two wiki
*pages* carry the link instead:

1. The outfit *brand* pages ("Outfit/Test Collection", "Outfit/EPOQUE",
   ...): each lists every outfit released under that brand as an
   {{Outfit cell}} with a `release` field naming the event it came out
   with, and a `model` field naming the operator. This is the primary,
   authoritative source -- it covers minor events whose own page never
   lists their outfit (e.g. Greyy's "My Fellow Newsboy" with "Vector
   Breakthrough Trial from Misery"), and it wins over an event page that
   claims an outfit belonging to a different event. See
   fetch_outfit_brand_releases(); CN-only releases are skipped.
2. The event's own ==Outfits== section, used only for outfits no brand
   page lists at all (e.g. one too new for its brand page to have caught
   up). That page is only scraped for an event whose Global run is still
   ongoing/estimated, or finished too recently to trust the wiki's
   editors to have caught up yet -- see event_outfits_are_final(); once
   an event clears that bar its scraped result is cached forever in
   skin_outfit_cache.json rather than re-fetched on every run.

An outfit neither source ties to an event is left off the calendar
entirely -- guessing by release date was tried and removed, since an
unrelated shop-skin rotation landing on the same day as a SideStory is
indistinguishable from a real tie.
"""
import requests
import re
import os
import json
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

REQUEST_TIMEOUT = 30  # seconds, per attempt
REQUEST_RETRIES = 3
REQUEST_BACKOFF = 5  # seconds, multiplied by attempt number

# Pause between individual image-resolve batches and image downloads (see
# resolve_image_urls()/download_image()). Mirroring event banners alone
# only ever needed a handful of these calls per run, but the first run that
# also mirrors every operator's icon can send hundreds of consecutive
# requests -- far more api.php/CDN traffic in one run than this project had
# ever sent before, and confirmed live to trip something (every single
# resolve batch came back with an empty, non-JSON body) that a low-volume
# run never hit. A short pause between requests is cheap insurance against
# that; once every icon is mirrored once, later runs only fetch a handful
# of new ones per month and this barely adds any time.
REQUEST_PACING = 1  # seconds

# How many of the most recently Global-released confirmed events to take
# the "current lag" median from (see the module docstring). Matches the
# default window size myrtle.moe's own release-lag model uses.
RECENT_LAG_WINDOW_EVENTS = 10

# backtest() needs at least this many earlier confirmed events before it'll
# simulate a prediction for a given point -- an estimate built from 1-2
# data points isn't a meaningful test of the model, just noise.
MIN_BACKTEST_PRIOR = 3


def percentile(sorted_values, p):
    """Linear-interpolated percentile of an already-sorted list (p in
    [0, 1]). Returns 0.0 for an empty list rather than raising, since every
    caller here already treats "no data" as its own case."""
    n = len(sorted_values)
    if n == 0:
        return 0.0
    if n == 1:
        return sorted_values[0]
    rank = p * (n - 1)
    lo = int(rank)
    hi = min(lo + 1, n - 1)
    frac = rank - lo
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * frac


def http_get(url, **kwargs):
    kwargs.setdefault('timeout', REQUEST_TIMEOUT)
    last_exc = None
    for attempt in range(1, REQUEST_RETRIES + 1):
        try:
            return requests.get(url, **kwargs)
        except requests.exceptions.RequestException as exc:
            last_exc = exc
            print(f'Request to {url} failed (attempt {attempt}/{REQUEST_RETRIES}): {exc}')
            if attempt < REQUEST_RETRIES:
                time.sleep(REQUEST_BACKOFF * attempt)
    raise last_exc


WIKI_API = "https://arknights.wiki.gg/api.php"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
}


def parse_date(s):
    """Cargo date fields can come back as 'YYYY-MM-DD', with a time
    component, or occasionally empty/None. Try a few formats and give up
    (returning None) rather than crashing the whole run over one bad row."""
    if not s:
        return None
    s = str(s).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    print(f"Could not parse date: {s!r}")
    return None


OVERRIDES_PATH = "./overrides.json"


def load_overrides(path=OVERRIDES_PATH):
    """Manually-pinned Global dates for events Yostar/Hypergryph has
    announced or teased ahead of arknights.wiki.gg tracking a confirmed
    Global date for them -- or to correct a wiki data error without
    waiting on the wiki itself. This is the third tier alongside
    "confirmed" (from the wiki) and "estimated" (computed): it takes
    priority over an estimate, but never over an actual wiki-confirmed
    date, and only applies to an event that already has a CN date
    tracked (there's nothing to anchor an end date/duration to
    otherwise). See README.md for the exact file format.

    Hand-edited, and optional -- a missing or unreadable file just means
    no overrides today, not a crash. `overrides.json` starts out empty
    ({}) and is meant to be edited directly in the repo when needed."""
    try:
        with open(path) as f:
            raw = json.load(f)
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as exc:
        print(f"Could not read {path} (ignoring overrides): {exc}")
        return {}

    overrides = {}
    for event, ov in raw.items():
        start = parse_date(ov.get("globalStart"))
        if not start:
            print(f"Skipping override for {event!r}: no usable globalStart")
            continue
        overrides[event] = {
            "globalStart": start,
            "globalEnd": parse_date(ov.get("globalEnd")),
            "source": ov.get("source") or None,
            "note": ov.get("note") or None,
        }
    return overrides


def fetch_event_server_details():
    """Pull every (event, server, startTime, endTime, image) row. No
    `where` filter -- we don't know every server-name spelling in use
    (CN/global/TW/JP/KR), so grab everything and sort it out in Python."""
    rows = []
    offset = 0
    limit = 500
    while True:
        params = {
            "action": "cargoquery",
            "tables": "EventServerDetails",
            "fields": "EventServerDetails._pageName=page,EventServerDetails.event=event,EventServerDetails.startTime=startTime,EventServerDetails.endTime=endTime,EventServerDetails.server=server,EventServerDetails.image=image",
            "format": "json",
            "limit": limit,
            "offset": offset,
        }
        r = http_get(WIKI_API, params=params, headers=HEADERS)
        data = r.json()
        if "error" in data:
            raise RuntimeError(f"Cargo API error: {data['error']}")
        page_rows = data.get("cargoquery", [])
        for row in page_rows:
            rows.append(row["title"])
        offset += limit
        if len(page_rows) < limit:
            break
    return rows


def pick_image(servers):
    """Choose one banner image *filename* for an event out of its
    per-server rows -- EventServerDetails.image holds a bare wiki
    filename (confirmed by hand via Special:CargoQuery -- e.g. "EN A
    Death in Chunfen banner.png"), not a resolved URL, and it's kept
    that way here (see localize_images() for turning it into something
    servable). Prefers the Global server's own art, but falls back to
    another server's (usually CN) -- an event with no Global row yet
    (estimated or announced) is exactly the case where showing *some*
    preview art is most useful, and CN's banner is normally a close
    preview of what Global's will look like."""
    for key in ("global", "cn"):
        image = (servers.get(key) or {}).get("image")
        if image and str(image).strip():
            return str(image).strip()
    for server_entry in servers.values():
        image = server_entry.get("image")
        if image and str(image).strip():
            return str(image).strip()
    return None


def fetch_event_operators():
    """Pull every Operators row that's tied to an event via the table's
    own `event` field (see the module docstring) -- rarity, class, and
    portrait icon filename included so the calendar's preview panel can
    show more than just a name. `class` is aliased to `opClass` in the
    query since it's a reserved word in some SQL dialects Cargo's query
    layer sits on top of; safer to just not use it as an output key."""
    rows = []
    offset = 0
    limit = 500
    while True:
        params = {
            "action": "cargoquery",
            "tables": "Operators",
            "fields": (
                "Operators.event=event,"
                "Operators.operator=operator,"
                "Operators.rarity=rarity,"
                "Operators.class=opClass,"
                "Operators.icon=icon"
            ),
            "where": "Operators.event IS NOT NULL AND Operators.event != ''",
            "format": "json",
            "limit": limit,
            "offset": offset,
        }
        r = http_get(WIKI_API, params=params, headers=HEADERS)
        data = r.json()
        if "error" in data:
            raise RuntimeError(f"Cargo API error: {data['error']}")
        page_rows = data.get("cargoquery", [])
        for row in page_rows:
            rows.append(row["title"])
        offset += limit
        if len(page_rows) < limit:
            break
    return rows


def group_operators_by_event(rows):
    """{event name: [operator dicts]} from fetch_event_operators()'s raw
    rows, sorted highest-rarity-first (then name) within each event so
    the flagship 6-star of a banner shows up first in the preview panel.
    A row missing an event or operator name is dropped -- not enough to
    show anything useful."""
    by_event = {}
    for row in rows:
        # Stripped defensively -- this is matched below against
        # EventServerDetails' own `event` value (see build_events()),
        # which comes from a different Cargo table maintained somewhat
        # independently on the wiki, so incidental leading/trailing
        # whitespace on one side (but not the other) would otherwise be
        # an easy way for an operator to silently fail to match up.
        event = (row.get("event") or "").strip()
        name = row.get("operator")
        if not event or not name:
            continue
        op = {"name": name}
        try:
            rarity = int(row.get("rarity"))
        except (TypeError, ValueError):
            rarity = None
        if rarity is not None:
            op["rarity"] = rarity
        op_class = row.get("opClass")
        if op_class:
            op["class"] = op_class
        icon = row.get("icon")
        if icon:
            icon = str(icon).strip()
            # Operators.icon is a Cargo `File`-type field, unlike
            # EventServerDetails.image (a plain `String` field, and
            # already confirmed to come back as a bare filename with no
            # prefix). Confirmed live via Special:CargoQuery: a File-type
            # field comes back already carrying its namespace prefix
            # (e.g. "File:Qiubai icon.png"), so stripping it here keeps
            # `icon` on the same bare-filename convention the rest of
            # this pipeline (local_image_name/resolve_image_urls/
            # download_image) already assumes for `image` -- otherwise
            # every icon would get requested as the doubly-prefixed,
            # nonexistent title "File:File:Qiubai icon.png" and never
            # resolve.
            if icon.lower().startswith("file:"):
                icon = icon[len("file:") :].strip()
            if icon:
                op["icon"] = icon
        by_event.setdefault(event, []).append(op)
    for op_list in by_event.values():
        op_list.sort(key=lambda o: (-(o.get("rarity") or 0), o["name"]))
    return by_event


IMAGES_DIR = "./images"

# Where a locally-mirrored image is served from once committed -- mirrors
# EXTRA_DATA_REPO_RAW_BASE in js/config.js; if you fork this, update both
# together (and see the README's fork-setup section).
PUBLIC_IMAGE_BASE = "https://raw.githubusercontent.com/KaKuna285/akshop-history/main/akgcc-extra-data/images/"


def local_image_name(wiki_filename):
    """A filesystem/git/URL-safe local name for a wiki filename -- kept
    recognizable (so the repo's images/ folder stays human-browsable)
    but with spaces and anything that could be awkward across
    filesystems or in a URL path replaced with an underscore."""
    name = wiki_filename.strip().replace(" ", "_")
    return re.sub(r"[^A-Za-z0-9_.\-]", "_", name)


def resolve_image_urls(filenames):
    """Resolve a batch of bare wiki filenames to their real (CDN) upload
    URLs via MediaWiki's imageinfo API on api.php.

    This replaced an earlier version that fetched Special:FilePath
    directly: confirmed live in a workflow run, every single one of
    those requests came back a 403 with an HTML body (a bot-protection
    page, not the image), even though api.php's cargoquery calls from
    the very same run succeeded normally. That lines up with
    robots.txt also singling out the Special: namespace specifically
    (see the module docstring) -- the block is scoped to Special:
    pages, not to this project's requests in general, so routing
    through api.php (proven to work) instead of Special:FilePath sides
    steps it entirely.

    Batches up to 50 titles per request (MediaWiki's default limit for
    non-bot API access), with a short REQUEST_PACING pause between
    batches -- confirmed live, a run resolving hundreds of batches back
    to back (every operator icon's first-ever mirror, on top of any new
    event banners) got an empty, non-JSON body back from every single
    one, something a low-volume run never hit; the pause is cheap
    insurance against whatever rate-limiting or bot-protection that was.
    Returns {filename: resolved URL}, omitting any filename MediaWiki
    can't resolve (e.g. renamed/deleted/never existed) -- never raises,
    since one bad batch shouldn't take down the whole run."""
    resolved = {}
    filenames = list(filenames)
    batch_size = 50
    for i in range(0, len(filenames), batch_size):
        batch = filenames[i : i + batch_size]
        r = None
        try:
            params = {
                "action": "query",
                "titles": "|".join(f"File:{f}" for f in batch),
                "prop": "imageinfo",
                "iiprop": "url",
                "format": "json",
            }
            r = http_get(WIKI_API, params=params, headers=HEADERS)
            data = r.json()
            pages = data.get("query", {}).get("pages", {})
            for page in pages.values():
                title = page.get("title", "")
                filename = title[len("File:") :] if title.startswith("File:") else title
                imageinfo = page.get("imageinfo")
                if imageinfo and imageinfo[0].get("url"):
                    resolved[filename] = imageinfo[0]["url"]
        except Exception as exc:
            # r.text (not just the parse exception) is the useful part --
            # "Expecting value: line 1 column 1" alone just means "the body
            # wasn't JSON," not why; the status code and a body snippet is
            # what actually says whether that was rate-limiting, a bot-
            # protection page, or something else entirely.
            if r is not None:
                detail = f"status={r.status_code} body={r.text[:200]!r}"
            else:
                detail = str(exc)
            print(f"Could not resolve image batch starting at {batch[0]!r}: {detail}")
        if i + batch_size < len(filenames):
            time.sleep(REQUEST_PACING)
    return resolved


def download_image(wiki_filename, resolved_url):
    """Mirror one wiki banner into IMAGES_DIR from its already-resolved
    URL (see resolve_image_urls()). Skips the download entirely if a
    file with this name already exists locally -- the wiki filename
    itself changes whenever the actual art changes (a rerun gets
    " Rerun" appended to the filename, for example), so an unchanged
    filename means an unchanged image, and only a new or changed banner
    costs a request on any given run.

    Returns the local filename on success, None on any failure (no
    resolved URL, bad status, wrong content type, network error) --
    never raises, since one bad image shouldn't take down the whole
    run. Paces itself with REQUEST_PACING after every real network
    request (see resolve_image_urls()'s docstring for why) -- but only
    when it actually made one; the early returns above (already
    mirrored, or no resolved URL to try) don't touch the network at
    all, so there's nothing to pace there."""
    local_name = local_image_name(wiki_filename)
    local_path = os.path.join(IMAGES_DIR, local_name)
    if os.path.exists(local_path):
        return local_name
    if not resolved_url:
        print(f"Skipping image {wiki_filename!r}: could not resolve a real URL for it")
        return None
    try:
        r = http_get(resolved_url, headers=HEADERS)
        content_type = r.headers.get("Content-Type", "")
        if r.status_code != 200 or not content_type.startswith("image/"):
            print(
                f"Skipping image {wiki_filename!r}: "
                f"status={r.status_code} content-type={content_type!r}"
            )
            return None
        os.makedirs(IMAGES_DIR, exist_ok=True)
        with open(local_path, "wb") as f:
            f.write(r.content)
        return local_name
    except Exception as exc:
        print(f"Could not download image {wiki_filename!r}: {exc}")
        return None
    finally:
        time.sleep(REQUEST_PACING)


def localize_images(events, operators_by_event=None):
    """Replace each event's raw wiki filename (see pick_image()) with
    its locally-mirrored URL, and do the same for every new operator's
    portrait icon (see fetch_event_operators()) -- resolving and
    downloading each not-yet-mirrored file first (see
    resolve_image_urls()/download_image()). An event whose banner fails
    to download loses its image entirely, and an operator whose icon
    fails loses just its icon (the name/rarity/class stay), rather than
    linking to something broken or (as with the wiki directly) blocked.

    Only filenames not already mirrored locally are resolved at all --
    a single batched imageinfo call covering both event banners and
    operator icons together, rather than one API round-trip per image
    (or a second call just for icons), on top of the same skip-if-
    already-downloaded caching download_image() does."""
    operators_by_event = operators_by_event or {}
    needed = set()
    for entry in events:
        filename = entry.get("image")
        if filename and not os.path.exists(os.path.join(IMAGES_DIR, local_image_name(filename))):
            needed.add(filename)
    for op_list in operators_by_event.values():
        for op in op_list:
            filename = op.get("icon")
            if filename and not os.path.exists(os.path.join(IMAGES_DIR, local_image_name(filename))):
                needed.add(filename)
    resolved_urls = resolve_image_urls(needed) if needed else {}

    cache = {}

    def mirror(filename):
        if filename not in cache:
            cache[filename] = download_image(filename, resolved_urls.get(filename))
        return cache[filename]

    for entry in events:
        filename = entry.get("image")
        if not filename:
            continue
        local_name = mirror(filename)
        if local_name:
            entry["image"] = PUBLIC_IMAGE_BASE + quote(local_name)
        else:
            del entry["image"]

    for op_list in operators_by_event.values():
        for op in op_list:
            filename = op.get("icon")
            if not filename:
                continue
            local_name = mirror(filename)
            if local_name:
                op["icon"] = PUBLIC_IMAGE_BASE + quote(local_name)
            else:
                del op["icon"]

    return events


def backtest_lag_model(confirmed_pairs, window):
    """Simulates the trailing-window model against history: for every
    confirmed pair, rebuilds the model from only the pairs that were
    already confirmed *earlier* (by Global release order) than it, and
    compares what that model would have estimated to what actually
    happened. `confirmed_pairs` must already be sorted oldest-first by
    Global start, same as `build_events` produces.

    Returns a dict of {window, n, medianAbsErrDays, p75AbsErrDays,
    p90AbsErrDays, maxAbsErrDays} -- n is how many past events this
    actually got to test against (the first few, without enough prior
    history, are skipped)."""
    abs_errs = []
    for i, (gl_start, event, cn_start, actual_lag) in enumerate(confirmed_pairs):
        prior = confirmed_pairs[:i]
        if len(prior) < MIN_BACKTEST_PRIOR:
            continue
        model_lags = sorted(d for _, _, _, d in prior[-window:])
        predicted_lag = percentile(model_lags, 0.5)
        predicted_gl_start = cn_start + timedelta(days=predicted_lag)
        abs_err = abs((predicted_gl_start - gl_start).total_seconds()) / 86400
        abs_errs.append(abs_err)

    abs_errs.sort()
    n = len(abs_errs)
    return {
        "window": window,
        "n": n,
        "medianAbsErrDays": percentile(abs_errs, 0.5) if n else 0.0,
        "p75AbsErrDays": percentile(abs_errs, 0.75) if n else 0.0,
        "p90AbsErrDays": percentile(abs_errs, 0.9) if n else 0.0,
        "maxAbsErrDays": abs_errs[-1] if n else 0.0,
    }


SKIN_OUTFIT_CACHE_PATH = "./json/skin_outfit_cache.json"

# How long past an event's own confirmed Global end date to keep re-
# scraping its page anyway, before trusting the cache forever -- a short
# grace window for the wiki's own editors to actually add the Outfits
# section after the event wraps, rather than caching an empty result
# that was really just "nobody's gotten to it yet".
SKIN_CACHE_GRACE_DAYS = 2


def load_skin_outfit_cache(path=SKIN_OUTFIT_CACHE_PATH):
    """{wikiPage: {"skinNames": [...], "scrapedAt": iso}} -- every event
    page's own Outfits section is scraped at most once *ever* for an
    event whose Global run has actually finished (see
    event_outfits_are_final()); this is what makes that possible. A
    missing or unreadable file just means starting from an empty cache
    (a first-ever run, most likely), not a crash."""
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as exc:
        print(f"Could not read {path} (starting from an empty skin cache): {exc}")
        return {}


def save_skin_outfit_cache(cache, path=SKIN_OUTFIT_CACHE_PATH):
    with open(path, "w") as f:
        json.dump(cache, f, indent=2, sort_keys=True)


# Matches one {{Outfit list ...}} template invocation and captures
# everything up to its own closing "}}" -- confirmed live against
# several real event pages (see the module docstring) that this
# template is never itself nested inside another, so a plain non-greedy
# scan to the first "}}" is enough even though an unrelated *inner*
# template further down in the same invocation (e.g. an addendum's
# "{{I|Outfit Voucher|gridview=0}}") can close before the outer one
# does -- harmless here, since the "new=" parameter this is actually
# after always appears earlier in the template than any such addendum.
_OUTFIT_LIST_RE = re.compile(r"\{\{Outfit list(.*?)\}\}", re.DOTALL)
_OUTFIT_LIST_NEW_PARAM_RE = re.compile(r"\|\s*new\s*=\s*([^\n|]+)")


def parse_outfit_skin_names(wikitext):
    """Every skin name an event page's own ==Outfits== section lists as
    newly added to the Outfit Store, confirmed live against several
    real pages (e.g. "Crossing": "Lorem Ipsum, The Next Side Quest, The
    Bloodwing Rose" -- independently matching those same three skins'
    own EN getTime in skin_table.json). Skips the *other* flavor of
    this same template, the one used for the page's separate "Fashion
    Review" rotation (identified by its own "display=single" parameter)
    -- that one lists whichever outfits are newly featured in a site-
    wide showcase, not necessarily ones this event itself introduced.
    Most event pages have no ==Outfits== section at all (most events
    don't add a new paid outfit), which this returns as an empty list,
    not an error."""
    names = []
    for m in _OUTFIT_LIST_RE.finditer(wikitext or ""):
        body = m.group(1)
        if re.search(r"display\s*=\s*single", body):
            continue
        new_m = _OUTFIT_LIST_NEW_PARAM_RE.search(body)
        if not new_m:
            continue
        for name in new_m.group(1).split(","):
            # A skin name that itself contains a comma (rare, but real --
            # e.g. "Rainforest, Me, Rainbow") gets that comma HTML-entity-
            # escaped by whoever edits this template, specifically so it
            # isn't mistaken for another separator between names -- the
            # split above only ever breaks on an *unescaped* comma, so
            # decoding this back is safe to do after the fact, per piece.
            name = name.strip().replace("&comma;", ",")
            if name:
                names.append(name)
    return names


def fetch_event_outfit_skin_names(wiki_page):
    """Scrapes one event's own wiki page for parse_outfit_skin_names().
    Returns [] (not an error) for a missing/renamed page or a page with
    no Outfits section -- neither should take down the whole run."""
    try:
        params = {
            "action": "parse",
            "page": wiki_page,
            "prop": "wikitext",
            "format": "json",
        }
        r = http_get(WIKI_API, params=params, headers=HEADERS)
        data = r.json()
        if "error" in data:
            print(f"Couldn't fetch wikitext for {wiki_page!r}: {data['error']}")
            return []
        wikitext = ((data.get("parse") or {}).get("wikitext") or {}).get("*", "")
        return parse_outfit_skin_names(wikitext)
    except Exception as exc:
        print(f"Couldn't fetch wikitext for {wiki_page!r}: {exc}")
        return []


def fetch_skin_operator_names():
    """{skin display name: operator display name}, from the wiki's own
    Skins Cargo table (Skins.name/Skins.operator) -- one batched query
    covering every operator's every skin at once, cheap enough to just
    redo on every run (unlike the per-event wikitext scrape above,
    which is what actually needs the cache). This -- not a direct id
    lookup -- is how a scraped skin *name* gets back to charId: Skins.id
    is confirmed empty on every row checked live, and Skins.skinGroup
    too, so there's no event or id field on this table to join against
    directly; operator *name* is the only usable link it has, and
    fetch_operator_name_to_charid() below covers the rest of the way."""
    rows = []
    offset = 0
    limit = 500
    while True:
        params = {
            "action": "cargoquery",
            "tables": "Skins",
            "fields": "Skins.name=name,Skins.operator=operator",
            "format": "json",
            "limit": limit,
            "offset": offset,
        }
        r = http_get(WIKI_API, params=params, headers=HEADERS)
        data = r.json()
        if "error" in data:
            raise RuntimeError(f"Cargo API error: {data['error']}")
        page_rows = data.get("cargoquery", [])
        for row in page_rows:
            rows.append(row["title"])
        offset += limit
        if len(page_rows) < limit:
            break
    name_to_operator = {}
    for row in rows:
        name = (row.get("name") or "").strip()
        operator = (row.get("operator") or "").strip()
        if name and operator:
            name_to_operator[name] = operator
    return name_to_operator


_NORMALIZE_NAME_RE = re.compile(r"[^a-z0-9]+")


def normalize_skin_name(name):
    """Loose-match key for a skin name: lowercased, every run of
    non-alphanumeric characters (punctuation *and* whitespace alike)
    collapsed to nothing. Exists because the wiki's event-page text and
    its own Skins table aren't always typed identically by whoever last
    edited each one -- confirmed live, one event page's own Outfits
    list reads "Unstained Unshaken" while the Skins table (and the
    actual in-game skin) has it as "Unstained, Unshaken". An exact
    lookup only ever misses on punctuation/spacing like this, never on
    two genuinely different names colliding, so this is tried only as a
    *second* pass, after the exact lookup already failed -- see
    attach_event_skins()."""
    return _NORMALIZE_NAME_RE.sub("", name.lower())


def fetch_operator_name_to_charid():
    """Operator display name -> charId, from the wiki's own
    OperatorFiles table (F.name/F.id) -- the same fields/table
    operator_online.py's own scrape_wiki() already trusts for this
    exact mapping, fetched fresh here since these are two independent
    scripts with no shared state between runs."""
    rows = []
    offset = 0
    limit = 500
    while True:
        params = {
            "action": "cargoquery",
            "tables": "OperatorFiles",
            "fields": "OperatorFiles.name=name,OperatorFiles.id=charId",
            "where": "OperatorFiles.id IS NOT NULL",
            "format": "json",
            "limit": limit,
            "offset": offset,
        }
        r = http_get(WIKI_API, params=params, headers=HEADERS)
        data = r.json()
        if "error" in data:
            raise RuntimeError(f"Cargo API error: {data['error']}")
        page_rows = data.get("cargoquery", [])
        for row in page_rows:
            rows.append(row["title"])
        offset += limit
        if len(page_rows) < limit:
            break
    name_to_charid = {}
    for row in rows:
        name = (row.get("name") or "").strip()
        charid = row.get("charId")
        if name and charid:
            name_to_charid[name] = charid
    return name_to_charid


# Every outfit *brand* (Test Collection, EPOQUE, Made by 0011, ...) has its
# own wiki page under this prefix, listing every outfit released under that
# brand along with -- per outfit -- the event it was released alongside.
# Discovered dynamically (see fetch_outfit_brand_wikitexts()) rather than
# hard-coded, so a newly-added brand page is picked up with no code change.
OUTFIT_BRAND_PAGE_PREFIX = "Outfit/"

_OUTFIT_CELL_SPLIT_RE = re.compile(r"\{\{\s*Outfit cell\b", re.IGNORECASE)
_TEMPLATE_PARAM_LINE_RE = re.compile(r"^\|\s*([A-Za-z][A-Za-z ]*?)\s*=\s*(.*)$")
_WIKILINK_TARGET_RE = re.compile(r"\[\[([^\]|#]+)")
# A region marker on a release line: either a bracketed tag, e.g.
# "{{Color|[CN]}}" or "{{Color|code=00FFFF|[EN and KR]}}", or a leading
# "CN:" / "Global:" label, e.g. "*CN: [[X]]". The bracket lookarounds keep
# this from ever mistaking the opening "[" of a "[[wikilink]]" for a tag.
_RELEASE_REGION_MARKER_RE = re.compile(
    r"(?<!\[)\[(?!\[)([^\]]*)\]|^(CN|EN|Global)\s*:", re.IGNORECASE
)
_RELEASE_GLOBAL_WORD_RE = re.compile(r"\b(EN|Global)\b", re.IGNORECASE)


def parse_outfit_cells(wikitext):
    """[{"name", "model", "release"}, ...] for every {{Outfit cell ...}}
    on one brand page -- name is the outfit's own display name, model the
    operator it's for, release the raw (possibly multi-line) wikitext
    saying which event it came with. Parsed line by line rather than with
    one big regex: a value can run over several "*" bullet lines (the
    per-region releases of a collab outfit), and a plain regex lookahead
    for "the next parameter" proved fragile against those."""
    cells = []
    for chunk in _OUTFIT_CELL_SPLIT_RE.split(wikitext or "")[1:]:
        params = {}
        key = None
        for line in chunk.split("\n"):
            m = _TEMPLATE_PARAM_LINE_RE.match(line)
            if m:
                key = m.group(1).strip().lower()
                params[key] = m.group(2).strip()
            elif key is not None and line.lstrip().startswith("*"):
                params[key] += "\n" + line.strip()
        name = (params.get("name") or "").replace("&comma;", ",").strip()
        model = (params.get("model") or "").strip()
        if name and model:
            cells.append({"name": name, "model": model, "release": params.get("release", "")})
    return cells


def parse_outfit_release_targets(release):
    """Page titles of the *Global* event(s) an outfit's "release" field
    names, in order. Every pattern seen live across all brand pages:
    a plain "[[Event]]" (the overwhelming majority -- unmarked means
    Global/EN here); "[[Event]] (available from ... to ...)"; a CN-only
    "{{Color|[CN]}} [[Event]]" (not out on Global yet, so skipped -- the
    event it names is CN's, and this calendar is the Global one);
    several region lines like "*CN: [[A]]" / "*Global: [[B]]" or
    "*[CN and JP] [[A]]" / "*[EN and KR] [[B]]" (only the Global/EN line
    is kept); "Alongside ''[[Event]]''"; and plain text with no link at
    all (e.g. a web event or a bare date), which names no event and so
    yields nothing."""
    targets = []
    for line in (release or "").split("\n"):
        line = re.sub(r"^\*+\s*", "", line.strip())
        link = _WIKILINK_TARGET_RE.search(line)
        if not link:
            continue
        marker = _RELEASE_REGION_MARKER_RE.search(line)
        if marker:
            label = marker.group(1) if marker.group(1) is not None else marker.group(2)
            if not _RELEASE_GLOBAL_WORD_RE.search(label):
                continue
        targets.append(link.group(1).strip().replace("_", " "))
    return targets


def normalize_event_key(title):
    """Loose-match key for an event's wiki page title, so the Outfit
    pages' own spelling of an event lines up with this script's: they
    write a rerun / multi-part event as "X Rerun" / "X Part 2" (a redirect
    on the wiki), where EventServerDetails -- and so `wikiPage` here --
    has the real page title "X/Rerun" / "X/Part 2". Lowercased, with
    every run of non-alphanumerics (slash and spacing included) dropped,
    both spellings land on the same key, while "X" and "X Rerun" still
    stay distinct (confirmed live: no two tracked events collide)."""
    return _NORMALIZE_NAME_RE.sub("", title.replace("_", " ").lower())


def fetch_outfit_brand_wikitexts():
    """{page title: wikitext} for every "Outfit/<brand>" page, in one
    batched query (generator=allpages + prop=revisions) instead of one
    request per brand -- about 25 pages / 340 KB at time of writing, well
    inside a single response, but the continuation is still followed in
    case that ever grows past one batch."""
    wikitexts = {}
    params = {
        "action": "query",
        "generator": "allpages",
        "gapprefix": OUTFIT_BRAND_PAGE_PREFIX,
        "gapnamespace": 0,
        "gaplimit": 50,
        "prop": "revisions",
        "rvprop": "content",
        "rvslots": "main",
        "format": "json",
        "formatversion": 2,
    }
    for _ in range(20):  # hard ceiling -- never loop forever on a misbehaving continuation
        r = http_get(WIKI_API, params=params, headers=HEADERS)
        data = r.json()
        if "error" in data:
            raise RuntimeError(f"Outfit brand page query error: {data['error']}")
        for page in (data.get("query") or {}).get("pages", []):
            revisions = page.get("revisions") or []
            if revisions:
                content = ((revisions[0].get("slots") or {}).get("main") or {}).get("content", "")
                wikitexts[page["title"]] = content
        if "continue" not in data:
            break
        params.update(data["continue"])
    return wikitexts


def fetch_outfit_brand_releases():
    """[{"skinName", "operatorName", "targets": [event page title, ...]}]
    -- one entry per outfit across every brand page whose release field
    names at least one Global event. This is the authoritative skin ->
    event link: unlike an event page's own Outfits section (which some
    pages simply never fill in -- e.g. "Vector Breakthrough Trial from
    Misery" never lists Greyy's "My Fellow Newsboy", though its brand
    page, Outfit/EPOQUE, does name it), every outfit has to be listed on
    exactly one brand page, with its event, for the brand page to be
    complete at all."""
    releases = []
    for title, wikitext in fetch_outfit_brand_wikitexts().items():
        for cell in parse_outfit_cells(wikitext):
            targets = parse_outfit_release_targets(cell["release"])
            if targets:
                releases.append(
                    {"skinName": cell["name"], "operatorName": cell["model"], "targets": targets}
                )
    return releases


def index_outfit_brand_releases(releases):
    """(brand_by_event, claimed_pairs, claimed_names): brand_by_event maps
    normalize_event_key(event page) -> [{"skinName", "operatorName"}, ...];
    claimed_pairs / claimed_names are every (operator, normalized skin
    name) / normalized skin name some brand page assigned to *any* event
    -- tracked here or not -- which is what lets attach_event_skins() tell
    "an event page names a skin no brand page knows about" (keep it) from
    "an event page names a skin a brand page already assigned to a
    different event" (drop it; the brand page wins)."""
    brand_by_event = {}
    claimed_pairs = set()
    claimed_names = set()
    seen = set()
    for rel in releases:
        skin_key = normalize_skin_name(rel["skinName"])
        claimed_pairs.add((rel["operatorName"], skin_key))
        claimed_names.add(skin_key)
        for target in rel["targets"]:
            event_key = normalize_event_key(target)
            if (event_key, rel["operatorName"], skin_key) in seen:
                continue
            seen.add((event_key, rel["operatorName"], skin_key))
            brand_by_event.setdefault(event_key, []).append(
                {"skinName": rel["skinName"], "operatorName": rel["operatorName"]}
            )
    return brand_by_event, claimed_pairs, claimed_names


def event_outfits_are_final(ev, now):
    """Whether this event's own cached Outfits scrape can be trusted
    forever instead of re-fetched on every run: only once Yostar's
    actual Global date is confirmed (an estimate can still shift, which
    would shift which page even has the real Outfits section by then)
    *and* that window closed at least SKIN_CACHE_GRACE_DAYS ago, giving
    the wiki's own editors a little time to add the section after an
    event wraps. Anything not yet final gets re-scraped every run until
    it is -- cheap, since only a handful of events are ever in that
    state at once."""
    if not ev.get("globalConfirmed"):
        return False
    end = ev.get("globalEnd") or ev.get("globalStart")
    if not end:
        return False
    end_dt = datetime.fromisoformat(end)
    if end_dt.tzinfo is None:
        end_dt = end_dt.replace(tzinfo=timezone.utc)
    return now - end_dt > timedelta(days=SKIN_CACHE_GRACE_DAYS)


def attach_event_skins(events, cache):
    """Mutates every event in `events`, setting ev["skins"] = [{charId,
    skinName, operatorName}, ...] for each new outfit released alongside
    it. Two sources, in order of trust:

    1. The outfit *brand* pages (see fetch_outfit_brand_releases()) --
       every outfit is listed on one, with the event it came out with.
       Authoritative: an outfit's event is stated outright per outfit,
       so it holds up even for a minor event whose own page never lists
       its outfit at all, and it overrides an event page that wrongly
       claims someone else's outfit as its own.
    2. The event's own wiki page ==Outfits== section (see
       fetch_event_outfit_skin_names()), only for outfits *no* brand page
       lists at all -- e.g. one too new for its brand page to have caught
       up yet. `cache` is read and mutated in place (see
       load_skin_outfit_cache()) so a finalized event's page is scraped
       at most once ever -- see event_outfits_are_final().

    An outfit neither source ties to an event is simply left off the
    calendar entirely. An earlier version also had calendar.js guess at
    those with a nearest-event date match -- but confirmed live, that
    produced real wrong associations a date-only heuristic can't avoid
    (an unrelated shop-skin rotation landing on the same calendar day as
    a SideStory's release), so it was removed rather than tuned."""
    now = datetime.now(timezone.utc)

    # Brand pages are one cheap batched request, so unlike the per-event
    # page scrape below they're simply re-read on every run. If that
    # request fails, fall back to the event pages alone (the behavior
    # before brand pages were used) rather than losing skins outright.
    try:
        brand_releases = fetch_outfit_brand_releases()
    except Exception as exc:
        print(f"Couldn't read the Outfit brand pages (using event pages only): {exc}")
        brand_releases = []
    brand_by_event, claimed_pairs, claimed_names = index_outfit_brand_releases(brand_releases)
    print(f"{len(brand_releases)} outfit(s) across the Outfit brand pages name a Global event")

    # Fetched lazily -- only once some event actually has a skin to resolve.
    skin_to_operator = None
    skin_to_operator_normalized = None
    operator_to_charid = None

    def ensure_operator_lookup():
        nonlocal operator_to_charid
        if operator_to_charid is None:
            operator_to_charid = fetch_operator_name_to_charid()

    def ensure_skin_lookups():
        nonlocal skin_to_operator, skin_to_operator_normalized
        if skin_to_operator is None:
            skin_to_operator = fetch_skin_operator_names()
            # Second-pass lookup for a name the exact match misses only on
            # punctuation/spacing -- see normalize_skin_name(). Built once,
            # off the same query result, not refetched.
            skin_to_operator_normalized = {}
            for skin_name, operator_name in skin_to_operator.items():
                skin_to_operator_normalized.setdefault(normalize_skin_name(skin_name), operator_name)
        ensure_operator_lookup()

    scraped = 0
    for ev in events:
        wiki_page = ev.get("wikiPage") or ev.get("event")
        if not wiki_page:
            continue

        # --- 1. brand pages: authoritative ---
        skins = []
        for brand_skin in brand_by_event.get(normalize_event_key(wiki_page), []):
            ensure_operator_lookup()
            skin = dict(brand_skin)
            charid = operator_to_charid.get(skin["operatorName"])
            if charid:
                skin["charId"] = charid
            skins.append(skin)

        # --- 2. this event's own page, for outfits no brand page claims ---
        cached = cache.get(wiki_page)
        if cached is not None and event_outfits_are_final(ev, now):
            names = cached.get("skinNames", [])
        else:
            names = fetch_event_outfit_skin_names(wiki_page)
            cache[wiki_page] = {"skinNames": names, "scrapedAt": now.isoformat()}
            scraped += 1
            time.sleep(REQUEST_PACING)

        page_skins = []
        if names:
            ensure_skin_lookups()
            for name in names:
                operator_name = skin_to_operator.get(name)
                if not operator_name:
                    operator_name = skin_to_operator_normalized.get(normalize_skin_name(name))
                charid = operator_to_charid.get(operator_name) if operator_name else None
                skin = {"skinName": name}
                if operator_name:
                    skin["operatorName"] = operator_name
                if charid:
                    skin["charId"] = charid
                page_skins.append(skin)

            # Drop any entry that never resolved as a skin in its own right,
            # but whose raw text exactly matches some OTHER entry's already-
            # resolved operator name -- a one-off editorial slip confirmed
            # live on "The Masses' Travels/Rerun", where the page's own
            # new= list reads "Caelum Aeternum, Sankta Miksaparato" for
            # what is really just one skin ("Caelum Aeternum", tied to
            # operator Sankta Miksaparato): whoever wrote that page comma-
            # separated the skin from its own operator's name as if they
            # were two different skins. The comma split has no way to know
            # that ahead of time, so this is caught after the fact, by
            # noticing the leftover fragment is identical to a sibling
            # skin's own operator -- never flagged just for sharing a word.
            resolved_operator_names = {s["operatorName"] for s in page_skins if s.get("operatorName")}
            page_skins = [
                s for s in page_skins
                if s.get("operatorName") or s["skinName"] not in resolved_operator_names
            ]

        for skin in page_skins:
            skin_key = normalize_skin_name(skin["skinName"])
            operator_name = skin.get("operatorName")
            if operator_name:
                claimed = (operator_name, skin_key) in claimed_pairs
            else:
                claimed = skin_key in claimed_names
            if not claimed:
                skins.append(skin)

        if skins:
            ev["skins"] = skins
    print(f"Scraped {scraped} event page(s) for new-outfit names this run")
    return events


def build_events(rows, overrides=None, operators_by_event=None):
    overrides = overrides or {}
    operators_by_event = operators_by_event or {}
    # Group every row by event name, then by a normalized server key.
    by_event = {}
    # The wiki's actual page name for each event, kept separately from the
    # display name (`event`) -- they're usually the same, but the page name
    # is what a /wiki/<page> link actually needs, so it's tracked from the
    # already-fetched `page` field rather than guessed from `event`.
    wiki_page_by_event = {}
    for row in rows:
        # Stripped for the same reason as group_operators_by_event()'s own
        # event name -- this is the key looked up in operators_by_event
        # below, from a separately-maintained Cargo table.
        event = (row.get("event") or row.get("page") or "").strip()
        if not event:
            continue
        page = row.get("page")
        if page and event not in wiki_page_by_event:
            wiki_page_by_event[event] = page
        server_raw = (row.get("server") or "").strip()
        server_key = server_raw.lower()
        entry = by_event.setdefault(event, {})
        entry[server_key] = {
            "start": parse_date(row.get("startTime")),
            "end": parse_date(row.get("endTime")),
            "image": row.get("image"),
        }

    def clean_window(server_entry):
        """Returns (start, end) for a cn/global sub-dict, dropping an end
        date that's actually before its own start date (a mistyped year on
        the wiki, most likely) rather than trusting it -- otherwise it can
        produce a negative duration, and downstream an estimated globalEnd
        earlier than globalStart."""
        if not server_entry or not server_entry.get("start"):
            return None, None
        start = server_entry["start"]
        end = server_entry.get("end")
        if end and end < start:
            end = None
        return start, end

    def lag_days(cn_start, gl_start):
        """CN->Global lag in days, or None if it's not a usable
        observation. A non-positive lag isn't real data -- it means the
        wiki has the same (or an inverted) date recorded for both
        servers, not that Global actually shipped same-day as CN."""
        d = (gl_start - cn_start).days
        return d if d > 0 else None

    # Every event where both a CN and a Global date are known and the lag
    # between them is usable, in Global release order (oldest first) --
    # this is the basis for both the current estimate and the backtest
    # below. `by_event` isn't ordered usefully (it's insertion order from
    # the raw rows), so this is its own sorted pass.
    confirmed_pairs = []
    for event, servers in by_event.items():
        cn_start, _ = clean_window(servers.get("cn"))
        gl_start, _ = clean_window(servers.get("global"))
        if not (cn_start and gl_start):
            continue
        d = lag_days(cn_start, gl_start)
        if d is not None:
            confirmed_pairs.append((gl_start, event, cn_start, d))
    confirmed_pairs.sort(key=lambda p: p[0])

    def median_lag(pairs):
        if not pairs:
            return None
        return percentile(sorted(d for _, _, _, d in pairs), 0.5)

    # All-time median, across every confirmed pair regardless of date.
    # Not used to build any estimate -- purely a reference point, shown
    # alongside the current lag so it's obvious how far the current pace
    # has drifted from the historical one.
    median_lag_days = median_lag(confirmed_pairs)

    # The lag actually applied to every estimate below: the median lag
    # from just the last RECENT_LAG_WINDOW_EVENTS confirmed pairs (or
    # fewer, early on when that many don't exist yet).
    estimate_lag_days = median_lag(confirmed_pairs[-RECENT_LAG_WINDOW_EVENTS:])

    backtest = backtest_lag_model(confirmed_pairs, RECENT_LAG_WINDOW_EVENTS)

    # Split into events with a CN date (which can be estimated below) and
    # events with only a Global date (rare -- e.g. Global-exclusive
    # content -- these are just included as-is, since they're already
    # fully known).
    with_cn = []
    without_cn = []
    for event, servers in by_event.items():
        cn_start, cn_end = clean_window(servers.get("cn"))
        gl_start, gl_end = clean_window(servers.get("global"))
        if cn_start:
            with_cn.append((cn_start, event, cn_end, gl_start, gl_end))
        elif gl_start:
            without_cn.append((event, gl_start, gl_end))
        # else: no usable date at all for this event -- dropped.

    with_cn.sort(key=lambda t: t[0])

    out = []
    for cn_start, event, cn_end, gl_start, gl_end in with_cn:
        entry = {"event": event}
        wiki_page = wiki_page_by_event.get(event)
        if wiki_page:
            entry["wikiPage"] = wiki_page
        image = pick_image(by_event[event])
        if image:
            entry["image"] = image
        operators = operators_by_event.get(event)
        if operators:
            entry["operators"] = operators
        entry["cnStart"] = cn_start.isoformat()
        entry["cnEnd"] = cn_end.isoformat() if cn_end else None

        if gl_start:
            # Confirmed: Yostar has actually set/run this date.
            entry["globalStart"] = gl_start.isoformat()
            entry["globalEnd"] = gl_end.isoformat() if gl_end else None
            entry["globalConfirmed"] = True
        elif event in overrides:
            # Announced: not yet in the wiki's own confirmed data, but
            # manually pinned -- see load_overrides(). Takes priority
            # over the computed estimate, but is still not "confirmed"
            # (that's reserved for what the wiki itself has tracked).
            ov = overrides[event]
            ov_start = ov["globalStart"]
            ov_end = ov["globalEnd"]
            if not ov_end:
                duration = (cn_end - cn_start) if cn_end else timedelta(days=0)
                ov_end = ov_start + duration
            entry["globalStart"] = ov_start.isoformat()
            entry["globalEnd"] = ov_end.isoformat()
            entry["globalConfirmed"] = False
            entry["announced"] = True
            if ov["source"]:
                entry["source"] = ov["source"]
            if ov["note"]:
                entry["note"] = ov["note"]
        elif estimate_lag_days is not None:
            # Not yet confirmed: this event's own CN date plus the
            # currently-applicable lag (see above).
            est_start = cn_start + timedelta(days=estimate_lag_days)
            duration = (cn_end - cn_start) if cn_end else timedelta(days=0)
            entry["globalStart"] = est_start.isoformat()
            entry["globalEnd"] = (est_start + duration).isoformat()
            entry["globalConfirmed"] = False
        else:
            # No lag data at all to estimate from yet -- nothing usable.
            continue

        out.append(entry)

    for event, gl_start, gl_end in without_cn:
        entry = {
            "event": event,
            "globalStart": gl_start.isoformat(),
            "globalEnd": gl_end.isoformat() if gl_end else None,
            "globalConfirmed": True,
        }
        wiki_page = wiki_page_by_event.get(event)
        if wiki_page:
            entry["wikiPage"] = wiki_page
        image = pick_image(by_event[event])
        if image:
            entry["image"] = image
        operators = operators_by_event.get(event)
        if operators:
            entry["operators"] = operators
        out.append(entry)

    out.sort(key=lambda e: e["globalStart"])

    return out, median_lag_days, estimate_lag_days, backtest


if __name__ == "__main__":
    rows = fetch_event_server_details()
    print(f"Fetched {len(rows)} EventServerDetails rows")
    overrides = load_overrides()
    print(f"Loaded {len(overrides)} manual overrides")
    operator_rows = fetch_event_operators()
    operators_by_event = group_operators_by_event(operator_rows)
    print(
        f"Fetched {len(operator_rows)} Operators rows tied to an event, "
        f"across {len(operators_by_event)} events"
    )
    events, median_lag_days, current_lag_days, backtest = build_events(
        rows, overrides, operators_by_event
    )
    events = localize_images(events, operators_by_event)
    with_image = sum(1 for e in events if e.get("image"))
    with_operators = sum(1 for e in events if e.get("operators"))
    print(f"{with_image}/{len(events)} events have art, {with_operators}/{len(events)} list new operators")

    # New-skins-per-event -- see attach_event_skins()'s own docstring for
    # why this needs a persistent cache rather than just another scraped
    # table like operators_by_event above. Wrapped defensively so a wiki
    # hiccup here (a bad Cargo query, a timeout on one page fetch) can't
    # take down a run that otherwise successfully built every event's
    # dates/operators -- worst case this run's events.json just carries
    # whatever skins were already cached from a previous run, if any.
    try:
        skin_outfit_cache = load_skin_outfit_cache()
        events = attach_event_skins(events, skin_outfit_cache)
        save_skin_outfit_cache(skin_outfit_cache)
        with_skins = sum(1 for e in events if e.get("skins"))
        print(f"{with_skins}/{len(events)} events list new skins")
    except Exception as exc:
        print(f"Couldn't attach new-skin data to events (leaving events.json's skins as-is): {exc}")
    print(
        f"Built {len(events)} events; median CN->Global lag = {median_lag_days} days, "
        f"current CN->Global lag = {current_lag_days} days"
    )
    print(
        f"Backtest ({backtest['n']} points, window={backtest['window']} events): "
        f"median err = {backtest['medianAbsErrDays']:.1f}d, "
        f"p75 = {backtest['p75AbsErrDays']:.1f}d, "
        f"p90 = {backtest['p90AbsErrDays']:.1f}d, "
        f"max = {backtest['maxAbsErrDays']:.1f}d"
    )
    with open("./json/events.json", "w") as f:
        json.dump(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "medianLagDays": median_lag_days,
                "currentLagDays": current_lag_days,
                "backtest": backtest,
                "events": events,
            },
            f,
        )
