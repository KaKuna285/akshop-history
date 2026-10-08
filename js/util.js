// EXTRA_DATA_REPO_RAW_BASE now lives in js/config.js (loaded before this
// file) -- shared across util.js, shoplist.js, and calendar.js.
const DATA_SOURCE =
  "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/";
const DATA_SOURCE_YOSTAR =
  "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData_YoStar/main/";
const USE_ALTERNATE_DATA_SOURCE = true; // use ArknightsAssets instead of ArknightsGameData
// const DATA_SOURCE =
//   "https://raw.githubusercontent.com/Aceship/AN-EN-Tags/master/json/gamedata/";
// const CC_DATA_SOURCE =
//   "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/";
// const DATA_SOURCE_LOCAL =
//   "https://raw.githubusercontent.com/akgcc/arkdata/main/";
const DATA_SOURCE_LOCAL = "https://cdn.jsdelivr.net/gh/akgcc/arkdata@main/";
const ASSET_SOURCE = {
  RAW: "https://raw.githubusercontent.com/akgcc/arkdata/main/assets/",
  LOCAL: `${DATA_SOURCE_LOCAL}assets/`,
  // ACESHIP: "https://raw.githubusercontent.com/Aceship/Arknight-Images/main/",
  ACESHIP: "https://cdn.jsdelivr.net/gh/Aceship/Arknight-Images@main/",
  ARKWAIFU: "https://arkwaifu.cc/api/v1/arts/REPLACEME/variants/origin/content",
  // Third fallback tier for full skin illustrations only (see
  // uri_skin_illust_myrtle() below) -- myrtle.moe runs its own asset
  // pipeline that extracts directly from the official game CDN rather
  // than waiting on community contributors, so its coverage of very
  // recent/collab-exclusive skins is noticeably better than Aceship's.
  // Confirmed via direct fetch: open CORS (access-control-allow-origin:
  // *), fronted by Cloudflare, cache-control: public.
  MYRTLE: "https://api.myrtle.moe/api/assets/textures/",
};

// do not modify SERVERS even if you change data source as this is used locally as well.
const SERVERS = {
  EN: "en_US",
  JP: "ja_JP",
  KR: "ko_KR",
  CN: "zh_CN",
};
// data URI gen:
function uri_sound(soundpath, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/audio/${soundpath}.mp3`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `https://raw.githubusercontent.com/Aceship/Arknight-voices/main/${soundpath.replace(
        /^sound_beta_2\//,
        "",
      )}.wav`.toLowerCase();
  }
}
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

// The full splash illustration for a skin -- multiple MB each (confirmed:
// real samples ranged ~0.2-5.7MB), only ever meant to be lazy-loaded one
// at a time on an explicit user action (see showSkinPreview() in
// operator-page.js), never preloaded in bulk or embedded as a grid
// thumbnail. Only confirmed reliable on the Aceship mirror (LOCAL/akgcc
// doesn't have a matching flat "characters/<id>.png" convention -- its
// own "characters/" folder is nested by charId instead and only covers
// default-outfit art, not purchased skins).
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

// Fallback full-illustration source for when Aceship doesn't have a skin
// yet (confirmed via the skin art coverage debug page: ~328 skins,
// mostly recent/collab-exclusive content) -- myrtle.moe's own asset
// pipeline, laid out differently from Aceship's flat "characters/<id>"
// convention:
//  - non-purchased entries (the "Default outfit"/Elite 1/Elite 2 art
//    every operator has) live under "chararts/<charId>/<portraitId>.png"
//  - real purchasable skins live under
//    "skinpack/<charId>/<portraitId>b.png" -- note the trailing "b" on
//    the filename itself, confirmed against several real skins (not
//    assumed from one sample): it's the smaller of two variants Myrtle
//    exposes per skin (~1-1.3MB) and the one its own frontend actually
//    displays: the non-"b" file at the same path is a much larger (~5MB+)
//    source texture, not meant for direct display.
// Both forms are nested by charId, unlike Aceship's flat layout, so this
// needs isBuySkin and charId as well as portraitId.
function uri_skin_illust_myrtle(charId, portraitId, isBuySkin) {
  const encChar = encodeURIComponent(charId);
  const encPortrait = encodeURIComponent(portraitId);
  return isBuySkin
    ? `${ASSET_SOURCE.MYRTLE}skinpack/${encChar}/${encPortrait}b.png`
    : `${ASSET_SOURCE.MYRTLE}chararts/${encChar}/${encPortrait}.png`;
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

function uri_background(imageName, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/avg/backgrounds/${imageName}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}avg/backgrounds/${imageName}.png`;
    case ASSET_SOURCE.ARKWAIFU:
      return ASSET_SOURCE.ARKWAIFU.replace(/REPLACEME/, imageName);
  }
}
function uri_video(vidPath, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    default:
      return `${ASSET_SOURCE.RAW}raw/${vidPath}`.toLowerCase();
  }
}
function uri_thumb(imageName, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    default:
      return `${DATA_SOURCE_LOCAL}thumbs/${imageName}.webp`.toLowerCase();
  }
}
function uri_roguelike_item(imageName, source = ASSET_SOURCE.LOCAL) {
  if (/_copper_/.test(imageName)) {
    imageName = imageName
      .replace("_change", "")
      .replace("_buff", "")
      .replace(/_[a-zA-Z]$/, "");
  }
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/arts/ui/rogueliketopic/itempic/${imageName}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}ui/roguelike/item/${imageName}.png`;
  }
}
function uri_rogue_1_capsule(imageName, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/ui/rogueliketopic/topics/rogue_1/capsule/${imageName}.png`.toLowerCase();
  }
}
function uri_uniequip(imageName, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/arts/ui/uniequipimg/${imageName}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}equip/icon/${imageName}.png`;
  }
}
function uri_item_image(imageName, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/avg/items/${imageName}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}avg/items/${imageName}.png`;
  }
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
function uri_image(imageName, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/avg/images/${imageName}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}avg/images/${imageName}.png`;
    case ASSET_SOURCE.ARKWAIFU:
      return ASSET_SOURCE.ARKWAIFU.replace(/REPLACEME/, imageName);
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

function uri_character(imageName, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}avg/characters/${imageName}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}avg/characters/${imageName}.png`;
    case ASSET_SOURCE.ARKWAIFU:
      return ASSET_SOURCE.ARKWAIFU.replace(/REPLACEME/, imageName);
  }
}
const DATA_BASE = {};
DATA_BASE[SERVERS.EN] = DATA_SOURCE_YOSTAR + SERVERS.EN;
DATA_BASE[SERVERS.JP] = DATA_SOURCE_YOSTAR + SERVERS.JP;
DATA_BASE[SERVERS.KR] = DATA_SOURCE_YOSTAR + SERVERS.KR;
DATA_BASE[SERVERS.CN] = DATA_SOURCE + SERVERS.CN;
if (USE_ALTERNATE_DATA_SOURCE) {
  DATA_BASE[SERVERS.EN] =
    "https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master/en";
  DATA_BASE[SERVERS.JP] =
    "https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master/jp";
  DATA_BASE[SERVERS.KR] =
    "https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master/kr";
  DATA_BASE[SERVERS.CN] =
    "https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master/cn";
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

const serverString = localStorage.getItem("server") || "en_US";
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
//   "Skadi the Corrupting Heart": "Skadiva",
//   "Ch'en the Holungday": "Ch'oom",
//   "Nearl the Radiant Knight": "NTR",
// };
const LINKAGE_LIMITEDS = [
  // R6 1
  "char_456_ash",
  "char_457_blitz",
  "char_458_rfrost",
  // MH
  "char_1029_yato2",
  "char_1030_noirc2",
  // R6 2
  "char_4125_rdoc",
  "char_4123_ela",
  "char_4124_iana",
  // DM
  "char_4144_chilc",
  "char_4142_laios",
  "char_4141_marcil",
];
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
const CCMAP = {
  "#b": {
    tag: "-ccbclear",
    title: "Operation Beta (CCβ)",
  },
  "#all": {
    tag: "-cc-all",
    title: "Combined Data (All CCs)",
  },
};
function intersection(a, b) {
  return new Set([...a].filter((x) => b.has(x)));
}
const rootMeanSquare = (xs) =>
  Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);
const geometricMean = (xs) => xs.reduce((a, x) => a * x, 1) ** (1 / xs.length);
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

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
async function get_cc_list(server = "en_US") {
  let raw = await gameDataFetch(server, "crisis_table");
  let data = await fixedJson(raw);
  data.seasonInfo.forEach((cc) => {
    let cc_num = /rune_season_(\d+)_1/.exec(cc.seasonId)[1];
    CCMAP["#" + cc_num] = {
      tag: "-cc" + cc_num + "clear",
      title: cc.name + " (CC#" + cc_num + ")",
      start: cc.startTs,
      end: cc.endTs,
    };
  });
  CCMAP["#all"].start = CCMAP["#12"].start;
  CCMAP["#all"].end = CCMAP["#12"].end;
  server == SERVERS.CN
    ? (CCMAP["#b"].start = 1574139600)
    : (CCMAP["#b"].start = 1591934400);
}
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

function thumbnail_tooltip(chart_canvas, even_rows_only = false) {
  // Works only with this specific custom tooltip CSS.
  return function f(context) {
    let tooltip = context.tooltip;
    const tooltipStylePadding = 3;
    const fullTTWidth =
      tooltip.width +
      tooltip.height -
      Chart.defaults.plugins.tooltip.padding * 2;
    var tooltipEl = document.getElementById("chartjs-tooltip");
    if (tooltip.opacity == 0) {
      tooltipEl.classList.add("hidden");
      return;
    }
    tooltipEl.className = ""; // clear all classes
    let beforeRect = tooltipEl.getBoundingClientRect();
    tooltipEl.style.cssText = "";
    tooltipEl.classList.add("x" + tooltip.xAlign, "y" + tooltip.yAlign);
    var innerHtml = "";
    let title = tooltip.title[0] || tooltip.body[0].lines[0].split(":")[0]; // for pie chart legend
    innerHtml =
      `<img src="${uri_avatar(charIdMap[title])}"> <div> <span><b>` +
      title +
      "</b></span>";
    for (const [i, b] of tooltip.body.entries()) {
      if (!even_rows_only || !(i % 2))
        innerHtml +=
          '<span><i class="fas fa-square-full" style="color: ' +
          tooltip.labelColors[i].backgroundColor +
          "; font-size:" +
          (parseInt(tooltip.bodyFontSize) - 2) +
          '"></i>' +
          b.lines[0] +
          "</span>";
    }
    innerHtml += "</div>";
    tooltipEl.innerHTML = innerHtml;
    let tt_left = chart_canvas.offsetLeft + tooltip.caretX;
    let xmod = 0;
    switch (tooltip.xAlign) {
      case "left":
        break;
      case "center":
        tt_left += -fullTTWidth / 2 - tooltipStylePadding;
        break;
      case "right":
        xmod = -tooltip.height;
        tt_left += -fullTTWidth - tooltipStylePadding * 2;
        break;
    }
    switch (tooltip.yAlign) {
      case "center":
        switch (tooltip.xAlign) {
          case "right":
            tt_left -= 5 + 1;
            break;
          case "left":
            tt_left += 5 + 1;
            break;
        }
        break;
      default:
        switch (tooltip.xAlign) {
          case "right":
            tt_left += 7;
            break;
          case "left":
            tt_left -= 7;
            break;
        }
        break;
    }
    tooltipEl.style.left = tt_left + "px";
    tooltipEl.style.top = chart_canvas.offsetTop + tooltip.y + "px";
    tooltipEl.style.height = tooltip.height + "px";
    tooltipEl.style.font = Chart.helpers.toFont(
      tooltip.options.bodyFont,
    ).string;

    // animate movement with FLIP technique
    let newRect = tooltipEl.getBoundingClientRect();
    let xform =
      "translateY(" +
      (beforeRect.top - newRect.top) +
      "px) translateX(" +
      (beforeRect.left - newRect.left) +
      "px)";
    tooltipEl.style.transition = "opacity .25s ease, transform 0s";
    tooltipEl.style.transform = xform;
    window.requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        tooltipEl.style.removeProperty("transform");
        tooltipEl.style.removeProperty("transition");
      });
    });
  };
}

var percentColors; // define this according to your data.

var getColorForPercentage = function (pct) {
  for (var i = 1; i < percentColors.length - 1; i++) {
    if (pct < percentColors[i].pct) {
      break;
    }
  }
  var lower = percentColors[i - 1];
  var upper = percentColors[i];
  var range = upper.pct - lower.pct;
  var rangePct = (pct - lower.pct) / range;
  var pctLower = 1 - rangePct;
  var pctUpper = rangePct;
  var color = {
    r: Math.floor(lower.color.r * pctLower + upper.color.r * pctUpper),
    g: Math.floor(lower.color.g * pctLower + upper.color.g * pctUpper),
    b: Math.floor(lower.color.b * pctLower + upper.color.b * pctUpper),
    a: (lower.color.a * pctLower + upper.color.a * pctUpper).toFixed(2),
  };
  return "rgba(" + [color.r, color.g, color.b, color.a].join(",") + ")";
};

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

// https://stackoverflow.com/questions/118241/calculate-text-width-with-javascript/21015393#21015393
function getCssStyle(element, prop) {
  return window.getComputedStyle(element, null).getPropertyValue(prop);
}

function getCanvasFontSize(el = document.body) {
  const fontWeight = getCssStyle(el, "font-weight") || "normal";
  const fontSize = getCssStyle(el, "font-size") || "12px";
  const fontFamily = getCssStyle(el, "font-family") || "Ariel";

  return fontWeight + " " + fontSize + " " + fontFamily;
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

function divideString(text) {
  let tokens = text.split(" ");
  if (tokens.length < 2) return [text, ""];
  let diff = text.length;
  let i = 1;
  for (; i < tokens.length; i++) {
    let newdiff = Math.abs(
      tokens.slice(0, i).join(" ").length - tokens.slice(i).join(" ").length,
    );
    if (newdiff > diff) break;
    diff = newdiff;
  }
  return [tokens.slice(0, i - 1).join(" "), tokens.slice(i - 1).join(" ")];
}

function CreateOpCheckbox(
  operator,
  data1map = null,
  data2map = null,
  colorScaleMax = null,
  clickfunc = null,
  destDiv = document.getElementById("checkboxes"),
  order = null,
  skills = [],
  dispSkillId = null,
) {
  let operatorName = operator.name;
  var checkboxDiv = document.createElement("div");
  checkboxDiv.classList.add("operatorCheckbox", "show");
  checkboxDiv.dataset.class = operator.profession;
  checkboxDiv.dataset.rarity = operator.rarity;
  if (order) checkboxDiv.style.order = order;
  if (data1map) {
    let count = data1map[operatorName] || 0;
    let useDiv = document.createElement("div");
    useDiv.classList.add("data1");
    useDiv.innerHTML = count;
    checkboxDiv.appendChild(useDiv);
    checkboxDiv.style.cssText =
      "background: " + getColorForPercentage(count / colorScaleMax) + ";";
  }
  if (data2map) {
    let riskDiv = document.createElement("div");
    riskDiv.classList.add("data2");
    riskDiv.innerHTML = data2map[operatorName] || 0;
    checkboxDiv.appendChild(riskDiv);
  }

  let im = document.createElement("img");
  im.setAttribute("loading", "lazy");
  im.src = uri_avatar(operator.charId);
  checkboxDiv.appendChild(im);

  let name = document.createElement("div");
  name.classList.add("name");
  let svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  let txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
  txt.innerHTML = operatorName;
  txt.setAttribute("x", "50%");
  txt.setAttribute("y", "50%");
  txt.setAttribute("dominant-baseline", "central");
  txt.setAttribute("text-anchor", "middle");
  txt.setAttribute("lengthAdjust", "spacingAndGlyphs");
  svg.appendChild(txt);
  name.appendChild(svg);

  checkboxDiv.appendChild(name);

  let skilldiv = document.createElement("div");
  skilldiv.classList.add("opskills");
  skilldiv.onclick = (e) => e.stopPropagation();
  skills.forEach((sid, idx) => {
    let i = document.createElement("img");
    i.src = uri_skill(sid);
    i.setAttribute("loading", "lazy");
    i.classList.add("opskillCheckbox");
    skilldiv.appendChild(i);
    // if also clickfunc, need to call it while passing skill LIST.
    i.onclick = (e) => {
      e.stopPropagation();
      i.classList.toggle("_selected");
      if (i.classList.contains("_selected"))
        checkboxDiv.dataset.selsk =
          parseInt(checkboxDiv.dataset.selsk || 0) | (1 << idx);
      else
        checkboxDiv.dataset.selsk =
          parseInt(checkboxDiv.dataset.selsk) ^ (1 << idx);
      if (clickfunc) {
        clickfunc(
          operator,
          checkboxDiv.classList.contains("_selected"),
          parseInt(checkboxDiv.dataset.selsk),
        );
      }
    };
  });
  if (skills.length > 1) checkboxDiv.appendChild(skilldiv);

  if (dispSkillId) {
    let skimg = document.createElement("img");
    skimg.classList.add("skimg");
    skimg.setAttribute("loading", "lazy");
    skimg.src = uri_skill(dispSkillId);
    checkboxDiv.appendChild(skimg);
  }

  destDiv.appendChild(checkboxDiv);

  if (clickfunc) {
    checkboxDiv.onclick = (e) => {
      checkboxDiv.classList.toggle("_selected");
      clickfunc(
        operator,
        checkboxDiv.classList.contains("_selected"),
        parseInt(checkboxDiv.dataset.selsk) || 0,
      );
    };
  }

  // must do this after appending to body as we need computed styles.
  let nameWidth = getTextWidth(operatorName, getCanvasFontSize(name));
  let plateWidth = parseInt(getComputedStyle(checkboxDiv).width);
  if (nameWidth > plateWidth * 1.2 && operatorName.split(" ").length > 1) {
    // multiple words, split onto multiple lines.
    let [first, second] = divideString(operatorName);
    txt.setAttribute("y", "35%");
    txt.setAttribute("x", "0");
    txt.setAttribute("transform", "scale(1,.75)");
    txt.innerHTML = "";
    // need to check width of each line and set textLength
    let firstLine = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "tspan",
    );
    firstLine.setAttribute("dy", "0");
    firstLine.setAttribute("x", "50%");
    if (getTextWidth(first, getCanvasFontSize(name)) > plateWidth * 0.95)
      firstLine.setAttribute("textLength", plateWidth * 0.95);
    firstLine.innerHTML = first;
    let secondLine = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "tspan",
    );
    secondLine.setAttribute("dy", "1em");
    secondLine.setAttribute("x", "50%");
    if (getTextWidth(second, getCanvasFontSize(name)) > plateWidth * 0.95)
      secondLine.setAttribute("textLength", plateWidth * 0.95);
    secondLine.innerHTML = second;
    txt.appendChild(firstLine);
    txt.appendChild(secondLine);
  } else if (nameWidth > plateWidth * 0.95)
    txt.setAttribute("textLength", plateWidth * 0.95);

  return checkboxDiv;
}
function htmlDecode(input) {
  var doc = new DOMParser().parseFromString(input, "text/html");
  return doc.documentElement.textContent;
}
function selectColor(number, saturation = 15, lightness = 60) {
  const hue = number * 137.508; // use golden angle approximation
  return `hsl(${hue},${saturation}%,${lightness}%)`;
}
function countWords(str, server = serverString) {
  if (server == SERVERS.EN)
    return str.trim().split(/\s+/).filter(Boolean).length;
  return str.trim().length;
}
function getViewportTop(el) {
  let top = 0;
  let node = el;
  while (node) {
    top += getOffsets(node).offsetTop || 0;
    node = node.offsetParent;
  }
  return top - window.scrollY;
}
const offsetCache = new Map();
function getOffsets(el) {
  if (offsetCache.has(el)) {
    return offsetCache.get(el);
  }
  const offsets = {
    offsetTop: el.offsetTop,
    offsetHeight: el.offsetHeight,
    offsetWidth: el.offsetWidth,
    offsetLeft: el.offsetLeft,
  };
  offsetCache.set(el, offsets);
  return offsets;
}
function clearOffsetCache() {
  offsetCache.clear();
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
