import json
import os
import sys

from common import http_get, parse_date


DATA = {}

RELEASE_DATES_PATH = './json/operator_release_dates.json'
# Refuse to write a file where far fewer operators have an EN date than
# last time -- that's a broken scrape, not the game removing operators.
ONLINE_TIME_KEEP_FRACTION = 0.8
ONLINE_TIME_MIN_PREVIOUS = 50


def cargo_rows(r, what):
    """The rows of a Cargo API response, or a RuntimeError saying why there
    aren't any. A failed query (renamed table/field, bad syntax, wiki
    trouble) comes back as HTTP 200 with {"error": {...}} and no
    "cargoquery" key -- treating that as "zero rows" would silently blank
    every date that query feeds."""
    try:
        body = r.json()
    except ValueError:
        raise RuntimeError(f"{what}: HTTP {r.status_code}, response isn't JSON")
    if "error" in body:
        err = body["error"]
        info = (err.get("info") or err.get("code")) if isinstance(err, dict) else err
        raise RuntimeError(f"{what}: Cargo query failed: {info}")
    if not isinstance(body.get("cargoquery"), list):
        raise RuntimeError(f"{what}: response has no cargoquery rows (HTTP {r.status_code})")
    return body["cargoquery"]


def count_online_times(data):
    return sum(1 for v in data.values() if isinstance(v, dict) and v.get('onlineTime'))


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
    # The other two gacha-pool keywords PRTS's obtainMethod field uses:
    # '标准寻访' (standard headhunting) and '中坚寻访' (Kernel pool). Only
    # used so notInGachaPool below can tell "not offered through any known
    # gacha pool" from "not limited/collab". (The site's Kernel badge comes
    # from character_table.json's classicPotentialItemId, not from this.)
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
        pages = cargo_rows(r, "prts.wiki char_obtain")
        for page in pages:
            charId = page['title']['charId']
            # obtainMethod is a single method (e.g. "限定寻访") or a
            # "、"-joined list of several (e.g. Civilight Eterna's
            # "公开招募、中坚寻访"), so look for each keyword inside it
            # rather than comparing the whole string.
            obtain = page['title']['obtainMethod'] or ''
            online = page['title']['cnOnlineTime']
            limited = any(method in obtain for method in LIMITED_OBTAIN_METHODS)
            # An obtainMethod containing none of the four known gacha-pool
            # keywords (standard/kernel/limited/collab) means the operator
            # isn't offered through any gacha pool -- usually one given out
            # through an event's rewards/shop. operator-page.js shows that
            # instead of its default "Standard pool" badge. A blank
            # obtainMethod doesn't set this: missing data keeps the default.
            known_methods = LIMITED_OBTAIN_METHODS + STANDARD_OBTAIN_METHODS
            not_in_gacha_pool = bool(obtain) and not any(method in obtain for method in known_methods)
            DATA[charId] = {'cnOnlineTime': online, 'isLimited': limited, 'notInGachaPool': not_in_gacha_pool}
        offset += limit
        if len(pages) < limit:
            break
    return DATA
# Strips quote characters (straight and curly) from an operator's display
# name before it's used as a cross-table join key. OperatorFiles.name for
# Justice Knight is '"Justice Knight"' (her in-game name is quoted) while
# Operators.operator has the plain 'Justice Knight', so an exact-string
# join would miss her event and its Global date.
_QUOTE_CHARS = str.maketrans('', '', '"“”‘’\'')


def normalize_name(name):
    return (name or '').translate(_QUOTE_CHARS).strip()


def wiki_cargo_query(url, headers, tables, fields, where=None):
    """Every row of a Cargo query on `tables`/`fields` (optionally filtered
    by `where`), paged through 500 at a time. Used by scrape_wiki()."""
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
        page_rows = cargo_rows(r, f"arknights.wiki.gg {tables}")
        for row in page_rows:
            rows.append(row["title"])
        offset += limit
        if len(page_rows) < limit:
            break
    return rows


def scrape_wiki():
    # Adds EN/Global release dates (onlineTime) from arknights.wiki.gg to
    # the PRTS data. Limited status and CN dates come only from PRTS.
    # https://arknights.wiki.gg/wiki/Special:CargoTables
    #
    # The three Cargo tables are fetched separately and joined here in
    # Python (like events.py's event<->operator matching) rather than with
    # a Cargo-side join_on: Operators.event and EventServerDetails.event
    # are freeform names in independently maintained tables, and Cargo's
    # join has no tolerance for formatting drift such as stray whitespace.
    # Both sides are stripped (names also lose quotes, see normalize_name())
    # before joining; a difference in case would still not match.
    # An operator whose event has no Global row in EventServerDetails gets
    # no onlineTime here -- operator_overrides.json covers those.
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }
    url = "https://arknights.wiki.gg/api.php"

    # OperatorFiles: display name -> charId.
    file_rows = wiki_cargo_query(
        url, headers, "OperatorFiles=F", "F.name=name,F.id=charId",
        where="F.id IS NOT NULL",
    )
    name_to_charid = {}
    for row in file_rows:
        name = normalize_name(row.get("name"))
        charid = row.get("charId")
        if name and charid:
            name_to_charid[name] = charid

    # Operators: operator name -> event it was introduced/granted through
    # (the same O.operator/O.event fields events.py's
    # fetch_event_operators() reads; the name field is `operator`, not
    # `name`).
    op_rows = wiki_cargo_query(
        url, headers, "Operators=O", "O.operator=operator,O.event=event",
        where="O.event IS NOT NULL AND O.event != ''",
    )
    operator_event = {}
    for row in op_rows:
        name = normalize_name(row.get("operator"))
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

    # charId -> name -> event -> that event's Global start.
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


OPERATOR_OVERRIDES_PATH = "./operator_overrides.json"


def load_operator_overrides(path=OPERATOR_OVERRIDES_PATH):
    """Manually-pinned EN/Global release dates (onlineTime), keyed by
    charId, for operators the wiki's event data doesn't cover. Several
    event-reward/shop operators (Conviction, Highmore, Kestrel, Shalem,
    Tin Man, U-Official, Valarqvin) have a correct `Operators.event`, but
    EventServerDetails has no rows for those events, so there is no date
    to join to.

    The file has the same hand-edited JSON shape as events.py's
    overrides.json (see load_overrides() there and the README), with one
    difference: an operator override here always wins, even over an
    onlineTime the scrape did set. Event overrides never replace a
    wiki-confirmed date, but the scrape here can pick up the wrong
    operator for a shared name/version (e.g. an Amiya alternate
    version's page data landing on base Amiya's charId), so an override
    must be able to correct a scraped value, not just fill a gap. To add
    one, open the operator's page on the site, copy their charId from the
    `?id=` URL, and add an entry, e.g.:

        {
          "char_4064_rockr": {
            "onlineTime": "2024-06-01 16:00:00",
            "source": "Yostar patch notes / personal observation",
            "note": "optional, for whoever edits this file next"
          }
        }

    Only `onlineTime` is read; `source` and `note` are optional notes for
    whoever edits the file next. A missing or unreadable file just means
    no overrides, not a crash.
    """
    try:
        with open(path) as f:
            raw = json.load(f)
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as exc:
        print(f"Could not read {path} (ignoring operator overrides): {exc}")
        return {}

    overrides = {}
    for charid, ov in raw.items():
        start = parse_date(ov.get("onlineTime"))
        if not start:
            print(f"Skipping operator override for {charid!r}: no usable onlineTime")
            continue
        overrides[charid] = start.strftime("%Y-%m-%d %H:%M:%S")
    return overrides


# arknights.wiki.gg's EventServerDetails gives the whole Day 1 roster
# (~90 operators) the Global startTime "2020-02-05 17:00:00", but the
# EN/Global launch was January 16, 2020. This corrects that one value in
# bulk instead of needing ~90 operator_overrides.json entries. If the wiki
# fixes its data, nothing matches WRONG_LAUNCH_DATE and this does nothing.
WRONG_LAUNCH_DATE = "2020-02-05 17:00:00"
CORRECT_LAUNCH_DATE = "2020-01-16 00:00:00"


scrape_PRTS()
if not DATA:
    # PRTS gave back nothing parseable -- keep the existing file and fail
    # the step rather than writing out an (almost) empty one.
    print("No operators scraped from PRTS -- leaving operator_release_dates.json as it was")
    sys.exit(1)
scrape_wiki() # must call AFTER scrape_PRTS as it will update DATA (and relies on it being filled)

_launch_date_corrected = 0
for _entry in DATA.values():
    if _entry.get('onlineTime') == WRONG_LAUNCH_DATE:
        _entry['onlineTime'] = CORRECT_LAUNCH_DATE
        _launch_date_corrected += 1
print(f"Corrected {_launch_date_corrected} operator(s) from the known-wrong wiki launch date")

# Manual overrides apply last and always win, even over an onlineTime
# the scrape set -- see load_operator_overrides() for why (events.py's
# event overrides, by contrast, never replace a confirmed date).
_operator_overrides = load_operator_overrides()
_overrides_applied = 0
for _charid, _online_time in _operator_overrides.items():
    _entry = DATA.setdefault(_charid, {})
    _entry['onlineTime'] = _online_time
    _overrides_applied += 1
print(f"Applied {_overrides_applied} manual operator release-date override(s)")

# A scrape that "worked" but lost most EN dates (e.g. the wiki's tables
# changed shape without an outright error) mustn't replace good data.
try:
    with open(RELEASE_DATES_PATH) as f:
        _previous_online = count_online_times(json.load(f))
except (OSError, ValueError):
    _previous_online = 0
_online = count_online_times(DATA)
print(f"{_online} operator(s) with an EN release date (previously {_previous_online})")
if _previous_online >= ONLINE_TIME_MIN_PREVIOUS and _online < _previous_online * ONLINE_TIME_KEEP_FRACTION:
    print(f"EN release dates dropped from {_previous_online} to {_online} -- leaving {RELEASE_DATES_PATH} as it was")
    sys.exit(1)

# Temp file + swap, so a crash mid-write never leaves a truncated file.
with open(RELEASE_DATES_PATH + '.tmp','w') as f:
    json.dump(DATA,f)
os.replace(RELEASE_DATES_PATH + '.tmp', RELEASE_DATES_PATH)
