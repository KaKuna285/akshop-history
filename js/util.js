// EXTRA_DATA_REPO_RAW_BASE and extraDataUrl() come from js/config.js,
// which every page loads before this file.

// The upstream game-data mirror (ArknightsAssets/ArknightsGamedata, updated
// on every game patch). Pages load the slim copies via gameDataFetch()
// below, which only falls back to this.
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

// Don't change SERVERS when switching data sources: these values are also
// used as local keys.
const SERVERS = {
  EN: "en_US",
  JP: "ja_JP",
  KR: "ko_KR",
  CN: "zh_CN",
};
// --- asset URLs ---
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

// Avatar icon for a skin, by its avatarId (e.g. "char_002_amiya_winter#1",
// from skin_table.json's charSkins[skinId].avatarId -- see loadSkinTable()
// in operator-page.js). The avatarId names the exact file, so unlike
// uri_avatar() there's no Amiya special case. It must be URL-encoded:
// avatarIds contain "#", which would otherwise start a URL fragment. Both
// mirrors serve these from the same folder as operator icons.
function uri_skin_avatar(avatarId, source = ASSET_SOURCE.LOCAL) {
  const enc = encodeURIComponent(avatarId);
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/arts/charavatars/${enc}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}avatars/${enc}.png`;
  }
}

// The full splash illustration for a skin on the Aceship mirror -- the
// skin preview's last fallback (loadFullArt() in operator-page.js).
// Aceship hasn't been updated since May 2024, has only the full-size
// file, and is slow through jsDelivr (~3s for a 1MB file), so it's only
// loaded one at a time on user action, never in bulk.
//
// Callers must pass the skin's "portraitId", not "avatarId" or
// skin_table.json's "illustId":
//  - avatarId matches portraitId for every skin except the base "Default
//    outfit" (ILLUST_0), e.g. Amiya's avatarId is the bare
//    "char_002_amiya" (no such file here) while her portraitId is
//    "char_002_amiya_1".
//  - illustId (e.g. "illust_char_002_amiya_winter#1") never matches this
//    mirror's filenames (e.g. "char_002_amiya_winter#1.png").
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

// Full-illustration URL from the CN client's assets (ArknightsAssets2 on
// GitHub, through this site's R2 mirror -- CN_ART_MIRROR_BASE in config.js):
// "characters/<charId>/<portraitId>.png", default and skin art alike, with
// the same smaller "b" copy as myrtle.moe has (size "display"). This is what
// covers CN-only operators and skins.
function uri_skin_illust_cn(charId, portraitId, size = "display") {
  const base =
    (typeof CN_ART_MIRROR_BASE !== "undefined" && CN_ART_MIRROR_BASE) ||
    "https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/cn/assets/dyn/arts/";
  const suffix = size === "full" ? "" : "b";
  return base + ["characters", charId, `${portraitId}${suffix}.png`].map(encodeURIComponent).join("/");
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

// Operator/item icons with fallbacks, shared by every page that shows
// roster cards, search results or the edit modal.
//
// The default LOCAL mirror (akgcc/arkdata on jsDelivr) is missing some
// icons, so a failed load retries from Aceship; if that fails too, the
// <img> gets the "iconMissing" class (hidden, so the icon's circular
// background shows as an empty placeholder instead of a broken image).
//
// Both mirrors only carry released EN client art, so an operator or item
// not yet out on EN has no icon in either. For a cnOnly entity, a small
// generated "CN" placeholder is shown instead of the blank circle, so it
// reads as expected rather than broken.
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
// operator-edit-modal.js): not yet released on the EN server, so it's
// marked wherever it appears.
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
// Base (RIIC) skill icons, by building_data's skillIcon ("bskill_man_spd1").
function uri_building_skill(skillIcon, source = ASSET_SOURCE.LOCAL) {
  switch (source) {
    case ASSET_SOURCE.LOCAL:
      return `${ASSET_SOURCE.LOCAL}torappu/dynamicassets/arts/building/skills/${skillIcon}.png`.toLowerCase();
    case ASSET_SOURCE.ACESHIP:
      return `${ASSET_SOURCE.ACESHIP}ui/infrastructure/skill/${skillIcon}.png`;
  }
}
// Medal (achievement) icons, for the account page's medal detail popup.
// Neither LOCAL nor ACESHIP carries these; fexli/ArknightsResource's
// medal/ folder (synced from the official client) does, keyed by the full
// medalId. There's no second mirror to fall back to, so callers should
// hide the <img> on error.
function uri_medal(medalId) {
  // Lowercase only the id: unlike the other mirrors' paths, the repo path
  // "fexli/ArknightsResource" is mixed-case and case-sensitive on jsDelivr.
  return `https://cdn.jsdelivr.net/gh/fexli/ArknightsResource@master/medal/${medalId.toLowerCase()}.png`;
}

const DATA_BASE = {
  [SERVERS.EN]: `${GAME_DATA_MIRROR}/en`,
  [SERVERS.JP]: `${GAME_DATA_MIRROR}/jp`,
  [SERVERS.KR]: `${GAME_DATA_MIRROR}/kr`,
  [SERVERS.CN]: `${GAME_DATA_MIRROR}/cn`,
};
// --- small helpers shared by the calendar and operator pages ----------

// The site's data writes timestamps without a timezone, in a few shapes:
// "2020-12-10", "2020-12-10 16:00:00" (release dates), "2026-10-08T17:00:00"
// (events), "2025/11/13 08:00" (shop history). This reads all of them the
// same way in every browser: as that date and time on the viewer's own
// clock, so a date shows as the day it says. (new Date()/Date.parse() on
// anything but strict ISO is browser-specific -- Safari rejects
// "2020-12-10 16:00:00" -- and treats a bare "2020-12-10" as UTC midnight,
// which is the previous day anywhere west of UTC.) A string with an
// explicit offset or "Z", a Date or a number goes through new Date().
// Returns a Date, or null if there's nothing usable.
function parseTimestamp(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") return new Date(v);
  const s = String(v).trim();
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/.exec(s);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// parseTimestamp() as epoch milliseconds, NaN if unusable.
function timestampMs(v) {
  const d = parseTimestamp(v);
  return d ? d.getTime() : NaN;
}

// "Oct 8, 2026" (in the browser's locale) for a Date or a data timestamp
// (see parseTimestamp()); null for a missing or unparseable value.
function fmtDate(d) {
  const date = parseTimestamp(d);
  if (!date) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// A text box with a drop-down list of matches (the "Jump to operator",
// "Add operator" and "Add material" boxes). Typing shows the first `limit`
// entries of items() whose name contains the text (case-insensitive); the
// first match is highlighted, ArrowUp/ArrowDown move the highlight, and
// Enter or a click picks one. Escape or a click anywhere else closes the
// list. Picking clears the box, closes the list and calls onPick(item).
//
//   input, results -- the <input> and the (initially .hidden) list element
//   items()        -- the entries to search, each with a .name; return []
//                     while the data is still loading
//   buildRow(item) -- returns the row element for one match
//
// Returns { clear() }, which empties the box and closes the list.
function createSearchBox({ input, results, items, buildRow, onPick, limit = 20 }) {
  let matches = [];
  let highlighted = -1;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", results.id);
  input.setAttribute("aria-expanded", "false");
  results.setAttribute("role", "listbox");

  function highlight(index) {
    highlighted = index;
    Array.from(results.children).forEach((row, i) => {
      row.classList.toggle("highlighted", i === index);
      row.setAttribute("aria-selected", i === index ? "true" : "false");
    });
    const row = results.children[index];
    if (!row) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    input.setAttribute("aria-activedescendant", row.id);
    // Keep the highlighted row visible inside the scrolling list (without
    // scrolling the page itself).
    if (row.offsetTop < results.scrollTop) {
      results.scrollTop = row.offsetTop;
    } else if (row.offsetTop + row.offsetHeight > results.scrollTop + results.clientHeight) {
      results.scrollTop = row.offsetTop + row.offsetHeight - results.clientHeight;
    }
  }

  function show(list) {
    matches = list;
    results.innerHTML = "";
    list.forEach((item, i) => {
      const row = buildRow(item);
      row.id = `${results.id}-option-${i}`;
      row.setAttribute("role", "option");
      row.addEventListener("click", () => pick(item));
      results.appendChild(row);
    });
    results.classList.toggle("hidden", !list.length);
    input.setAttribute("aria-expanded", list.length ? "true" : "false");
    results.scrollTop = 0;
    highlight(list.length ? 0 : -1);
  }

  function clear() {
    input.value = "";
    show([]);
  }

  function pick(item) {
    clear();
    onPick(item);
  }

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    show(q ? items().filter((item) => item.name.toLowerCase().includes(q)).slice(0, limit) : []);
  });

  input.addEventListener("keydown", (e) => {
    if (results.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight(Math.min(highlighted + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight(Math.max(highlighted - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[highlighted]) pick(matches[highlighted]);
    } else if (e.key === "Escape") {
      show([]);
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target !== input && !results.contains(e.target)) show([]);
  });

  return { clear };
}

// A search-result row for an operator: avatar, name, CN tag if it's
// CN-only, and rarity stars.
function buildOperatorResultRow(op) {
  const row = document.createElement("div");
  row.className = "operatorSearchResult";
  const icon = document.createElement("img");
  icon.className = "operatorSearchResultIcon";
  setAvatarIcon(icon, op.charId, op.cnOnly);
  icon.alt = "";
  const name = document.createElement("span");
  name.className = "operatorSearchResultName";
  name.textContent = op.name;
  const rarity = document.createElement("span");
  rarity.className = "operatorSearchResultRarity";
  rarity.textContent = op.rarity + 1 + "★";
  row.appendChild(icon);
  row.appendChild(name);
  if (op.cnOnly) row.appendChild(buildCnBadge(op));
  row.appendChild(rarity);
  return row;
}

// Keyboard focus for the site's pop-up dialogs: moves focus into
// `dialogEl` as it opens, keeps Tab / Shift+Tab cycling inside it while
// it's open, and returns a release() to call when it closes, which puts
// focus back on whatever had it before (usually the button that opened it).
// If that element was re-rendered meanwhile (the planner redraws its cards
// on every edit), its replacement is found by the same data-focus-key.
// Dialogs can stack (the skin zoom opens over the skin preview): only the
// most recently opened one handles Tab.
const focusHoldStack = [];
function holdFocusIn(dialogEl) {
  const previous = document.activeElement;
  const focusables = () =>
    Array.from(
      dialogEl.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.getClientRects().length);
  const onKeyDown = (e) => {
    if (e.key !== "Tab" || focusHoldStack[focusHoldStack.length - 1] !== onKeyDown) return;
    const items = focusables();
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const inside = dialogEl.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKeyDown, true);
  focusHoldStack.push(onKeyDown);
  if (!dialogEl.hasAttribute("tabindex")) dialogEl.tabIndex = -1;
  (focusables()[0] || dialogEl).focus({ preventScroll: true });
  const focusKey = previous && previous.dataset ? previous.dataset.focusKey : null;
  return function release() {
    document.removeEventListener("keydown", onKeyDown, true);
    const at = focusHoldStack.indexOf(onKeyDown);
    if (at >= 0) focusHoldStack.splice(at, 1);
    let target = previous;
    if (target && !document.contains(target) && focusKey) {
      target = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    }
    if (target && typeof target.focus === "function" && document.contains(target)) {
      target.focus({ preventScroll: true });
    }
  };
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
  "uniequip_lore",
  "battle_equip_table",
  "skill_table",
  "skin_table",
  "item_table",
  "gamedata_const",
  "medal_table",
  "building_data",
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
// Scraped shop-history names that differ from the game data's names.
const GAMEPRESS_NAME_MAP = {
  "Rosa (Poca)": "Rosa",
  Pozëmka: "Позёмка",
  "Reed the Flame Shadow": "Reed The Flame Shadow",
  "Fang the Fire-Sharpened": "Fang the Fire-sharpened",
  "Eyjafjalla the Hvit Aska": "Eyjafjalla the Hvít Aska",
  // Not in the EN game data yet; the wiki's EN name -> her CN appellation.
  "Kal'tsit - Esperanta": "Kal'tsit·Esperanta",
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

// The tooltip element (#chartjs-tooltip) the store page's charts use
// (shoplist.js).
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
  // Returns the character table, modified:
  // - non-playable characters removed (unless keep_non_playable)
  // - a charId key on each character
  // - patch characters (Amiya's extra class forms) merged in and renamed
  // - internal profession names converted to the in-game ones
  // - rarity remapped to a 0-5 int
  // Also fills charIdMap (name/appellation -> charId) for use elsewhere.
  // With extra_data, adds isLimited, notInGachaPool, onlineTime and
  // cnOnlineTime from operator_release_dates.json (one extra fetch,
  // shared across calls -- see loadOperatorReleaseDates()).
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
        // notInGachaPool: not offered through any known gacha pool (usually
        // an event-reward operator) -- see scrape_PRTS() in
        // operator_online.py. Like onlineTime/cnOnlineTime below, it's left
        // unset (not `false`) when the data doesn't say, since a missing
        // value means "unknown", not "no".
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
      // Game data stores rarity as "TIER_1".."TIER_6"; the site uses 0-5.
      json[key].rarity = RARITY_MAP[json[key].rarity] ?? json[key].rarity;
    }
  }
  for (const [k, v] of Object.entries(CN_ID_MAP)) {
    if (!(k in charIdMap)) charIdMap[k] = charIdMap[v];
  }
  // short-name aliases (SHORT_NAMES: full name -> short name)
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

// The per-phase/level EXP+LMD curve and the per-rarity/phase Elite
// promotion LMD cost, for calcOperatorCost() below (planner page).
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
// rarity, ... }.
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
// defaultState()/defaultTargetState()). gameConst is a loadGameConst()
// result. Used by the planner page, summed across its whole roster.
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
// Returns a charId -> entry index of what's left, since charId is the key
// the rest of the site uses (the scraper keys by name because that's
// what the in-game shop shows).
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
    data.banner.sort((a, b) => timestampMs(a.date) - timestampMs(b.date));
    data.isKernel = charTableForServer[data.charId]?.classicPotentialItemId != null;
    // The default avatar mirror is missing some icons, so a failed load
    // retries once from Aceship (same as setIconWithFallback()). imgReady
    // settles either way -- resolved once the image has loaded or has
    // definitely failed -- so a page waiting on it never hangs on one
    // missing icon; check img.naturalWidth before drawing it.
    const img = new Image();
    const charId = data.charId;
    data.imgReady = new Promise((resolve) => {
      img.addEventListener("load", resolve);
      img.addEventListener("error", () => {
        if (img.dataset.fallback) return resolve();
        img.dataset.fallback = "1";
        img.src = uri_avatar(charId, ASSET_SOURCE.ACESHIP);
      });
    });
    img.src = uri_avatar(charId);
    data.img = img;
    // Take the true minimum rather than banner[0]: one unparseable date
    // makes the sort's NaN comparisons unreliable, which can leave a later
    // (e.g. rerun) date in slot 0.
    data.first = Math.min(...data.banner.map((b) => timestampMs(b.date)));
    data.shop = data.shop
      .map((entry) => ({ ...entry, date: timestampMs(entry.date) }))
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
// rarity, on one server. The anchor date (returned as latestRelease) is
// when the shop cadence last ticked forward: the most recent FIRST shop
// appearance among operators already shopped. Release dates aren't used
// as the anchor, since a never-shopped operator can have been released
// after the last one added to the shop. Also returns the queue of
// operators never in the shop yet, oldest-released first -- presumably
// next in line, one cadence apart: the first is expected `cadence` weeks
// after the anchor, the next 2x`cadence`, and so on. De-duped by charId
// in case the data lists an operator under more than one name.
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
      // data.shop[].date is already a number (normalizeShopHistory()).
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

// Patches Chart.js's PointElement to draw image points clipped to a
// circle -- or, when several points overlap (pointStyle.conflictCount),
// to that point's slice of the circle.
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

        // Custom part (the rest follows Chart.js's own drawPoint):
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
        ctx.drawImage(
          style,
          -style.width / 2,
          -style.height / 2,
          style.width,
          style.height,
        );
        // end of custom part

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

    drawPoint_round(ctx, options, this.x, this.y); // the only change from Chart.js's own draw()
  };

  Chart.defaults.scales.logarithmic.ticks.callback = function (
    tick,
    index,
    ticks,
  ) {
    return tick.toLocaleString();
  };
}

function htmlDecode(input) {
  var doc = new DOMParser().parseFromString(input, "text/html");
  return doc.documentElement.textContent;
}
function selectColor(number, saturation = 15, lightness = 60) {
  const hue = number * 137.508; // use golden angle approximation
  return `hsl(${hue},${saturation}%,${lightness}%)`;
}
// The page title links back to the page itself (without its query).
window.addEventListener("load", () => {
  const title = document.getElementById("pageTitle");
  if (title) title.href = location.origin + location.pathname;
});
