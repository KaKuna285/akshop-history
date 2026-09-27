'''Get banner history from gamepress and convert to json format.'''
## NOTE: if gamepress revives check to make sure kernal locating banners are ignored
import requests
import re
import json
from pprint import pprint
from urllib.parse import quote
from html import unescape
# import xml.etree.ElementTree as ET
# from lxml import etree
NA_OPS = {}
CN_OPS = {}
ALIAS = {
    'Mlynar':'Młynar',
    'Leto':'Лето',
    '麒麟X夜刀':'麒麟R夜刀',
    }
def get_operator_lists_gp(live = True):
    # xml is malformed, so we use regex instead.
    if live:
        r = requests.get('https://gamepress.gg/arknights/database/banner-list-gacha')
        r.encoding = 'utf8'
        content = r.text
        with open('i_oplist_cache','w',encoding='utf8') as f:
            f.write(content)
    else:
        with open('i_oplist_cache','r',encoding='utf8') as f:
            content = f.read()
    tables = re.compile('<tbody>.*?</tbody>',re.DOTALL)
    # skip the first table as it's just upcoming for global
    for table in tables.findall(content)[1:]:
        rows = re.compile('<tr>.*?</tr>',re.DOTALL)
        for row in rows.findall(table):
            cn_date = re.compile('<td[^>]*views-field-field-cn-end-date[^>]*>(.*?)</td>',re.DOTALL)
            na_date = re.compile('<td[^>]*views-field-field-start-time[^>]*>(.*?)</td>',re.DOTALL)
            shop_ops = re.compile('<td[^>]*views-field-field-store-operators[^>]*>(.*?)</td>',re.DOTALL)
            banner_ops = re.compile('<td[^>]*views-field-field-featured-characters[^>]*>(.*?)</td>',re.DOTALL)
            time_parser = re.compile('<time[^>]*?>([^<]*)</time>',re.DOTALL)
            op_parser = re.compile('<a[^>]*?>([^<]*)</a>',re.DOTALL)
            link_parser = re.compile('<td[^>]*views-field-field-event-banner[^>]*>[^<]*<a\\s+href="([^"]*)',re.DOTALL)
            na_times = na_date.findall(row)[0]
            cn_times = cn_date.findall(row)[0]
            na_m = time_parser.match(na_times)
            cn_m = time_parser.match(cn_times)
            sim_link = link_parser.findall(row)[0]
            blue = int('#BB_'.lower() in sim_link.lower())
            for op_name in op_parser.findall(shop_ops.findall(row)[0]):
                if na_m:
                    l = NA_OPS.setdefault(op_name,{'shop':[],'banner':[]})
                    l['shop'].append({'date': na_m.group(1), 'blue': blue})
                if cn_m:
                    l = CN_OPS.setdefault(op_name,{'shop':[],'banner':[]})
                    l['shop'].append({'date': cn_m.group(1), 'blue': blue})
            for op_name in op_parser.findall(banner_ops.findall(row)[0]):
                if na_m:
                    l = NA_OPS.setdefault(op_name,{'shop':[],'banner':[]})
                    l['banner'].append({'date': na_m.group(1), 'blue': blue})
                if cn_m:
                    l = CN_OPS.setdefault(op_name,{'shop':[],'banner':[]})
                    l['banner'].append({'date': cn_m.group(1), 'blue': blue})
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
    r = requests.get(url, params=params)
    pages = [p["title"] for p in r.json()["query"]["categorymembers"] if p['ns'] == 0 and 'Upcoming' not in p['title']]
    # pages.append('Headhunting/Banners')
    params = {
        "action": "query",
        "prop": "revisions",
        "titles": "|".join(pages),
        "rvslots": "main",
        "rvprop": "content",
        "formatversion": "2",
        "format": "json",
    }
    r = requests.get(url, params=params)
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
    r = requests.get(url, params=params, headers=headers)
    pages = []
    blue = 0
    for page in r.json()['query']['pages']:
        blue = page['title'] == "卡池一览/常驻中坚寻访&中坚甄选"
        pages.extend([(p,blue) for p in re.findall('pageName=([^|}]*)', page['revisions'][0]['slots']['main']['content'])])
    pages.append((banner_pages[2], False))
    blue_pages = dict(pages)
    params['titles'] = '|'.join(p[0] for p in pages)
    r = requests.get(url, params=params, headers=headers)
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

get_operator_lists_prts()
# get_operator_lists_gp(live=True)
get_operator_lists_wiki()
with open('./json/banner_history.json','w') as f:
    if NA_OPS and CN_OPS:
        json.dump({'NA':NA_OPS,'CN':CN_OPS},f)
