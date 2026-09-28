"""Get past + upcoming EN (Global) event dates and write json/events.json.

Gryphline (the EN publisher) only ever officially confirms an event's
Global date a week or two ahead of time. There's no source of "confirmed
EN dates months out" because that information doesn't exist yet -- so
"preliminary" here means: once an event has run on CN, arknights.wiki.gg
tracks it, and once Gryphline has confirmed its Global date that's tracked
too, but for the (usually many-months) gap in between, we estimate the
Global date by applying the historical CN -> Global lag (computed from
every event where enough dates are known) to the event's known CN date --
the same "cadence"-style prediction idea already used for shop-debut
predictions on the /store page.

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

    # Historical CN -> Global lag, from every event where both are known,
    # so the estimate adapts automatically instead of using a hardcoded
    # guess (same spirit as the shop-debut cadence prediction).
    lags_days = []
    for event, servers in by_event.items():
        cn = servers.get("cn")
        gl = servers.get("global")
        if cn and gl and cn.get("start") and gl.get("start"):
            lags_days.append((gl["start"] - cn["start"]).days)
    median_lag_days = statistics.median(lags_days) if lags_days else None

    out = []
    for event, servers in by_event.items():
        cn = servers.get("cn")
        gl = servers.get("global")
        entry = {"event": event}
        wiki_page = wiki_page_by_event.get(event)
        if wiki_page:
            entry["wikiPage"] = wiki_page

        # A handful of wiki rows have an endTime that's actually *before*
        # startTime (a mistyped year, most likely) -- treat that as "no end
        # date" rather than let a negative duration through, which would
        # otherwise silently produce an estimated globalEnd earlier than
        # globalStart further down.
        cn_end = cn.get("end") if cn else None
        if cn_end and cn.get("start") and cn_end < cn["start"]:
            cn_end = None

        if cn and cn.get("start"):
            entry["cnStart"] = cn["start"].isoformat()
            entry["cnEnd"] = cn_end.isoformat() if cn_end else None

        if gl and gl.get("start"):
            # Confirmed: Gryphline has actually set/run this date.
            gl_end = gl.get("end")
            if gl_end and gl_end < gl["start"]:
                gl_end = None
            entry["globalStart"] = gl["start"].isoformat()
            entry["globalEnd"] = gl_end.isoformat() if gl_end else None
            entry["globalConfirmed"] = True
        elif cn and cn.get("start") and median_lag_days is not None:
            # Not yet confirmed on Global: estimate from the historical
            # CN -> Global lag, preserving the event's own CN duration.
            est_start = cn["start"] + timedelta(days=median_lag_days)
            duration = (cn_end - cn["start"]) if cn_end else timedelta(days=0)
            entry["globalStart"] = est_start.isoformat()
            entry["globalEnd"] = (est_start + duration).isoformat()
            entry["globalConfirmed"] = False
        else:
            # No CN date either (or no lag data to estimate from yet) --
            # nothing usable to show for this event.
            continue

        out.append(entry)

    out.sort(key=lambda e: e["globalStart"])
    return out, median_lag_days


if __name__ == "__main__":
    rows = fetch_event_server_details()
    print(f"Fetched {len(rows)} EventServerDetails rows")
    events, median_lag_days = build_events(rows)
    print(f"Built {len(events)} events; median CN->Global lag = {median_lag_days} days")
    with open("./json/events.json", "w") as f:
        json.dump(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "medianLagDays": median_lag_days,
                "events": events,
            },
            f,
        )
