"""Machine-translate the CN-only gameplay text in the slim CN game data.

Operators, skills, modules, skins, base skills and items that EN doesn't
have yet are shown from the CN client's data, in Chinese. game_data.py
calls apply_translations() on the CN gap tables it writes: each Chinese
string in the fields below is replaced by an English translation from
DeepL, and the original is kept beside it under "_zh" ({field: original})
so the site can label the text as machine-translated and show the
original on hover. Names that identify an operator (character_table's
name/appellation) are never touched: the shop page matches CN shop
history by them. Lore texts (skin descriptions, module stories) are not
translated.

Translation details:
- Placeholders ({atk_scale:0%}), rich-text markers (<@ba.vup>...</>,
  <$ba.stun>...</>) and line breaks are swapped for XML tags before
  translating (DeepL's tag_handling=xml keeps tags intact and moves them
  with the words they belong to) and swapped back afterwards. A result
  that lost or invented a placeholder or marker, or still contains
  Chinese, is rejected and the string stays in Chinese.
- GLOSSARY maps game terms to their official EN wording (Arts damage,
  SP, Block, ...). It's uploaded as a DeepL glossary, named after a hash
  of its entries, so editing it creates a new one (and deletes the old).
- Translations are cached in json/translation_cache.json, keyed by the
  Chinese text, so each string is sent to DeepL once. Entries made with
  an older glossary are re-translated. Entries no longer needed (the
  operator came out on EN) are dropped.
- MAX_CHARS_PER_RUN caps what one run sends (DeepL Free allows 500,000
  characters a month); anything left over is done on the next run.
- Without DEEPL_API_KEY in the environment nothing is sent: cached
  translations are still applied, everything else stays in Chinese.
"""

import hashlib
import json
import os
import re
import xml.sax.saxutils as saxutils

import requests

CACHE_PATH = "./json/translation_cache.json"
MAX_CHARS_PER_RUN = 150_000
BATCH_SIZE = 40  # DeepL accepts up to 50 texts per request
CJK = re.compile(r"[㐀-鿿豈-﫿]")

# Chinese game term -> official EN client wording. Multi-character terms
# only: DeepL matches glossary entries inside words, so single characters
# would misfire.
GLOSSARY = {
    # stats
    "攻击力": "ATK",
    "防御力": "DEF",
    "生命上限": "Max HP",
    "最大生命值": "Max HP",
    "生命值": "HP",
    "法术抗性": "RES",
    "攻击速度": "ASPD",
    "攻击间隔": "Attack Interval",
    "部署费用": "DP Cost",
    "再部署时间": "Redeployment Time",
    "阻挡数": "Block",
    "技力": "SP",
    "嘲讽等级": "Taunt Level",
    # damage and status
    "物理伤害": "Physical damage",
    "法术伤害": "Arts damage",
    "真实伤害": "True damage",
    "元素伤害": "Elemental damage",
    "元素损伤": "Elemental Damage",
    "凋亡损伤": "Necrosis Damage",
    "神经损伤": "Nervous Impairment",
    "侵蚀损伤": "Corrosion Damage",
    "灼燃损伤": "Burn Damage",
    "晕眩": "Stun",
    "束缚": "Bind",
    "冻结": "Freeze",
    "寒冷": "Cold",
    "沉默": "Silence",
    "睡眠": "Sleep",
    "浮空": "Levitate",
    "恐惧": "Fear",
    "法术脆弱": "Arts Fragility",
    "脆弱": "Fragile",
    "隐匿": "Invisible",
    "迷彩": "Camouflage",
    "庇护": "Shelter",
    "屏障": "Barrier",
    "护盾": "Shield",
    "物理闪避": "Physical Dodge",
    "法术闪避": "Arts Dodge",
    "失衡": "Imbalance",
    "重量等级": "Weight",
    "召唤物": "Summon",
    # skills
    "自动回复": "Auto Recovery",
    "攻击回复": "Offensive Recovery",
    "受击回复": "Defensive Recovery",
    "手动触发": "Manual Trigger",
    "自动触发": "Auto Trigger",
    "持续时间": "Duration",
    "地面单位": "ground unit",
    "空中单位": "aerial unit",
    "近战位": "melee tile",
    "远程位": "ranged tile",
    "友方干员": "allied Operators",
    "干员": "Operator",
    "天赋": "Talent",
    "特性": "Trait",
    "模组": "Module",
    "潜能": "Potential",
    "精英化": "Elite Promotion",
    # classes
    "先锋": "Vanguard",
    "近卫": "Guard",
    "重装": "Defender",
    "狙击": "Sniper",
    "术师": "Caster",
    "医疗": "Medic",
    "辅助": "Supporter",
    "特种": "Specialist",
    # base (RIIC)
    "控制中枢": "Control Center",
    "制造站": "Factory",
    "贸易站": "Trading Post",
    "发电站": "Power Plant",
    "宿舍": "Dormitory",
    "会客室": "Reception Room",
    "办公室": "Office",
    "加工站": "Workshop",
    "训练室": "Training Room",
    "心情": "Morale",
    "生产力": "productivity",
    "订单效率": "order efficiency",
    "订单上限": "order limit",
    "无人机": "Drone",
    "线索": "Clue",
    "赤金": "Pure Gold",
    "作战记录": "Battle Record",
    "源石碎片": "Originium Shard",
    "龙门币": "LMD",
    "合成玉": "Orundum",
    "公开招募": "Recruitment",
}


def glossary_hash():
    return hashlib.sha1(json.dumps(GLOSSARY, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:10]


# --- protecting placeholders and markers ------------------------------------

# A placeholder, a rich-text opener (<@ba.vup> / <$ba.stun>), the closer
# (</>), or a line break (a real newline or the literal "\n" the game
# data uses).
TOKEN = re.compile(r"(\{[^{}]+\})|<([@$][^<>]+)>|(</>)|(\\n|\n)")


def protect(text):
    """Chinese text -> (XML for DeepL, data for restore()), or None when the
    markers don't pair up (such a string is left untranslated)."""
    parts = []
    spec = {"ph": [], "open": [], "nl": []}
    stack = []
    pos = 0
    for m in TOKEN.finditer(text):
        parts.append(saxutils.escape(text[pos : m.start()]))
        pos = m.end()
        if m.group(1):
            spec["ph"].append(m.group(1))
            parts.append(f'<x i="{len(spec["ph"]) - 1}"/>')
        elif m.group(2):
            spec["open"].append("<" + m.group(2) + ">")
            n = len(spec["open"]) - 1
            stack.append(n)
            parts.append(f"<t{n}>")
        elif m.group(3):
            if not stack:
                return None
            parts.append(f"</t{stack.pop()}>")
        else:
            spec["nl"].append(m.group(4))
            parts.append(f'<n i="{len(spec["nl"]) - 1}"/>')
    if stack:
        return None
    parts.append(saxutils.escape(text[pos:]))
    return "".join(parts), spec


# Also accepts <x i="0"></x> and single quotes, in case DeepL rewrites
# empty elements.
RESULT_TOKEN = re.compile(
    r"""<x i=["'](\d+)["']\s*/?>(?:</x>)?|<t(\d+)>|</t(\d+)>|<n i=["'](\d+)["']\s*/?>(?:</n>)?"""
)


def restore(xml, spec):
    """DeepL's XML -> the translated string with the original placeholders
    and markers, or None when anything is missing, duplicated, unbalanced
    or left in Chinese."""
    out = []
    pos = 0
    seen_ph, seen_open, seen_nl = [], [], []
    stack = []
    for m in RESULT_TOKEN.finditer(xml):
        out.append(saxutils.unescape(xml[pos : m.start()]))
        pos = m.end()
        if m.group(1) is not None:
            i = int(m.group(1))
            if i >= len(spec["ph"]):
                return None
            seen_ph.append(i)
            out.append(spec["ph"][i])
        elif m.group(2) is not None:
            i = int(m.group(2))
            if i >= len(spec["open"]):
                return None
            seen_open.append(i)
            stack.append(i)
            out.append(spec["open"][i])
        elif m.group(3) is not None:
            if not stack or stack.pop() != int(m.group(3)):
                return None
            out.append("</>")
        else:
            i = int(m.group(4))
            if i >= len(spec["nl"]):
                return None
            seen_nl.append(i)
            out.append(spec["nl"][i])
    out.append(saxutils.unescape(xml[pos:]))
    if stack:
        return None
    if sorted(seen_ph) != list(range(len(spec["ph"]))):
        return None
    if sorted(seen_open) != list(range(len(spec["open"]))):
        return None
    if sorted(seen_nl) != list(range(len(spec["nl"]))):
        return None
    text = "".join(out).strip()
    if not text:
        return None
    if CJK.search(re.sub(r"\{[^{}]+\}|<[@$][^<>]+>", "", text)):
        return None
    return text


# --- DeepL --------------------------------------------------------------------


class DeepL:
    def __init__(self, key, session=None):
        self.key = key
        self.host = "https://api-free.deepl.com" if key.endswith(":fx") else "https://api.deepl.com"
        self.session = session or requests.Session()
        self.headers = {"Authorization": f"DeepL-Auth-Key {key}"}

    def _call(self, method, path, **kwargs):
        r = self.session.request(method, self.host + path, headers=self.headers, timeout=60, **kwargs)
        if r.status_code >= 400:
            raise RuntimeError(f"DeepL {method} {path}: HTTP {r.status_code} {r.text[:200]}")
        return r.json() if r.content else None

    def ensure_glossary(self):
        """The glossary for the current GLOSSARY entries (created if needed);
        older ones made by this script are deleted."""
        name = f"akshop-{glossary_hash()}"
        found = None
        for g in self._call("GET", "/v2/glossaries").get("glossaries", []):
            if g.get("name") == name and g.get("ready", True):
                found = g["glossary_id"]
            elif str(g.get("name", "")).startswith("akshop-"):
                self._call("DELETE", f"/v2/glossaries/{g['glossary_id']}")
        if found:
            return found
        entries = "\n".join(f"{zh}\t{en}" for zh, en in GLOSSARY.items())
        g = self._call(
            "POST",
            "/v2/glossaries",
            json={"name": name, "source_lang": "zh", "target_lang": "en", "entries": entries, "entries_format": "tsv"},
        )
        return g["glossary_id"]

    def translate(self, xml_texts, glossary_id):
        body = {
            "text": xml_texts,
            "source_lang": "ZH",
            "target_lang": "EN-US",
            "tag_handling": "xml",
            "preserve_formatting": True,
        }
        if glossary_id:
            body["glossary_id"] = glossary_id
        return [t["text"] for t in self._call("POST", "/v2/translate", json=body)["translations"]]


# --- which fields get translated ---------------------------------------------


def _fields(cn, en_char_ids):
    """Yield (object, field) for every gameplay text field in the CN gap
    tables. Operator name fields are left alone (see the module docstring)."""
    for char_id, c in cn["character_table"].items():
        if char_id in en_char_ids or not isinstance(c, dict):
            continue
        for talent in c.get("talents") or []:
            for cand in (talent or {}).get("candidates") or []:
                if isinstance(cand, dict):
                    yield cand, "name"
                    yield cand, "description"
        for rank in c.get("potentialRanks") or []:
            if isinstance(rank, dict):
                yield rank, "description"
    for skill in cn["skill_table"].values():
        for level in (skill or {}).get("levels") or []:
            if isinstance(level, dict):
                yield level, "name"
                yield level, "description"
    for equip in cn["uniequip_table"]["equipDict"].values():
        if isinstance(equip, dict):
            yield equip, "uniEquipName"
    for equip in cn["battle_equip_table"].values():
        for phase in (equip or {}).get("phases") or []:
            for part in (phase or {}).get("parts") or []:
                for bundle in ("addOrOverrideTalentDataBundle", "overrideTraitDataBundle"):
                    for cand in ((part or {}).get(bundle) or {}).get("candidates") or []:
                        if isinstance(cand, dict):
                            for f in ("description", "upgradeDescription", "additionalDescription", "overrideDescripton"):
                                yield cand, f
    for skin in cn["skin_table"]["charSkins"].values():
        display = (skin or {}).get("displaySkin")
        if isinstance(display, dict):
            yield display, "skinName"
            yield display, "skinGroupName"
    for buff in cn["building_data"]["buffs"].values():
        if isinstance(buff, dict):
            yield buff, "buffName"
            yield buff, "description"
    for item in cn["item_table"]["items"].values():
        if isinstance(item, dict):
            yield item, "name"


def load_cache(path=CACHE_PATH):
    try:
        with open(path, encoding="utf8") as f:
            data = json.load(f)
        return data.get("entries", {}) if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def apply_translations(cn, en_char_ids, client=None, cache=None, max_chars=MAX_CHARS_PER_RUN):
    """Translate the CN gap tables in place. `client` is a DeepL (None: no
    API calls, cached translations only); `cache` is the entries dict from
    load_cache(), updated in place and pruned to the strings still in use.
    Returns stats for the run."""
    cache = load_cache() if cache is None else cache
    ghash = glossary_hash()
    targets = [(obj, f) for obj, f in _fields(cn, en_char_ids) if isinstance(obj.get(f), str) and CJK.search(obj[f])]
    wanted = {obj[f] for obj, f in targets}
    stats = {"strings": len(wanted), "translated": 0, "cached": 0, "rejected": 0, "pending": 0, "error": None}

    todo = [s for s in wanted if not (s in cache and cache[s].get("g") == ghash)]
    todo.sort(key=len)
    if client and todo:
        try:
            glossary_id = client.ensure_glossary()
        except Exception as exc:  # glossary trouble shouldn't stop translation
            print(f"DeepL glossary unavailable, translating without it: {exc}")
            glossary_id = None
        sent = 0
        batch = []

        def flush():
            nonlocal batch
            if not batch:
                return
            results = client.translate([xml for _, xml, _ in batch], glossary_id)
            for (src, _, spec), xml in zip(batch, results):
                en = restore(xml, spec)
                cache[src] = {"en": en, "g": ghash}
                if en is None:
                    cache[src]["raw"] = xml[:500]
                    stats["rejected"] += 1
                    print(f"Rejected translation of {src[:60]!r}: {xml[:120]!r}")
                else:
                    stats["translated"] += 1
            batch = []

        try:
            for src in todo:
                protected = protect(src)
                if protected is None:
                    cache[src] = {"en": None, "g": ghash, "raw": "unbalanced markers"}
                    stats["rejected"] += 1
                    continue
                if sent + len(src) > max_chars:
                    break
                sent += len(src)
                batch.append((src, protected[0], protected[1]))
                if len(batch) >= BATCH_SIZE:
                    flush()
            flush()
        except Exception as exc:
            stats["error"] = str(exc)[:300]
            print(f"DeepL translation stopped: {exc}")

    for obj, f in targets:
        src = obj[f]
        en = (cache.get(src) or {}).get("en")
        if en:
            obj.setdefault("_zh", {})[f] = src
            obj[f] = en
    stats["pending"] = len({s for s in wanted if not (s in cache and cache[s].get("g") == ghash)})
    stats["cached"] = sum(1 for s in wanted if cache.get(s, {}).get("en")) - stats["translated"]

    for src in list(cache):
        if src not in wanted:
            del cache[src]
    return stats


def save_cache(cache, path=CACHE_PATH):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = json.dumps({"glossary": glossary_hash(), "entries": dict(sorted(cache.items()))}, ensure_ascii=False, indent=0)
    try:
        with open(path, encoding="utf8") as f:
            if f.read() == text:
                return False
    except FileNotFoundError:
        pass
    with open(path, "w", encoding="utf8") as f:
        f.write(text)
    return True


def client_from_env():
    key = os.environ.get("DEEPL_API_KEY", "").strip()
    return DeepL(key) if key else None
