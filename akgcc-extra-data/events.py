"""Get past + upcoming EN (Global) event dates and write json/events.json.

Gryphline (the EN publisher) only ever officially confirms an event's
Global date a week or two ahead of time. There's no source of "confirmed
EN dates months out" because that information doesn't exist yet -- so
"preliminary" here means: once an event has run on CN, arknights.wiki.gg
tracks it, and once Gryphline has confirmed its Global date that's tracked
too, but for the (usually many-months) gap in between, we estimate it.

The estimate is "this event's own CN date plus a lag" -- but which lag
matters a lot. The real Global lag drifts over time (Gryphline has sped
up localization before and can again), so a flat lag averaged over the
*entire* dataset reacts to that far too slowly: months of schedule
changes get diluted by years of older history sitting in the same
average. Instead, the lag applied to every current estimate is the
median CN->Global lag from just the last RECENT_LAG_WINDOW_DAYS days of
confirmed events -- a rolling window recomputed fresh on every run.
That's still a median over a couple dozen events rather than one single
data point, so one unusually fast or slow event doesn't swing every
estimate on the page, but it tracks a real shift in pace (the schedule
speeding up or slowing down) far faster than the all-time average would.
A CN/Global pair with a non-positive lag is dropped before either median
is computed -- that's not a real observation, just the wiki having the
same (or an inverted) date recorded for both servers. If there isn't
enough recent history to compute the rolling median from (early on, or
a quiet stretch with nothing confirmed in the window), estimates fall
back to the all-time median instead, which is still reported in the
output for reference.

NOTE: this script's exact field names (EventServerDetails.event/
startTime/endTime/server) are based on the query already proven to work
in operator_online.py's scrape_wiki(), which only ever used startTime for
server='global'. endTime, and rows for server='CN', are new territory --
this could not be tested directly (arknights.wiki.gg isn't reachable from
the environment this was written in), so if this fails in the Action log,
check the exact error: a wrong field/table name shows up immediately as a
Cargo API error in the response body.
"""
import requests
import re
import json
import time
import statistics
from datetime import datetime, timedelta, timezone

REQUEST_TIMEOUT = 30  # seconds, per attempt
REQUEST_RETRIES = 3
REQUEST_BACKOFF = 5  # seconds, multiplied by attempt number

# How far back to look for the rolling "current lag" median (see the
# module docstring). A year covers roughly two dozen events -- enough to
# smooth out one noisy data point without being so long a real change in
# pace takes forever to show up.
RECENT_LAG_WINDOW_DAYS = 365


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


def fetch_event_server_details():
    """Pull every (event, server, startTime, endTime) row. No `where`
    filter -- we don't know every server-name spelling in use (CN/global/
    TW/JP/KR), so grab everything and sort it out in Python."""
    rows = []
    offset = 0
    limit = 500
    while True:
        params = {
            "action": "cargoquery",
            "tables": "EventServerDetails",
            "fields": "EventServerDetails._pageName=page,EventServerDetails.event=event,EventServerDetails.startTime=startTime,EventServerDetails.endTime=endTime,EventServerDetails.server=server",
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


def build_events(rows):
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

    # All-time CN -> Global lag, from every event where both are known.
    # Used only as a fallback when there isn't enough recent history to
    # compute the rolling median below (see the module docstring) -- kept
    # as its own pass since it needs to look at every event regardless of
    # date.
    lags_days = []
    for event, servers in by_event.items():
        cn_start, _ = clean_window(servers.get("cn"))
        gl_start, _ = clean_window(servers.get("global"))
        if cn_start and gl_start:
            d = lag_days(cn_start, gl_start)
            if d is not None:
                lags_days.append(d)
    median_lag_days = statistics.median(lags_days) if lags_days else None

    # Recent CN -> Global lag: the same thing, but only from confirmed
    # pairs whose CN date falls within the last RECENT_LAG_WINDOW_DAYS
    # days. This is the number that actually drives every estimate below.
    now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    recent_cutoff = now_naive - timedelta(days=RECENT_LAG_WINDOW_DAYS)
    recent_lags_days = []
    for event, servers in by_event.items():
        cn_start, _ = clean_window(servers.get("cn"))
        gl_start, _ = clean_window(servers.get("global"))
        if cn_start and gl_start and cn_start >= recent_cutoff:
            d = lag_days(cn_start, gl_start)
            if d is not None:
                recent_lags_days.append(d)
    recent_median_lag_days = (
        statistics.median(recent_lags_days) if recent_lags_days else None
    )

    # The lag actually applied to every estimate below: the rolling
    # recent median when there's enough recent history to compute one,
    # otherwise the all-time median as a fallback.
    estimate_lag_days = (
        recent_median_lag_days
        if recent_median_lag_days is not None
        else median_lag_days
    )

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
        entry["cnStart"] = cn_start.isoformat()
        entry["cnEnd"] = cn_end.isoformat() if cn_end else None

        if gl_start:
            # Confirmed: Gryphline has actually set/run this date.
            entry["globalStart"] = gl_start.isoformat()
            entry["globalEnd"] = gl_end.isoformat() if gl_end else None
            entry["globalConfirmed"] = True
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
        out.append(entry)

    out.sort(key=lambda e: e["globalStart"])

    return out, median_lag_days, estimate_lag_days


if __name__ == "__main__":
    rows = fetch_event_server_details()
    print(f"Fetched {len(rows)} EventServerDetails rows")
    events, median_lag_days, current_lag_days = build_events(rows)
    print(
        f"Built {len(events)} events; median CN->Global lag = {median_lag_days} days, "
        f"current CN->Global lag = {current_lag_days} days"
    )
    with open("./json/events.json", "w") as f:
        json.dump(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "medianLagDays": median_lag_days,
                "currentLagDays": current_lag_days,
                "events": events,
            },
            f,
        )
