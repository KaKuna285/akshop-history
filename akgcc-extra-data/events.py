"""Get past + upcoming EN (Global) event dates and write json/events.json.

Yostar (the EN publisher) only confirms an event's Global date a week or
two ahead. arknights.wiki.gg tracks each event's CN date and, once
known, its confirmed Global date; for the gap in between, this script
estimates the Global date.

The estimate is the event's CN date plus a lag: the median CN->Global
lag of the last RECENT_LAG_WINDOW_EVENTS confirmed events (in Global
release order), recomputed every run. A median over several events keeps
one unusually fast or slow event from moving every estimate, while the
trailing window follows real changes in localization pace much faster
than an all-time average would. Pairs with a non-positive lag are
dropped (the wiki has the same or an inverted date for both servers).
The all-time median is also written out, for comparison only.

backtest_lag_model() checks the model against history: for each past
confirmed event it rebuilds the model from the events confirmed before
it, estimates that event's date, and compares it with what happened.
The median/p75/p90/max absolute errors (days) go into the output.

Data sources (arknights.wiki.gg Cargo tables, via api.php):
- EventServerDetails (event/startTime/endTime/server/image): one row
  per (event, server). `image` is that server's banner art; CN and
  Global often differ (see pick_image()).
- Operators, via its `event` field: the operators an event introduced
  (the same link operator_online.py uses for Global release dates).
  A rerun is its own event name on the wiki and operators link only to
  the original, so reruns correctly list no new operators.

Event banners and operator icons are mirrored into
akgcc-extra-data/images/ (resolve_image_urls() / download_image() /
localize_images()) instead of linked from the wiki: the wiki's image
host sends a Cross-Origin-Resource-Policy header, so browsers refuse to
embed its images on another site. A server-side download isn't affected.
Files are resolved through MediaWiki's imageinfo API rather than
Special:FilePath, which returns a bot-protection 403 to GitHub Actions.

New skins per event (attach_event_skins()) have no event field on the
wiki's Skins table, so two kinds of page supply the link:

1. The outfit *brand* pages ("Outfit/Test Collection", "Outfit/EPOQUE",
   ...): each {{Outfit cell}} has a `release` field naming the event it
   came with and a `model` field naming the operator. This is the
   authoritative source: it covers minor events whose own page never
   lists their outfit, and it wins over an event page that claims an
   outfit from a different event. See fetch_outfit_brand_releases().
2. The event's own ==Outfits== section, only for outfits no brand page
   lists (e.g. one too new for its brand page). An event page is
   re-scraped until the event is final (see event_outfits_are_final()),
   then cached for good in skin_outfit_cache.json.

An outfit neither source ties to an event is left off the calendar: a
match by release date alone can't tell a real tie from an unrelated
shop-skin rotation on the same day.

Integrated Strategies / Reclamation Algorithm themes are game modes, not
EventServerDetails rows, so their dates come from each mode page's
{{Game mode themes cell}} entries and are added as extra events (see
fetch_game_mode_theme_rows()). They're tagged with `mode`, given a
fixed-length window when the wiki has no end date, and kept out of the
lag model; see GAME_MODE_THEME_DAYS and build_events().
"""
import hashlib
import re
from difflib import SequenceMatcher
import os
import json
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from common import http_get, parse_date

# Pause between image-resolve batches and image downloads (see
# resolve_image_urls()/download_image()). Hundreds of back-to-back
# requests (e.g. mirroring every operator icon at once) get empty,
# non-JSON responses from the wiki; once everything is mirrored, a run
# only fetches a few new images, so this costs little time.
REQUEST_PACING = 1  # seconds

# How many of the most recently Global-released confirmed events to take
# the "current lag" median from (see the module docstring). Matches the
# default window size myrtle.moe's own release-lag model uses.
RECENT_LAG_WINDOW_EVENTS = 10

# backtest_lag_model() only tests an event with at least this many earlier
# confirmed events to build the model from; 1-2 data points are just noise.
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


# Parts of a run that failed without taking the whole run down (the
# game-mode themes, the skin scrape, a batch of image downloads, ...).
# Each is wrapped in its own try/except so one wiki hiccup doesn't cost
# every event its dates, which also makes them silent: the run stays green
# with less data. note_degraded() collects them; they're written into
# events.json as `warnings` (the calendar shows "some details may be
# incomplete") and read by health.py for json/meta.json and the workflow's
# failure issue.
RUN_WARNINGS = []


def note_degraded(step, message):
    print(f"[degraded] {step}: {message}")
    RUN_WARNINGS.append({"step": step, "message": message})


def any_note_for(step):
    return any(w["step"] == step for w in RUN_WARNINGS)


WIKI_API = "https://arknights.wiki.gg/api.php"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
}


OVERRIDES_PATH = "./overrides.json"


def load_overrides(path=OVERRIDES_PATH):
    """Hand-pinned Global dates from overrides.json: for events Yostar has
    announced before the wiki tracks a confirmed date, or to correct a
    wiki data error. This "announced" tier beats an estimate but never a
    wiki-confirmed date, and only applies to an event with a CN date (to
    anchor its duration). See README.md for the file format.

    Optional: a missing or unreadable file means no overrides."""
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
    per-server rows. EventServerDetails.image is a bare wiki filename
    (e.g. "EN A Death in Chunfen banner.png"), kept as is here (see
    localize_images() for turning it into something servable). Prefers the Global server's own art, but falls back to
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
    """Pull every Operators row tied to an event via the table's `event`
    field (see the module docstring), with rarity, class and portrait icon
    filename for the calendar's preview panel. `class` is aliased to
    `opClass` since it's a reserved word in SQL."""
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
        # Stripped: matched below against EventServerDetails' `event` (see
        # build_events()), a separately maintained table where stray
        # whitespace on one side would silently break the match.
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
            # Operators.icon is a Cargo `File` field, which comes back with
            # its namespace ("File:Qiubai icon.png"). Strip it so `icon` is a
            # bare filename like `image`, as local_image_name()/
            # resolve_image_urls()/download_image() expect.
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


# Mirrored images are stored as WebP, scaled down to at most this width.
# The wiki's banners are 1560x500 PNGs of ~1.2 MB each -- 230+ MB in all,
# downloaded in full by every daily Action checkout and by every visitor
# who opens a preview. The calendar shows a banner at most ~640 CSS px
# wide (.eventPreview's max-width), so 1280 px stays sharp on 2x screens;
# as WebP that's ~5-10% of the original size. Smaller images (operator
# icons, 180x180) are only re-encoded, never upscaled.
MIRROR_MAX_WIDTH = 1280
MIRROR_WEBP_QUALITY = 82
# Conversions that failed this run (kept as the original instead) --
# reported by localize_images() as a degraded run, since a missing Pillow
# would otherwise quietly bring back full-size PNGs.
IMAGE_CONVERT_FAILURES = []


def legacy_image_name(wiki_filename):
    """A filesystem/git/URL-safe version of the wiki filename (spaces and
    anything awkward replaced with an underscore), original extension
    kept. The stem of the WebP mirror's name, and the name a file is kept
    under when WebP conversion fails or an older unconverted copy exists
    (see download_image())."""
    name = wiki_filename.strip().replace(" ", "_")
    return re.sub(r"[^A-Za-z0-9_.\-]", "_", name)


def local_image_name(wiki_filename):
    """The mirrored file's local name: the legacy name with its extension
    swapped for .webp ("CN_Yet_Another_Wave_banner.png" ->
    "CN_Yet_Another_Wave_banner.webp"). A wiki name with characters the
    safe name had to replace (anything outside A-Z, 0-9, space, _ . -)
    also gets a short hash of the full wiki name, so two names that differ
    only in those characters ("Młynar icon.png" / "Mlynar icon.png", or a
    Chinese title) can't end up sharing one file."""
    stem = os.path.splitext(legacy_image_name(wiki_filename))[0]
    if re.search(r"[^A-Za-z0-9 _.\-]", wiki_filename.strip()):
        stem += "_" + hashlib.sha1(wiki_filename.strip().encode("utf8")).hexdigest()[:8]
    return stem + ".webp"


# Which wiki file (and which version of it, by the SHA-1 the wiki reports)
# each mirrored image came from: {wiki filename: {"file": local name,
# "sha1": ...}}. The wiki keeps a file's name when someone uploads new art
# over it, so the name alone can't tell an updated image from an
# unchanged one -- the SHA-1 can (see download_image()).
def image_manifest_path():
    return os.path.join(IMAGES_DIR, "manifest.json")


def load_image_manifest():
    try:
        with open(image_manifest_path(), encoding="utf8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_image_manifest(manifest):
    os.makedirs(IMAGES_DIR, exist_ok=True)
    tmp = image_manifest_path() + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=0, sort_keys=True)
    os.replace(tmp, image_manifest_path())


def to_webp(data):
    """Re-encode image bytes as WebP, scaled down to MIRROR_MAX_WIDTH if
    wider (aspect ratio kept). Transparency is kept. Raises on anything
    Pillow can't read."""
    from io import BytesIO

    from PIL import Image

    with Image.open(BytesIO(data)) as im:
        im.load()
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if ("transparency" in im.info or im.mode in ("LA", "PA", "P")) else "RGB")
        if im.width > MIRROR_MAX_WIDTH:
            height = max(1, round(im.height * MIRROR_MAX_WIDTH / im.width))
            im = im.resize((MIRROR_MAX_WIDTH, height), Image.LANCZOS)
        out = BytesIO()
        im.save(out, "WEBP", quality=MIRROR_WEBP_QUALITY, method=6)
        return out.getvalue()


def write_mirrored_image(wiki_filename, data):
    """Save image bytes as the WebP mirror. If conversion fails (Pillow
    missing, an unreadable format), the original bytes are kept under the
    legacy name instead, so the image still works -- returns whichever
    local name was written."""
    os.makedirs(IMAGES_DIR, exist_ok=True)
    try:
        webp = to_webp(data)
    except Exception as exc:
        print(f"Couldn't convert {wiki_filename!r} to WebP, keeping the original: {exc}")
        IMAGE_CONVERT_FAILURES.append(wiki_filename)
        name = legacy_image_name(wiki_filename)
        with open(os.path.join(IMAGES_DIR, name), "wb") as f:
            f.write(data)
        return name
    name = local_image_name(wiki_filename)
    tmp = os.path.join(IMAGES_DIR, name + ".tmp")
    with open(tmp, "wb") as f:
        f.write(webp)
    os.replace(tmp, os.path.join(IMAGES_DIR, name))
    return name


def resolve_image_urls(filenames):
    """Resolve a batch of bare wiki filenames to their real (CDN) upload
    URLs via MediaWiki's imageinfo API on api.php.

    (Special:FilePath would be simpler, but it returns a bot-protection
    403 to GitHub Actions; api.php doesn't.)

    Batches up to 50 titles per request (MediaWiki's limit for non-bot
    API access), pausing REQUEST_PACING between batches: hundreds of
    back-to-back requests get empty, non-JSON responses.
    Returns {filename: info}, omitting any filename MediaWiki
    can't resolve (e.g. renamed/deleted/never existed) -- never raises,
    since one bad batch shouldn't take down the whole run. Each value is
    {"url": ..., "sha1": ...} -- the SHA-1 of the wiki's current version
    of the file, which is how a re-uploaded image is noticed."""
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
                "iiprop": "url|sha1",
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
                    resolved[filename] = {"url": imageinfo[0]["url"], "sha1": imageinfo[0].get("sha1")}
        except Exception as exc:
            # Include the status and a body snippet: they show whether this
            # was rate limiting, a bot-protection page or something else,
            # which the parse error alone doesn't.
            if r is not None:
                detail = f"status={r.status_code} body={r.text[:200]!r}"
            else:
                detail = str(exc)
            print(f"Could not resolve image batch starting at {batch[0]!r}: {detail}")
        if i + batch_size < len(filenames):
            time.sleep(REQUEST_PACING)
    return resolved


def download_image(wiki_filename, info, manifest=None):
    """Mirror one wiki image into IMAGES_DIR. `info` is its entry from
    resolve_image_urls() ({"url", "sha1"}, or None if it couldn't be
    resolved this run); `manifest` is the image manifest (see
    load_image_manifest()), updated in place.

    An image already mirrored is only downloaded again when the wiki's
    SHA-1 for it differs from the one recorded when it was mirrored -- the
    wiki keeps the file name when new art is uploaded over it. An image
    with no recorded SHA-1 gets today's recorded, without a download. A
    failed re-download keeps the old copy.

    Returns the local filename on success, None on any failure for a not
    yet mirrored image (no resolved URL, bad status, wrong content type,
    network error) -- never raises, since one bad image shouldn't take down
    the whole run. Paces itself with REQUEST_PACING after every real
    network request (see REQUEST_PACING)."""
    manifest = manifest if manifest is not None else {}
    sha1 = (info or {}).get("sha1")
    url = (info or {}).get("url")
    local_name = local_image_name(wiki_filename)
    recorded = manifest.get(wiki_filename) or {}

    def record(name):
        entry = {"file": name}
        if sha1 or recorded.get("sha1"):
            entry["sha1"] = sha1 or recorded.get("sha1")
        manifest[wiki_filename] = entry
        return name

    if os.path.exists(os.path.join(IMAGES_DIR, local_name)):
        changed = sha1 and recorded.get("sha1") and recorded["sha1"] != sha1
        if not changed:
            return record(local_name)
        print(f"Image {wiki_filename!r} changed on the wiki -- downloading the new version")
    else:
        # An unconverted local copy (the legacy name): convert it to WebP
        # without downloading and remove the original.
        legacy_name = legacy_image_name(wiki_filename)
        legacy_path = os.path.join(IMAGES_DIR, legacy_name)
        if legacy_name != local_name and os.path.exists(legacy_path):
            with open(legacy_path, "rb") as f:
                data = f.read()
            written = write_mirrored_image(wiki_filename, data)
            if written == local_name:
                os.remove(legacy_path)
            return record(written)
    have_copy = os.path.exists(os.path.join(IMAGES_DIR, local_name))
    if not url:
        if have_copy:
            return local_name
        print(f"Skipping image {wiki_filename!r}: could not resolve a real URL for it")
        return None
    try:
        r = http_get(url, headers=HEADERS)
        content_type = r.headers.get("Content-Type", "")
        if r.status_code != 200 or not content_type.startswith("image/"):
            print(
                f"Skipping image {wiki_filename!r}: "
                f"status={r.status_code} content-type={content_type!r}"
            )
            return local_name if have_copy else None
        return record(write_mirrored_image(wiki_filename, r.content))
    except Exception as exc:
        print(f"Could not download image {wiki_filename!r}: {exc}")
        return local_name if have_copy else None
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

    Every image is resolved each run -- batched imageinfo calls covering
    event banners and operator icons together, 50 per request -- because
    the SHA-1 that comes back is how download_image() notices art that was
    replaced on the wiki under the same name. Only new or changed images
    are actually downloaded."""
    operators_by_event = operators_by_event or {}
    needed = set()
    for entry in events:
        if entry.get("image"):
            needed.add(entry["image"])
    for op_list in operators_by_event.values():
        for op in op_list:
            if op.get("icon"):
                needed.add(op["icon"])
    resolved = resolve_image_urls(sorted(needed)) if needed else {}
    manifest = load_image_manifest()

    cache = {}

    def mirror(filename):
        if filename not in cache:
            cache[filename] = download_image(filename, resolved.get(filename), manifest)
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

    # One image that won't download (a file deleted from the wiki, say) is
    # routine and would just nag on every run, so only a pattern counts:
    # at least two failures making up half or more of what was attempted
    # is what a blocked/rate-limited image host looks like.
    save_image_manifest(manifest)
    failed = sum(1 for v in cache.values() if v is None)
    if failed >= 2 and failed * 2 >= len(cache):
        note_degraded("images", f"{failed} of {len(cache)} image downloads failed this run")
    if IMAGE_CONVERT_FAILURES:
        note_degraded(
            "images",
            f"{len(IMAGE_CONVERT_FAILURES)} image(s) couldn't be converted to WebP and were kept as-is "
            f"(first: {IMAGE_CONVERT_FAILURES[0]})",
        )

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


# Matches one {{Outfit list ...}} template and captures everything up to
# the first "}}". The template is never nested, and the "new=" parameter
# read from it always comes before any inner template (e.g.
# "{{I|Outfit Voucher|gridview=0}}") whose "}}" could end the match early.
_OUTFIT_LIST_RE = re.compile(r"\{\{Outfit list(.*?)\}\}", re.DOTALL)
_OUTFIT_LIST_NEW_PARAM_RE = re.compile(r"\|\s*new\s*=\s*([^\n|]+)")


def parse_outfit_skin_names(wikitext):
    """Every skin name an event page's own ==Outfits== section lists as
    newly added to the Outfit Store (e.g. "Crossing": "Lorem Ipsum, The
    Next Side Quest, The Bloodwing Rose"). Skips the *other* flavor of
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
            # A comma inside a skin name ("Rainforest, Me, Rainbow") is
            # HTML-entity-escaped on the wiki so it isn't read as a separator;
            # the split above only breaks on unescaped commas, so decode each
            # piece afterwards.
            name = name.strip().replace("&comma;", ",")
            if name:
                names.append(name)
    return names


def fetch_event_outfit_skin_names(wiki_page):
    """Scrapes one event's own wiki page for parse_outfit_skin_names().
    Returns [] (not an error) for a missing/renamed page or a page with
    no Outfits section -- neither should take down the whole run -- but
    None when the request itself failed (a timeout, a rate limit, an API
    error): "couldn't ask" must stay distinguishable from "asked, and
    there are none", or attach_event_skins() would cache a transient
    failure as an empty list and, for a finished event, trust it forever."""
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
            code = (data["error"] or {}).get("code") if isinstance(data["error"], dict) else None
            return [] if code == "missingtitle" else None
        wikitext = ((data.get("parse") or {}).get("wikitext") or {}).get("*", "")
        return parse_outfit_skin_names(wikitext)
    except Exception as exc:
        print(f"Couldn't fetch wikitext for {wiki_page!r}: {exc}")
        return None


def fetch_skin_operator_names():
    """{skin display name: operator display name}, from the wiki's own
    Skins Cargo table (Skins.name/Skins.operator) -- one batched query
    covering every operator's every skin at once, cheap enough to just
    redo on every run (unlike the per-event wikitext scrape above,
    which is what actually needs the cache). Skins.id and Skins.skinGroup
    are empty on the wiki, so operator *name* is the only link from a
    skin to its operator; fetch_operator_name_to_charid() maps that on to
    a charId."""
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
    edited each one -- e.g. an event page's Outfits list reads
    "Unstained Unshaken" while the Skins table (and the
    actual in-game skin) has it as "Unstained, Unshaken". An exact
    lookup only ever misses on punctuation/spacing like this, never on
    two genuinely different names colliding, so this is tried only as a
    *second* pass, after the exact lookup already failed -- see
    attach_event_skins()."""
    return _NORMALIZE_NAME_RE.sub("", name.lower())


# Two spellings of one operator's skin count as the same outfit above this
# similarity (on normalize_skin_name() keys), e.g. "Summer Flowers FA240"
# on a brand page vs "Summer Flower FA240" on the event page. Only skins
# of the *same* operator are compared, so two different outfits would have
# to be near-identical in name *and* share an operator to merge.
SKIN_NAME_SIMILARITY = 0.9


def skin_keys_match(a, b):
    """Same outfit, allowing a small spelling slip. The digits must agree
    exactly, though: many outfits are numbered codes ("Holiday HD91" vs
    "Holiday HD92", "Summer Flowers FA098" vs "FA099"), which are
    different outfits that look 90%+ alike as plain text."""
    if a == b:
        return True
    if re.sub(r"\D", "", a) != re.sub(r"\D", "", b):
        return False
    return SequenceMatcher(None, a, b).ratio() >= SKIN_NAME_SIMILARITY


def fetch_operator_name_to_charid():
    """Operator display name -> charId, from the wiki's own
    OperatorFiles table (F.name/F.id), the same mapping
    operator_online.py's scrape_wiki() uses."""
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
    for "the next parameter" is fragile against those."""
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
    """[{"title": event page title, "cnOnly": bool}, ...] -- the event(s)
    an outfit's "release" field names. Patterns used on the brand pages: a plain "[[Event]]" (the overwhelming majority --
    unmarked means Global/EN here); "[[Event]] (available from ... to
    ...)"; "Alongside ''[[Event]]''"; a CN-only "{{Color|[CN]}}
    [[Event]]"; several region lines like "*CN: [[A]]" / "*Global: [[B]]"
    or "*[CN and JP] [[A]]" / "*[EN and KR] [[B]]"; and plain text with no
    link at all (a web event, a bare date), which names no event and so
    yields nothing.

    If any line is Global/EN (or unmarked) only those are returned -- the
    outfit's Global release is known, so a CN line is just CN's own
    (different) event and says nothing about Global. Only when *every*
    linked line is CN-marked does it return those, flagged cnOnly: the
    outfit is out on CN but the wiki has no Global release for it. That
    is either "not on Global *yet*" (its CN event simply hasn't reached
    Global, so it's expected with that event) or "never" (a CN-exclusive
    collab) -- the page alone can't tell which, so the caller decides by
    whether that event's Global run is still ahead (see
    index_outfit_brand_releases())."""
    global_targets = []
    cn_targets = []
    for line in (release or "").split("\n"):
        line = re.sub(r"^\*+\s*", "", line.strip())
        link = _WIKILINK_TARGET_RE.search(line)
        if not link:
            continue
        title = link.group(1).strip().replace("_", " ")
        marker = _RELEASE_REGION_MARKER_RE.search(line)
        if marker:
            label = marker.group(1) if marker.group(1) is not None else marker.group(2)
            if not _RELEASE_GLOBAL_WORD_RE.search(label):
                cn_targets.append({"title": title, "cnOnly": True})
                continue
        global_targets.append({"title": title, "cnOnly": False})
    return global_targets or cn_targets


def normalize_event_key(title):
    """Loose-match key for an event's wiki page title, so the Outfit
    pages' own spelling of an event lines up with this script's: they
    write a rerun / multi-part event as "X Rerun" / "X Part 2" (a redirect
    on the wiki), where EventServerDetails -- and so `wikiPage` here --
    has the real page title "X/Rerun" / "X/Part 2". Lowercased, with
    every run of non-alphanumerics (slash and spacing included) dropped,
    both spellings land on the same key, while "X" and "X Rerun" still
    stay distinct (no two tracked events share a key)."""
    return _NORMALIZE_NAME_RE.sub("", title.replace("_", " ").lower())


def fetch_outfit_brand_wikitexts():
    """{page title: wikitext} for every "Outfit/<brand>" page, in one
    batched query (generator=allpages + prop=revisions) instead of one
    request per brand. About 25 pages / 340 KB fit in one response; the
    continuation is followed in case it grows."""
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
    """[{"skinName", "operatorName", "targets": [{"title", "cnOnly"}]}]
    -- one entry per outfit across every brand page whose release field
    links at least one event. This is the authoritative skin -> event
    link: unlike an event page's own Outfits section (which some pages
    simply never fill in -- e.g. "Vector Breakthrough Trial from Misery"
    never lists Greyy's "My Fellow Newsboy", though its brand page,
    Outfit/EPOQUE, does name it), every outfit has to be listed on
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


def _event_global_end(ev):
    end = ev.get("globalEnd") or ev.get("globalStart")
    if not end:
        return None
    try:
        end_dt = datetime.fromisoformat(end)
    except ValueError:
        return None
    return end_dt if end_dt.tzinfo else end_dt.replace(tzinfo=timezone.utc)


def index_outfit_brand_releases(releases, events, now):
    """(brand_by_event, claimed_pairs, claimed_names): brand_by_event maps
    normalize_event_key(event page) -> [{"skinName", "operatorName"[,
    "cnOnly": True]}, ...]; claimed_pairs ({operator: {normalized skin
    names}}) / claimed_names ({normalized skin names}) are every outfit
    some brand page assigned to an event -- tracked here or not -- which is what lets
    attach_event_skins() tell "an event page names a skin no brand page
    knows about" (keep it) from "an event page names a skin a brand page
    already assigned to a different event" (drop it; the brand page wins).

    A CN-marked outfit (cnOnly) is kept only when its event is tracked
    here and its Global run hasn't ended yet -- ongoing or upcoming -- so
    an upcoming event can show the skins it's expected to bring, while a
    CN-exclusive outfit tied to an event that already ran on Global
    without it (or to one we don't track) never shows up. It stays flagged
    cnOnly, since the wiki hasn't confirmed it for Global."""
    event_ends = {}
    for ev in events:
        end = _event_global_end(ev)
        if end is not None:
            event_ends[normalize_event_key(ev.get("wikiPage") or ev.get("event") or "")] = end

    brand_by_event = {}
    claimed_pairs = {}  # operator -> {normalized skin names}
    claimed_names = set()
    entries = {}  # (event_key, operator, skin_key) -> entry, so a Global listing beats a CN one
    for rel in releases:
        skin_key = normalize_skin_name(rel["skinName"])
        for target in rel["targets"]:
            event_key = normalize_event_key(target["title"])
            if target["cnOnly"]:
                end = event_ends.get(event_key)
                if end is None or end < now:
                    continue
            claimed_pairs.setdefault(rel["operatorName"], set()).add(skin_key)
            claimed_names.add(skin_key)
            key = (event_key, rel["operatorName"], skin_key)
            existing = entries.get(key)
            if existing is not None and not existing.get("cnOnly"):
                continue
            entry = {"skinName": rel["skinName"], "operatorName": rel["operatorName"]}
            if target["cnOnly"]:
                entry["cnOnly"] = True
            if existing is None:
                brand_by_event.setdefault(event_key, []).append(entry)
            else:
                brand_by_event[event_key][brand_by_event[event_key].index(existing)] = entry
            entries[key] = entry
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

    An outfit neither source ties to an event is left off the calendar
    (see the module docstring for why release dates alone aren't used)."""
    now = datetime.now(timezone.utc)

    # Brand pages are one cheap batched request, re-read every run. If it
    # fails, fall back to the event pages alone rather than losing skins.
    try:
        brand_releases = fetch_outfit_brand_releases()
    except Exception as exc:
        note_degraded("skins", f"couldn't read the Outfit brand pages, using event pages only: {exc}")
        brand_releases = []
    if not brand_releases and not any_note_for("skins"):
        # Zero outfits from ~25 pages isn't "nothing released" -- it means
        # the page layout (or the Outfit/ prefix) changed under the parser.
        note_degraded("skins", "the Outfit brand pages produced no outfits at all (page layout changed?)")
    brand_by_event, claimed_pairs, claimed_names = index_outfit_brand_releases(brand_releases, events, now)
    print(f"{len(brand_releases)} outfit(s) across the Outfit brand pages name an event")

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
    page_fetch_failures = 0
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
            if names is None:
                # The request failed -- don't overwrite the cache with an
                # empty list. Keep whatever an earlier run scraped (if
                # anything) so this event doesn't lose its skins, and try
                # again next run.
                page_fetch_failures += 1
                names = (cached or {}).get("skinNames", [])
            else:
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

            # Drop an entry that never resolved as a skin and whose raw text
            # exactly matches another entry's resolved operator name. Event
            # pages sometimes comma-separate a skin from its own operator
            # ("Caelum Aeternum, Sankta Miksaparato" on "The Masses'
            # Travels/Rerun" is one skin), and the comma split can't know that
            # in advance. Only exact operator-name matches are dropped.
            resolved_operator_names = {s["operatorName"] for s in page_skins if s.get("operatorName")}
            page_skins = [
                s for s in page_skins
                if s.get("operatorName") or s["skinName"] not in resolved_operator_names
            ]

        # A CN-marked brand skin (see index_outfit_brand_releases()) that
        # this event's own page *also* names as new is corroborated by that
        # page, so it stops being flagged as unconfirmed for Global.
        page_keys = [(s.get("operatorName"), normalize_skin_name(s["skinName"])) for s in page_skins]
        for skin in skins:
            if skin.get("cnOnly"):
                skin_key = normalize_skin_name(skin["skinName"])
                if any(
                    op in (None, skin["operatorName"]) and skin_keys_match(skin_key, key)
                    for op, key in page_keys
                ):
                    del skin["cnOnly"]

        for skin in page_skins:
            skin_key = normalize_skin_name(skin["skinName"])
            operator_name = skin.get("operatorName")
            if operator_name:
                claimed = any(skin_keys_match(skin_key, k) for k in claimed_pairs.get(operator_name, ()))
            else:
                claimed = skin_key in claimed_names
            if not claimed:
                skins.append(skin)

        if skins:
            ev["skins"] = skins
    print(f"Scraped {scraped} event page(s) for new-outfit names this run")
    if page_fetch_failures:
        note_degraded(
            "skins",
            f"{page_fetch_failures} event page(s) couldn't be read this run (their skins keep "
            "whatever an earlier run found)",
        )
    return events


# Integrated Strategies and Reclamation Algorithm are game modes, not
# SideStory events, so they have no EventServerDetails rows. Each mode's
# page lists every "theme" (a content drop, e.g. "Sui's Garden of
# Grotesqueries") with its CN and Global release dates in a
# {{Game mode themes cell}}, read here instead. Outfits are tied to
# themes the same way as to events, so they need these to attach to.
GAME_MODE_PAGES = ["Integrated Strategies", "Reclamation Algorithm"]

# A theme is a release day, not a limited-time event (all but one are
# permanently playable afterwards), and the wiki only gives a date range
# for the oldest one or two -- so a theme with no end date is shown as a
# fixed-length window starting on its release day. Only applied when the
# wiki gives no end of its own.
GAME_MODE_THEME_DAYS = 7

_GAME_MODE_CELL_SPLIT_RE = re.compile(r"\{\{\s*Game mode themes cell\b", re.IGNORECASE)
_WIKI_DATE_RE = re.compile(r"(\d{4})/(\d{2})/(\d{2})")


def _first_dates(value):
    """(start, end-or-None) from a cn/global date value such as
    "2022/07/14" or "2021/02/25&ndash;2021/03/18"; (None, None) when
    there's no date in it at all (a theme not out on that server yet)."""
    found = [datetime(int(y), int(m), int(d)) for y, m, d in _WIKI_DATE_RE.findall(value or "")]
    if not found:
        return None, None
    return found[0], (found[1] if len(found) > 1 else None)


def parse_game_mode_themes(wikitext):
    """[{"theme", "cn": (start, end), "global": (start, end)}, ...] for
    every {{Game mode themes cell}} on one mode page. `theme` is also the
    theme's own wiki page title. Only the first occurrence of each
    parameter counts, so prose after the last cell can't overwrite it."""
    themes = []
    for chunk in _GAME_MODE_CELL_SPLIT_RE.split(wikitext or "")[1:]:
        params = {}
        for line in chunk.split("\n"):
            m = _TEMPLATE_PARAM_LINE_RE.match(line)
            if m:
                params.setdefault(m.group(1).strip().lower(), m.group(2).strip())
        theme = (params.get("theme") or "").strip()
        if not theme:
            continue
        themes.append(
            {
                "theme": theme,
                "cn": _first_dates(params.get("cn date")),
                "global": _first_dates(params.get("global date")),
            }
        )
    return themes


def game_mode_theme_rows(themes):
    """EventServerDetails-shaped rows (page/event/startTime/endTime/server)
    for parse_game_mode_themes()'s output, so build_events() treats a theme
    exactly like any other event -- including estimating an upcoming Global
    date from its CN one. A window with no end of its own gets
    GAME_MODE_THEME_DAYS days, ending at the last second of the final day
    (the same convention as the wiki's own end times)."""
    rows = []
    for t in themes:
        for server, (start, end) in (("CN", t["cn"]), ("Global", t["global"])):
            if start is None:
                continue
            if end is None or end < start:
                end = start + timedelta(days=GAME_MODE_THEME_DAYS) - timedelta(seconds=1)
            rows.append(
                {
                    "page": t["theme"],
                    "event": t["theme"],
                    "server": server,
                    "startTime": start.strftime("%Y-%m-%d %H:%M:%S"),
                    "endTime": end.strftime("%Y-%m-%d %H:%M:%S"),
                    "image": None,
                    "mode": t.get("mode"),  # not an EventServerDetails field; read back in __main__
                }
            )
    return rows


def fetch_game_mode_theme_rows():
    """Rows for every theme on every GAME_MODE_PAGES page, in one batched
    request. Raises on a failed request -- the caller decides whether to
    carry on without them."""
    params = {
        "action": "query",
        "prop": "revisions",
        "rvprop": "content",
        "rvslots": "main",
        "titles": "|".join(GAME_MODE_PAGES),
        "format": "json",
        "formatversion": 2,
    }
    r = http_get(WIKI_API, params=params, headers=HEADERS)
    data = r.json()
    if "error" in data:
        raise RuntimeError(f"Game mode page query error: {data['error']}")
    themes = []
    for page in (data.get("query") or {}).get("pages", []):
        revisions = page.get("revisions") or []
        if revisions:
            content = ((revisions[0].get("slots") or {}).get("main") or {}).get("content", "")
            for theme in parse_game_mode_themes(content):
                theme["mode"] = page["title"]
                themes.append(theme)
    return game_mode_theme_rows(themes)


def build_events(rows, overrides=None, operators_by_event=None, lag_excluded_events=None):
    """`lag_excluded_events`: event names still built and estimated like any
    other, but kept out of the CN->Global lag model and its backtest --
    game-mode themes (see fetch_game_mode_theme_rows()) are released on
    their own schedule, so their lags shouldn't shift what the regular
    events' estimates (and the accuracy figures reported for them) are
    based on."""
    overrides = overrides or {}
    lag_excluded_events = lag_excluded_events or set()
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
        if event in lag_excluded_events:
            continue
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


EVENTS_JSON_PATH = "./json/events.json"

# An event's date can move between runs: the estimate follows the CN date
# and the trailing-window lag (both can change), Yostar can announce or
# the wiki can confirm the real date, or a confirmed date can be
# rescheduled. `dateHistory` records those moves so the calendar can say
# "moved +4 days" / "now confirmed" instead of the date just silently
# differing from what someone saw last week.
#
# A move smaller than this many days is ignored for estimates -- the lag
# is a median that nudges by a day or so run to run, which would otherwise
# put a "moved" note on nearly every estimated event. A change of *status*
# (estimated -> announced -> confirmed) is always recorded.
DATE_HISTORY_MIN_SHIFT_DAYS = 2
DATE_HISTORY_MAX_ENTRIES = 6


def event_date_status(ev):
    if ev.get("globalConfirmed"):
        return "confirmed"
    if ev.get("announced"):
        return "announced"
    return "estimated"


def load_previous_events(path=EVENTS_JSON_PATH):
    """The previous run's events.json, as ({event name: entry}, its
    generatedAt) -- the baseline update_date_history() diffs against. A
    missing or unreadable file just means there's nothing to compare to
    (first run, or a bad file): ({}, None), never an error."""
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}, None
    except (json.JSONDecodeError, OSError) as exc:
        print(f"Couldn't read the previous {path} (no date-change tracking this run): {exc}")
        return {}, None
    events = data.get("events") if isinstance(data, dict) else None
    if not isinstance(events, list):
        return {}, None
    by_event = {e["event"]: e for e in events if isinstance(e, dict) and e.get("event")}
    return by_event, data.get("generatedAt")


def _history_day(iso):
    return datetime.fromisoformat(iso).date()


def _valid_history(history):
    if not isinstance(history, list):
        return []
    out = []
    for h in history:
        if isinstance(h, dict) and h.get("at") and h.get("start") and h.get("status"):
            try:
                _history_day(h["start"])
            except (TypeError, ValueError):
                continue
            out.append(h)
    return out


def update_date_history(events, previous, previous_generated_at, now):
    """Sets ev["dateHistory"] = [{at, start, status, reason?}, ...] (oldest
    first) on every event that hasn't finished yet, carrying forward what
    the previous run recorded and appending an entry whenever the date or
    status has moved since the last recorded one.

    Each entry is a state the event was *in*: `start` is its Global start
    then, `status` is "estimated" / "announced" / "confirmed", and `reason`
    (not on the first entry) says why it changed:
      "estimate"    -- still an estimate, same CN date: the lag model moved
      "cn"          -- still an estimate, but its CN date changed
      "announced" / "confirmed" -- it just became that
      "rescheduled" -- an announced/confirmed date moved

    Moves are measured against the last *recorded* entry, not the previous
    run, so a slow drift of a day per run still shows up once it adds up
    past DATE_HISTORY_MIN_SHIFT_DAYS instead of being rounded away forever.
    A finished event's history is dropped (it only matters ahead of time).
    For an event the previous run knew but that has no history yet, the
    first entry is that previous state, so a move since then is reported."""
    for ev in events:
        ev.pop("dateHistory", None)
        end_dt = _event_global_end(ev)
        if end_dt is None or end_dt < now:
            continue
        name = ev["event"]
        status = event_date_status(ev)
        prev = previous.get(name)
        history = _valid_history(prev.get("dateHistory")) if prev else []
        if prev and not history and prev.get("globalStart"):
            history = [
                {
                    "at": previous_generated_at or now.isoformat(),
                    "start": prev["globalStart"],
                    "status": event_date_status(prev),
                }
            ]
        if not history:
            history = [{"at": now.isoformat(), "start": ev["globalStart"], "status": status}]
        else:
            last = history[-1]
            shift = (_history_day(ev["globalStart"]) - _history_day(last["start"])).days
            status_changed = status != last["status"]
            if status_changed or abs(shift) >= DATE_HISTORY_MIN_SHIFT_DAYS:
                if status_changed and status != "estimated":
                    reason = status
                elif status_changed:
                    reason = "estimate"
                elif status == "estimated":
                    cn_moved = prev is not None and prev.get("cnStart") != ev.get("cnStart")
                    reason = "cn" if cn_moved else "estimate"
                else:
                    reason = "rescheduled"
                history.append(
                    {"at": now.isoformat(), "start": ev["globalStart"], "status": status, "reason": reason}
                )
        ev["dateHistory"] = history[-DATE_HISTORY_MAX_ENTRIES:]
    return events


if __name__ == "__main__":
    # Read the previous run's output first -- it's overwritten at the end.
    previous_events, previous_generated_at = load_previous_events()
    rows = fetch_event_server_details()
    print(f"Fetched {len(rows)} EventServerDetails rows")
    # Game-mode themes (Integrated Strategies / Reclamation Algorithm) --
    # optional, so a failure here just means a run without them. Put first
    # so a real EventServerDetails row for the same name (should the wiki
    # ever add one) overwrites ours in build_events().
    try:
        mode_rows = fetch_game_mode_theme_rows()
    except Exception as exc:
        note_degraded("themes", f"couldn't read the Integrated Strategies / Reclamation Algorithm dates: {exc}")
        mode_rows = []
    mode_by_theme = {r["event"]: r["mode"] for r in mode_rows if r.get("mode")}
    mode_theme_names = set(mode_by_theme)
    print(f"Read {len(mode_theme_names)} game-mode themes")
    rows = mode_rows + rows
    overrides = load_overrides()
    print(f"Loaded {len(overrides)} manual overrides")
    operator_rows = fetch_event_operators()
    operators_by_event = group_operators_by_event(operator_rows)
    print(
        f"Fetched {len(operator_rows)} Operators rows tied to an event, "
        f"across {len(operators_by_event)} events"
    )
    events, median_lag_days, current_lag_days, backtest = build_events(
        rows, overrides, operators_by_event, lag_excluded_events=mode_theme_names
    )
    # Tag each theme with its mode ("Integrated Strategies" / "Reclamation
    # Algorithm") so calendar.js can tell it isn't an ordinary event: it
    # must not be given operators by release-date proximity (a theme often
    # drops the same day as a SideStory, whose operators these aren't), and
    # its preview says why it's only a week long.
    for e in events:
        if e["event"] in mode_by_theme:
            e["mode"] = mode_by_theme[e["event"]]
    events = localize_images(events, operators_by_event)
    with_image = sum(1 for e in events if e.get("image"))
    with_operators = sum(1 for e in events if e.get("operators"))
    print(f"{with_image}/{len(events)} events have art, {with_operators}/{len(events)} list new operators")

    # New skins per event (see attach_event_skins() for why this needs a
    # persistent cache). Wrapped so a wiki hiccup here can't take down a run
    # that built every event's dates and operators; at worst this run keeps
    # the skins cached by earlier runs.
    try:
        skin_outfit_cache = load_skin_outfit_cache()
        events = attach_event_skins(events, skin_outfit_cache)
        save_skin_outfit_cache(skin_outfit_cache)
        with_skins = sum(1 for e in events if e.get("skins"))
        print(f"{with_skins}/{len(events)} events list new skins")
    except Exception as exc:
        note_degraded("skins", f"couldn't attach new-skin data to events: {exc}")
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
    run_time = datetime.now(timezone.utc)
    try:
        events = update_date_history(events, previous_events, previous_generated_at, run_time)
        print(f"{sum(1 for e in events if len(e.get('dateHistory', ())) > 1)} event(s) have a recorded date change")
    except Exception as exc:
        note_degraded("dateHistory", f"couldn't track date changes: {exc}")
    with open("./json/events.json", "w") as f:
        json.dump(
            {
                "generatedAt": run_time.isoformat(),
                "warnings": RUN_WARNINGS,
                "medianLagDays": median_lag_days,
                "currentLagDays": current_lag_days,
                "backtest": backtest,
                "events": events,
            },
            f,
        )
