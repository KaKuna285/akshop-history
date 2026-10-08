'''Build json/banner_history.json: every operator's headhunting-banner and
shop appearances, per server -- EN from arknights.wiki.gg's yearly
Headhunting/Banners pages, CN from PRTS's banner-list pages (which is also
where CN's Kernel vs Limited pool distinction comes from).'''
import requests
import re
import json
import os
import sys
import time
from datetime import datetime, timezone
from html import unescape

# Plain requests.get() has no timeout by default, so a slow or rate-limited
# wiki can hang a run indefinitely instead of failing loudly (this is what
# happened on a run that sat on shop_operators.py for 2+ minutes with no
# error). http_get() always sets a timeout and retries a couple of times
# with backoff before actually raising, so a genuinely-down wiki still fails
# fast and with a clear error in the Action log.
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


NA_OPS = {}
CN_OPS = {}
ALIAS = {
    'Mlynar':'Młynar',
    'Leto':'Лето',
    '麒麟X夜刀':'麒麟R夜刀',
    }
def extract_banners_cell_templates(wikitext):
    # chatGPT function
    # Regex pattern to match {{Banners cell|...}} templates
    pattern = r'{{Banners[ _]cell\s*\|([\s\S]*?)}}'

    # Find all matches
    matches = re.findall(pattern, wikitext)
    # List to store parsed parameters for each template
    parsed_templates = []

    for match in matches:
        # Split parameters by '|' and extract key-value pairs
        parameters = {}
        for param in match.split('|'):
            # Split key-value by '='
            key_value = param.split('=', 1)
            if len(key_value) == 2:
                parameters[key_value[0].strip()] = key_value[1].strip()
        parsed_templates.append(parameters)

    return parsed_templates
def extract_prts_banners_cell_templates(wikitext):
    # Another chatGPT function
    # Regex to match each row
    row_pattern = re.compile(
    r'\|-\s*\n'                    # Match row start '|-' followed by optional spaces and a newline
    r'(?:\|.*?\s*)*?'              # Skip any cells before the date, non-capturing group
    r'\|(\d{4}-\d{2}-\d{2}).*?'  # Match and capture the date (format: YYYY-MM-DD)
    r'(\|.*?)(?=\|-\s*\n|\Z)',       # Capture everything after the date until the next row starts or end of content
    re.DOTALL
)
    # Regex to match the {{干员头像}} templates within a cell
    avatar_pattern = re.compile(r'\{\{干员头像\|([^|}]+)(.*?)\}\}')

    results = []
    for match in row_pattern.finditer(wikitext):
        date = match.group(1).strip()
        avatar_cells = match.group(2).strip()
        # Extract and parse all {{干员头像}} templates
        avatars = []
        for avatar_match in avatar_pattern.finditer(avatar_cells):
            name = avatar_match.group(1).strip()  # The name of the avatar
            args = avatar_match.group(2).strip()  # Any optional arguments
            parsed_args = {}
            if args:
                # Split optional arguments and parse them as key-value pairs
                for arg in args.split('|'):
                    if arg:
                        if '=' in arg:
                            key, value = arg.split('=', 1)
                            parsed_args[key.strip()] = value.strip()
                        else:
                            parsed_args[arg.strip()] = None
            avatars.append({"name": name, "args": parsed_args})
        results.append({
            "date": date,
            "avatars": avatars,
        })
    return results
def get_operator_lists_wiki():
    # get list of banner pages:
    url = "https://arknights.wiki.gg/api.php"
    params = {
        "action": "query",
        "list": "categorymembers",
        "cmtitle": "Category:Headhunting banners",
        "cmlimit": "max",
        "format": "json",
    }
    r = http_get(url, params=params)
    pages = [p["title"] for p in r.json()["query"]["categorymembers"] if p['ns'] == 0 and 'Upcoming' not in p['title']]
    params = {
        "action": "query",
        "prop": "revisions",
        "titles": "|".join(pages),
        "rvslots": "main",
        "rvprop": "content",
        "formatversion": "2",
        "format": "json",
    }
    r = http_get(url, params=params)
    all_pages = r.json()["query"]["pages"]
    for page in all_pages:
    # for page in pages:
        content = page['revisions'][0]['slots']['main']['content']
        banners = []
        banners.extend(extract_banners_cell_templates(content))  # for each year

        for banner in banners:
            blue = int('type' in banner and 'kernel' in banner['type'].lower())
            if blue and 'locating' in banner['type'].lower():
                continue  # skip kernel locating
            if 'type' in banner and 'linkup' in banner['type'].lower():
                continue  # skip linkup
            raw_date = banner.get('date') or banner.get('global', '') or banner.get('start') or banner.get('globalstart')
            date = unescape(raw_date).split('–')[0].strip()

            ops = []
            for key in ['operators', 'operators1', 'operators2']:
                if key in banner:
                    ops.extend([n.strip() for n in banner[key].split(',')])
            store = [int(n.strip()) for n in banner['store'].split(',')] if 'store' in banner else [0]*len(ops)
            for i, op_name in enumerate(ops):
                l = NA_OPS.setdefault(ALIAS.get(op_name, op_name), {'shop': [], 'banner': []})
                l['banner'].append({'date': date, 'blue': blue})
                if store[i] == 1:
                    l['shop'].append({'date': date, 'blue': blue})

def get_operator_lists_prts():
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
    banner_pages = [
        "卡池一览/常驻中坚寻访&中坚甄选",  # blue
        "卡池一览/常驻标准寻访",          # standard
        "卡池一览/限时寻访"              # limited
    ]
    params = {
        "action": "query",
        "prop": "revisions",
        "titles": "|".join(banner_pages[:2]),
        "rvslots": "main",
        "rvprop": "content",
        "formatversion": "2",
        "format": "json",
    }
    r = http_get(url, params=params, headers=headers)
    pages = []
    blue = 0
    for page in r.json()['query']['pages']:
        blue = page['title'] == "卡池一览/常驻中坚寻访&中坚甄选"
        pages.extend([(p,blue) for p in re.findall('pageName=([^|}]*)', page['revisions'][0]['slots']['main']['content'])])
    pages.append((banner_pages[2], False))
    blue_pages = dict(pages)
    params['titles'] = '|'.join(p[0] for p in pages)
    r = http_get(url, params=params, headers=headers)
    for page in r.json()['query']['pages']:
        is_blue = blue_pages[page['title']]
        banners = []
        banners.extend(extract_prts_banners_cell_templates(page['revisions'][0]['slots']['main']['content']))
        for banner in banners:
            # skip kernal locating ??
            date = banner['date'].split('~&lt;')[0].strip()
            for op in banner['avatars']:
                l = CN_OPS.setdefault(ALIAS.get(op['name'],op['name']),{'shop':[],'banner':[]})
                l['banner'].append({'date': date, 'blue': int(is_blue)})
                if 'shop' in op['args'] or 'shop2' in op['args']:
                    l['shop'].append({'date': date, 'blue': int(is_blue)})

def write_json_atomic(path, data):
    """Write to a temp file, then swap it in, so a crash halfway through
    never leaves a truncated file behind to be committed."""
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, path)


if __name__ == '__main__':
    get_operator_lists_prts()
    get_operator_lists_wiki()
    if not NA_OPS or not CN_OPS:
        # Nothing parseable from one of the wikis (a changed template, an
        # error page). Keep yesterday's banner_history.json untouched and
        # fail this step, so the run goes red and health.py reports it --
        # this used to open the file for writing *before* this check, which
        # emptied it and still exited 0, so the empty file got committed.
        print(f'No banner data scraped (EN: {len(NA_OPS)}, CN: {len(CN_OPS)}) -- leaving banner_history.json as it was')
        sys.exit(1)
    # generatedAt powers the "data updated" note on the shop history
    # page (js/shoplist.js) -- a top-level key alongside NA/CN, same
    # pattern events.py already uses for events.json. Consumers only
    # ever read .NA/.CN off this object, so extra top-level keys are
    # harmless to them.
    output = {'NA': NA_OPS, 'CN': CN_OPS, 'generatedAt': datetime.now(timezone.utc).isoformat()}
    # Names the shop page won't be able to match to an operator (see
    # name_check.py) -- read by health.py. Optional: if the check itself
    # can't run, the data is still written and health.py says so.
    try:
        import name_check
        output['unmatchedNames'] = name_check.check(output, http_get)
        print(f"Unmatched operator names: {output['unmatchedNames']}")
    except Exception as exc:
        output['nameCheckError'] = str(exc)
        print(f"Couldn't check operator names against game data: {exc}")
    write_json_atomic('./json/banner_history.json', output)
