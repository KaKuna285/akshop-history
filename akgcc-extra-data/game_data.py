"""Build slim copies of the game-data tables the site reads.

The full Arknights game-data tables on the ArknightsAssets/ArknightsGamedata
mirror are large (EN + CN: ~100 MB of JSON for the operator page, ~49 MB
for the calendar), and the site reads a small fraction of them. This
writes, per server, a copy of each table with the *same top-level shape
and the same field names/value formats* but only the rows and fields some
page actually reads:

    json/gamedata/<en|cn>/<table>.json

js/util.js's gameDataFetch() loads these (falling back to the upstream
mirror if one is missing), so page code treats them exactly like the
full tables. All the client-side transforms (char_patch merge, rarity
remap, profession names, the Amiya rename, the EN/CN merges, module
grouping) happen in the browser -- this only removes what nothing reads.

The field lists below come from tracing every read in js/*.js. When a
page starts reading a new field, add it here, or it will be missing:
the field simply won't exist in the slim file. Arrays whose *length*
matters to the site (phases, skills, levelUpCostCond, potentialRanks,
skill levels, ...) are kept at full length; only their entries are
slimmed. Blackboards are kept whole because descriptions can reference
any key.

Run with no arguments in the workflow (fetches from the mirror), or
`python game_data.py --from <dir>` to slim a local checkout of the mirror
(<dir>/<server>/gamedata/excel/<table>.json) for testing.
"""

import json
import os
import re
import sys

MIRROR_BASE = "https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master"
SERVERS = ["en", "cn"]
OUT_DIR = "./json/gamedata"

# True = keep the value as-is; dict = keep only these keys (recursively);
# [spec] = a list whose every entry is slimmed with spec.
COST = [{"id": True, "count": True, "type": True}]
BLACKBOARD = True

CHARACTER = {
    "name": True,
    "appellation": True,
    "displayNumber": True,
    "profession": True,
    "subProfessionId": True,
    "nationId": True,
    "groupId": True,
    "teamId": True,
    "rarity": True,
    "classicPotentialItemId": True,
    "phases": [
        {
            "maxLevel": True,
            "evolveCost": COST,
            "attributesKeyFrames": [
                {
                    "level": True,
                    "data": {
                        k: True
                        for k in (
                            "maxHp",
                            "atk",
                            "def",
                            "magicResistance",
                            "cost",
                            "respawnTime",
                            "blockCnt",
                            "baseAttackTime",
                        )
                    },
                }
            ],
        }
    ],
    "allSkillLvlup": [{"lvlUpCost": COST}],
    "skills": [{"skillId": True, "levelUpCostCond": [{"levelUpCost": COST}]}],
    "potentialRanks": [
        {
            "description": True,
            "buff": {"attributes": {"attributeModifiers": [{"attributeType": True, "value": True}]}},
        }
    ],
    "talents": [
        {
            "candidates": [
                {
                    "name": True,
                    "unlockCondition": {"phase": True, "level": True},
                    "requiredPotentialRank": True,
                    "description": True,
                    "blackboard": BLACKBOARD,
                }
            ]
        }
    ],
}

# uniEquipDesc (module lore, ~80% of the table) goes to its own
# uniequip_lore file instead -- only the operator page shows it, and only
# when a module's lore is expanded, so the planner and calendar (which load
# this table too) don't download it.
UNIEQUIP = {
    k: True
    for k in ("uniEquipId", "uniEquipName", "typeName2", "charEquipOrder", "charId")
}
UNIEQUIP["itemCost"] = True  # dict keyed "1"/"2"/"3" -> cost lists; kept whole

# classifyType "NONE" marks items the game keeps out of its depot screen
# (event progress keys, faction prestige, ...); the planner hides them too.
ITEM = {"itemId": True, "name": True, "iconId": True, "rarity": True, "classifyType": True}

SKILL = {
    "iconId": True,
    "levels": [
        {
            "name": True,
            "spData": {"spCost": True, "initSp": True},
            "description": True,
            "blackboard": BLACKBOARD,
        }
    ],
}

TRAIT_TALENT_CANDIDATE = {
    "description": True,
    "upgradeDescription": True,
    "additionalDescription": True,
    "overrideDescripton": True,  # sic -- the game data's own spelling
    "blackboard": BLACKBOARD,
}
BATTLE_EQUIP = {
    "phases": [
        {
            "equipLevel": True,
            "attributeBlackboard": BLACKBOARD,
            "parts": [
                {
                    "addOrOverrideTalentDataBundle": {"candidates": [TRAIT_TALENT_CANDIDATE]},
                    "overrideTraitDataBundle": {"candidates": [TRAIT_TALENT_CANDIDATE]},
                }
            ],
        }
    ]
}

SKIN = {
    "charId": True,
    "skinId": True,
    "avatarId": True,
    "portraitId": True,
    "isBuySkin": True,
    # Which animated chibi the operator page shows for this outfit (see
    # chibiFiles() in js/chibi-viewer.js).
    "tmplId": True,
    "buildingId": True,
    "battleSkin": True,
    "displaySkin": {
        k: True for k in ("sortId", "skinName", "skinGroupId", "skinGroupName", "content", "usage")
    },
}

MEDAL = {
    k: True
    for k in (
        "medalId",
        "medalName",
        "medalType",
        "rarity",
        "isHidden",
        "description",
        "getMethod",
        "preMedalIdList",
    )
}

GAMEDATA_CONST_KEYS = ["characterExpMap", "characterUpgradeCostMap", "evolveGoldCost"]

# What the CN character table still has to carry for an operator EN
# *already has*: every page merges EN and CN with EN winning, except the
# shop page, which reads the CN table on its own -- CN shop history is
# keyed by Chinese name, and its filters read rarity / Kernel status from
# it. (profession only feeds the Amiya rename in get_char_table().)
CHARACTER_CN_SHOP_ONLY = {
    k: True
    for k in ("name", "appellation", "displayNumber", "profession", "rarity", "classicPotentialItemId")
}


def slim(value, spec):
    """Keep only what `spec` names. A list spec applies to every entry; the
    game data sometimes has {} where a list is expected (an empty list
    serialised as an object), which is normalised to [] -- the client
    iterates these with for...of, which would throw on {}."""
    if spec is True or value is None:
        return value
    if isinstance(spec, list):
        if isinstance(value, dict) and not value:
            return []
        if not isinstance(value, list):
            return value
        return [slim(v, spec[0]) for v in value]
    if isinstance(spec, dict):
        if not isinstance(value, dict):
            return value
        return {k: slim(value[k], sub) for k, sub in spec.items() if k in value}
    return value


def build_cn(cn, en):
    """Slim the CN tables down to what the site reads *from CN*, given the
    already-built EN ones. Every page merges EN and CN by key with EN
    winning (CN only fills gaps: CN-only operators, and the skills,
    modules, skins and items EN doesn't have yet), so for anything EN has,
    the CN copy is never read -- with one exception, the CN character
    table, which the shop page reads in full (see CHARACTER_CN_SHOP_ONLY).
    medal_table and gamedata_const are only ever read from EN."""
    out = {}
    en_chars = {**en["character_table"], **en["char_patch_table"]["patchChars"]}
    out["character_table"] = {
        k: (slim(v, CHARACTER_CN_SHOP_ONLY) if k in en_chars else v)
        for k, v in cn["character_table"].items()
    }
    out["char_patch_table"] = cn["char_patch_table"]
    en_equips = en["uniequip_table"]["equipDict"]
    out["uniequip_table"] = {
        "equipDict": {k: v for k, v in cn["uniequip_table"]["equipDict"].items() if k not in en_equips}
    }
    out["uniequip_lore"] = {k: v for k, v in cn["uniequip_lore"].items() if k not in en_equips}
    for name in ("battle_equip_table", "skill_table"):
        out[name] = {k: v for k, v in cn[name].items() if k not in en[name]}
    en_skins = en["skin_table"]["charSkins"]
    out["skin_table"] = {"charSkins": {k: v for k, v in cn["skin_table"]["charSkins"].items() if k not in en_skins}}
    en_items = en["item_table"]["items"]
    out["item_table"] = {"items": {k: v for k, v in cn["item_table"]["items"].items() if k not in en_items}}
    return out


def build(tables):
    """tables: {"character_table": {...}, ...} raw JSON for one server.
    Returns {table name: slim JSON} with each table's original top-level
    shape. Row filtering only drops rows the client ignores anyway."""
    out = {}

    # Characters: the client deletes records without a displayNumber
    # (tokens, traps), so they're dropped here too. Patch characters
    # (Amiya's other forms) are slimmed the same way, in char_patch_table.
    chars = {
        k: slim(v, CHARACTER)
        for k, v in tables["character_table"].items()
        if isinstance(v, dict) and v.get("displayNumber")
    }
    out["character_table"] = chars
    patch = (tables.get("char_patch_table") or {}).get("patchChars") or {}
    out["char_patch_table"] = {"patchChars": {k: slim(v, CHARACTER) for k, v in patch.items()}}
    all_chars = {**chars, **out["char_patch_table"]["patchChars"]}

    # Modules: the client skips equips without charId / itemCost / typeName2
    # (the placeholder "original" ones), so they're dropped here too.
    equip_src = tables["uniequip_table"]
    equip_dict = equip_src.get("equipDict", equip_src)
    equips = {
        k: slim(v, UNIEQUIP)
        for k, v in equip_dict.items()
        if isinstance(v, dict) and v.get("charId") and v.get("itemCost") and v.get("typeName2")
    }
    out["uniequip_table"] = {"equipDict": equips}
    out["uniequip_lore"] = {k: equip_dict[k]["uniEquipDesc"] for k in equips if equip_dict[k].get("uniEquipDesc")}

    # Battle-equip stats: only for modules kept above.
    out["battle_equip_table"] = {
        k: slim(v, BATTLE_EQUIP) for k, v in tables["battle_equip_table"].items() if k in equips
    }

    # Skills: only those some kept character references.
    skill_ids = {
        s.get("skillId")
        for c in all_chars.values()
        for s in (c.get("skills") or [])
        if isinstance(s, dict) and s.get("skillId")
    }
    out["skill_table"] = {k: slim(v, SKILL) for k, v in tables["skill_table"].items() if k in skill_ids}

    # Skins: only for kept characters (drops token/trap skins).
    skins = tables["skin_table"].get("charSkins") or {}
    out["skin_table"] = {
        "charSkins": {
            k: slim(v, SKIN)
            for k, v in skins.items()
            if isinstance(v, dict) and v.get("charId") in all_chars
        }
    }

    # Items: every row kept -- the planner's depot search lists every named
    # item, and sanitizeDepot() deletes saved depot entries whose id isn't
    # in the table, so pruning rows here could wipe someone's saved depot.
    items = tables["item_table"]
    out["item_table"] = {"items": {k: slim(v, ITEM) for k, v in (items.get("items", items)).items()}}

    const = tables["gamedata_const"]
    out["gamedata_const"] = {k: const.get(k, []) for k in GAMEDATA_CONST_KEYS}

    medals = tables["medal_table"].get("medalList") or []
    out["medal_table"] = {"medalList": [slim(m, MEDAL) for m in medals]}
    return out


TABLES = [
    "character_table",
    "char_patch_table",
    "uniequip_table",
    "battle_equip_table",
    "skill_table",
    "skin_table",
    "item_table",
    "gamedata_const",
    "medal_table",
]


def parse_json_lenient(text):
    # Same as util.js's fixedJson(): the mirror can serve trailing commas.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(re.sub(r",\s*([}\]])", r"\1", text))


def load_tables_local(root, server):
    tables = {}
    for name in TABLES:
        with open(os.path.join(root, server, "gamedata", "excel", f"{name}.json"), encoding="utf8") as f:
            tables[name] = parse_json_lenient(f.read())
    return tables


def load_tables_remote(server, http_get):
    tables = {}
    for name in TABLES:
        r = http_get(f"{MIRROR_BASE}/{server}/gamedata/excel/{name}.json")
        if r.status_code != 200:
            raise RuntimeError(f"{server}/{name}.json: HTTP {r.status_code}")
        tables[name] = parse_json_lenient(r.content.decode("utf8"))
    return tables


def write_if_changed(path, data):
    """Compact JSON, and only rewritten when the content differs, so a day
    with no game update produces no commit."""
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    try:
        with open(path, encoding="utf8") as f:
            if f.read() == text:
                return False
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        f.write(text)
    os.replace(tmp, path)
    return True


def sanity_check(server, slim_tables):
    """Refuse to write an obviously broken result (a renamed field upstream
    could otherwise produce an empty-but-valid file the site would happily
    load). Thresholds are far below the real counts. Runs on the full
    per-server build, before build_cn() cuts CN down to its gaps (the gap
    tables can legitimately be near-empty)."""
    counts = {
        "character_table": len(slim_tables["character_table"]),
        "skill_table": len(slim_tables["skill_table"]),
        "uniequip_table": len(slim_tables["uniequip_table"]["equipDict"]),
        "skin_table": len(slim_tables["skin_table"]["charSkins"]),
        "item_table": len(slim_tables["item_table"]["items"]),
        "medal_table": len(slim_tables["medal_table"]["medalList"]),
    }
    minimums = {"character_table": 300, "skill_table": 500, "uniequip_table": 100, "skin_table": 500, "item_table": 500, "medal_table": 100}
    low = {k: v for k, v in counts.items() if v < minimums[k]}
    if low:
        raise RuntimeError(f"{server}: suspiciously few rows {low} -- not writing")
    return counts


def main(argv):
    local_root = None
    if len(argv) >= 2 and argv[0] == "--from":
        local_root = argv[1]
    http_get = None
    if local_root is None:
        from common import http_get
    manifest = {"source": MIRROR_BASE, "servers": {}}
    changed = []
    built = {}
    for server in SERVERS:
        raw = load_tables_local(local_root, server) if local_root else load_tables_remote(server, http_get)
        built[server] = build(raw)
        manifest["servers"][server] = sanity_check(server, built[server])
    outputs = {"en": built["en"], "cn": build_cn(built["cn"], built["en"])}
    for server, slim_tables in outputs.items():
        for name, data in slim_tables.items():
            if write_if_changed(os.path.join(OUT_DIR, server, f"{name}.json"), data):
                changed.append(f"{server}/{name}")
    write_if_changed(os.path.join(OUT_DIR, "manifest.json"), manifest)
    print(f"Slim game data: {manifest['servers']}")
    print(f"Changed: {', '.join(changed) if changed else 'nothing (no game update)'}")


if __name__ == "__main__":
    main(sys.argv[1:])
