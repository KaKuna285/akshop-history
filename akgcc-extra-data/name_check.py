"""Find shop-history operator names the site won't be able to place.

banner_history.json is keyed by operator *name* as the wikis write it, and
the shop page (js/util.js normalizeShopHistory()) turns each name into a
charId through game data -- character_table.json's `name` and
`appellation`, for both EN and CN, plus a few hand-kept alias maps in
util.js (GAMEPRESS_NAME_MAP, CN_ID_MAP, SHORT_NAMES) for names the wikis
spell differently from the game ("Pozëmka" vs "Позёмка"). A name that
resolves to nothing is silently dropped from the chart; the only trace is a
console.log in the visitor's browser. That's the one recurring manual job
on this site -- a new operator whose wiki name differs from its game-data
name needs an alias -- so this repeats the same lookup in the pipeline and
reports the misses, which health.py turns into a warning (and, if it lasts,
a GitHub issue).

The alias maps are read straight out of js/util.js rather than copied here,
so there is only one list to edit. Game data comes from the same mirror
util.js's DATA_BASE uses (GAME_DATA_MIRROR).
"""

import json
import os
import re
from html import unescape

GAMEDATA_BASE = "https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master"
GAMEDATA_SERVERS = ["cn", "en"]  # util.js loads both; any match counts
UTIL_JS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "js", "util.js")
JS_NAME_MAPS = ["GAMEPRESS_NAME_MAP", "CN_ID_MAP", "SHORT_NAMES"]

# normalizeShopHistory() skips these without logging; so do we.
IGNORED_NAME_FRAGMENTS = ["APRIL FOOLS"]

_JS_STRING = r'"((?:[^"\\]|\\.)*)"'
_JS_PAIR_RE = re.compile(r'(?:' + _JS_STRING + r'|([^\s,:"{}]+))\s*:\s*' + _JS_STRING)


def read_js_string_map(source, name):
    """Parse `const NAME = { key: "value", "key two": "value", };` out of
    JS source. Only handles what these maps actually contain: string
    values, quoted or bare keys, // comments. Raises ValueError if the
    map isn't found, so a renamed/moved map is reported instead of
    silently checking against nothing."""
    m = re.search(r"const\s+" + re.escape(name) + r"\s*=\s*\{(.*?)\};", source, re.DOTALL)
    if not m:
        raise ValueError(f"couldn't find {name} in util.js")
    body = re.sub(r"//[^\n]*", "", m.group(1))
    out = {}
    for quoted_key, bare_key, value in _JS_PAIR_RE.findall(body):
        key = json.loads(f'"{quoted_key}"') if quoted_key else bare_key
        out[key] = json.loads(f'"{value}"')
    return out


def load_js_name_maps(path=UTIL_JS_PATH):
    with open(path, encoding="utf8") as f:
        source = f.read()
    return {name: read_js_string_map(source, name) for name in JS_NAME_MAPS}


def parse_json_lenient(text):
    """util.js's fixedJson(): the mirror can serve JSON with trailing
    commas, so retry with those stripped."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(re.sub(r",\s*([}\]])", r"\1", text))


def known_names(tables):
    """Every string util.js's get_char_table() would put in charIdMap:
    name and appellation of each playable character (displayNumber set),
    including char_patch_table's patchChars. (util.js also renames Amiya's
    forms to "Amiya (Caster)" etc.; her plain name is kept here too, since
    her appellation is "Amiya" anyway.)"""
    names = set()
    for table in tables:
        for char in table.values():
            if not isinstance(char, dict) or not char.get("displayNumber"):
                continue
            for key in ("name", "appellation"):
                if char.get(key):
                    names.add(char[key])
    return names


def unmatched_names(banner_history, tables, js_maps):
    """{"NA": [...], "CN": [...]}: names normalizeShopHistory() would drop."""
    names = known_names(tables)
    gamepress = js_maps.get("GAMEPRESS_NAME_MAP", {})
    short = js_maps.get("SHORT_NAMES", {})
    # CN_ID_MAP: an EN name that resolves to whatever its CN spelling does.
    for en_name, cn_name in js_maps.get("CN_ID_MAP", {}).items():
        if cn_name in names:
            names.add(en_name)
    # SHORT_NAMES: the short name resolves to whatever the full one does.
    for full, short_name in short.items():
        if full in names:
            names.add(short_name)
    out = {}
    for server in ("NA", "CN"):
        missing = []
        for raw in banner_history.get(server) or {}:
            name = unescape(raw)
            if any(frag in name for frag in IGNORED_NAME_FRAGMENTS):
                continue
            op = short.get(name, name)
            op = gamepress.get(op, op)
            if op not in names:
                missing.append(name)
        out[server] = sorted(missing)
    return out


def fetch_tables(http_get):
    tables = []
    for server in GAMEDATA_SERVERS:
        for filename in ("character_table.json", "char_patch_table.json"):
            r = http_get(f"{GAMEDATA_BASE}/{server}/gamedata/excel/{filename}")
            if r.status_code != 200:
                raise RuntimeError(f"{server}/{filename}: HTTP {r.status_code}")
            data = parse_json_lenient(r.text)
            tables.append(data.get("patchChars", {}) if filename.startswith("char_patch") else data)
    return tables


def check(banner_history, http_get):
    return unmatched_names(banner_history, fetch_tables(http_get), load_js_name_maps())
