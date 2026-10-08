// EXTRA_DATA_REPO_RAW_BASE now lives in js/config.js (loaded before this
// file) -- shared across util.js, shoplist.js, and calendar.js.

// The upstream game-data mirror (ArknightsAssets/ArknightsGamedata, updated
// on every game patch). Pages don't read it directly any more: they load the
// slim copies via gameDataFetch() below, which only falls back to this.
const GAME_DATA_MIRROR = "https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master";
const DATA_SOURCE_LOCAL = "https://cdn.jsdelivr.net/gh/akgcc/arkdata@main/";
const ASSET_SOURCE = {
  LOCAL: `${DATA_SOURCE_LOCAL}assets/`,
  ACESHIP: "https://cdn.jsdelivr.net/gh/Aceship/Arknight-Images@main/",
  // myrtle.moe's asset API: skin illustrations and chibi Spine files,
  // extracted straight from the official game CDN, so it has every current
  // skin. Normally reached through this site's own mirror instead -- see
  // myrtleAssetUrl() below.
  MYRTLE: "https://api.myrtle.moe/api/assets/",
};

// do not modify SERVERS even if you change data source as this is used locally as well.
const SERVERS = {
  EN: "en_US",
  JP: "ja_JP",
  KR: "ko_KR",
  CN: "zh_CN",
};
// data URI gen:
function uri_avatar(charId, source = ASSET_SOURCE.LOCAL) {
  let skinSuffix = "";
  if (charId.includes("_amiya")) skinSuffix = "_2";
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/arts/charavatars/${charId}${skinSuffix}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}avatars/${charId}${skinSuffix}.png`;
  }
}

// A skin's own avatarId (e.g. "char_002_amiya_winter#1", from skin_table.
// json's charSkins[skinId].avatarId -- see operator-page.js's loadSkinTable())
// already names the exact asset, unlike uri_avatar()'s charId+hardcoded-
// Amiya-suffix guess above, so no special-casing is needed here -- just
// URL-encode it (avatarIds contain "#", which breaks an unencoded URL by
// being read as a fragment). Verified against both mirrors directly
// (real browser fetch, not assumed from uri_avatar()'s convention) before
// relying on this: LOCAL and ACESHIP both serve it from the same
// charavatars/avatars folders real operator icons already come from.
function uri_skin_avatar(avatarId, source = ASSET_SOURCE.LOCAL) {
  const enc = encodeURIComponent(avatarId);
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/arts/charavatars/${enc}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}avatars/${enc}.png`;
  }
}

// The full splash illustration for a skin on the Aceship mirror -- only
// the last fallback in showSkinPreview() (operator-page.js) now: Aceship
// hasn't been updated since May 2024, has only the full-size file, and
// is slow through jsDelivr (~3s for a 1MB file, measured). Loaded one at
// a time on user action, never in bulk.
//
// Callers must pass the skin's "portraitId" here, NOT "avatarId" and NOT
// skin_table.json's "illustId" field:
//  - avatarId is the small avatar-crop id (see uri_skin_avatar() above)
//    and for the base/"Default outfit" (ILLUST_0) entry specifically it
//    does NOT match this mirror's illustration filename -- e.g. Amiya's
//    avatarId is the bare "char_002_amiya" (no such file here), while her
//    portraitId is "char_002_amiya_1" (a real file). For every other
//    skin (Elite 1/Elite 2 default art, and real purchasable skins)
//    portraitId and avatarId happen to be identical, which is how this
//    was initially missed.
//  - illustId (e.g. "illust_char_002_amiya_winter#1") never matches this
//    mirror's actual filenames (e.g. "char_002_amiya_winter#1.png") --
//    confirmed directly, not assumed; trusting that field name over a
//    live fetch would have repeated the same mistake this project has
//    already made twice before with large upstream game-data JSON files.
function uri_skin_illust(portraitId, source = ASSET_SOURCE.ACESHIP) {
  const enc = encodeURIComponent(portraitId);
  switch (source) {
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}characters/${enc}.png`;
  }
}

// Full-illustration URLs for myrtle.moe's files (through the mirror, see
// myrtleAssetUrl()), the primary source for the skin preview. Layout
// (nested by charId, unlike Aceship's flat folder, so it needs charId and
// isBuySkin as well as portraitId):
//  - default/Elite 1/Elite 2 art: "textures/chararts/<charId>/<portraitId>.png"
//  - purchasable skins:           "textures/skinpack/<charId>/<portraitId>.png"
// Each also has a "<portraitId>b.png" next to it: a 1024x1024 copy
// (measured: ~0.3-1MB vs 1-6MB for the 2048-2560px original), enough for
// the preview's ~860px on a 1080p screen. Every sampled skin has the original;
// the "b" copy is missing for some default/Elite art (12 of 38 sampled),
// so callers try size "display" first and fall back to "full".
function uri_skin_illust_myrtle(charId, portraitId, isBuySkin, size = "display") {
  const dir = isBuySkin ? "skinpack" : "chararts";
  const suffix = size === "full" ? "" : "b";
  return myrtleAssetUrl(`textures/${dir}/${charId}/${portraitId}${suffix}.png`);
}

// A myrtle.moe asset path ("textures/...", "spine/...", unencoded) as a URL:
// through this site's R2 mirror (MYRTLE_MIRROR_BASE in config.js) when
// that's set, so myrtle.moe only ever sees one request per file, else
// straight from myrtle.moe.
function myrtleAssetUrl(path) {
  const base = (typeof MYRTLE_MIRROR_BASE !== "undefined" && MYRTLE_MIRROR_BASE) || ASSET_SOURCE.MYRTLE;
  return base + path.split("/").map(encodeURIComponent).join("/");
}

// The same image through Cloudflare Image Transformations
// (IMAGE_TRANSFORM_BASE in config.js): scaled down to at most `width`
// pixels wide, in the best format the browser accepts (AVIF/WebP), cached
// at Cloudflare. null when transformations aren't configured.
function uri_transformed(url, width) {
  if (typeof IMAGE_TRANSFORM_BASE === "undefined" || !IMAGE_TRANSFORM_BASE) return null;
  return `${IMAGE_TRANSFORM_BASE}width=${width},fit=scale-down,format=auto/${url}`;
}

function setSkinAvatarIcon(imgEl, avatarId) {
  setIconWithFallback(imgEl, uri_skin_avatar(avatarId), uri_skin_avatar(avatarId, ASSET_SOURCE.ACESHIP), false);
}

// setAvatarIcon()/buildCnBadge() (and their shared helpers below) are used
// by both the planner page (roster cards, search results, the operator
// edit modal) and the calendar page (the same edit modal, opened in place
// from an event's operator chips -- see js/operator-edit-modal.js) -- kept
// here, already loaded by both, rather than duplicated in each.
//
// The community asset mirror uri_avatar() defaults to (LOCAL, an
// akgcc/arkdata jsdelivr mirror) doesn't have full coverage -- some
// operators' icons 404 there. Rather than leave a broken-image glyph
// showing, fall back to the Aceship mirror (a separately-maintained, more
// complete asset repo, already wired up as ASSET_SOURCE.ACESHIP above)
// and, if that also fails, hide the <img> so the icon's circular
// background shows as an empty placeholder instead of a broken-image icon.
//
// Both of those sources are mirrors of RELEASED client data -- an
// operator that isn't out on EN yet has no art in either one, by
// construction, regardless of charId correctness. There's no reliable
// third-party mirror of actual CN client art currently reachable (a
// dedicated CN asset-dump repo exists but its real path layout isn't
// discoverable, and wiki sites that do show this art block scripted
// access). So for a cnOnly entity specifically, once both real sources
// fail, show a small generated "CN" placeholder instead of the plain
// blank circle -- same "nothing to show yet" outcome, but it reads as
// expected/labeled rather than looking like a broken image.
const CN_ICON_PLACEHOLDER =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<rect width="64" height="64" fill="#2a2a2a"/>' +
      '<text x="32" y="40" font-family="sans-serif" font-size="20" ' +
      'font-weight="bold" fill="#ff9f43" text-anchor="middle">CN</text>' +
      "</svg>",
  );
function setIconWithFallback(imgEl, primarySrc, fallbackSrc, isCnOnly) {
  const giveUp = () => {
    if (isCnOnly) {
      imgEl.onerror = null;
      imgEl.src = CN_ICON_PLACEHOLDER;
    } else {
      imgEl.onerror = null;
      imgEl.classList.add("iconMissing");
    }
  };
  imgEl.src = primarySrc;
  imgEl.onerror = () => {
    if (fallbackSrc && fallbackSrc !== primarySrc) {
      imgEl.onerror = giveUp;
      imgEl.src = fallbackSrc;
    } else {
      giveUp();
    }
  };
}
function setAvatarIcon(imgEl, charId, isCnOnly) {
  setIconWithFallback(imgEl, uri_avatar(charId), uri_avatar(charId, ASSET_SOURCE.ACESHIP), isCnOnly);
}

// A small "CN" tag for any operator/material flagged cnOnly during an
// EN+CN data merge (see loadData() in planner.js, loadCharTable() in
// operator-edit-modal.js) -- not yet released on the EN server, so shown
// with EN data throughout but marked wherever it appears so it's never
// mistaken for an EN-available entry.
function buildCnBadge(entity) {
  const badge = document.createElement("span");
  badge.className = "cnBadge";
  badge.textContent = "CN";
  badge.title =
    entity && entity.cnName
      ? `Not yet released on the EN server -- shown under its CN codename (original CN name: ${entity.cnName})`
      : "Not yet released on the EN server -- shown using CN data";
  return badge;
}

function uri_item(imageName, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/arts/items/icons/${imageName}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}items/${imageName}.png`;
  }
}
function uri_skill(skillId, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/arts/skills/skill_icon_${skillId}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}skills/skill_icon_${skillId}.png`;
  }
}
// Medal (achievement) icons -- used by the account overview page's medal
// detail popup. Neither of this project's usual two mirrors (LOCAL/
// akgcc-arkdata, ACESHIP/Arknight-Images) carries these; the only mirror
// found to actually serve them, tested against several real medalIds, is
// fexli/ArknightsResource's own medal/ folder (auto-synced from the
// official client), keyed directly by the full medalId string. No second
// mirror is known to fall back to here, unlike uri_avatar() and friends --
// callers should hide the <img> on error rather than chain a fallback src.
function uri_medal(medalId) {
  // Lowercase ONLY the id, not the whole URL -- unlike the LOCAL/ACESHIP
  // mirrors above (whose repo-path portions are already all-lowercase,
  // so chaining .toLowerCase() across the whole string was always a
  // no-op there), this repo/owner path ("fexli/ArknightsResource") is
  // mixed-case and genuinely case-sensitive on GitHub/jsdelivr -- naively
  // reusing that same whole-string .toLowerCase() pattern here would 404
  // every request.
  return `https://cdn.jsdelivr.net/gh/fexli/ArknightsResource@master/medal/${medalId.toLowerCase()}.png`;
}

const DATA_BASE = {
  [SERVERS.EN]: `${GAME_DATA_MIRROR}/en`,
  [SERVERS.JP]: `${GAME_DATA_MIRROR}/jp`,
  [SERVERS.KR]: `${GAME_DATA_MIRROR}/kr`,
  [SERVERS.CN]: `${GAME_DATA_MIRROR}/cn`,
};
// --- small helpers shared by the calendar and operator pages ----------

// "Oct 8, 2026" (in the browser's locale) for a Date or anything Date can
// parse; null for a missing or unparseable value.
function fmtDate(d) {
  if (d == null) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// A whole-day number for comparing dates by day. events.json's
// globalStart ("...T17:00:00") and operator_release_dates.json's
// onlineTime ("... 17:00:00") use the same plain, no-UTC-offset timestamp
// convention, so only the Y-M-D part is read (via Date.UTC, so it doesn't
// drift with the browser's timezone) instead of parsing a full timestamp.
function dayKeyFromTimestamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

// A /wiki/<page> URL on arknights.wiki.gg for a MediaWiki page name.
// Segments are encoded individually (not the whole string) so a literal
// "/" in a subpage name like "Event/Rerun" stays a subpage path instead of
// being percent-encoded into one long, broken slug.
function wikiUrl(pageName) {
  if (!pageName) return null;
  return (
    "https://arknights.wiki.gg/wiki/" +
    pageName
      .split("/")
      .map((seg) => encodeURIComponent(seg.replace(/ /g, "_")))
      .join("/")
  );
}

// Slim copies of the game-data tables, built daily by
// akgcc-extra-data/game_data.py and published next to the rest of this
// site's data. Same top-level shape and field names as the upstream
// tables, minus the rows and fields no page reads -- so callers treat the
// response exactly like the upstream file. The CN copies only carry what
// EN doesn't have (every page merges EN and CN with EN winning), plus the
// few fields the shop page reads from CN for every operator. If a slim
// file is missing or the request fails, this falls back to the full
// upstream table, which is a superset, so the page still works.
// NOTE: a page that starts reading a new field from one of these tables
// needs that field added in game_data.py too.
const GAME_DATA_SLIM_BASE = `${EXTRA_DATA_REPO_RAW_BASE}gamedata/`;
const GAME_DATA_SLIM_SERVERS = { [SERVERS.EN]: "en", [SERVERS.CN]: "cn" };
const GAME_DATA_SLIM_TABLES = new Set([
  "character_table",
  "char_patch_table",
  "uniequip_table",
  "battle_equip_table",
  "skill_table",
  "skin_table",
  "item_table",
  "gamedata_const",
  "medal_table",
]);
async function gameDataFetch(server, table) {
  const upstream = `${DATA_BASE[server]}/gamedata/excel/${table}.json`;
  const dir = GAME_DATA_SLIM_SERVERS[server];
  if (!dir || !GAME_DATA_SLIM_TABLES.has(table)) return fetch(upstream);
  try {
    const res = await fetch(`${GAME_DATA_SLIM_BASE}${dir}/${table}.json`);
    if (res.ok) return res;
  } catch (err) {
    // fall through to the upstream table
  }
  return fetch(upstream);
}

// operator_release_dates.json, fetched once per page load: get_char_table()
// asks for it for every server it loads (EN and CN on most pages), and it
// only ever changes with the daily data update.
let operatorReleaseDatesPromise = null;
function loadOperatorReleaseDates() {
  if (!operatorReleaseDatesPromise) {
    operatorReleaseDatesPromise = fetch(extraDataUrl("operator_release_dates.json"))
      .then((res) => {
        if (!res.ok) throw new Error(`operator_release_dates.json: HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        operatorReleaseDatesPromise = null; // let a later caller retry
        throw err;
      });
  }
  return operatorReleaseDatesPromise;
}

const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
if (scrollbarWidth > 0) {
  document.documentElement.style.setProperty(
    "--scrollbarWidth",
    scrollbarWidth + "px",
  );
} else document.documentElement.style.setProperty("--scrollbarWidth", "0px");

const CLASS_MAPPING = {
  WARRIOR: "Guard",
  SUPPORT: "Supporter",
  CASTER: "Caster",
  SNIPER: "Sniper",
  TANK: "Defender",
  PIONEER: "Vanguard",
  SPECIAL: "Specialist",
  MEDIC: "Medic",
};
const RARITY_MAP = {
  TIER_1: 0,
  TIER_2: 1,
  TIER_3: 2,
  TIER_4: 3,
  TIER_5: 4,
  TIER_6: 5,
};
const SHORT_NAMES = {};
const GAMEPRESS_NAME_MAP = {
  "Rosa (Poca)": "Rosa",
  Pozëmka: "Позёмка",
  "Reed the Flame Shadow": "Reed The Flame Shadow",
  "Fang the Fire-Sharpened": "Fang the Fire-sharpened",
  "Eyjafjalla the Hvit Aska": "Eyjafjalla the Hvít Aska",
};
const charIdMap = {};
// maps some en names to their appellations
const CN_ID_MAP = {
  Zima: "Зима",
  "Mr. Nothing": "Mr.Nothing",
  Rosa: "Роса",
  Istina: "Истина",
};

function updateJSON(dest, src, existingOnly = false) {
  for (let key in src) {
    if (typeof dest[key] == "object" && typeof src[key] == "object")
      dest[key] = updateJSON(dest[key], src[key], existingOnly);
    else if (!existingOnly || key in dest) dest[key] = src[key];
  }
  return dest;
}

//add tooltip element for use in below functions
let tt = document.createElement("div");
tt.id = "chartjs-tooltip";
tt.classList.add("hidden");
document.addEventListener("DOMContentLoaded", () =>
  document.body.appendChild(tt),
);
async function get_char_table(
  keep_non_playable = false,
  server = "en_US",
  extra_data = false,
) {
  // gets a modified character table:
  // non-playable characters removed
  // add charId key for each character
  // patch characters added and renamed (only guardmiya for now)
  // also builds charIdMap for use elsewhere
  // converts internal profession names to in-game ones
  // if "extra_data" is true, adds "isLimited", "onlineTime", "cnOnlineTime" at the cost of 1 extra github fetch
  let raw = await gameDataFetch(server, "character_table");
  let json = await fixedJson(raw);
  raw = await gameDataFetch(server, "char_patch_table");
  let patch = await fixedJson(raw);
  updateJSON(json, patch.patchChars);
  if (extra_data) {
    let extra_chardata = await loadOperatorReleaseDates();
    for (const [charId, data] of Object.entries(extra_chardata)) {
      if (json[charId]) {
        json[charId].isLimited = data.isLimited ?? false;
        // See operator_online.py's scrape_PRTS() for what this means and
        // how it's derived -- "not currently offered through any known
        // gacha pool" (most often: obtained only through a past event's
        // activity rewards/shop), as opposed to just "not limited/collab".
        // Left unset (not even `false`) when the upstream data doesn't
        // know either way, same "absence means uncertain, not disproven"
        // reasoning as the onlineTime/cnOnlineTime fields right below.
        if (data.notInGachaPool) json[charId].notInGachaPool = true;
        if (data.onlineTime != null) json[charId].onlineTime = data.onlineTime;
        if (data.cnOnlineTime != null)
          json[charId].cnOnlineTime = data.cnOnlineTime;
      }
    }
  }

  Object.keys(json).forEach((op) => {
    json[op].profession =
      CLASS_MAPPING[json[op].profession] || json[op].profession;
    // rename amiya forms to prevent conflict
    if (op.includes("_amiya"))
      json[op].name = `${json[op].name} (${json[op].profession})`;
  });
  for (var key in json) {
    if (!keep_non_playable && !json[key].displayNumber) delete json[key];
    else {
      charIdMap[json[key].name] = key;
      if (json[key].appellation) charIdMap[json[key].appellation] = key;
      json[key].charId = key;
      // remap "rarity" field (AK 2.0)
      json[key].rarity = RARITY_MAP[json[key].rarity] ?? json[key].rarity;
    }
  }
  for (const [k, v] of Object.entries(CN_ID_MAP)) {
    if (!(k in charIdMap)) charIdMap[k] = charIdMap[v];
  }
  // add skadiva short name
  for (const [k, v] of Object.entries(SHORT_NAMES)) {
    charIdMap[v] = charIdMap[k];
  }
  return json;
}

async function fixedJson(res) {
  // if .json() fails, try to remove trailing comma then parse with JSON.parse
  return res
    .clone()
    .json()
    .catch((e) =>
      res.text().then((txt) => JSON.parse(txt.replace(/,(\W+}\W*$)/, "$1"))),
    );
}

// The per-rarity/phase/level EXP+LMD curve and the per-rarity/phase Elite
// promotion LMD cost -- used alongside calcOperatorCost() below. Used by
// both the planner page (its own roster) and the operator page (a single
// operator's "cost to fully max" table), so it lives here rather than
// being fetched twice with two copies of this same normalization.
async function loadGameConst(server) {
  const res = await gameDataFetch(server, "gamedata_const");
  const json = await fixedJson(res);
  return {
    characterExpMap: json.characterExpMap || [],
    characterUpgradeCostMap: json.characterUpgradeCostMap || [],
    evolveGoldCost: json.evolveGoldCost || [],
  };
}

// Material/LMD/EXP names, icons and rarity -- itemId -> { name, iconId,
// rarity, ... }. Same reasoning as loadGameConst() above.
async function loadItemTable(server) {
  const res = await gameDataFetch(server, "item_table");
  const json = await fixedJson(res);
  return json.items || json;
}

// Routes a cost list (as found on an evolveCost/lvlUpCost/itemCost entry)
// into a running total -- a GOLD-type entry (id "4001") is LMD and goes
// into cost.lmd directly rather than the material list, since a module's
// itemCost mixes its LMD cost in as a normal list entry instead of using
// a separate LMD-only field the way Elite promotion costs do.
function addCosts(cost, list) {
  if (!list) return;
  for (const { id, count, type } of list) {
    if (type === "GOLD") {
      cost.lmd += count;
    } else {
      cost.materials[id] = (cost.materials[id] || 0) + count;
    }
  }
}

// The LMD/EXP/materials needed to take one operator from `current` to
// `target` (both { phase, level, skillLevel, mastery: {skillIdx: rank},
// modules: {uniEquipId: stage} }, see the shared edit modal's
// defaultState()/defaultTargetState()/maxState()). gameConst is a
// loadGameConst() result. Shared by the planner page (summed across its
// whole roster) and the operator page (a single E0/Lv1 -> everything-maxed
// total).
function calcOperatorCost(op, current, target, gameConst) {
  const cost = { lmd: 0, exp: 0, materials: {} };
  const rarity = op.rarity; // already remapped to a 0-5 int by get_char_table()

  // Elite promotions crossed. phases[p].evolveCost is the cost to
  // promote INTO phase p (so phase 0 is always null); evolveGoldCost is
  // the matching LMD-only cost, indexed [rarity][p - 1].
  for (let p = current.phase + 1; p <= target.phase; p++) {
    const goldRow = gameConst.evolveGoldCost[rarity];
    const gold = goldRow ? goldRow[p - 1] : undefined;
    if (typeof gold === "number" && gold > 0) cost.lmd += gold;
    const phaseData = op.phases[p];
    if (phaseData) addCosts(cost, phaseData.evolveCost);
  }

  // Operator level, across every phase the change passes through. The
  // per-level EXP/LMD curve is shared across all operators of any
  // rarity -- only how far into it a given operator can go (each
  // phase's own maxLevel) differs.
  for (let p = current.phase; p <= target.phase; p++) {
    const phaseData = op.phases[p];
    if (!phaseData) continue;
    const startLevel = p === current.phase ? current.level : 1;
    const endLevel = p === target.phase ? target.level : phaseData.maxLevel;
    const expRow = gameConst.characterExpMap[p] || [];
    const lmdRow = gameConst.characterUpgradeCostMap[p] || [];
    for (let lvl = startLevel; lvl < endLevel; lvl++) {
      const e = expRow[lvl - 1];
      const l = lmdRow[lvl - 1];
      if (typeof e === "number" && e > 0) cost.exp += e;
      if (typeof l === "number" && l > 0) cost.lmd += l;
    }
  }

  // Skill level (1-7), shared across every skill the operator has at
  // once. allSkillLvlup[i] is the cost to go from skill level i+1 to
  // i+2, so index 0..5 covers levels 1->7. Operators with no skills at
  // all (a handful of very low rarities) have nothing here.
  if (op.allSkillLvlup && op.allSkillLvlup.length) {
    for (let lvl = current.skillLevel; lvl < target.skillLevel; lvl++) {
      const entry = op.allSkillLvlup[lvl - 1];
      if (entry) addCosts(cost, entry.lvlUpCost);
    }
  }

  // Skill mastery (M1-M3), per individual skill. Each skill's own
  // levelUpCostCond[m] is the cost to go from mastery m to m+1 (index
  // 0 = M1, 1 = M2, 2 = M3).
  if (op.skills) {
    op.skills.forEach((skill, skillIdx) => {
      if (!skill.levelUpCostCond) return;
      const curM = (current.mastery && current.mastery[skillIdx]) || 0;
      const tgtM = (target.mastery && target.mastery[skillIdx]) || 0;
      for (let m = curM; m < tgtM; m++) {
        addCosts(cost, skill.levelUpCostCond[m] && skill.levelUpCostCond[m].levelUpCost);
      }
    });
  }

  // Module stages, per module. itemCost is keyed by the STAGE REACHED
  // as a string ("1", "2", "3"), so going from stage s to s+1 uses
  // itemCost[String(s + 1)].
  if (op.modules) {
    op.modules.forEach((mod) => {
      const curS = (current.modules && current.modules[mod.uniEquipId]) || 0;
      const tgtS = (target.modules && target.modules[mod.uniEquipId]) || 0;
      for (let s = curS + 1; s <= tgtS; s++) {
        addCosts(cost, mod.itemCost && mod.itemCost[String(s)]);
      }
    });
  }

  return cost;
}

// --- shop/banner history (banner_history.json) -----------------------------
// Shared by the store page (shoplist.js, across every operator at once) and
// the operator page (one operator at a time), so the raw-data normalization
// and the shop-debut prediction math can't drift between the two.

// Normalizes one server's raw banner_history.json entries (keyed by
// operator NAME, as scraped off the in-game shop) in place: resolves each
// entry's charId via charIdMap, flags isKernel from that server's own char
// table, parses/sorts its banner and shop dates, and preloads its avatar
// image. Entries whose name doesn't resolve to a known charId are dropped
// (a stale/removed name, or the odd "APRIL FOOLS" joke entry).
//
// Returns a derived charId -> entry index of what's left -- charId is the
// key every other part of the site already uses, whereas the scraper's
// raw output is keyed by name only because that's what's shown in-game.
function normalizeShopHistory(servdata, charTableForServer) {
  const byCharId = {};
  for (const [op, data] of Object.entries(servdata)) {
    const name = htmlDecode(op);
    data.op = SHORT_NAMES[name] || name;
    data.op = GAMEPRESS_NAME_MAP[data.op] || data.op;
    data.charId = charIdMap[data.op];
    if (data.charId == undefined) {
      if (!data.op.includes("APRIL FOOLS")) console.log("Operator not found:", data.op);
      delete servdata[op];
      continue;
    }
    data.banner.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    data.isKernel = charTableForServer[data.charId]?.classicPotentialItemId != null;
    const img = new Image();
    img.src = uri_avatar(data.charId);
    data.img = img;
    // Use the true minimum banner date rather than trusting banner[0]
    // after the sort above: a single malformed/unparseable date string
    // anywhere in the array makes Array.sort's comparisons with NaN
    // unreliable, which can silently leave a later (e.g. rerun) date in
    // slot 0.
    data.first = Math.min(...data.banner.map((b) => Date.parse(b.date)));
    data.shop = data.shop
      .map((entry) => ({ ...entry, date: Date.parse(entry.date) }))
      .sort((a, b) => a.date - b.date);
    byCharId[data.charId] = data;
  }
  return byCharId;
}

// Predicts a Standard-pool operator's shop debut from a fixed weekly
// cadence per (remapped) rarity. 4* operators never get added to the
// shop at all, so they're deliberately left out of this map.
const SHOP_DEBUT_CADENCE_WEEKS = { 5: 6, 4: 5 };

// Standard-pool (non-Kernel, non-Limited) operators of a given remapped
// rarity, on one server. The anchor date is when the shop cadence last
// actually ticked forward -- i.e. the most recent FIRST shop appearance
// among ops that have already been shopped -- not any operator's
// original character-release date. (A never-shopped operator can easily
// have been released more recently than the last operator actually added
// to the shop, and using their release date as the anchor pulls the
// whole prediction off by however early/late that operator happens to
// be.) Also returns the "queue" of ops that have never appeared in the
// shop yet, oldest-released first -- those are presumably next in line,
// one cadence-length apart: the longest-waiting one is expected
// `cadence` weeks after the anchor, the next one 2x`cadence`, and so on.
// De-duped by charId in case the source data lists the same operator
// under more than one name/alias.
//
// shopDataForServer/charTableForServer: one server's normalizeShopHistory()
// input (or output -- only Object.values() is used, so either the
// name-keyed or charId-keyed form works) and that server's own char table.
function getStandardPoolPipeline(rarity, shopDataForServer, charTableForServer) {
  let anchorDate = -Infinity;
  let anchorOp = null;
  const seen = new Set();
  const waiting = [];
  for (const data of Object.values(shopDataForServer)) {
    if (data.isKernel) continue;
    if (charTableForServer[data.charId]?.isLimited) continue;
    if (charTableForServer[data.charId]?.rarity !== rarity) continue;
    if (seen.has(data.charId)) continue;
    seen.add(data.charId);
    if (data.shop.length) {
      // data.shop[].date is already a numeric timestamp by this point
      // (normalizeShopHistory() above), so this is a plain min over
      // numbers -- NOT another Date.parse.
      const firstShopDate = Math.min(...data.shop.map((s) => s.date));
      if (firstShopDate > anchorDate) {
        anchorDate = firstShopDate;
        anchorOp = data.op;
      }
    } else {
      waiting.push(data);
    }
  }
  waiting.sort((a, b) => a.first - b.first);
  return { latestRelease: anchorDate, latestOp: anchorOp, waiting };
}

// The full predicted-debut computation for one operator, built on top of
// getStandardPoolPipeline() above. opInfo needs charId, rarity (remapped),
// isKernel, isLimited and hasShopHistory. Returns null when there's
// nothing to predict (already in the shop, a 4*/Kernel/Limited op, or no
// same-rarity anchor to predict from yet), otherwise { predictedDate,
// position, anchorOp, anchorDate }.
function predictShopDebut(opInfo, shopDataForServer, charTableForServer) {
  if (
    opInfo.hasShopHistory ||
    opInfo.isKernel ||
    opInfo.isLimited ||
    SHOP_DEBUT_CADENCE_WEEKS[opInfo.rarity] == null
  ) {
    return null;
  }
  const cadenceMs = SHOP_DEBUT_CADENCE_WEEKS[opInfo.rarity] * 7 * 24 * 60 * 60 * 1000;
  const { latestRelease, latestOp, waiting } = getStandardPoolPipeline(
    opInfo.rarity,
    shopDataForServer,
    charTableForServer,
  );
  if (latestOp == null || !isFinite(latestRelease)) return null;
  let position = waiting.findIndex((d) => d.charId === opInfo.charId) + 1;
  if (position <= 0) position = 1; // shouldn't happen, but stay safe
  return { predictedDate: latestRelease + position * cadenceMs, position, anchorOp: latestOp, anchorDate: latestRelease };
}

// Modify chartjs pointElement to draw a circular image instead.
if (typeof Chart !== "undefined") {
  const drawPoint_round = (ctx, options, x, y) => {
    let type, xOffset, yOffset, size, cornerRadius;
    const style = options.pointStyle;
    const rotation = options.rotation;
    const radius = options.radius;
    let rad = (rotation || 0) * Chart.helpers.RAD_PER_DEG;

    if (style && typeof style === "object") {
      type = style.toString();
      if (
        type === "[object HTMLImageElement]" ||
        type === "[object HTMLCanvasElement]"
      ) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rad);

        // below block is modified code.
        let sliceSize = Math.max(
          (1 / 4) * 2,
          (1 / options.pointStyle.conflictCount) * 2,
        );
        sliceSize = (1 / options.pointStyle.conflictCount) * 2;
        let sliceStart = sliceSize * options.pointStyle.conflict;
        ctx.beginPath();
        ctx.arc(
          0,
          0,
          Math.min(style.height / 2, style.width / 2),
          Math.PI / 2 + Math.PI * sliceStart,
          Math.PI / 2 + Math.PI * sliceStart + Math.PI * sliceSize,
          false,
        );
        if (options.pointStyle.conflictCount > 1) ctx.lineTo(0, 0);
        ctx.closePath();
        ctx.stroke();
        ctx.clip();
        // ctx.globalAlpha = 0.8;
        ctx.drawImage(
          style,
          -style.width / 2,
          -style.height / 2,
          style.width,
          style.height,
        );
        ///////////////////////////////

        ctx.restore();
        return;
      }
    }

    return Chart.helpers.drawPoint(ctx, options, x, y);
  };
  const pe_draw_orig = Chart.PointElement.prototype.draw;
  Chart.PointElement.prototype.draw = function (ctx, area) {
    const options = this.options;

    if (
      this.skip ||
      options.radius < 0.1 ||
      !Chart.helpers._isPointInArea(this, area, this.size(options) / 2)
    ) {
      return;
    }

    ctx.strokeStyle = options.borderColor;
    ctx.lineWidth = options.borderWidth;
    ctx.fillStyle = options.backgroundColor;

    drawPoint_round(ctx, options, this.x, this.y); // only this line was modified
  };

  Chart.defaults.scales.logarithmic.ticks.callback = function (
    tick,
    index,
    ticks,
  ) {
    return tick.toLocaleString();
  };

  Chart.register({
    id: "imgsplit",
    beforeDatasetDraw: function (chart, args, options) {
      if (chart.config.options.split_images) {
        let conflicts = {};
        for (let i = 0; i < chart.data.datasets[0].data.length; i++) {
          let pt = chart.data.datasets[0].data[i];
          conflicts[pt.x] || (conflicts[pt.x] = {});
          chart.data.datasets[0].pointStyle[i].conflict = 0;
          if (pt.y in conflicts[pt.x]) {
            conflicts[pt.x][pt.y] += 1;
            chart.data.datasets[0].pointStyle[i].conflict =
              conflicts[pt.x][pt.y];
          } else {
            conflicts[pt.x][pt.y] = 0;
          }
        }
        for (let i = 0; i < chart.data.datasets[0].data.length; i++) {
          let pt = chart.data.datasets[0].data[i];
          chart.data.datasets[0].pointStyle[i].conflictCount =
            conflicts[pt.x][pt.y] + 1;
        }
      }
    },
  });
}

function beforeDatasetDraw(chart, args) {
  if (chart.animating || chart.$deferred.loaded) {
    const { index: dataIndex, meta } = args;
    const points = meta.data.map((el) => ({ x: el._model.x, y: el._model.y }));
    const { length: dsLength } = chart.data.datasets;
    const adjustedMap = []; // keeps track of adjustments to prevent double offsets

    for (let datasetIndex = 0; datasetIndex < dsLength; datasetIndex += 1) {
      if (dataIndex !== datasetIndex) {
        const datasetMeta = chart.getDatasetMeta(datasetIndex);
        datasetMeta.data.forEach((el) => {
          const overlap = points.find(
            (point) => point.x === el._model.x && point.y === el._model.y,
          );
          if (overlap) {
            const adjusted = adjustedMap.find(
              (item) =>
                item.datasetIndex === datasetIndex &&
                item.dataIndex === dataIndex,
            );
            if (!adjusted && datasetIndex % 2) {
              el._model.x += 7;
            } else {
              el._model.x -= 7;
            }
            adjustedMap.push({ datasetIndex, dataIndex });
          }
        });
      }
    }
  }
}

function getTextWidth(text, font) {
  // re-use canvas object for better performance
  const canvas =
    getTextWidth.canvas ||
    (getTextWidth.canvas = document.createElement("canvas"));
  const context = canvas.getContext("2d");
  context.font = font;
  const metrics = context.measureText(text);
  return metrics.width;
}

function htmlDecode(input) {
  var doc = new DOMParser().parseFromString(input, "text/html");
  return doc.documentElement.textContent;
}
function selectColor(number, saturation = 15, lightness = 60) {
  const hue = number * 137.508; // use golden angle approximation
  return `hsl(${hue},${saturation}%,${lightness}%)`;
}
window.onload = () => {
  const title = document.getElementById("pageTitle");
  if (title) title.href = location.origin + location.pathname;

  const serverSelect = document.getElementById("serverSelect");
  if (serverSelect) {
    const dd_content = serverSelect.querySelector(".dropdown-content");
    const dd_btn = serverSelect.querySelector(".dropbtn");
    Object.keys(SERVERS).forEach((k) => {
      let opt = document.createElement("div");
      opt.dataset.value = SERVERS[k];
      opt.innerHTML = k;
      opt.onclick = () => {
        localStorage.setItem("server", SERVERS[k]);
        sessionStorage.setItem("userChange", true);
        location.reload();
      };
      dd_content.appendChild(opt);
      if ((localStorage.getItem("server") || "en_US") == SERVERS[k])
        dd_btn.firstChild.nodeValue = k;
    });
    // click handlers for mobile
    dd_btn.onclick = () => {
      dd_content.classList.toggle("show");
      dd_btn.classList.toggle("checked");
    };
    window.addEventListener("click", (e) => {
      if (e.target != dd_btn) {
        dd_content.classList.remove("show");
        dd_btn.classList.remove("checked");
      }
    });
  }
};
