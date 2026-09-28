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
"""
import requests
import re
import json
import time
from datetime import datetime, timedelta, timezone

REQUEST_TIMEOUT = 30  # seconds, per attempt
REQUEST_RETRIES = 3
REQUEST_BACKOFF = 5  # seconds, multiplied by attempt number

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
    """Choose one banner image for an event out of its per-server rows.
    Prefers the Global server's own art, but falls back to another
    server's (usually CN) -- an event with no Global row yet (estimated
    or announced) is exactly the case where showing *some* preview art
    is most useful, and CN's banner is normally a close preview of what
    Global's will look like. Only trusts a value Cargo actually resolved
    to a full URL -- a bare filename would need a second API call to
    resolve to a real upload path, and a guessed-at URL is worse than no
    image at all."""
    for key in ("global", "cn"):
        image = (servers.get(key) or {}).get("image")
        if image and str(image).startswith("http"):
            return image
    for server_entry in servers.values():
        image = server_entry.get("image")
        if image and str(image).startswith("http"):
            return image
    return None


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


def build_events(rows, overrides=None):
    overrides = overrides or {}
    # Group every row by event name, then by a normalized server key.
    by_event = {}
    # The wiki's actual page name for each event, kept separately from the
    # display name (`event`) -- they're usually the same, but the page name
    # is what a /wiki/<page> link actually needs, so it's tracked from the
    # already-fetched `page` field rather than guessed from `event`.
    wiki_page_by_event = {}
    for row in rows:
        event = row.get("event") or row.get("page")
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
        out.append(entry)

    out.sort(key=lambda e: e["globalStart"])

    return out, median_lag_days, estimate_lag_days, backtest


if __name__ == "__main__":
    rows = fetch_event_server_details()
    print(f"Fetched {len(rows)} EventServerDetails rows")
    overrides = load_overrides()
    print(f"Loaded {len(overrides)} manual overrides")
    events, median_lag_days, current_lag_days, backtest = build_events(rows, overrides)
    with_image = sum(1 for e in events if e.get("image"))
    print(f"{with_image}/{len(events)} events have art")
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
