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
        if icon and str(icon).strip():
            op["icon"] = str(icon).strip()
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
