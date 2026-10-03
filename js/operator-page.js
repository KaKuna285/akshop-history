(function () {
  // Per-operator hub page: release dates (EN/CN + the event it likely
  // debuted alongside, best-effort), stats with Elite/level sliders,
  // talents, potential upgrades, skills with a Lv1-M3 slider per skill,
  // and modules -- plus an "Add to planner" button wired to the same
  // shared edit modal the planner and calendar pages use. Landing state
  // (no operator picked yet) shows the whole roster as a filterable,
  // sortable grid of boxes instead of a bare prompt -- see the "browsable
  // grid" section below.
  //
  // Routing is a plain `?id=charId` query string (no build-time page
  // generation on this static site) -- same deep-link convention as the
  // planner's own `?add=charId`. Picking a different operator from the
  // jump-search box, the browse grid, or a "released alongside" link
  // re-renders in place (history.replaceState, not a real navigation)
  // rather than reloading the page, since every data source below is
  // already loaded for every operator at once.
  //
  // Data sources:
  //   - OperatorEditModal.loadCharTable() (operator-edit-modal.js): EN+CN
  //     merged character data -- phases/attributesKeyFrames (stats),
  //     talents, potentialRanks, skills (skill ID references),
  //     subProfessionId/nationId/groupId/teamId, and modules (via its own
  //     uniequip_table.json fetch) -- the exact same table the shared
  //     edit modal itself uses.
  //   - skill_table.json (fetched here, EN+CN merged the same way
  //     loadCharTable() merges character_table.json): each skill
  //     reference on an operator is just an ID into this separate table,
  //     which has the actual name/description/SP cost for every skill
  //     level 1-7 *and* mastery ranks M1-M3 (the same "levels" array
  //     just keeps going to 10 entries for a masterable skill).
  //   - battle_equip_table.json (fetched here, EN+CN merged the same
  //     way): each module on op.modules is just a uniEquipId -- this
  //     separate table holds the real per-stage (equipLevel 1-3) effects,
  //     as both flat stat deltas (attributeBlackboard) and talent/trait
  //     override text (parts[].addOrOverrideTalentDataBundle /
  //     .overrideTraitDataBundle). Module records' own uniEquipDesc is
  //     just a one-line flavor blurb, not per-stage numeric data.
  //
  // Two small lookup tables below (SUBCLASS_NAMES, FACTION_NAMES) turn
  // raw subProfessionId/nationId-groupId-teamId values into readable
  // labels for the header badges. These are reconstructed from general
  // public knowledge of the game (SUBCLASS_NAMES cross-checked against a
  // community game-data mirror and wiki branch rosters, not pulled from
  // a verified primary in-game string table -- no reliably-fetchable
  // copy of that mapping was found while building this) -- an id missing
  // from either table just falls back to a lightly-capitalized version
  // of the raw id instead of guessing, so a gap here never looks wrong,
  // just plainer than ideal.
  //
  // Account-linked "your actual progression" data is a deferred
  // follow-up -- the "Add to planner" button below always starts a new
  // roster entry from a fresh E0/Lv1, same as adding one from the
  // planner's own search box would.

  const DAY_MS = 24 * 60 * 60 * 1000;
  const SERVER = SERVERS.EN;

  const jumpInput = document.getElementById("operatorJumpSearch");
  const jumpResultsEl = document.getElementById("operatorJumpResults");
  const statusEl = document.getElementById("operatorStatus");
  const browseEl = document.getElementById("operatorBrowse");
  const gridEl = document.getElementById("operatorGrid");
  const classFilterEl = document.getElementById("opFilterClass");
  const rarityFilterEl = document.getElementById("opFilterRarity");
  const sortByEl = document.getElementById("opSortBy");
  const ownedFilterEl = document.getElementById("opFilterOwned");
  const ownedFilterHintEl = document.getElementById("opOwnedFilterHint");
  const contentEl = document.getElementById("operatorContent");
  const backLinkEl = document.getElementById("opBackLink");
  const iconEl = document.getElementById("opIcon");
  const nameEl = document.getElementById("opName");
  const rarityBadgeEl = document.getElementById("opRarityBadge");
  const classBadgeEl = document.getElementById("opClassBadge");
  const subclassBadgeEl = document.getElementById("opSubclassBadge");
  const factionBadgeEl = document.getElementById("opFactionBadge");
  const poolBadgeEl = document.getElementById("opPoolBadge");
  const addToPlannerBtn = document.getElementById("opAddToPlannerBtn");
  const statsViewToggleEl = document.getElementById("opStatsViewToggle");
  const statsViewMaxedBtn = document.getElementById("opStatsViewMaxed");
  const statsViewOwnedBtn = document.getElementById("opStatsViewOwned");
  const ownedSummaryEl = document.getElementById("opOwnedSummary");
  const releaseInfoEl = document.getElementById("opReleaseInfo");
  const statsInfoEl = document.getElementById("opStatsInfo");
  const talentsInfoEl = document.getElementById("opTalentsInfo");
  const potentialsInfoEl = document.getElementById("opPotentialsInfo");
  const skillsInfoEl = document.getElementById("opSkillsInfo");
  const modulesInfoEl = document.getElementById("opModulesInfo");
  const skinsInfoEl = document.getElementById("opSkinsInfo");
  const skinsUnownedToggleEl = document.getElementById("opSkinsUnownedToggle");
  const skinsUnownedToggleInputEl = document.getElementById("opSkinsUnownedToggleInput");
  const skinPreviewOverlayEl = document.getElementById("skinPreviewOverlay");
  const skinPreviewEl = document.getElementById("skinPreview");
  const skinPreviewCloseBtn = document.getElementById("skinPreviewClose");
  const skinPreviewImgEl = document.getElementById("skinPreviewImg");
  const skinPreviewNameEl = document.getElementById("skinPreviewName");
  const skinPreviewMetaEl = document.getElementById("skinPreviewMeta");
  const skinPreviewContentEl = document.getElementById("skinPreviewContent");

  let charTable = null; // charId -> operator record (EN+CN merged, via OperatorEditModal.loadCharTable())
  let operatorList = []; // playable operators, sorted by name, for the jump-search box
  let skillTable = {}; // skillId -> { levels: [...] } (EN+CN merged)
  let battleEquipTable = {}; // uniEquipId -> { phases: [...] } (EN+CN merged)
  // charId -> [skin, ...] (skin_table.json's charSkins entries, EN+CN
  // merged the same best-effort way as skillTable/battleEquipTable above,
  // then filtered down to entries whose charId is a real playable
  // operator -- see loadData() -- which also happens to drop every
  // token_*-prefixed entry (enemy/summon re-skins, not operator skins)
  // for free, since those charIds never appear in charTable either.
  // Sorted per-operator by displaySkin.sortId, which the real data puts
  // the default Elite 0/1/2 outfits (negative sortId) before actual
  // purchasable skins (positive sortId, in release order) -- see
  // skinDisplayName() for how those default entries get a readable label
  // despite having no skinName of their own.
  let skinsByCharId = {};

  // "Grey out skins you don't own" state for the gallery above -- the
  // inverse of /store's own "Grey out owned" toggle (js/shoplist.js,
  // which dims operators you DO have, to highlight who's left to pull):
  // here it dims the skins you DON'T have yet, so the ones you still
  // need to get stand out instead -- as a CSS opacity class on these DOM
  // .opSkinCard buttons rather than a Chart.js canvas's globalAlpha,
  // since this gallery isn't a canvas. Sourced from
  // AccountSync.getOwnedSkins() (populated by a sync whose Worker
  // response included skin ownership data -- see
  // cloudflare/depot-import.js's extractOwnedSkins()); computed once
  // here rather than per-render since a sync only changes via a full
  // page reload. `hasOwnedSkinData` kept apart from an empty
  // ownedSkinIdSet on purpose (same reasoning as the operator-roster
  // owned/not-owned filter elsewhere on this page) so the toggle can stay
  // hidden entirely for a never-synced visitor, or one whose last sync
  // predates this field, instead of just doing nothing visible.
  let greyUnownedSkins = getPref("operator", "greyUnownedSkins", true, (v) => typeof v === "boolean");
  const ownedSkinsMap = AccountSync.getOwnedSkins();
  const hasOwnedSkinData = !!ownedSkinsMap;
  const ownedSkinIdSet = new Set(Object.keys(ownedSkinsMap || {}));

  let events = []; // events.json's events[] -- best-effort, may stay empty
  let dataReady = false;
  let currentCharId = null;
  let jumpHighlighted = -1;
  let jumpResults = [];

  // --- "Maxed" / "Your stats" toggle --------------------------------------
  // Whether to show the fully-maxed state (the page's long-standing
  // default) or this operator's actual synced progress in the Stats/
  // Potentials/Skills/Modules sections below. `statsView` is the user's
  // last choice (persisted, so picking "Your stats" once keeps it picked
  // for the next operator too); `currentIsOwned`/`currentProgress` are
  // refreshed for whichever operator is currently on screen, by
  // renderOperator() below, since a stale `true`/non-null here from a
  // previously-viewed operator would wrongly offer "Your stats" for one
  // that isn't actually owned (or isn't the same owned operator the
  // progress data belongs to).
  let statsView = getPref("operator", "statsView", "maxed", (v) => v === "maxed" || v === "owned");
  let currentIsOwned = false;
  let currentProgress = null; // this operator's synced progress, or null

  // "Your stats" only ever actually applies when the operator is owned
  // *and* the synced data includes this operator's progress (an older
  // sync, from before ownedOperatorProgress existed, still has a roster
  // but no per-operator detail) -- otherwise this silently falls back to
  // "Maxed" without changing the stored preference, so switching to a
  // different owned-with-progress operator still remembers "Your stats".
  function effectiveView() {
    return currentIsOwned && currentProgress && statsView === "owned" ? "owned" : "maxed";
  }

  function getAccountProgress(charId) {
    if (typeof AccountSync === "undefined" || !AccountSync.getOperatorProgress) return null;
    return AccountSync.getOperatorProgress(charId);
  }

  function updateStatsViewToggle() {
    if (!currentIsOwned) {
      statsViewToggleEl.classList.add("hidden");
      return;
    }
    statsViewToggleEl.classList.remove("hidden");
    statsViewOwnedBtn.disabled = !currentProgress;
    statsViewOwnedBtn.title = currentProgress
      ? ""
      : "This sync didn't include detailed progress for this operator -- re-sync your account from the home page to use this.";
    const view = effectiveView();
    statsViewMaxedBtn.classList.toggle("opStatsViewBtnActive", view === "maxed");
    statsViewOwnedBtn.classList.toggle("opStatsViewBtnActive", view === "owned");
  }

  // The compact "Owned · E1 · Lv55 · ..." line in the header -- always
  // reflects the account's actual synced state (regardless of which
  // Maxed/Your stats button is currently selected below), since the
  // point of this line is "what do I actually have", not a preview.
  function renderOwnedSummary(op) {
    if (!currentIsOwned) {
      ownedSummaryEl.classList.add("hidden");
      return;
    }
    ownedSummaryEl.textContent =
      typeof AccountSync !== "undefined" && AccountSync.formatInvestmentSummary
        ? AccountSync.formatInvestmentSummary(op, currentProgress)
        : "Owned";
    ownedSummaryEl.classList.remove("hidden");
  }

  function setStatsView(view) {
    statsView = view;
    setPref("operator", "statsView", view);
    updateStatsViewToggle();
    const op = charTable && charTable[currentCharId];
    if (op) renderStatDependentSections(op);
  }

  statsViewMaxedBtn.addEventListener("click", () => setStatsView("maxed"));
  statsViewOwnedBtn.addEventListener("click", () => {
    if (statsViewOwnedBtn.disabled) return;
    setStatsView("owned");
  });

  // --- best-effort id -> display name lookups (see the file header for
  // why these are reconstructed rather than fetched) -----------------------

  const SUBCLASS_NAMES = {
    // Vanguard
    pioneer: "Pioneer",
    charger: "Charger",
    tactician: "Tactician",
    bearer: "Standard Bearer",
    agent: "Agent",
    counsellor: "Strategist",
    // Guard
    fighter: "Fighter",
    artsfghter: "Arts Fighter",
    sword: "Swordmaster",
    lord: "Lord",
    musha: "Soloblade",
    reaper: "Reaper",
    librator: "Liberator",
    centurion: "Centurion",
    crusher: "Crusher",
    instructor: "Instructor",
    fearless: "Dreadnought",
    hammer: "Earthshaker",
    mercenary: "Mercenary",
    primguard: "Primal Guard",
    // Defender
    protector: "Protector",
    unyield: "Juggernaut",
    fortress: "Fortress",
    artsprotector: "Arts Protector",
    duelist: "Duelist",
    guardian: "Guardian",
    shotprotector: "Sentry Protector",
    primprotector: "Primal Protector",
    // Medic
    physician: "Medic",
    ringhealer: "Multi-target Medic",
    healer: "Therapist",
    wandermedic: "Wandering Medic",
    incantationmedic: "Incantation Medic",
    chainhealer: "Chain Medic",
    watchman: "Watchman",
    // Sniper
    fastshot: "Marksman",
    longrange: "Deadeye",
    closerange: "Heavyshooter",
    reaperrange: "Spreadshooter",
    bombarder: "Flinger",
    siegesniper: "Besieger",
    aoesniper: "Artilleryman",
    hunter: "Hunter",
    loopshooter: "Loopshooter",
    skybreaker: "Skybreaker",
    // Caster
    splashcaster: "Splash Caster",
    corecaster: "Core Caster",
    chain: "Chain Caster",
    funnel: "Mech-accord Caster",
    mystic: "Mystic Caster",
    primcaster: "Primal Caster",
    soulcaster: "Shaper Caster",
    // Caster (crowd control / special shapes)
    blastcaster: "Blast Caster",
    phalanx: "Phalanx Caster",
    // Supporter
    slower: "Decel Binder",
    summoner: "Summoner",
    craftsman: "Artificer",
    underminer: "Hexer",
    bard: "Bard",
    blessing: "Abjurer",
    ritualist: "Ritualist",
    // Specialist
    executor: "Executor",
    pusher: "Push Stroker",
    stalker: "Ambusher",
    geek: "Geek",
    hookmaster: "Hookmaster",
    merchant: "Merchant",
    dollkeeper: "Dollkeeper",
    traper: "Trapmaster",
    alchemist: "Alchemist",
    skywalker: "Skyranger",
  };

  const FACTION_NAMES = {
    rhodes: "Rhodes Island",
    kazimierz: "Kazimierz",
    columbia: "Columbia",
    victoria: "Victoria",
    bolivar: "Bolívar",
    iberia: "Iberia",
    higashi: "Higashi",
    yan: "Yan",
    lungmen: "Lungmen",
    sami: "Sami",
    ursus: "Ursus",
    sargon: "Sargon",
    minos: "Minos",
    laterano: "Laterano",
    kjerag: "Kjerag",
    leithanien: "Leithanien",
    siracusa: "Siracusano",
    sarkaz: "Sarkaz",
    karlan: "Karlan Trade",
    penguin: "Penguin Logistics",
    blacksteel: "Blacksteel Workshop",
    rhine: "Rhine Lab",
    pinus: "Pinus Sylvestris",
    glasgow: "Glasgow",
    S4: "S.P.C.4",
  };

  function humanizeId(id) {
    if (!id) return "";
    return id.charAt(0).toUpperCase() + id.slice(1);
  }

  function charIdFromUrl() {
    return new URLSearchParams(location.search).get("id");
  }

  function fmtDate(d) {
    if (d == null) return null;
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function textNote(text) {
    const el = document.createElement("div");
    el.className = "opNote";
    el.textContent = text;
    return el;
  }

  // Skill/talent/module descriptions reference their own numeric
  // parameters as "{key}" or "{key:format}" tokens, resolved against a
  // "blackboard" array of { key, value } pairs living alongside that same
  // description -- and wrap emphasized words in the game's own rich-text
  // markup, which isn't real HTML. That markup isn't always "<@ba....>":
  // some skills use "<$ba....>" instead (same meaning, different sigil --
  // e.g. Ascalon's S3 uses "<@ba.vup>" for one clause but plain "<$...>"
  // elsewhere), so this strips any "<...>...</>" -style tag generically
  // rather than special-casing one sigil. Token keys aren't always plain
  // identifiers either -- some reference a specific sub-effect with an
  // "@" in the key itself (e.g. "{attack@hp_ratio:0%}", a literal
  // blackboard key "attack@hp_ratio", not a scope prefix to strip -- see
  // Ascalon's S3 for a real example), so "@" is allowed in the token-key
  // character class too. Fills in every token this can resolve; leaves
  // one it can't (an unrecognized key, or an entirely separate
  // templating convention some newer skills use) exactly as written
  // rather than silently dropping it, so a miss is visible instead of
  // quietly wrong.
  function formatDescription(text, blackboard) {
    if (!text) return "";
    let out = text.replace(/<\/?[^>]+>/g, "");
    const bbMap = {};
    // A candidate/skill-level with literally zero blackboard tokens to
    // substitute (plain-text description, no "{x}" placeholders) doesn't
    // always come back as an empty array -- this codebase's own upstream
    // data (battle_equip_table.json) has been directly observed emitting
    // an empty *object* ("{}") for an empty list field in this exact
    // shape (see tokenAttributeBlackboard on a real module phase), not
    // just "[]". `(blackboard || [])` only guards against a falsy value,
    // so a truthy-but-non-array "{}" slipped through to .forEach and
    // threw -- which, since this is called from inside modules'
    // renderModuleStage() for *every* candidate with any blackboard
    // field, blanked the whole module behind the "couldn't load full
    // details" fallback for any module whose text needed no token
    // substitution at all. That's common enough to explain it happening
    // "a lot of the time" rather than as a rare edge case.
    (Array.isArray(blackboard) ? blackboard : []).forEach((b) => {
      if (b && b.key) bbMap[String(b.key).toLowerCase()] = b.value;
    });
    out = out.replace(/\{(-?)([a-zA-Z0-9_.@]+)(:([^}]+))?\}/g, (whole, neg, key, _m, fmt) => {
      const v = bbMap[key.toLowerCase()];
      if (v == null) return whole;
      const signed = neg ? -v : v;
      if (fmt && fmt.indexOf("%") !== -1) return Math.round(signed * 100) + "%";
      if (Number.isInteger(signed)) return String(signed);
      return String(Math.round(signed * 100) / 100);
    });
    return out;
  }

  // "PHASE_0" / "PHASE_1" / "PHASE_2" -> 0 / 1 / 2.
  function phaseNumber(phaseStr) {
    const m = /PHASE_(\d+)/.exec(phaseStr || "");
    return m ? parseInt(m[1], 10) : null;
  }

  // Module stat deltas (battle_equip_table.json's attributeBlackboard) use
  // the same short, snake_case keys as other tables on this site --
  // a few common ones get a friendly label, anything else just gets its
  // underscores turned into spaces and title-cased, same fallback spirit
  // as humanizeId() above.
  const MODULE_STAT_LABELS = {
    max_hp: "Max HP",
    atk: "ATK",
    def: "DEF",
    magic_resistance: "RES",
    res: "RES",
    cost: "DP Cost",
    block_cnt: "Block",
    respawn_time: "Redeploy Time",
    attack_speed: "Attack Speed",
    max_deploy_count: "Max Deploy Count",
  };

  function moduleStatLabel(key) {
    if (MODULE_STAT_LABELS[key]) return MODULE_STAT_LABELS[key];
    return String(key)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatModuleStatDelta(key, value) {
    const sign = value >= 0 ? "+" : "";
    if (/pct|percent/i.test(key)) return sign + Math.round(value * 100) + "%";
    const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
    return sign + rounded;
  }

  // --- "released alongside event X" (best-effort) ---------------------
  // A lighter, one-directional cousin of calendar.js's own
  // matchOperatorsToEvents(): that one matches *every* operator against
  // *every* event at once (for the calendar's own preview chips), this
  // one just needs "does any event fall within a day of THIS operator's
  // release" for a single operator -- not worth routing through the
  // calendar's own bulk version or extracting a shared one for.
  //
  // Both events.json's globalStart ("...T17:00:00") and operator_release_
  // dates.json's onlineTime ("...17:00:00") use the same plain,
  // no-UTC-offset timestamp convention -- comparing just the Y-M-D
  // portion (via Date.UTC, so this doesn't drift with the browser's own
  // timezone) avoids the ambiguity of parsing either one as a full
  // timestamp. See calendar.js's own dayKeyFromTimestamp() for the
  // original version of this reasoning.
  function dayKeyFromTimestamp(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    if (!m) return null;
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
  }
  const EVENT_MATCH_WINDOW_DAYS = 1;

  function findReleaseEvent(op) {
    if (!events.length || !op.onlineTime) return null;
    const day = dayKeyFromTimestamp(op.onlineTime);
    if (day == null) return null;
    for (const ev of events) {
      const evDay = dayKeyFromTimestamp(ev.globalStart);
      if (evDay != null && Math.abs(evDay - day) <= EVENT_MATCH_WINDOW_DAYS) return ev;
    }
    return null;
  }

  // Same wiki-link convention as calendar.js's own wikiUrl() -- segments
  // encoded individually so a literal "/" in a subpage name (e.g.
  // "Event/Rerun") stays a subpage path instead of being escaped away.
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

  // --- data loading -----------------------------------------------------

  // Every operator's "skills" field on character_table.json is just a
  // list of { skillId, ... } references -- the real name/description/SP
  // cost for every skill level (and mastery rank, for a masterable
  // skill) lives in this separate table, keyed by that same skillId.
  // Not needed by any other page yet, so (unlike loadGameConst()/
  // loadItemTable() in util.js) this stays local here rather than
  // getting extracted for a second caller that doesn't exist.
  async function loadSkillTable(server) {
    const res = await fetch(`${DATA_BASE[server]}/gamedata/excel/skill_table.json`);
    return await fixedJson(res);
  }

  // Keyed by uniEquipId -- same "not needed anywhere else yet" reasoning
  // as loadSkillTable() above.
  async function loadBattleEquipTable(server) {
    const res = await fetch(`${DATA_BASE[server]}/gamedata/excel/battle_equip_table.json`);
    return await fixedJson(res);
  }

  // skin_table.json's top-level shape is { charSkins: {...}, buildinEvolveMap,
  // buildinPatchMap, brandList, specialSkinInfoList, spDynSkins, ... } --
  // only charSkins (skinId -> skin record) is used here, so this returns
  // just that sub-dict rather than the whole ~4MB structure. Confirmed via
  // a real browser fetch of the live file (not assumed from the field
  // name) that every record's own isBuySkin/getTime cleanly separate the
  // 480-ish actual purchasable skins from the ~1600 default Elite 0/1/2
  // outfit entries every operator also gets one of here -- see
  // skinDisplayName() below for how those get labeled.
  async function loadSkinTable(server) {
    const res = await fetch(`${DATA_BASE[server]}/gamedata/excel/skin_table.json`);
    const json = await fixedJson(res);
    return (json && json.charSkins) || {};
  }

  async function loadData() {
    const [chars, skills, battleEquip, skins] = await Promise.all([
      OperatorEditModal.loadCharTable(),
      loadSkillTable(SERVER),
      loadBattleEquipTable(SERVER),
      loadSkinTable(SERVER),
    ]);
    charTable = chars;
    skillTable = skills;
    battleEquipTable = battleEquip;

    operatorList = Object.values(charTable)
      .map((op) => ({
        charId: op.charId,
        name: op.name,
        rarity: op.rarity,
        cnOnly: op.cnOnly,
        profession: op.profession,
        onlineTime: op.onlineTime,
        cnOnlineTime: op.cnOnlineTime,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Best-effort CN merge, same reasoning (and same "never let a slow
    // or down CN mirror break EN data" approach) as loadCharTable()'s own
    // CN merge -- covers skill/module ids referenced only by a cnOnly
    // operator.
    try {
      const cnSkills = await loadSkillTable(SERVERS.CN);
      for (const [skillId, data] of Object.entries(cnSkills)) {
        if (!skillTable[skillId]) skillTable[skillId] = data;
      }
    } catch (err) {
      console.warn("Couldn't load CN-exclusive skill data:", err);
    }

    try {
      const cnEquip = await loadBattleEquipTable(SERVERS.CN);
      for (const [uniEquipId, data] of Object.entries(cnEquip)) {
        if (!battleEquipTable[uniEquipId]) battleEquipTable[uniEquipId] = data;
      }
    } catch (err) {
      console.warn("Couldn't load CN-exclusive module effect data:", err);
    }

    // Same best-effort CN top-up as skill/module data above -- covers a
    // cnOnly operator's skins (including their default Elite 0/1/2 art),
    // which otherwise wouldn't exist under this charId in the EN-only
    // skin table at all.
    try {
      const cnSkins = await loadSkinTable(SERVERS.CN);
      for (const [skinId, data] of Object.entries(cnSkins)) {
        if (!skins[skinId]) skins[skinId] = data;
      }
    } catch (err) {
      console.warn("Couldn't load CN-exclusive skin data:", err);
    }

    // Index by charId, dropping anything that isn't a real playable
    // operator's own skin -- this is what filters out the token_*-
    // prefixed entries (enemy/summon re-skins) seen in the live data,
    // since those charIds never appear in charTable either. Order within
    // each operator's list follows the game data's own displaySkin.sortId
    // (defaults first, then real skins in release order).
    skinsByCharId = {};
    for (const skin of Object.values(skins)) {
      if (!skin || !skin.charId || !charTable[skin.charId]) continue;
      if (!skinsByCharId[skin.charId]) skinsByCharId[skin.charId] = [];
      skinsByCharId[skin.charId].push(skin);
    }
    for (const list of Object.values(skinsByCharId)) {
      list.sort((a, b) => ((a.displaySkin && a.displaySkin.sortId) || 0) - ((b.displaySkin && b.displaySkin.sortId) || 0));
    }

    // Event data is best-effort: a failed/slow fetch just leaves the
    // "released alongside" row out, rather than blocking the rest of the
    // page.
    try {
      const res = await fetch(extraDataUrl("events.json"));
      const js = await res.json();
      events = js.events || [];
    } catch (err) {
      console.warn("Couldn't load event data:", err);
    }

    dataReady = true;
  }

  // --- rendering ----------------------------------------------------------

  function renderReleaseInfo(op) {
    releaseInfoEl.innerHTML = "";
    const addRow = (label, valueNode) => {
      const row = document.createElement("div");
      row.className = "opInfoRow";
      const l = document.createElement("span");
      l.className = "opInfoLabel";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "opInfoValue";
      if (typeof valueNode === "string") v.textContent = valueNode;
      else v.appendChild(valueNode);
      row.appendChild(l);
      row.appendChild(v);
      releaseInfoEl.appendChild(row);
    };
    addRow("EN release", fmtDate(op.onlineTime) || "Not yet released on EN");
    if (op.cnOnlineTime) addRow("CN release", fmtDate(op.cnOnlineTime));
    const ev = findReleaseEvent(op);
    if (ev) {
      const href = wikiUrl(ev.wikiPage || ev.event);
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = ev.event;
        addRow("Released alongside", a);
      } else {
        addRow("Released alongside", ev.event);
      }
    }
  }

  // --- skins ---------------------------------------------------------------
  // A skin's own displaySkin.skinName is only ever set for an actual
  // purchasable/obtainable skin (isBuySkin: true) -- the default Elite
  // 0/1/2 outfit entries every operator also has here have a null
  // skinName, so they're labeled from their skinGroupId instead
  // ("ILLUST_0"/"ILLUST_1"/"ILLUST_2", confirmed via a real fetch of the
  // live data -- not every operator has all three; a 4-star-and-under
  // operator with no Elite 2 simply has no ILLUST_2 entry at all).
  function skinDisplayName(skin) {
    const d = (skin && skin.displaySkin) || {};
    if (d.skinName) return d.skinName;
    const m = /^ILLUST_(\d+)$/.exec(d.skinGroupId || "");
    if (m) return m[1] === "0" ? "Default outfit" : `Elite ${m[1]} art`;
    return "Outfit";
  }

  function hideSkinPreview() {
    skinPreviewOverlayEl.classList.add("hidden");
  }

  function showSkinPreview(skin) {
    const d = (skin && skin.displaySkin) || {};
    const avatarId = skin.avatarId || skin.skinId;
    // The full illustration is keyed by the skin's own *portraitId*, not
    // avatarId -- they're the same string for a real purchasable skin and
    // for the Elite 1/Elite 2 default-outfit entries, which is how Phase
    // 1's research missed this, but for the base/"Default outfit"
    // (ILLUST_0) entry they differ: e.g. Amiya's avatarId is the bare
    // "char_002_amiya" (no file by that name in the illustration mirror),
    // while her portraitId is "char_002_amiya_1" (a real ~300KB file that
    // IS there) -- confirmed directly against skin_table.json and the
    // mirror's file listing. Using portraitId here is what actually
    // enables full-size art for the default outfit, not a separate
    // special case.
    const portraitId = skin.portraitId || avatarId;
    // Show the small avatar immediately as a placeholder -- cheap, and
    // usually already in the browser's cache from this same skin's grid
    // card -- while the full illustration (several times bigger, up to a
    // few MB for some skins) loads in the background via a detached
    // Image(). Only swap the visible <img> over to it once that load has
    // actually succeeded, so the modal never shows a half-loaded image.
    skinPreviewImgEl.dataset.avatarId = avatarId;
    skinPreviewImgEl.classList.remove("skinPreviewImgFull");
    skinPreviewImgEl.onload = () => {
      skinPreviewImgEl.style.display = "block";
    };
    skinPreviewImgEl.onerror = () => {
      skinPreviewImgEl.style.display = "none";
    };
    skinPreviewImgEl.style.display = "none";
    setSkinAvatarIcon(skinPreviewImgEl, avatarId);

    // Aceship first (the long-established mirror, usually fastest/most
    // cached), then myrtle.moe's own asset pipeline as a second try -- it
    // extracts straight from the official game CDN rather than waiting on
    // community contributors, so it reliably has art Aceship doesn't yet
    // for very recent/collab-exclusive skins. A handful of skins (see the
    // "Check skin art coverage" debug page linked at the bottom of this
    // page) still have no full illustration on either mirror; that last
    // 404 just silently leaves the avatar showing.
    const fullUrlCandidates = [uri_skin_illust(portraitId), uri_skin_illust_myrtle(skin.charId, portraitId, skin.isBuySkin)];
    function tryNextFullUrl(i) {
      if (i >= fullUrlCandidates.length) return; // nothing worked -- stay on the avatar
      const url = fullUrlCandidates[i];
      const preload = new Image();
      preload.onload = () => {
        // The user may already have clicked a different skin card before
        // this background load finished -- only apply it if the preview
        // is still showing the same skin it was requested for.
        if (skinPreviewImgEl.dataset.avatarId !== avatarId) return;
        skinPreviewImgEl.onload = null;
        skinPreviewImgEl.onerror = null;
        skinPreviewImgEl.src = url;
        skinPreviewImgEl.classList.add("skinPreviewImgFull");
        skinPreviewImgEl.style.display = "block";
      };
      preload.onerror = () => tryNextFullUrl(i + 1);
      preload.src = url;
    }
    tryNextFullUrl(0);

    skinPreviewNameEl.textContent = skinDisplayName(skin);
    skinPreviewMetaEl.textContent = d.skinGroupName || "";
    // Default outfit entries have no real flavor text to show -- content
    // (sale/epoque copy) and usage (a shorter blurb) are both just the
    // in-shop description, shown as one paragraph same as the medal
    // preview's description does for its own flavor text. This data has
    // the exact same "<color name=#xxxxxx>...</color>"-style rich-text
    // markup as skill/talent/module text, so reuse the same stripper --
    // skin flavor text has no "{key}" blackboard tokens to resolve, hence
    // the null second argument.
    skinPreviewContentEl.textContent = formatDescription(d.content || d.usage || "", null);
    skinPreviewOverlayEl.classList.remove("hidden");
    skinPreviewOverlayEl.scrollTop = 0;
  }

  skinPreviewCloseBtn.addEventListener("click", hideSkinPreview);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !skinPreviewOverlayEl.classList.contains("hidden")) hideSkinPreview();
  });
  skinPreviewOverlayEl.addEventListener("click", (e) => {
    if (e.target === skinPreviewOverlayEl) hideSkinPreview();
  });

  function renderSkins(op) {
    skinsInfoEl.innerHTML = "";
    const skins = skinsByCharId[op.charId] || [];
    if (!skins.length) {
      skinsInfoEl.appendChild(textNote("No skin data available for this operator."));
      return;
    }
    for (const skin of skins) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "opSkinCard";
      // hasOwnedSkinData guards this the same as the toggle's own
      // visibility -- without it, a never-synced visitor (empty
      // ownedSkinIdSet, so every skin looks "not owned") would see the
      // whole gallery dimmed by greyUnownedSkins' own true default, with
      // no visible toggle to turn it back off.
      if (hasOwnedSkinData && greyUnownedSkins && !ownedSkinIdSet.has(skin.skinId)) {
        card.classList.add("opSkinCardUnowned");
      }
      const img = document.createElement("img");
      img.className = "opSkinCardImg";
      img.alt = "";
      setSkinAvatarIcon(img, skin.avatarId || skin.skinId);
      card.appendChild(img);
      const label = document.createElement("span");
      label.className = "opSkinCardName";
      label.textContent = skinDisplayName(skin);
      card.appendChild(label);
      card.addEventListener("click", () => showSkinPreview(skin));
      skinsInfoEl.appendChild(card);
    }
  }

  // Every phase stores exactly an E-start (level 1) and an E-end (that
  // phase's max level) snapshot -- a level in between is a plain linear
  // interpolation between the two, the same approach other community
  // calculators (Penguin Stats, ArknightsToolbox) use, and the same
  // growth curve the game itself uses within a single Elite phase.
  function interpolateStat(kf0, kf1, level, key) {
    const v0 = kf0.data ? kf0.data[key] : undefined;
    const v1 = kf1.data ? kf1.data[key] : undefined;
    if (v0 == null) return v1;
    if (v1 == null) return v0;
    if (kf1.level === kf0.level) return v0;
    const t = (level - kf0.level) / (kf1.level - kf0.level);
    return v0 + (v1 - v0) * t;
  }

  const OP_STATS_ROWS = [
    ["HP", "maxHp", (v) => Math.round(v).toLocaleString()],
    ["ATK", "atk", (v) => Math.round(v).toLocaleString()],
    ["DEF", "def", (v) => Math.round(v).toLocaleString()],
    ["RES", "magicResistance", (v) => Math.round(v) + "%"],
    ["Redeploy Cost (DP)", "cost", (v) => String(Math.round(v))],
    ["Redeploy Time (sec)", "respawnTime", (v) => String(Math.round(v))],
    ["Block", "blockCnt", (v) => String(Math.round(v))],
    ["Attack Interval", "baseAttackTime", (v) => Math.round(v * 100) / 100 + "s"],
  ];

  // potentialRanks' attribute-type codes -> this file's own stat-row
  // keys. Confirmed real shape (via a community mirror of the same game
  // data, since the raw data itself is too large to fetch directly in
  // this environment): a plain numeric potential (type "BUFF") carries
  // `buff.attributes.attributeModifiers[]`, each a flat
  // `{attributeType, formulaItem: "ADDITION", value}` -- a "CUSTOM" rank
  // (e.g. "Improves Talent") has `buff: null` and isn't a stat delta at
  // all, so it's simply skipped here (its effect is already covered by
  // the Talents/Potential upgrades sections above). ATTACK_SPEED is
  // deliberately left unmapped -- turning a percentage attack-speed
  // buff back into a change in displayed Attack Interval needs the
  // game's own frame-rounding formula, which isn't confirmed, so a rare
  // potential that touches it just doesn't show up here rather than
  // risking a wrong number.
  const POTENTIAL_ATTR_TO_STAT_KEY = {
    MAX_HP: "maxHp",
    ATK: "atk",
    DEF: "def",
    MAGIC_RESISTANCE: "magicResistance",
    COST: "cost",
    RESPAWN_TIME: "respawnTime",
  };

  // The default (and, before the "Your stats" toggle existed, only) view
  // on this page assumes max Potential (Potential 6 -- all 5 upgrade
  // ranks applied, same assumption OperatorEditModal's own maxState()
  // makes for the planner/calendar pages). "Your stats" instead caps this
  // at however many ranks the synced account actually has (capRank --
  // potentialRank from the sync, 0-5): passing it in limits how many of
  // potentialRanks' entries get summed, since potentialRanks[i] is
  // exactly the effect of reaching Potential (i+2), so the first capRank
  // entries are the ones actually unlocked. Omitting capRank (the
  // "Maxed" view) keeps the original always-sum-everything behavior.
  function potentialStatBonuses(op, capRank) {
    const totals = {};
    // Guarded the same way as the battle_equip_table.json-sourced fields
    // below (formatDescription()'s comment has the confirmed real-world
    // case) -- character_table.json goes through the same upstream export
    // pipeline, so an empty potentialRanks could plausibly hit the same
    // "{}" -instead-of-"[]" quirk even though it hasn't been directly
    // observed here.
    const ranks = Array.isArray(op.potentialRanks) ? op.potentialRanks : [];
    const limit = typeof capRank === "number" ? Math.max(0, Math.min(capRank, ranks.length)) : ranks.length;
    ranks.slice(0, limit).forEach((rank) => {
      const modifiers = rank && rank.buff && rank.buff.attributes && rank.buff.attributes.attributeModifiers;
      if (!Array.isArray(modifiers)) return;
      modifiers.forEach((mod) => {
        if (!mod || !mod.attributeType || typeof mod.value !== "number") return;
        const key = POTENTIAL_ATTR_TO_STAT_KEY[mod.attributeType];
        if (!key) return;
        totals[key] = (totals[key] || 0) + mod.value;
      });
    });
    return totals;
  }

  // battle_equip_table.json's own snake_case attributeBlackboard keys ->
  // this file's stat-row keys (a sibling of MODULE_STAT_LABELS above,
  // which maps the same keys to a *display* label for the Modules
  // section rather than a row to add onto).
  const MODULE_ATTR_TO_STAT_KEY = {
    max_hp: "maxHp",
    atk: "atk",
    def: "def",
    magic_resistance: "magicResistance",
    res: "magicResistance",
    cost: "cost",
    respawn_time: "respawnTime",
    block_cnt: "blockCnt",
  };

  // A module stage's attributeBlackboard is that stage's *total* bonus,
  // not incremental on top of the stage before it (matches how
  // renderModuleStage() above already treats it) -- so this looks up
  // exactly one phase (by its own equipLevel, not array index, in case a
  // module's phases are ever sparse) rather than summing across stages.
  function moduleStatBonuses(uniEquipId, stage) {
    const totals = {};
    if (!uniEquipId || !stage) return totals;
    const equipData = battleEquipTable[uniEquipId];
    const phases = (equipData && Array.isArray(equipData.phases) && equipData.phases) || [];
    const phase = phases.find((ph) => ph && ph.equipLevel === stage);
    if (!phase) return totals;
    // Same "empty list can come back as {} instead of []" upstream quirk
    // as formatDescription() guards against above -- this isn't wrapped
    // in any try/catch (it runs straight from the Stats section's Module/
    // Stage dropdown's own update callback), so a stage with zero stat
    // deltas used to throw here and break live stat updates entirely
    // rather than just showing a fallback notice.
    (Array.isArray(phase.attributeBlackboard) ? phase.attributeBlackboard : []).forEach((b) => {
      if (!b || !b.key || typeof b.value !== "number") return;
      const key = MODULE_ATTR_TO_STAT_KEY[b.key];
      if (!key) return;
      totals[key] = (totals[key] || 0) + b.value;
    });
    return totals;
  }

  // Rebuilds the Stage dropdown's own options from whichever module is
  // currently selected, rather than assuming every module goes to stage
  // 3 -- real coverage varies, and this way a module missing from
  // battleEquipTable (a fetch gap, or a CN-only one not covered by the
  // best-effort CN merge) just leaves the dropdown at "None" instead of
  // offering stages that don't actually have data.
  function populateStageOptions(stageSelect, uniEquipId) {
    stageSelect.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "0";
    noneOpt.textContent = "None";
    stageSelect.appendChild(noneOpt);
    const equipData = uniEquipId && battleEquipTable[uniEquipId];
    const phases = (equipData && Array.isArray(equipData.phases) && equipData.phases) || [];
    const levels = phases
      .filter((ph) => ph && typeof ph.equipLevel === "number")
      .map((ph) => ph.equipLevel)
      .sort((a, b) => a - b);
    levels.forEach((lvl) => {
      const opt = document.createElement("option");
      opt.value = String(lvl);
      opt.textContent = `Stage ${lvl}`;
      stageSelect.appendChild(opt);
    });
    stageSelect.value = "0";
    stageSelect.disabled = !uniEquipId || !levels.length;
  }

  // An Elite dropdown, a Level slider, and (when the operator has any)
  // a Module + Stage dropdown drive a single live-updating stats column,
  // rather than a fixed E0-vs-max-Elite comparison -- so any level/
  // Elite/module combination can be previewed, not just the two
  // endpoints. Elite only ever has 2-4 discrete options, so it's a
  // dropdown rather than a slider; Level can run to 90, where a slider
  // reads better than a 90-option dropdown.
  function renderStats(op, view, progress) {
    statsInfoEl.innerHTML = "";
    // Same defensive Array.isArray guard as potentialStatBonuses() above, for the same reason.
    const phases = (Array.isArray(op.phases) ? op.phases : []).filter((ph) => ph && ph.attributesKeyFrames && ph.attributesKeyFrames.length);
    if (!phases.length) {
      statsInfoEl.appendChild(textNote("No stats data available."));
      return;
    }

    const owned = view === "owned" && !!progress;
    const potentialBonuses = potentialStatBonuses(
      op,
      owned && typeof progress.potentialRank === "number" ? progress.potentialRank : undefined,
    );
    const modules = (op.modules || []).filter(Boolean);

    const controls = document.createElement("div");
    controls.className = "opStatsControls";

    function buildRow(labelText, extraClass) {
      const row = document.createElement("div");
      row.className = "opStatsSliderRow" + (extraClass ? " " + extraClass : "");
      const label = document.createElement("label");
      label.textContent = labelText;
      row.appendChild(label);
      controls.appendChild(row);
      return row;
    }

    const eliteRow = buildRow("Elite", "opStatsEliteRow");
    const eliteSelect = document.createElement("select");
    eliteSelect.className = "opStatsSelect";
    phases.forEach((ph, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `Elite ${i}`;
      eliteSelect.appendChild(opt);
    });
    eliteSelect.disabled = phases.length <= 1;
    eliteRow.appendChild(eliteSelect);

    const levelRow = buildRow("Level", "opStatsLevelRow");
    const levelSlider = document.createElement("input");
    levelSlider.type = "range";
    levelSlider.className = "opStatsSlider";
    levelSlider.step = "1";
    const levelValue = document.createElement("span");
    levelValue.className = "opStatsSliderValue";
    levelRow.appendChild(levelSlider);
    levelRow.appendChild(levelValue);

    let moduleSelect = null;
    let stageSelect = null;
    if (modules.length) {
      const moduleRow = buildRow("Module", "opStatsModuleRow");
      moduleSelect = document.createElement("select");
      moduleSelect.className = "opStatsSelect";
      const noneOpt = document.createElement("option");
      noneOpt.value = "";
      noneOpt.textContent = "None";
      moduleSelect.appendChild(noneOpt);
      modules.forEach((mod) => {
        const opt = document.createElement("option");
        opt.value = mod.uniEquipId || "";
        opt.textContent = mod.typeName2 ? `${mod.typeName2} — ${mod.uniEquipName || ""}` : mod.uniEquipName || mod.uniEquipId || "Module";
        moduleSelect.appendChild(opt);
      });
      moduleRow.appendChild(moduleSelect);

      const stageRow = buildRow("Stage", "opStatsStageRow");
      stageSelect = document.createElement("select");
      stageSelect.className = "opStatsSelect";
      populateStageOptions(stageSelect, "");
      stageRow.appendChild(stageSelect);
    }

    const note = document.createElement("div");
    note.className = "opStatsNote";
    note.textContent = owned
      ? "Showing your synced Elite/level/potential/module progress. Adjust any control above to preview a different state."
      : modules.length
      ? "Stats assume max Potential (6). Pick a module and stage above to add its stat bonus too."
      : "Stats assume max Potential (6).";
    controls.appendChild(note);

    statsInfoEl.appendChild(controls);

    const table = document.createElement("table");
    table.className = "opStatsTable";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const headBlank = document.createElement("th");
    const headValue = document.createElement("th");
    headRow.appendChild(headBlank);
    headRow.appendChild(headValue);
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const valueCells = OP_STATS_ROWS.map(([label]) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = label;
      const td = document.createElement("td");
      tr.appendChild(th);
      tr.appendChild(td);
      tbody.appendChild(tr);
      return td;
    });
    table.appendChild(tbody);
    statsInfoEl.appendChild(table);

    // "Maxed" (the default, and the only option before this toggle
    // existed): max Elite, max level, no module equipped. "Your stats":
    // this operator's actual synced Elite phase/level, clamped into
    // whatever range is valid here in case the synced snapshot is stale
    // (e.g. a level recorded before a since-released Elite phase raised
    // the level cap).
    let eliteIdx = phases.length - 1;
    if (owned && typeof progress.evolvePhase === "number") {
      eliteIdx = Math.max(0, Math.min(progress.evolvePhase, phases.length - 1));
    }
    let level = phases[eliteIdx].attributesKeyFrames[phases[eliteIdx].attributesKeyFrames.length - 1].level;
    if (owned && typeof progress.level === "number") {
      const kfs0 = phases[eliteIdx].attributesKeyFrames;
      level = Math.max(kfs0[0].level, Math.min(progress.level, kfs0[kfs0.length - 1].level));
    }

    // "Your stats" also starts the Module/Stage dropdowns on whichever
    // module is actually equipped (Arknights only applies one module's
    // effect at a time, even when several are leveled up -- see
    // cloudflare/depot-import.js's extractOwnedOperatorProgress()
    // comment on `currentEquip`), at the stage it's actually reached.
    if (owned && moduleSelect && progress.currentEquip) {
      const equipped = modules.find((m) => m.uniEquipId === progress.currentEquip);
      if (equipped) {
        moduleSelect.value = equipped.uniEquipId;
        populateStageOptions(stageSelect, equipped.uniEquipId);
        const reached = progress.modules && progress.modules[equipped.uniEquipId];
        if (reached && stageSelect.querySelector(`option[value="${reached}"]`)) {
          stageSelect.value = String(reached);
        }
      }
    }

    function update() {
      const kfs = phases[eliteIdx].attributesKeyFrames;
      const kf0 = kfs[0];
      const kf1 = kfs[kfs.length - 1];
      level = Math.min(Math.max(level, kf0.level), kf1.level);

      eliteSelect.value = String(eliteIdx);
      levelSlider.min = String(kf0.level);
      levelSlider.max = String(kf1.level);
      levelSlider.disabled = kf1.level === kf0.level;
      levelSlider.value = String(level);
      levelValue.textContent = `Lv${level}`;
      headValue.textContent = `Elite ${eliteIdx}, Lv${level}`;

      const modBonuses = moduleSelect ? moduleStatBonuses(moduleSelect.value, parseInt(stageSelect.value, 10)) : {};

      OP_STATS_ROWS.forEach(([, key, fmt], i) => {
        let v = interpolateStat(kf0, kf1, level, key);
        if (v != null) {
          if (potentialBonuses[key]) v += potentialBonuses[key];
          if (modBonuses[key]) v += modBonuses[key];
        }
        valueCells[i].textContent = v == null ? "—" : fmt(v);
      });
    }

    eliteSelect.addEventListener("change", () => {
      eliteIdx = parseInt(eliteSelect.value, 10);
      update();
    });
    levelSlider.addEventListener("input", () => {
      level = parseInt(levelSlider.value, 10);
      update();
    });
    if (moduleSelect) {
      moduleSelect.addEventListener("change", () => {
        populateStageOptions(stageSelect, moduleSelect.value);
        update();
      });
      stageSelect.addEventListener("change", update);
    }

    update();
  }

  function renderTalents(op) {
    talentsInfoEl.innerHTML = "";
    // Same defensive Array.isArray guard as potentialStatBonuses() above, for the same reason.
    const talents = (Array.isArray(op.talents) ? op.talents : []).filter((t) => t && t.candidates && t.candidates.length);
    if (!talents.length) {
      talentsInfoEl.appendChild(textNote("No talents."));
      return;
    }
    talents.forEach((talent, i) => {
      const candidates = talent.candidates;
      const block = document.createElement("div");
      block.className = "opTalentBlock";
      const heading = document.createElement("div");
      heading.className = "opTalentHeading";
      heading.textContent = candidates[candidates.length - 1].name || `Talent ${i + 1}`;
      block.appendChild(heading);
      candidates.forEach((cand) => {
        const row = document.createElement("div");
        row.className = "opTalentCandidate";
        const unlock = document.createElement("div");
        unlock.className = "opTalentUnlock";
        const parts = [];
        const phaseNum = phaseNumber(cand.unlockCondition && cand.unlockCondition.phase);
        if (phaseNum != null) parts.push(`Elite ${phaseNum}`);
        if (cand.unlockCondition && cand.unlockCondition.level) parts.push(`Lv${cand.unlockCondition.level}`);
        if (cand.requiredPotentialRank) parts.push(`Potential ${cand.requiredPotentialRank + 1}`);
        unlock.textContent = parts.join(" · ") || "Base";
        row.appendChild(unlock);
        const desc = document.createElement("div");
        desc.className = "opTalentDescription";
        desc.textContent = formatDescription(cand.description, cand.blackboard);
        row.appendChild(desc);
        block.appendChild(row);
      });
      talentsInfoEl.appendChild(block);
    });
  }

  function renderPotentials(op, view, progress) {
    potentialsInfoEl.innerHTML = "";
    const ranks = op.potentialRanks || [];
    if (!ranks.length) {
      potentialsInfoEl.appendChild(textNote("No potential upgrades."));
      return;
    }
    // "Your stats": grey out (not hide -- same convention as the browse
    // grid's owned/not-owned filter) any rank beyond the account's actual
    // potentialRank, since potentialRanks[i] is the rank reached at
    // Potential (i+2) -- see potentialStatBonuses()'s own comment above.
    const unlockedCount =
      view === "owned" && progress && typeof progress.potentialRank === "number" ? progress.potentialRank : null;
    ranks.forEach((rank, i) => {
      const row = document.createElement("div");
      row.className = "opPotentialRow";
      if (unlockedCount != null && i >= unlockedCount) row.classList.add("opValueLocked");
      const label = document.createElement("span");
      label.className = "opPotentialLabel";
      label.textContent = `Potential ${i + 2}`;
      const desc = document.createElement("span");
      desc.className = "opPotentialDescription";
      desc.textContent = rank.description || "";
      row.appendChild(label);
      row.appendChild(desc);
      potentialsInfoEl.appendChild(row);
    });
  }

  // Skill icons use skill_table.json's own iconId when the skill has one
  // (not every skill does -- some reuse a generic icon keyed by the skill
  // id itself), same "LOCAL mirror, fall back to Aceship, then hide"
  // pattern as setAvatarIcon() in util.js, just without that one's
  // cnOnly-specific placeholder (a missing skill icon isn't a
  // not-yet-released signal the way a missing operator portrait is).
  function setSkillIcon(imgEl, iconKey) {
    setIconWithFallback(imgEl, uri_skill(iconKey), uri_skill(iconKey, ASSET_SOURCE.ACESHIP), false);
  }

  function skillLevelLabel(i) {
    return i < 7 ? `Lv${i + 1}` : `M${i - 6}`;
  }

  // One range slider per skill, Lv1 through M3 (indices 0-9, or 0-6 for a
  // non-masterable skill), rather than a fixed list of every level at
  // once -- mirrors the Elite/Level sliders in renderStats() above, and
  // keeps a 10-level masterable skill from dominating the page.
  function renderSkills(op, view, progress) {
    skillsInfoEl.innerHTML = "";
    const refs = Array.isArray(op.skills) ? op.skills : [];
    if (!refs.length) {
      skillsInfoEl.appendChild(textNote("No skills."));
      return;
    }

    // "Your stats": the account's overall Skill Level (1-7, shared by
    // every skill slot until it reaches 7) plus, once it has, each
    // skill's own independent mastery rank (specializeLevel, 0-3) --
    // matched by skillId rather than array position, in case the synced
    // `skills` order ever doesn't line up with this operator's own
    // `op.skills` order. See skillLevelLabel() above for how a slider
    // index maps back to "Lv<n>"/"M<n>".
    const owned = view === "owned" && !!progress;
    const mainSkillLvl = owned && typeof progress.mainSkillLvl === "number" ? progress.mainSkillLvl : null;
    const specializeBySkillId = {};
    if (owned && Array.isArray(progress.skills)) {
      progress.skills.forEach((s) => {
        if (s && s.skillId) specializeBySkillId[s.skillId] = s.specializeLevel || 0;
      });
    }

    refs.forEach((ref, idx) => {
      const data = skillTable[ref.skillId];
      const levels = data && data.levels;
      const block = document.createElement("div");
      block.className = "opSkillBlock";

      const heading = document.createElement("div");
      heading.className = "opSkillHeading";
      const icon = document.createElement("img");
      icon.className = "opSkillIcon";
      icon.alt = "";
      setSkillIcon(icon, (data && data.iconId) || ref.skillId);
      heading.appendChild(icon);
      const nameEl = document.createElement("span");
      nameEl.textContent = (levels && levels[0] && levels[0].name) || `Skill ${idx + 1}`;
      heading.appendChild(nameEl);
      block.appendChild(heading);

      if (!levels || !levels.length) {
        block.appendChild(textNote("Skill data not available."));
        skillsInfoEl.appendChild(block);
        return;
      }

      const sliderRow = document.createElement("div");
      sliderRow.className = "opStatsSliderRow opSkillSliderRow";
      const sliderLabel = document.createElement("label");
      sliderLabel.textContent = "Level";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "opStatsSlider";
      slider.min = "0";
      slider.max = String(levels.length - 1);
      slider.step = "1";
      slider.disabled = levels.length <= 1;
      const sliderValue = document.createElement("span");
      sliderValue.className = "opStatsSliderValue";
      sliderRow.appendChild(sliderLabel);
      sliderRow.appendChild(slider);
      sliderRow.appendChild(sliderValue);
      block.appendChild(sliderRow);

      const detail = document.createElement("div");
      detail.className = "opSkillLevelDetail";
      const spEl = document.createElement("div");
      spEl.className = "opSkillLevelSp";
      const descEl = document.createElement("div");
      descEl.className = "opSkillLevelDescription";
      detail.appendChild(spEl);
      detail.appendChild(descEl);
      block.appendChild(detail);

      function update(i) {
        slider.value = String(i);
        sliderValue.textContent = skillLevelLabel(i);
        sliderValue.classList.toggle("opSkillSliderValueMastery", i >= 7);
        const lvl = levels[i];
        const sp = (lvl && lvl.spData) || {};
        const spParts = [];
        if (sp.spCost != null) spParts.push(`${sp.spCost} SP`);
        if (sp.initSp) spParts.push(`${sp.initSp} initial`);
        spEl.textContent = spParts.join(", ");
        descEl.textContent = lvl ? formatDescription(lvl.description, lvl.blackboard) : "";
      }

      slider.addEventListener("input", () => update(parseInt(slider.value, 10)));

      // "Maxed" defaults to the highest mastery rank, same "show the
      // best state first" default as the stats sliders above. "Your
      // stats" instead defaults to this skill's actual Lv/mastery --
      // below Skill Level 7, every skill shares the same level; at 7,
      // each skill's own mastery rank (0 if none yet) takes over, per
      // skillLevelLabel()'s Lv1-7/M1-3 indexing.
      let defaultIndex = levels.length - 1;
      if (mainSkillLvl != null) {
        defaultIndex =
          mainSkillLvl < 7
            ? Math.min(mainSkillLvl - 1, levels.length - 1)
            : Math.min(6 + (specializeBySkillId[ref.skillId] || 0), levels.length - 1);
      }
      update(defaultIndex);
      skillsInfoEl.appendChild(block);
    });
  }

  // A module's own uniEquipName/uniEquipDesc is just a one-line flavor
  // blurb -- the real per-stage effects (both flat stat bonuses and any
  // talent/trait text) live in battle_equip_table.json, keyed by the same
  // uniEquipId, one entry per equip stage (1-3). A stage can carry either
  // kind of effect, both, or (rarely) neither beyond its stat bump, so
  // each stage's effect list is built up from whatever's actually there
  // rather than assuming a fixed shape.
  function renderModuleStage(phase) {
    const stage = document.createElement("div");
    stage.className = "opModuleStage";
    const heading = document.createElement("div");
    heading.className = "opModuleStageHeading";
    heading.textContent = `Stage ${phase.equipLevel}`;
    stage.appendChild(heading);

    // Same "{}" -instead-of-"[]" upstream quirk as formatDescription() and
    // moduleStatBonuses() guard against (see their comments) -- a stage
    // with no stat deltas at all can come back this way too.
    const deltas = (Array.isArray(phase.attributeBlackboard) ? phase.attributeBlackboard : []).filter((b) => b && b.key && b.value);
    if (deltas.length) {
      const statsLine = document.createElement("div");
      statsLine.className = "opModuleStageStats";
      statsLine.textContent = deltas
        .map((b) => `${moduleStatLabel(b.key)} ${formatModuleStatDelta(b.key, b.value)}`)
        .join(", ");
      stage.appendChild(statsLine);
    }

    // Real battle_equip_table.json data isn't as uniform as the examples
    // used to build this against -- a part can be null, a bundle can be
    // present with candidates missing or not actually an array, and so
    // on. Every level here is guarded so one oddly-shaped part only
    // skips that one part rather than throwing and (since this runs
    // inside the modules.forEach in renderModules(), and a thrown error
    // there aborts the whole loop after modulesInfoEl was already
    // cleared) silently blanking the entire Modules section.
    // "{}" -instead-of-"[]" again for a stage with no parts at all (see
    // formatDescription()'s comment above for where this upstream
    // serialization quirk was actually confirmed).
    (Array.isArray(phase.parts) ? phase.parts : []).forEach((part) => {
      if (!part) return;
      [part.addOrOverrideTalentDataBundle, part.overrideTraitDataBundle].forEach((bundle) => {
        const candidates = bundle && bundle.candidates;
        if (!Array.isArray(candidates)) return;
        candidates.forEach((cand) => {
          if (!cand) return;
          // A TRAIT-override candidate (Stage 1's usual part -- see
          // overrideTraitDataBundle above) carries its text in
          // "overrideDescripton" (sic -- that's really how the field is
          // spelled in the upstream game data, confirmed against several
          // real modules) whenever the module fully replaces the base
          // trait text rather than just appending to it; "additionalDescription"
          // is used instead when it's phrased as an addition. Both keys
          // are present on these objects with one of them null, so this
          // has to check all four fields -- without "overrideDescripton"
          // here, a module whose Stage 1 uses that field (e.g. Mountain's
          // own modules) shows nothing but its stat line, same bug this
          // comment is fixing.
          const text = cand.description || cand.upgradeDescription || cand.additionalDescription || cand.overrideDescripton;
          if (!text) return;
          const effect = document.createElement("div");
          effect.className = "opModuleStageEffect";
          effect.textContent = formatDescription(text, cand.blackboard);
          stage.appendChild(effect);
        });
      });
    });

    return stage;
  }

  function renderModules(op, view, progress) {
    modulesInfoEl.innerHTML = "";
    const modules = (op.modules || []).filter(Boolean);
    if (!modules.length) {
      modulesInfoEl.appendChild(textNote("No modules."));
      return;
    }
    const owned = view === "owned" && !!progress;
    modules.forEach((mod) => {
      // Each module is rendered independently and defensively -- real
      // battle_equip_table.json data has more shape variance than any
      // handful of examples can cover, and one module failing to parse
      // should never take the rest of this section down with it (see the
      // comment in renderModuleStage() above for the failure mode this
      // guards against).
      try {
        const row = document.createElement("div");
        row.className = "opModuleRow";
        const heading = document.createElement("div");
        heading.className = "opModuleHeading";
        if (mod.typeName2) {
          const code = document.createElement("span");
          code.className = "opModuleCode";
          code.textContent = mod.typeName2;
          heading.appendChild(code);
        }
        const name = document.createElement("span");
        name.className = "opModuleName";
        name.textContent = mod.uniEquipName || "";
        heading.appendChild(name);

        // "Your stats": Arknights only applies one module's effect at a
        // time even when several are leveled up (see this file's own
        // renderStats() comment on `currentEquip`) -- flagging which one
        // here avoids the Stage greying-out below (which is purely about
        // level reached) being mistaken for "this one's active".
        if (owned && progress.currentEquip && progress.currentEquip === mod.uniEquipId) {
          const badge = document.createElement("span");
          badge.className = "opModuleEquippedBadge";
          badge.textContent = "Equipped";
          heading.appendChild(badge);
        }

        // The flavor-text description (uniEquipDesc) is lore, not
        // gameplay-relevant numbers -- those live in the per-stage
        // effects below, which stay visible. Collapsed by default so a
        // module with several stages doesn't push them below the fold
        // just to show a sentence of flavor text; a small toggle arrow
        // (pushed to the far right of the heading row via CSS's
        // margin-left: auto) reveals it on demand.
        if (mod.uniEquipDesc) {
          const desc = document.createElement("div");
          desc.className = "opModuleDescription hidden";
          desc.textContent = formatDescription(mod.uniEquipDesc, null);

          const loreToggle = document.createElement("button");
          loreToggle.type = "button";
          loreToggle.className = "opModuleLoreToggle";
          loreToggle.textContent = "▾"; // ▾
          loreToggle.setAttribute("aria-expanded", "false");
          loreToggle.setAttribute("aria-label", "Show module lore");
          loreToggle.addEventListener("click", () => {
            const isHidden = desc.classList.toggle("hidden");
            const expanded = !isHidden;
            loreToggle.textContent = expanded ? "▴" : "▾"; // ▴ : ▾
            loreToggle.setAttribute("aria-expanded", String(expanded));
            loreToggle.setAttribute("aria-label", expanded ? "Hide module lore" : "Show module lore");
          });
          heading.appendChild(loreToggle);

          row.appendChild(heading);
          row.appendChild(desc);
        } else {
          row.appendChild(heading);
        }

        const equipData = battleEquipTable[mod.uniEquipId];
        const phases = (equipData && Array.isArray(equipData.phases) && equipData.phases) || [];
        if (phases.length) {
          const stageList = document.createElement("div");
          stageList.className = "opModuleStageList";
          // "Your stats": grey out (not hide) any stage beyond what the
          // account has actually reached for this module -- a module
          // never unlocked at all (not in progress.modules) greys out
          // every stage, same as `reached` defaulting to 0 everywhere
          // else on this page.
          const reached = owned && progress.modules ? progress.modules[mod.uniEquipId] || 0 : null;
          phases.forEach((phase) => {
            if (!phase) return;
            const stageEl = renderModuleStage(phase);
            if (reached != null && phase.equipLevel > reached) stageEl.classList.add("opValueLocked");
            stageList.appendChild(stageEl);
          });
          row.appendChild(stageList);
        }

        modulesInfoEl.appendChild(row);
      } catch (err) {
        console.warn("Couldn't render module", mod && mod.uniEquipId, err);
        const fallback = document.createElement("div");
        fallback.className = "opModuleRow";
        fallback.appendChild(textNote(`${(mod && mod.uniEquipName) || "A module"} (couldn't load full details).`));
        modulesInfoEl.appendChild(fallback);
      }
    });
  }

  // "Add to planner" -- same add-then-open sequence (and the same reason
  // for deferring the button's own label refresh to onClose rather than
  // updating it synchronously right after adding) as calendar.js's
  // openOperatorModalFromChip(): see that function's header comment for
  // the microtask-timing race this sidesteps. There's no sibling panel
  // to worry about losing here, but it costs nothing to stay consistent.
  function refreshAddToPlannerButton(op) {
    const roster = getPref("planner", "roster", [], (v) => Array.isArray(v));
    const inPlanner = roster.some((e) => e && e.charId === op.charId);
    addToPlannerBtn.textContent = inPlanner ? "✓ In planner (click to edit)" : "+ Add to planner";
    addToPlannerBtn.classList.toggle("inPlanner", inPlanner);
  }

  // A brand-new roster entry's "current" state, from the account's
  // synced progress rather than OperatorEditModal.defaultState()'s fixed
  // E0/Lv1 -- so "Add to planner" on an operator you actually own starts
  // the roster card from where you really are instead of from scratch.
  // Mirrors OperatorEditModal's own private clampState()/maxMastery()
  // math (see that file's header comment for why it keeps its own copy
  // of this rather than this file reaching into its scope) since none of
  // that is exported -- deliberately defensive the same way: an
  // out-of-range or missing field just falls back to that field's own
  // "nothing yet" value rather than producing an invalid state the modal
  // can't render.
  function stateFromProgress(op, progress) {
    const maxPhaseVal = OperatorEditModal.maxPhase(op);
    const phase = typeof progress.evolvePhase === "number" ? Math.max(0, Math.min(progress.evolvePhase, maxPhaseVal)) : 0;
    const phaseData = Array.isArray(op.phases) && op.phases[phase];
    const maxLevel = phaseData && phaseData.maxLevel ? phaseData.maxLevel : 1;
    const level = typeof progress.level === "number" ? Math.max(1, Math.min(progress.level, maxLevel)) : 1;
    const hasSkills = OperatorEditModal.hasSkills(op);
    const skillLevel =
      hasSkills && typeof progress.mainSkillLvl === "number" ? Math.max(1, Math.min(progress.mainSkillLvl, 7)) : 1;

    const specializeBySkillId = {};
    if (Array.isArray(progress.skills)) {
      progress.skills.forEach((s) => {
        if (s && s.skillId) specializeBySkillId[s.skillId] = s.specializeLevel || 0;
      });
    }
    const mastery = {};
    (op.skills || []).forEach((ref, idx) => {
      const cap = ref && ref.levelUpCostCond ? ref.levelUpCostCond.length : 0;
      if (!cap) return;
      mastery[idx] = Math.max(0, Math.min(specializeBySkillId[ref.skillId] || 0, cap));
    });

    const modules = {};
    (op.modules || []).forEach((mod) => {
      const v = (progress.modules && progress.modules[mod.uniEquipId]) || 0;
      modules[mod.uniEquipId] = Math.max(0, Math.min(v, 3));
    });

    return { phase, level, skillLevel, mastery, modules };
  }

  addToPlannerBtn.addEventListener("click", () => {
    const op = charTable && charTable[currentCharId];
    if (!op) return;
    let roster = getPref("planner", "roster", [], (v) => Array.isArray(v));
    let entry = roster.find((e) => e && e.charId === op.charId);
    if (!entry) {
      entry = {
        charId: op.charId,
        current: currentIsOwned && currentProgress ? stateFromProgress(op, currentProgress) : OperatorEditModal.defaultState(),
        target: OperatorEditModal.defaultTargetState(op),
      };
      roster = roster.concat([entry]);
      setPref("planner", "roster", roster);
    }
    OperatorEditModal.open(op, entry, {
      onChange: () => setPref("planner", "roster", roster),
      onRemove: () => {
        roster = roster.filter((e) => e !== entry);
        setPref("planner", "roster", roster);
        OperatorEditModal.close();
      },
      onClose: () => refreshAddToPlannerButton(op),
    });
  });

  // Re-renders exactly the four sections the "Maxed"/"Your stats" toggle
  // affects -- Release and Talents don't depend on it (a talent's own
  // unlock conditions are shown as plain text either way, not a live
  // preview), so they're left out of both this and renderOperator()'s
  // own full-page render below.
  function renderStatDependentSections(op) {
    const view = effectiveView();
    renderStats(op, view, currentProgress);
    renderPotentials(op, view, currentProgress);
    renderSkills(op, view, currentProgress);
    renderModules(op, view, currentProgress);
  }

  function renderOperator(charId) {
    // A skin preview from the previously-viewed operator (switching
    // operators in place, without a real navigation, is how the
    // jump-search/grid/"released alongside" links all work here) would
    // otherwise keep showing that operator's art over this one's page.
    hideSkinPreview();
    currentCharId = charId;
    const op = charId ? charTable[charId] : null;
    if (!op) {
      contentEl.classList.add("hidden");
      if (charId) {
        // A bad/unknown "?id=" -- show the error in place of the browse
        // grid rather than alongside it.
        browseEl.classList.add("hidden");
        statusEl.classList.remove("hidden");
        statusEl.textContent = `Couldn't find an operator with id "${charId}".`;
      } else {
        // Landing state: no operator picked yet -- show the full
        // browsable grid instead of a bare prompt.
        statusEl.classList.add("hidden");
        browseEl.classList.remove("hidden");
      }
      document.title = "Arknights Operator Details";
      return;
    }

    statusEl.classList.add("hidden");
    browseEl.classList.add("hidden");
    contentEl.classList.remove("hidden");
    document.title = `${op.name} – Arknights Operator Details`;

    setAvatarIcon(iconEl, charId, op.cnOnly);
    nameEl.textContent = op.name;
    nameEl.parentNode.querySelectorAll(".cnBadge").forEach((el) => el.remove());
    if (op.cnOnly) nameEl.insertAdjacentElement("afterend", buildCnBadge(op));

    rarityBadgeEl.textContent = (op.rarity + 1) + "★";
    classBadgeEl.textContent = op.profession || "";
    subclassBadgeEl.textContent = SUBCLASS_NAMES[op.subProfessionId] || humanizeId(op.subProfessionId);
    const factionId = op.nationId || op.groupId || op.teamId;
    factionBadgeEl.textContent = FACTION_NAMES[factionId] || humanizeId(factionId);
    factionBadgeEl.classList.toggle("hidden", !factionId);

    const isKernel = op.classicPotentialItemId != null;
    let poolClass = "opPoolStandard";
    let poolLabel = "Standard pool";
    if (isKernel) {
      poolClass = "opPoolKernel";
      poolLabel = "Kernel pool";
    } else if (op.isLimited) {
      poolClass = "opPoolLimited";
      poolLabel = "Limited pool";
    } else if (op.notInGachaPool) {
      // Set by operator_online.py's scrape_PRTS() when PRTS wiki's own
      // obtainMethod data for this operator doesn't contain ANY of the
      // standard/kernel/limited/collab gacha-pool keywords -- in practice
      // almost always an operator who was only ever given out through a
      // past event's activity rewards/shop, never through any actual
      // gacha banner. This used to silently fall through to "Standard
      // pool" (the unconditional default below) for lack of any other
      // category, which is what was actually being reported as wrong.
      poolClass = "opPoolEvent";
      poolLabel = "Event-obtained";
    }
    poolBadgeEl.textContent = poolLabel;
    poolBadgeEl.className = "opBadge opPoolBadge " + poolClass;

    const ownedSet = getOwnedSet();
    currentIsOwned = !!(ownedSet && ownedSet.has(op.charId));
    currentProgress = currentIsOwned ? getAccountProgress(op.charId) : null;
    updateStatsViewToggle();
    renderOwnedSummary(op);

    renderReleaseInfo(op);
    renderSkins(op);
    renderTalents(op);
    renderStatDependentSections(op);
    refreshAddToPlannerButton(op);

    const params = new URLSearchParams(location.search);
    if (params.get("id") !== charId) {
      params.set("id", charId);
      history.replaceState(null, "", "?" + params.toString());
    }
    jumpInput.value = "";
    renderJumpResults([]);
    window.scrollTo({ top: 0 });
  }

  // --- browsable grid (landing state) -------------------------------------
  // The whole roster as individual boxes -- portrait, name, and a border/
  // label tinted by rarity (see the opRarity1-6 classes in operator-
  // extra.css) -- with a class/rarity filter and a sort order, shown in
  // place of the old bare "search for an operator above" prompt. The jump
  // search box above stays a separate, independent quick-jump; this is a
  // browse-everything view for when you don't already know who you're
  // looking for.

  // Canonical in-game class ordering (Vanguard first, as in the game's own
  // deploy-list ordering) -- anything unrecognized just sorts after these,
  // alphabetically, rather than being dropped.
  const CLASS_ORDER = ["Vanguard", "Guard", "Defender", "Sniper", "Caster", "Medic", "Supporter", "Specialist"];
  function classSortKey(cls) {
    const i = CLASS_ORDER.indexOf(cls);
    return i === -1 ? CLASS_ORDER.length : i;
  }

  function populateGridFilters() {
    const classes = Array.from(new Set(operatorList.map((op) => op.profession).filter(Boolean))).sort(
      (a, b) => classSortKey(a) - classSortKey(b) || a.localeCompare(b),
    );
    classes.forEach((cls) => {
      const opt = document.createElement("option");
      opt.value = cls;
      opt.textContent = cls;
      classFilterEl.appendChild(opt);
    });
    for (let r = 6; r >= 1; r--) {
      const opt = document.createElement("option");
      opt.value = String(r);
      opt.textContent = `${r}★`;
      rarityFilterEl.appendChild(opt);
    }
  }

  // Ascending by EN release date (oldest first), with operators that
  // have no onlineTime yet (CN-only, not yet released on EN) sorted to
  // the end rather than clumped at the start the way a missing/zero
  // timestamp would sort by default. Shared by the standalone "Release
  // date" sort option and as the rarity sort's tie-break, so both read
  // the same way once release date enters the picture.
  function compareByReleaseDate(a, b) {
    // onlineTime arrives as a "YYYY-MM-DD HH:MM:SS"-style string (see
    // fmtDate() above, which parses it the same way) rather than an
    // already-numeric timestamp, so it needs `new Date(...)` before it's
    // comparable at all -- a bare `a.onlineTime - b.onlineTime` would
    // just be NaN - NaN for every pair. An unparseable or missing value
    // sorts to the end, same as a release-date-less operator being
    // excluded from "Not yet released on EN" elsewhere on this page.
    const at = a.onlineTime ? new Date(a.onlineTime).getTime() : NaN;
    const bt = b.onlineTime ? new Date(b.onlineTime).getTime() : NaN;
    const aVal = isNaN(at) ? Infinity : at;
    const bVal = isNaN(bt) ? Infinity : bt;
    if (aVal !== bVal) return aVal - bVal;

    // Tied on Global release date -- in practice almost always because
    // *neither* has a confirmed one yet (both Infinity), which used to
    // fall straight to alphabetical for that entire group. An
    // operator's CN release always lands before its eventual Global
    // one and tends to be tracked well before Global is confirmed (see
    // operator_release_dates.json's own two-source build in
    // akgcc-extra-data/operator_online.py), so preferring it here still
    // gives this trailing group a real chronological order instead of
    // none at all -- an operator with at least a known CN date sorts
    // ahead of one with no known date whatsoever.
    const acn = a.cnOnlineTime ? new Date(a.cnOnlineTime).getTime() : NaN;
    const bcn = b.cnOnlineTime ? new Date(b.cnOnlineTime).getTime() : NaN;
    const acnVal = isNaN(acn) ? Infinity : acn;
    const bcnVal = isNaN(bcn) ? Infinity : bcn;
    return acnVal - bcnVal || a.name.localeCompare(b.name);
  }

  // Owned/not-owned reads AccountSync's synced roster (see
  // js/account-sync.js and cloudflare/depot-import.js's
  // extractOwnedOperators()) fresh on every render rather than being
  // cached, so syncing a different account or re-syncing on the home
  // page shows up here the next time this page (re)renders without
  // needing its own change-detection. Returns null -- not an empty Set
  // -- when there's no roster to check against, so renderGrid() can
  // tell "nothing's owned" apart from "we don't know" and leave the
  // grid alone rather than greying every operator out on missing data.
  function getOwnedSet() {
    const owned = typeof AccountSync !== "undefined" ? AccountSync.getOwnedOperators() : null;
    return owned ? new Set(owned) : null;
  }

  function renderGrid() {
    gridEl.innerHTML = "";
    const classVal = classFilterEl.value;
    const rarityVal = rarityFilterEl.value;
    const ownedVal = ownedFilterEl.value; // "", "owned", or "unowned"
    let list = operatorList.filter((op) => {
      if (classVal && op.profession !== classVal) return false;
      if (rarityVal && String(op.rarity + 1) !== rarityVal) return false;
      return true;
    });
    if (sortByEl.value === "rarity") {
      list = list.slice().sort((a, b) => b.rarity - a.rarity || compareByReleaseDate(a, b));
    } else if (sortByEl.value === "release") {
      list = list.slice().sort(compareByReleaseDate);
    } // else already name-sorted, same order operatorList itself is built in

    const ownedSet = ownedVal ? getOwnedSet() : null;
    // Only worth telling the user to go sync when they've actually
    // asked for the owned/not-owned filter and there's nothing to check
    // against -- silent the rest of the time.
    ownedFilterHintEl.classList.toggle("hidden", !(ownedVal && !ownedSet));

    if (!list.length) {
      gridEl.appendChild(textNote("No operators match these filters."));
      return;
    }

    list.forEach((op) => {
      const item = document.createElement("a");
      item.className = `opGridItem opRarity${op.rarity + 1}`;
      item.href = `?id=${encodeURIComponent(op.charId)}`;
      item.onclick = (e) => {
        e.preventDefault();
        renderOperator(op.charId);
      };

      // Greyed out, not removed, when it's on the "wrong" side of the
      // owned/not-owned filter -- per how this filter's meant to work,
      // the point is to see where an operator sits at a glance, not to
      // lose track of the grid's overall shape by hiding half of it.
      if (ownedSet) {
        const owned = ownedSet.has(op.charId);
        const greyedOut = (ownedVal === "owned" && !owned) || (ownedVal === "unowned" && owned);
        if (greyedOut) item.classList.add("opGreyedOut");
      }

      const imgWrap = document.createElement("div");
      imgWrap.className = "opGridItemImgWrap";
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      setAvatarIcon(img, op.charId, op.cnOnly);
      imgWrap.appendChild(img);
      item.appendChild(imgWrap);

      const nameEl2 = document.createElement("div");
      nameEl2.className = "opGridItemName";
      nameEl2.textContent = op.name;
      item.appendChild(nameEl2);

      gridEl.appendChild(item);
    });
  }

  classFilterEl.addEventListener("change", renderGrid);
  rarityFilterEl.addEventListener("change", renderGrid);
  ownedFilterEl.value = getPref("operator", "ownedFilter", "", (v) => v === "" || v === "owned" || v === "unowned");
  ownedFilterEl.addEventListener("change", () => {
    setPref("operator", "ownedFilter", ownedFilterEl.value);
    renderGrid();
  });
  sortByEl.value = getPref("operator", "sortBy", sortByEl.value, (v) => v === "name" || v === "rarity" || v === "release");
  sortByEl.addEventListener("change", () => {
    setPref("operator", "sortBy", sortByEl.value);
    renderGrid();
  });

  // Skin gallery's own "grey out skins you don't own" toggle -- see the
  // greyUnownedSkins/ownedSkinIdSet comment above. Only shown (and only
  // ever listened on) when there's actually a synced skin-ownership list
  // to grey against.
  if (hasOwnedSkinData) {
    skinsUnownedToggleEl.classList.remove("hidden");
  }
  skinsUnownedToggleInputEl.checked = greyUnownedSkins;
  skinsUnownedToggleInputEl.addEventListener("change", () => {
    greyUnownedSkins = skinsUnownedToggleInputEl.checked;
    setPref("operator", "greyUnownedSkins", greyUnownedSkins);
    if (currentCharId && charTable && charTable[currentCharId]) {
      renderSkins(charTable[currentCharId]);
    }
  });

  // --- jump-to-operator search (mirrors planner.js's own operator
  // search box -- same markup/behavior, but selecting a result re-renders
  // this page in place instead of adding a roster entry) -------------------

  function renderJumpResults(results) {
    jumpResults = results;
    jumpHighlighted = results.length ? 0 : -1;
    jumpResultsEl.innerHTML = "";
    if (!results.length) {
      jumpResultsEl.classList.add("hidden");
      return;
    }
    results.forEach((op, i) => {
      const row = document.createElement("div");
      row.className = "operatorSearchResult" + (i === jumpHighlighted ? " highlighted" : "");
      const icon = document.createElement("img");
      icon.className = "operatorSearchResultIcon";
      setAvatarIcon(icon, op.charId, op.cnOnly);
      icon.alt = "";
      const name = document.createElement("span");
      name.className = "operatorSearchResultName";
      name.textContent = op.name;
      const rarity = document.createElement("span");
      rarity.className = "operatorSearchResultRarity";
      rarity.textContent = (op.rarity + 1) + "★";
      row.appendChild(icon);
      row.appendChild(name);
      if (op.cnOnly) row.appendChild(buildCnBadge(op));
      row.appendChild(rarity);
      row.onclick = () => renderOperator(op.charId);
      jumpResultsEl.appendChild(row);
    });
    jumpResultsEl.classList.remove("hidden");
  }

  function updateJumpHighlight() {
    Array.from(jumpResultsEl.children).forEach((el, i) => el.classList.toggle("highlighted", i === jumpHighlighted));
  }

  jumpInput.addEventListener("input", () => {
    const q = jumpInput.value.trim().toLowerCase();
    if (!dataReady || !q) {
      renderJumpResults([]);
      return;
    }
    const results = operatorList.filter((op) => op.name.toLowerCase().includes(q)).slice(0, 20);
    renderJumpResults(results);
  });

  jumpInput.addEventListener("keydown", (e) => {
    if (jumpResultsEl.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      jumpHighlighted = Math.min(jumpHighlighted + 1, jumpResults.length - 1);
      updateJumpHighlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      jumpHighlighted = Math.max(jumpHighlighted - 1, 0);
      updateJumpHighlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (jumpResults[jumpHighlighted]) renderOperator(jumpResults[jumpHighlighted].charId);
    } else if (e.key === "Escape") {
      renderJumpResults([]);
    }
  });

  document.addEventListener("click", (e) => {
    if (!jumpResultsEl.contains(e.target) && e.target !== jumpInput) renderJumpResults([]);
  });

  // "<- All operators": re-renders the landing/browse state in place,
  // the same way picking a different operator via the jump box does,
  // instead of a full page reload -- and drops "?id=" from the URL so a
  // refresh afterward lands back on the browse grid too, not the
  // operator just left.
  backLinkEl.addEventListener("click", (e) => {
    e.preventDefault();
    const params = new URLSearchParams(location.search);
    if (params.has("id")) {
      params.delete("id");
      const qs = params.toString();
      history.replaceState(null, "", qs ? "?" + qs : location.pathname);
    }
    renderOperator(null);
  });

  // Back/forward between two operators (both via the jump box, or a
  // "?id=" link from elsewhere on the site) re-renders in place rather
  // than reloading, since the browser already updates location.search
  // for us before this fires.
  window.addEventListener("popstate", () => {
    if (dataReady) renderOperator(charIdFromUrl());
  });

  loadData()
    .then(() => {
      populateGridFilters();
      renderGrid();
      renderOperator(charIdFromUrl());
    })
    .catch((err) => {
      console.error("Failed to load operator page data:", err);
      statusEl.textContent = "Couldn't load operator data. Please try refreshing.";
    });
})();
