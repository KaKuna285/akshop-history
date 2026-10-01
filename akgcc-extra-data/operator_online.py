import requests
import re
import json
import time
from pprint import pprint
from urllib.parse import quote
from html import unescape

# Plain requests.get() has no timeout by default, so a slow or rate-limited
# wiki can hang a run indefinitely instead of failing loudly. http_get()
# always sets a timeout and retries a couple of times with backoff before
# actually raising, so a genuinely-down wiki still fails fast and with a
# clear error in the Action log.
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


DATA = {}
    
def scrape_PRTS():
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/138.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Referer": "https://prts.wiki/",
        "Origin": "https://prts.wiki",
        "Sec-CH-UA": '"Google Chrome";v="138", "Chromium";v="138", "Not=A?Brand";v="24"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }
    url = "https://prts.wiki/api.php"
    LINKAGE = '联动寻访'
    LIMITED = '限定寻访'
    LIMITED_OBTAIN_METHODS = [LINKAGE, LIMITED]
    # The other two gacha-pool keywords PRTS wiki's own obtainMethod field
    # uses (confirmed via an independent open-source scraper hitting the
    # exact same char_obtain Cargo table, plus PRTS's own recruitment-rules
    # docs -- prts.wiki itself is robots.txt-blocked to this project's own
    # fetch tooling, same restriction noted elsewhere in this file) --
    # '标准寻访' (standard headhunting) and '中坚寻访' (kernel/"intermediate"
    # pool, though this site also derives Kernel status independently from
    # character_table.json's own classicPotentialItemId field, which is the
    # one actually used for the Kernel badge). Listed here only so
    # NOT_IN_GACHA_POOL below can tell "not currently offered through *any*
    # known gacha pool" apart from "just not limited/collab" -- see that
    # comment for why this matters.
    STANDARD_OBTAIN_METHODS = ['标准寻访', '中坚寻访']
    limit = 500
    offset = 0
    # you can use CO.obtainMethod to list limited operators
    params = {
        "action": "cargoquery",
        "tables": "char_obtain=CO,chara=C",
        "fields": "CO._pageName=page,CO.cnOnlineTime=cnOnlineTime,CO.obtainMethod=obtainMethod,C.charId=charId",
        "join_on": "CO._pageName=C._pageName",
        "format": "json",
    }
    while 1:
        params['limit'] = limit
        params['offset'] = offset
        r = http_get(url, params=params, headers=headers)
        pages = r.json()['cargoquery']
        for page in pages:
            charId = page['title']['charId']
            # A real obtainMethod value can be a SINGLE method (e.g. just
            # "限定寻访") or a "、"-joined list of several (confirmed on a
            # real operator page: Civilight Eterna's own obtain-method
            # field reads "公开招募、中坚寻访" -- both standard recruitment
            # AND kernel pool at once). `obtain in LIMITED_OBTAIN_METHODS`
            # is an exact-equality check against the whole string, so it
            # silently failed to match "限定寻访" as *part of* any compound
            # value -- misclassifying every operator whose obtainMethod
            # lists limited/collab alongside anything else as NOT limited,
            # which then fell through to the site's default "Standard
            # pool" badge. Checking containment of each known keyword
            # instead of exact-list membership handles both the
            # single-value and compound-value cases.
            obtain = page['title']['obtainMethod'] or ''
            online = page['title']['cnOnlineTime']
            limited = any(method in obtain for method in LIMITED_OBTAIN_METHODS)
            # An operator whose obtainMethod contains NONE of the four
            # known gacha-pool keywords (standard/kernel/limited/collab)
            # isn't currently offered through any gacha pool at all --
            # most commonly because they were only ever given out through
            # an event's activity rewards/shop. Surfaced as its own field
            # (rather than silently left to default to "Standard pool" on
            # the frontend, which was the actual bug reported) so
            # operator-page.js can show something more accurate than a
            # guess. A blank/unrecognized obtainMethod (e.g. this field
            # itself failed to come through) intentionally does NOT set
            # this -- "we don't know" should keep falling back to the
            # existing default, not get relabeled on missing data.
            known_methods = LIMITED_OBTAIN_METHODS + STANDARD_OBTAIN_METHODS
            not_in_gacha_pool = bool(obtain) and not any(method in obtain for method in known_methods)
            DATA[charId] = {'cnOnlineTime': online, 'isLimited': limited, 'notInGachaPool': not_in_gacha_pool}
        offset += limit
        if len(pages) < limit:
            break
    return DATA
def wiki_cargo_query(url, headers, tables, fields, where=None):
    """Paginated Cargo query helper -- every scrape_wiki() sub-fetch below
    follows the exact same `limit`/`offset` loop operator_online.py and
    events.py both already hand-roll per query, just factored out once
    this function needed three of them instead of one."""
    rows = []
    limit = 500
    offset = 0
    while True:
        params = {
            "action": "cargoquery",
            "tables": tables,
            "fields": fields,
            "format": "json",
            "limit": limit,
            "offset": offset,
        }
        if where:
            params["where"] = where
        r = http_get(url, params=params, headers=headers)
        page_rows = r.json().get("cargoquery", [])
        for row in page_rows:
            rows.append(row["title"])
        offset += limit
        if len(page_rows) < limit:
            break
    return rows


def scrape_wiki():
    # update the prts.wiki data with global release dates from arknights.wiki.gg/
    # while it is possible to get limited status and some CN dates from the wiki, those only come from prts for now.
    # https://arknights.wiki.gg/wiki/Special:CargoTables
    #
    # REWRITTEN from a single three-table Cargo-side join (`tables:
    # "Operators=O,OperatorFiles=F,EventServerDetails=S", join_on:
    # "O.event=S.event,F.name=O.operator"`) to three separate fetches
    # joined here in Python instead. The single-query version fixed one
    # real bug earlier (that join_on used "O.name", when the Operators
    # table's actual display-name field is "operator" -- confirmed via
    # events.py's fetch_event_operators(), which hand-verified this exact
    # schema since Special:CargoTables is itself robots.txt-blocked to
    # this project's own tooling) but after a full data refresh with that
    # fix live, onlineTime was STILL missing for the same kind of
    # operator: every one of them confirmed (via notInGachaPool, see
    # scrape_PRTS() above) to be event-obtained rather than gacha-pool.
    # That points at the OTHER join condition instead: "O.event=S.event"
    # is a second exact-string match, this time between the Operators
    # table's own freeform event-name field and EventServerDetails' own
    # (two more independently-maintained Cargo tables), and Cargo's
    # server-side join has no tolerance for incidental formatting drift
    # between them (whitespace, e.g.). events.py already had to work
    # around exactly this: group_operators_by_event() explicitly
    # `.strip()`s Operators.event before using it as a join key of its
    # own, specifically because (per its own comment) "incidental
    # leading/trailing whitespace on one side (but not the other) would
    # otherwise be an easy way for an operator to silently fail to match
    # up" -- the exact silent-zero-rows failure mode this function kept
    # hitting. events.py does that matching in Python, across separately
    # fetched tables, rather than trusting a single Cargo-side join to
    # get it right; this function now does the same, reusing the same
    # proven shape (fetch Operators' event links and EventServerDetails'
    # per-event timings separately, normalize, join here) instead of
    # inventing a different approach. Still unverified live (this
    # project's own fetch tooling remains blocked by the wiki's
    # robots.txt) -- if onlineTime coverage for event-obtained operators
    # still doesn't improve after this merges, the remaining suspects are
    # EventServerDetails simply not having a `server LIKE 'global'` row
    # yet for that operator's specific event (nothing to join to, not a
    # join bug), or a *case* difference in the event name rather than
    # whitespace (str.strip() alone wouldn't catch that).
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }
    url = "https://arknights.wiki.gg/api.php"

    # OperatorFiles: display name -> charId (same F.id/F.name fields the
    # old single-query version used, just fetched on its own now).
    file_rows = wiki_cargo_query(
        url, headers, "OperatorFiles=F", "F.name=name,F.id=charId",
        where="F.id IS NOT NULL",
    )
    name_to_charid = {}
    for row in file_rows:
        name = (row.get("name") or "").strip()
        charid = row.get("charId")
        if name and charid:
            name_to_charid[name] = charid

    # Operators: operator name -> event it was introduced/granted through
    # (same O.operator/O.event fields events.py's own fetch_event_operators()
    # already trusts -- see that function's docstring in events.py).
    op_rows = wiki_cargo_query(
        url, headers, "Operators=O", "O.operator=operator,O.event=event",
        where="O.event IS NOT NULL AND O.event != ''",
    )
    operator_event = {}
    for row in op_rows:
        name = (row.get("operator") or "").strip()
        event = (row.get("event") or "").strip()
        if name and event:
            operator_event[name] = event

    # EventServerDetails: event -> its Global server's startTime.
    event_rows = wiki_cargo_query(
        url, headers, "EventServerDetails=S", "S.event=event,S.startTime=start,S.server=server",
    )
    event_global_start = {}
    for row in event_rows:
        event = (row.get("event") or "").strip()
        server = (row.get("server") or "").strip().lower()
        start = row.get("start")
        if event and server == "global" and start:
            event_global_start[event] = start

    # Join in Python, same as events.py's own event<->operator matching.
    for name, charid in name_to_charid.items():
        event = operator_event.get(name)
        if not event:
            continue
        start = event_global_start.get(event)
        if not start:
            continue
        if charid in DATA:
            DATA[charid]['onlineTime'] = start

    return DATA
scrape_PRTS()
scrape_wiki() # must call AFTER scrape_PRTS as it will update DATA (and relies on it being filled)
with open('./json/operator_release_dates.json','w') as f:
    json.dump(DATA,f)
