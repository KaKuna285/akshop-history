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
            obtain = page['title']['obtainMethod']
            online = page['title']['cnOnlineTime']
            limited = obtain in LIMITED_OBTAIN_METHODS
            DATA[charId] = {'cnOnlineTime':online, 'isLimited': limited}
        offset += limit
        if len(pages) < limit:
            break
    return DATA
def scrape_wiki():
    # update the prts.wiki data with global release dates from arknights.wiki.gg/
    # while it is possible to get limited status and some CN dates from the wiki, those only come from prts for now.
    # https://arknights.wiki.gg/wiki/Special:CargoTables
    #
    # join_on uses "O.operator", not "O.name" (a real bug this comment is
    # fixing) -- the Operators table's own display-name field is
    # "operator", confirmed by events.py's fetch_event_operators(), which
    # hand-verified this exact table's schema against the live wiki (see
    # that function's own docstring: Special:CargoTables is itself
    # robots.txt-blocked, same as api.php direct browsing, so it had to
    # be checked by hand rather than introspected). "O.name" isn't used
    # anywhere else in this project and most likely isn't the right
    # field -- joining OperatorFiles.name against it would only line up
    # by coincidence for an operator whose two differently-maintained
    # name fields (across two separately-maintained Cargo tables) happen
    # to match exactly, which fits the symptom this was fixing: this
    # join was silently producing zero rows -- so a missing onlineTime,
    # not a wrong one -- for operators whose name has any of the quirks
    # that make two independently-kept name fields more likely to drift
    # (quote marks, stylized characters like "Mon3tr", collab/event-only
    # names), while a plain name usually matched fine either way. Could
    # not re-verify this live (this project's own fetch tooling is
    # blocked by the same robots.txt rule), so if operator_release_dates
    # .json's onlineTime coverage doesn't visibly improve after this
    # merges, check this step's own Action log first.
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }
    url = "https://arknights.wiki.gg/api.php"
    limit = 500
    offset = 0
    params = {
        "action": "cargoquery",
        "tables": "Operators=O,OperatorFiles=F,EventServerDetails=S",
        "fields": "S.startTime=start,F.id=charId",
        "join_on": "O.event=S.event,F.name=O.operator",
        "format": "json",
        "where": "F.id IS NOT NULL AND S.startTime IS NOT NULL AND S.server LIKE 'global'",
    }
    while 1:
        params['limit'] = limit
        params['offset'] = offset
        r = http_get(url, params=params, headers=headers)
        pages = r.json()['cargoquery']
        for page in pages:
            charId = page['title']['charId']
            online = page['title']['start']
            if charId in DATA:
                DATA[charId]['onlineTime'] = online
        offset += limit
        if len(pages) < limit:
            break
    return DATA
scrape_PRTS()
scrape_wiki() # must call AFTER scrape_PRTS as it will update DATA (and relies on it being filled)
with open('./json/operator_release_dates.json','w') as f:
    json.dump(DATA,f)
