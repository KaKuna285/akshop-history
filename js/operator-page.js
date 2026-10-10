(function () {
  // Per-operator page: release dates (EN/CN, plus the event it likely
  // debuted alongside, best-effort), stats with Elite/level/module
  // controls, talents, potential upgrades, skills with a Lv1-M3 slider per
  // skill, modules, base skills and skins -- plus an "Add to planner" button that opens
  // the shared edit modal also used by the planner and calendar pages.
  // With no operator picked, the page shows the whole roster as a
  // filterable, sortable grid (see "browsable grid" below).
  //
  // Routing is a plain `?id=charId` query string (this static site has no
  // build-time page generation), matching the planner's `?add=charId`.
  // Picking another operator from the jump search or the grid re-renders
  // in place and pushes a history entry via navigateTo(), since every data
  // source below is loaded for all operators at once. Back/Forward step
  // through those entries.
  //
  // Data sources:
  //   - OperatorEditModal.loadCharTable() (operator-edit-modal.js): EN+CN
  //     merged character data -- phases/attributesKeyFrames (stats),
  //     talents, potentialRanks, skills (skill ID references),
  //     subProfessionId/nationId/groupId/teamId, and modules (via its own
  //     uniequip_table.json fetch). The same table the edit modal uses.
  //   - skill_table.json (EN+CN merged here): each skill reference on an
  //     operator is an ID into this table, which has the name/description/
  //     SP cost for levels 1-7 and, for a masterable skill, M1-M3 (the same
  //     "levels" array continues to 10 entries).
  //   - battle_equip_table.json (EN+CN merged here): op.modules only carries
  //     a uniEquipId; this table holds the per-stage (equipLevel 1-3)
  //     effects, as flat stat deltas (attributeBlackboard) and talent/trait
  //     text (parts[].addOrOverrideTalentDataBundle /
  //     .overrideTraitDataBundle).
  //   - skin_table.json (EN+CN merged here): skins and default outfits.
  //   - uniequip_lore (fetched on first use): module flavor text.
  //   - building_data (EN+CN, loaded alongside the rest but not waited
  //     for): base skills.
  //   - events.json (best-effort): the "Released alongside" row.
  //
  // SUBCLASS_NAMES and FACTION_NAMES turn raw subProfessionId/nationId/
  // groupId/teamId values into labels for the header badges. They are
  // hand-maintained from public game knowledge (SUBCLASS_NAMES checked
  // against a community game-data mirror and wiki branch rosters), not read
  // from an in-game string table. An id missing from either falls back to
  // the capitalized raw id rather than a guess.
  //
  // "Add to planner" starts a new roster entry from the account's synced
  // progress when the operator is owned, otherwise from E0/Lv1.

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
  const baseSkillsInfoEl = document.getElementById("opBaseSkillsInfo");
  const mtNoticeEl = document.getElementById("opMtNotice");
  const mtToggleEl = document.getElementById("opMtToggle");
  const skinsInfoEl = document.getElementById("opSkinsInfo");
  const skinPreviewOverlayEl = document.getElementById("skinPreviewOverlay");
  const skinPreviewEl = document.getElementById("skinPreview");
  const skinPreviewCloseBtn = document.getElementById("skinPreviewClose");
  const skinPreviewImgEl = document.getElementById("skinPreviewImg");
  const skinPreviewNameEl = document.getElementById("skinPreviewName");
  const skinPreviewMetaEl = document.getElementById("skinPreviewMeta");
  const skinPreviewContentEl = document.getElementById("skinPreviewContent");

  let charTable = null; // charId -> operator record (EN+CN merged, via OperatorEditModal.loadCharTable())
  let operatorList = []; // playable operators, sorted by name, for the jump search and browse grid
  let skillTable = {}; // skillId -> { levels: [...] } (EN+CN merged)
  let battleEquipTable = {}; // uniEquipId -> { phases: [...] } (EN+CN merged)
  // charId -> [skin, ...]: skin_table.json's charSkins entries (EN+CN
  // merged), limited to playable operators, which also drops the token_*
  // entries (enemy/summon re-skins). Sorted by displaySkin.sortId: default
  // Elite 0/1/2 outfits (negative sortId) first, then purchasable skins in
  // release order. See skinDisplayName() for how the defaults are labeled.
  let skinsByCharId = {};

  // Skin ownership, for dimming not-yet-owned skins. There is no separate
  // control: the "Maxed"/"Your stats" toggle below drives it, so "Maxed"
  // shows every skin at full brightness and "Your stats" dims the ones this
  // account doesn't have. Comes from AccountSync.getOwnedSkins() (filled by
  // a sync -- see cloudflare/depot-import/index.js's extractOwnedSkins())
  // and is read once, since it only changes on a page reload.
  // `hasOwnedSkinData` is kept separate from an empty set so a visitor with
  // no skin data (never synced, or a sync without this field) never sees
  // dimming.
  const ownedSkinsMap = AccountSync.getOwnedSkins();
  const hasOwnedSkinData = !!ownedSkinsMap;
  const ownedSkinIdSet = new Set(Object.keys(ownedSkinsMap || {}));

  let events = []; // events.json's events[] -- best-effort, may stay empty
  let dataReady = false;
  let currentCharId = null;

  // --- "Maxed" / "Your stats" toggle --------------------------------------
  // Chooses between the fully-maxed state (the default) and this
  // account's synced state in the Stats/Potentials/Skills/Modules
  // sections, and whether the Skins section dims unowned skins (see
  // skinsShouldGreyUnowned()). `statsView` is the user's choice, saved so
  // it carries over to the next operator. `currentIsOwned`/
  // `currentProgress` describe the operator on screen and are reset by
  // renderOperator(), so a previous operator's values never offer "Your
  // stats" for one that isn't owned.
  let statsView = getPref("operator", "statsView", "maxed", (v) => v === "maxed" || v === "owned");
  let currentIsOwned = false;
  let currentProgress = null; // this operator's synced progress, or null

  // "Your stats" applies only when the operator is owned and the sync
  // includes its progress (an older sync has the roster but no
  // per-operator detail). Otherwise this falls back to "Maxed" without
  // changing the saved preference, so it still applies to the next owned
  // operator that has progress data.
  function effectiveView() {
    return currentIsOwned && currentProgress && statsView === "owned" ? "owned" : "maxed";
  }

  // Whether the Skins section should dim unowned skins. Checks the raw
  // `statsView` rather than effectiveView(): skin ownership and
  // per-operator progress are independent parts of a sync, and an account
  // can have one without the other. effectiveView() requires
  // currentProgress, which would leave skins undimmed whenever this
  // operator's progress is missing.
  function skinsShouldGreyUnowned() {
    return currentIsOwned && hasOwnedSkinData && statsView === "owned";
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
    // Disabled only when neither kind of synced data is available: "Your
    // stats" also drives skin dimming, which needs only hasOwnedSkinData, so
    // the button stays usable with skin data but no progress for this
    // operator (Stats/Potentials/Skills/Modules then show "Maxed").
    statsViewOwnedBtn.disabled = !currentProgress && !hasOwnedSkinData;
    statsViewOwnedBtn.title = statsViewOwnedBtn.disabled
      ? "This sync didn't include detailed progress or skin ownership for this operator -- re-sync your account from the home page to use this."
      : "";
    // The pressed state follows the raw `statsView`, not effectiveView():
    // with skin data but no progress, "Your stats" still has an effect (skin
    // dimming), so the button shows as selected rather than looking like the
    // click did nothing.
    statsViewMaxedBtn.classList.toggle("opStatsViewBtnActive", statsView !== "owned");
    statsViewOwnedBtn.classList.toggle("opStatsViewBtnActive", statsView === "owned");
  }

  // The compact "Owned · E1 · Lv55 · ..." line in the header. Always shows
  // the synced state, whichever toggle button is selected.
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

  function textNote(text) {
    const el = document.createElement("div");
    el.className = "opNote";
    el.textContent = text;
    return el;
  }

  // Skill/talent/module descriptions reference their numeric parameters
  // as "{key}" or "{key:format}" tokens, resolved against a "blackboard"
  // array of { key, value } pairs stored with the description. They also
  // wrap words in the game's rich-text markup, which isn't real HTML and
  // uses more than one sigil (Ascalon's S3 has both "<@ba.vup>" and
  // "<$...>"), so any "<...>...</>" tag is stripped generically. Token
  // keys can contain "@" (e.g. "{attack@hp_ratio:0%}" is the literal
  // blackboard key "attack@hp_ratio", not a scope prefix), so "@" is part
  // of the key pattern. A token that can't be resolved (unknown key, or a
  // different templating convention some newer skills use) is left as
  // written, so a miss is visible rather than silently dropped.
  function formatDescription(text, blackboard) {
    if (!text) return "";
    let out = text.replace(/<\/?[^>]+>/g, "");
    const bbMap = {};
    // The upstream data sometimes serializes an empty list as an empty
    // object ("{}") instead of "[]" (seen on battle_equip_table.json module
    // phases, e.g. tokenAttributeBlackboard). Calling .forEach on that
    // throws, which would drop the whole module to the "couldn't load full
    // details" fallback, so anything that isn't an array is treated as
    // empty. Other list fields in this file are guarded the same way.
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

  // --- machine-translated CN text ---------------------------------------------
  // CN-only text in the slim game data is machine-translated by the daily
  // build (akgcc-extra-data/translate.py), which keeps the Chinese original
  // under obj._zh[field]. tr() picks the version to show ("Show original
  // Chinese" switches the whole page); markMt() gives translated text a
  // dotted underline.
  let showOriginalZh = false;

  function zhOriginal(obj, field) {
    return obj && obj._zh && typeof obj._zh[field] === "string" ? obj._zh[field] : null;
  }

  function tr(obj, field) {
    if (!obj) return undefined;
    const zh = zhOriginal(obj, field);
    return showOriginalZh && zh ? zh : obj[field];
  }

  function markMt(el, obj, field) {
    if (zhOriginal(obj, field)) el.classList.add("mtText");
    return el;
  }

  // Whether anything shown for this operator is machine-translated: its own
  // talents/potentials, or its skills, modules or skins.
  function usesMachineTranslation(op) {
    const related = [
      op,
      // Array.isArray: the upstream data can have {} for an empty list.
      ...(Array.isArray(op.skills) ? op.skills : []).map((s) => s && skillTable[s.skillId]),
      ...(Array.isArray(op.modules) ? op.modules : []).map((m) => m && battleEquipTable[m.uniEquipId]),
      skinsByCharId[op.charId] || [],
    ];
    return JSON.stringify(related).includes('"_zh"');
  }

  mtToggleEl.addEventListener("click", () => {
    showOriginalZh = !showOriginalZh;
    renderOperator(currentCharId);
  });

  // "PHASE_0" / "PHASE_1" / "PHASE_2" -> 0 / 1 / 2.
  function phaseNumber(phaseStr) {
    const m = /PHASE_(\d+)/.exec(phaseStr || "");
    return m ? parseInt(m[1], 10) : null;
  }

  // Module stat deltas (battle_equip_table.json's attributeBlackboard) use
  // short snake_case keys. Common ones get a friendly label; anything else
  // has its underscores turned into spaces and is title-cased.
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
  // Finds an event starting within a day of this operator's EN release.
  // A single-operator version of calendar.js's matchOperatorsToEvents(),
  // which matches every operator against every event at once. Days are
  // compared via dayKeyFromTimestamp() in js/util.js.
  const EVENT_MATCH_WINDOW_DAYS = 1;

  function findReleaseEvent(op) {
    if (!events.length || !op.onlineTime) return null;
    const day = dayKeyFromTimestamp(op.onlineTime);
    if (day == null) return null;
    for (const ev of events) {
      // Skip game-mode themes (Integrated Strategies / Reclamation
      // Algorithm; events.py tags them with `mode`): they often drop the
      // same day as the SideStory an operator actually debuted with, and
      // being first in date order here would make this return the theme.
      if (ev.mode) continue;
      const evDay = dayKeyFromTimestamp(ev.globalStart);
      if (evDay != null && Math.abs(evDay - day) <= EVENT_MATCH_WINDOW_DAYS) return ev;
    }
    return null;
  }

  // --- data loading -----------------------------------------------------

  // An operator's "skills" field in character_table.json is a list of
  // { skillId, ... } references; the name/description/SP cost for each
  // level (and mastery rank) lives in this separate table, keyed by
  // skillId. Only this page uses it, so it's loaded here rather than in
  // util.js.
  async function loadSkillTable(server) {
    const res = await gameDataFetch(server, "skill_table");
    return await fixedJson(res);
  }

  // Keyed by uniEquipId. Only this page uses it, like skill_table above.
  async function loadBattleEquipTable(server) {
    const res = await gameDataFetch(server, "battle_equip_table");
    return await fixedJson(res);
  }

  // skin_table.json's top level is { charSkins, buildinEvolveMap,
  // buildinPatchMap, brandList, specialSkinInfoList, spDynSkins, ... }; only
  // charSkins (skinId -> skin record) is used, so that's all this returns.
  // Each record's isBuySkin flag separates real skins from the default
  // Elite 0/1/2 outfit entries every operator also has -- see
  // skinDisplayName() for how those are labeled.
  async function loadSkinTable(server) {
    const res = await gameDataFetch(server, "skin_table");
    const json = await fixedJson(res);
    return (json && json.charSkins) || {};
  }

  async function loadData() {
    loadBaseSkills(); // starts the download; renderBaseSkills() waits for it
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

    // Best-effort CN merge, like loadCharTable()'s: fills in skill/module
    // ids used only by cnOnly operators, and a slow or failing CN mirror
    // never breaks the EN data.
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

    // Same best-effort CN merge for skins: a cnOnly operator's skins
    // (including its default Elite 0/1/2 art) aren't in the EN skin table.
    try {
      const cnSkins = await loadSkinTable(SERVERS.CN);
      for (const [skinId, data] of Object.entries(cnSkins)) {
        if (!skins[skinId]) {
          data.cnOnly = true; // artSourceUrls() tries the CN client's art first for these
          skins[skinId] = data;
        }
      }
    } catch (err) {
      console.warn("Couldn't load CN-exclusive skin data:", err);
    }

    // Index by charId, keeping only skins of playable operators (this drops
    // the token_* enemy/summon re-skins, whose charIds aren't in charTable).
    // Each list is ordered by displaySkin.sortId: defaults first, then real
    // skins in release order.
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
  // displaySkin.skinName is set only for real skins (isBuySkin: true). The
  // default Elite 0/1/2 outfits have a null skinName and are labeled from
  // their skinGroupId ("ILLUST_0"/"ILLUST_1"/"ILLUST_2"). Not every
  // operator has all three -- one without Elite 2 has no ILLUST_2 entry.
  function skinDisplayName(skin) {
    const d = (skin && skin.displaySkin) || {};
    if (d.skinName) return tr(d, "skinName");
    const m = /^ILLUST_(\d+)$/.exec(d.skinGroupId || "");
    if (m) return m[1] === "0" ? "Default outfit" : `Elite ${m[1]} art`;
    return "Outfit";
  }

  // Full illustration for a skin, resolved once per skin and cached:
  // skinId -> Promise of the first URL that loaded (null if none did).
  // Two sources of the art, both through the site's R2 mirror:
  //  - myrtle.moe (uri_skin_illust_myrtle()) -- everything on EN
  //  - the CN client's assets (uri_skin_illust_cn()) -- also has CN-only
  //    operators and skins, which myrtle.moe doesn't
  // A CN-only skin (flagged when the CN skin table is merged in) tries the
  // CN source first, everything else myrtle.moe first; each falls back to
  // the other. Each is tried, in order:
  //  1. through Cloudflare Image Transformations (uri_transformed(),
  //     IMAGE_TRANSFORM_BASE in config.js): WebP/AVIF at preview size, cached
  //  2. the mirror's original PNG, if transformations aren't set up or the
  //     monthly quota is used up
  //  3. Aceship -- frozen since May 2024 and ~3s for 1MB; last resort
  // For each source the 1024px "b" copy comes first (~0.3-1MB); some
  // default/Elite art only has the 2048-2560px original (1-6MB).
  const fullArtBySkinId = new Map();
  // The size of myrtle.moe's "b" copies, so they're converted without
  // resizing; the 2048px+ originals are scaled down to match. The preview
  // shows the art at up to 80vh (css/operator-extra.css) -- about 860px on
  // a 1080p screen.
  const SKIN_ART_WIDTH = 1024;

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(url);
      img.onerror = reject;
      img.src = url;
    });
  }

  // Keyed by portraitId, not avatarId: they match for every skin except
  // the base "Default outfit" (ILLUST_0), e.g. Amiya's avatarId is the bare
  // "char_002_amiya" while her art is "char_002_amiya_1".
  function skinPortraitId(skin) {
    return skin.portraitId || skin.avatarId || skin.skinId;
  }

  // The art's URLs on both sources (see above), in the order to try them,
  // for each of `sizes` ("display" = the 1024px "b" copy, "full" = the
  // original) -- source by source, sizes in the order given.
  function artSourceUrls(skin, sizes) {
    const portraitId = skinPortraitId(skin);
    const myrtle = sizes.map((size) => uri_skin_illust_myrtle(skin.charId, portraitId, skin.isBuySkin, size));
    const cn = sizes.map((size) => uri_skin_illust_cn(skin.charId, portraitId, size));
    return skin.cnOnly ? [...cn, ...myrtle] : [...myrtle, ...cn];
  }

  async function firstLoadable(urls) {
    for (const url of urls) {
      try {
        return await loadImage(url);
      } catch {
        // try the next one
      }
    }
    return null;
  }

  function loadFullArt(skin) {
    const key = skin.skinId;
    if (fullArtBySkinId.has(key)) return fullArtBySkinId.get(key);
    const portraitId = skinPortraitId(skin);
    const mirrored = artSourceUrls(skin, ["display", "full"]);
    const candidates = [
      ...mirrored.map((url) => uri_transformed(url, SKIN_ART_WIDTH)).filter(Boolean),
      ...mirrored,
      uri_skin_illust(portraitId),
    ];
    const promise = firstLoadable(candidates).then((url) => {
      // Nothing loaded -- forget the miss so a later click retries (it may
      // have been a network blip rather than missing art).
      if (!url) fullArtBySkinId.delete(key);
      return url;
    });
    fullArtBySkinId.set(key, promise);
    return promise;
  }

  // --- zoomed art -----------------------------------------------------------
  // Clicking the full art in the preview opens it full-screen. There, a
  // click zooms in on that spot (and loads the original, up to 2560px, if
  // only the 1024px copy was shown); drag or scroll to look around, click
  // again to zoom back out. Esc, the X or clicking the dark area closes it.
  const skinZoomEl = document.getElementById("skinZoom");
  const skinZoomImgEl = document.getElementById("skinZoomImg");
  const skinZoomCloseBtn = document.getElementById("skinZoomClose");
  const SKIN_ZOOM_WIDTH = 2048; // through Image Transformations; scaled down only
  const hiResArtBySkinId = new Map();
  let zoomSkin = null;
  let releaseZoomFocus = null;

  function loadHiResArt(skin) {
    if (!hiResArtBySkinId.has(skin.skinId)) {
      const originals = artSourceUrls(skin, ["full"]);
      const promise = firstLoadable([
        ...originals.map((url) => uri_transformed(url, SKIN_ZOOM_WIDTH)).filter(Boolean),
        ...originals,
      ]).then((url) => {
        if (!url) hiResArtBySkinId.delete(skin.skinId);
        return url;
      });
      hiResArtBySkinId.set(skin.skinId, promise);
    }
    return hiResArtBySkinId.get(skin.skinId);
  }

  function isZoomOpen() {
    return !skinZoomEl.classList.contains("hidden");
  }

  function openSkinZoom(skin) {
    zoomSkin = skin;
    setZoomed(false);
    skinZoomImgEl.src = skinPreviewImgEl.src; // already loaded -- shows at once
    skinZoomEl.classList.remove("hidden");
    document.body.classList.add("skinZoomOpen");
    if (!releaseZoomFocus) releaseZoomFocus = holdFocusIn(skinZoomEl);
    loadHiResArt(skin).then((url) => {
      if (url && zoomSkin === skin && isZoomOpen()) skinZoomImgEl.src = url;
    });
  }

  function closeSkinZoom() {
    if (!isZoomOpen()) return;
    skinZoomEl.classList.add("hidden");
    document.body.classList.remove("skinZoomOpen");
    setZoomed(false);
    zoomSkin = null;
    if (releaseZoomFocus) {
      releaseZoomFocus();
      releaseZoomFocus = null;
    }
  }

  // Zoomed in: the art at its own full size (at least twice the fitted size,
  // for the 1024px copy), with the point under (x, y) kept under the cursor.
  function setZoomed(on, x, y) {
    const wasRect = skinZoomImgEl.getBoundingClientRect();
    skinZoomEl.classList.toggle("zoomed", on);
    skinZoomImgEl.setAttribute("aria-label", on ? "Zoom out" : "Zoom in");
    if (!on) {
      skinZoomImgEl.style.width = "";
      skinZoomImgEl.style.marginTop = "";
      return;
    }
    const natW = skinZoomImgEl.naturalWidth || wasRect.width;
    const natH = skinZoomImgEl.naturalHeight || wasRect.height;
    const width = Math.max(natW, wasRect.width * 2);
    const height = (width * natH) / natW;
    skinZoomImgEl.style.width = `${width}px`;
    skinZoomImgEl.style.marginTop = `${Math.max(0, (skinZoomEl.clientHeight - height) / 2)}px`;
    const fx = x == null ? 0.5 : (x - wasRect.left) / wasRect.width;
    const fy = y == null ? 0.5 : (y - wasRect.top) / wasRect.height;
    const cx = x == null ? skinZoomEl.clientWidth / 2 : x;
    const cy = y == null ? skinZoomEl.clientHeight / 2 : y;
    const imgLeft = Math.max(0, (skinZoomEl.clientWidth - width) / 2);
    skinZoomEl.scrollLeft = imgLeft + fx * width - cx;
    skinZoomEl.scrollTop = fy * height - cy;
  }

  // Dragging pans the zoomed art (mouse/pen; touch scrolls natively). A
  // press that moved more than a few pixels was a drag, not a click.
  let drag = null;
  skinZoomImgEl.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, left: skinZoomEl.scrollLeft, top: skinZoomEl.scrollTop, moved: false };
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved && skinZoomEl.classList.contains("zoomed")) {
      skinZoomEl.scrollLeft = drag.left - dx;
      skinZoomEl.scrollTop = drag.top - dy;
    }
  });
  window.addEventListener("pointerup", () => {
    if (drag) setTimeout(() => (drag = null), 0); // after the click it ends in
  });
  skinZoomImgEl.addEventListener("click", (e) => {
    if (drag && drag.moved) return;
    setZoomed(!skinZoomEl.classList.contains("zoomed"), e.clientX, e.clientY);
  });
  skinZoomImgEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setZoomed(!skinZoomEl.classList.contains("zoomed"));
    }
  });
  skinZoomEl.addEventListener("click", (e) => {
    if (e.target === skinZoomEl) closeSkinZoom();
  });
  skinZoomCloseBtn.addEventListener("click", closeSkinZoom);

  // The preview's own art opens the zoom, once it's the full illustration
  // (not the avatar placeholder).
  skinPreviewImgEl.addEventListener("click", () => {
    if (skinPreviewImgEl.classList.contains("skinPreviewImgFull") && currentPreviewSkin) openSkinZoom(currentPreviewSkin);
  });
  skinPreviewImgEl.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && skinPreviewImgEl.classList.contains("skinPreviewImgFull") && currentPreviewSkin) {
      e.preventDefault();
      openSkinZoom(currentPreviewSkin);
    }
  });

  // The animated chibi under the art -- see js/chibi-viewer.js.
  const skinChibi = ChibiViewer.create(document.getElementById("skinPreviewChibi"));

  let releaseSkinPreviewFocus = null;

  let currentPreviewSkin = null;

  function hideSkinPreview() {
    closeSkinZoom();
    currentPreviewSkin = null;
    skinPreviewOverlayEl.classList.add("hidden");
    skinChibi.clear();
    if (releaseSkinPreviewFocus) {
      releaseSkinPreviewFocus();
      releaseSkinPreviewFocus = null;
    }
  }

  function showSkinPreview(skin) {
    const d = (skin && skin.displaySkin) || {};
    const avatarId = skin.avatarId || skin.skinId;
    // Show the small avatar right away as a placeholder (cheap, and usually
    // cached from this skin's card) while the full illustration (up to a few
    // MB) loads in the background. The visible <img> only switches to it
    // once that load succeeds, so the preview never shows a half-loaded
    // image.
    currentPreviewSkin = skin;
    skinPreviewImgEl.dataset.avatarId = avatarId;
    skinPreviewImgEl.classList.remove("skinPreviewImgFull");
    skinPreviewImgEl.removeAttribute("tabindex");
    skinPreviewImgEl.removeAttribute("role");
    skinPreviewImgEl.removeAttribute("aria-label");
    skinPreviewImgEl.onload = () => {
      skinPreviewImgEl.style.display = "block";
    };
    skinPreviewImgEl.onerror = () => {
      skinPreviewImgEl.style.display = "none";
    };
    skinPreviewImgEl.style.display = "none";
    setSkinAvatarIcon(skinPreviewImgEl, avatarId);

    loadFullArt(skin).then((url) => {
      // Apply only if the preview still shows the skin this was requested
      // for -- the user may have clicked another card meanwhile. No URL means
      // no source had the art: the avatar stays.
      if (!url || skinPreviewImgEl.dataset.avatarId !== avatarId) return;
      skinPreviewImgEl.onload = null;
      skinPreviewImgEl.onerror = null;
      skinPreviewImgEl.src = url;
      skinPreviewImgEl.classList.add("skinPreviewImgFull");
      // Clickable (and keyboard-reachable) to open the zoom view.
      skinPreviewImgEl.tabIndex = 0;
      skinPreviewImgEl.setAttribute("role", "button");
      skinPreviewImgEl.setAttribute("aria-label", "Zoom in on the art");
      skinPreviewImgEl.style.display = "block";
    });

    skinPreviewNameEl.textContent = skinDisplayName(skin);
    skinPreviewNameEl.classList.remove("mtText");
    markMt(skinPreviewNameEl, d, "skinName");
    skinPreviewMetaEl.textContent = tr(d, "skinGroupName") || "";
    skinPreviewMetaEl.classList.remove("mtText");
    markMt(skinPreviewMetaEl, d, "skinGroupName");
    // Default outfit entries have no flavor text. content (sale/epoque
    // copy) or, failing that, usage (a shorter blurb) is shown as one
    // paragraph. It uses the same "<color name=#xxxxxx>...</color>"-style
    // markup as skill text, so formatDescription() strips it; there are no
    // "{key}" tokens, hence the null blackboard.
    skinPreviewContentEl.textContent = formatDescription(d.content || d.usage || "", null);
    skinPreviewOverlayEl.classList.remove("hidden");
    skinPreviewOverlayEl.scrollTop = 0;
    skinChibi.show(skin);
    if (!releaseSkinPreviewFocus) releaseSkinPreviewFocus = holdFocusIn(document.getElementById("skinPreview"));
  }

  skinPreviewCloseBtn.addEventListener("click", hideSkinPreview);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isZoomOpen()) closeSkinZoom(); // just the zoom; the preview stays
    else if (!skinPreviewOverlayEl.classList.contains("hidden")) hideSkinPreview();
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
      // Dim only real purchasable skins (isBuySkin). The default Elite 0/1/2
      // outfits every operator has are never in a synced account's
      // ownedSkins map, so without this check they'd always read as unowned
      // under "Your stats".
      if (skinsShouldGreyUnowned() && skin.isBuySkin && !ownedSkinIdSet.has(skin.skinId)) {
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
      markMt(label, skin.displaySkin, "skinName");
      card.appendChild(label);
      card.addEventListener("click", () => showSkinPreview(skin));
      // Start downloading the full art as soon as a click looks likely:
      // resting the pointer on a card for a moment, keyboard focus, or the
      // press itself (which lands ~100ms before the click fires, and is
      // the only early signal on touch screens). A pointer just passing
      // over the grid doesn't trigger anything.
      let hoverTimer = null;
      card.addEventListener("pointerenter", (e) => {
        if (e.pointerType !== "mouse") return;
        hoverTimer = setTimeout(() => loadFullArt(skin), 150);
      });
      card.addEventListener("pointerleave", () => clearTimeout(hoverTimer));
      card.addEventListener("pointerdown", () => loadFullArt(skin));
      card.addEventListener("focus", () => loadFullArt(skin));
      skinsInfoEl.appendChild(card);
    }
  }

  // Each phase stores two keyframes: level 1 and that phase's max level.
  // Levels in between are linearly interpolated, matching the game's
  // growth within an Elite phase (and other community calculators).
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

  // potentialRanks' attribute-type codes -> this file's stat-row keys. A
  // numeric potential (type "BUFF") carries
  // `buff.attributes.attributeModifiers[]`, each a flat
  // `{attributeType, formulaItem: "ADDITION", value}`. A "CUSTOM" rank
  // (e.g. "Improves Talent") has `buff: null` and is skipped; its effect is
  // shown in the Talents/Potential upgrades sections. ATTACK_SPEED is left
  // unmapped: turning an attack-speed buff into a displayed Attack
  // Interval needs the game's frame-rounding formula, which isn't
  // confirmed, so it's omitted rather than risk a wrong number.
  const POTENTIAL_ATTR_TO_STAT_KEY = {
    MAX_HP: "maxHp",
    ATK: "atk",
    DEF: "def",
    MAGIC_RESISTANCE: "magicResistance",
    COST: "cost",
    RESPAWN_TIME: "respawnTime",
  };

  // Sums the stat bonuses from potentialRanks. potentialRanks[i] is the
  // effect of reaching Potential (i+2), so the first capRank entries are
  // the unlocked ones. "Your stats" passes the synced potentialRank (0-5)
  // as capRank; omitting it ("Maxed") sums all of them, i.e. Potential 6.
  function potentialStatBonuses(op, capRank) {
    const totals = {};
    // Guards against the "{}"-instead-of-"[]" upstream quirk (see
    // formatDescription()); character_table.json comes from the same export
    // pipeline.
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

  // battle_equip_table.json's snake_case attributeBlackboard keys -> this
  // file's stat-row keys (MODULE_STAT_LABELS maps the same keys to display
  // labels for the Modules section).
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

  // A module stage's attributeBlackboard is that stage's total bonus, not
  // an increment over the previous stage, so this reads exactly one phase
  // (matched by equipLevel, not array index, in case phases are sparse)
  // rather than summing across stages.
  function moduleStatBonuses(uniEquipId, stage) {
    const totals = {};
    if (!uniEquipId || !stage) return totals;
    const equipData = battleEquipTable[uniEquipId];
    const phases = (equipData && Array.isArray(equipData.phases) && equipData.phases) || [];
    const phase = phases.find((ph) => ph && ph.equipLevel === stage);
    if (!phase) return totals;
    // "{}"-instead-of-"[]" guard (see formatDescription()). This runs from
    // the Module/Stage dropdowns' change handler with no try/catch, so a
    // throw here would stop live stat updates.
    (Array.isArray(phase.attributeBlackboard) ? phase.attributeBlackboard : []).forEach((b) => {
      if (!b || !b.key || typeof b.value !== "number") return;
      const key = MODULE_ATTR_TO_STAT_KEY[b.key];
      if (!key) return;
      totals[key] = (totals[key] || 0) + b.value;
    });
    return totals;
  }

  // Rebuilds the Stage dropdown from the selected module's actual phases
  // rather than assuming stages 1-3. A module missing from
  // battleEquipTable (a fetch gap, or a CN-only one the CN merge didn't
  // cover) leaves the dropdown at "None" and disabled.
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

  // An Elite dropdown, a Level slider and, if the operator has modules, a
  // Module + Stage dropdown drive one live-updating stats column, so any
  // combination can be previewed. Elite has only 2-4 options, so it's a
  // dropdown; Level runs to 90, where a slider works better.
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
        const modName = tr(mod, "uniEquipName");
        opt.textContent = mod.typeName2 ? `${mod.typeName2} — ${modName || ""}` : modName || mod.uniEquipId || "Module";
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

    // "Maxed": max Elite, max level, no module. "Your stats": the synced
    // Elite phase and level, clamped into the valid range in case the synced
    // snapshot is out of date (e.g. a level recorded before a later Elite
    // phase raised the cap).
    let eliteIdx = phases.length - 1;
    if (owned && typeof progress.evolvePhase === "number") {
      eliteIdx = Math.max(0, Math.min(progress.evolvePhase, phases.length - 1));
    }
    let level = phases[eliteIdx].attributesKeyFrames[phases[eliteIdx].attributesKeyFrames.length - 1].level;
    if (owned && typeof progress.level === "number") {
      const kfs0 = phases[eliteIdx].attributesKeyFrames;
      level = Math.max(kfs0[0].level, Math.min(progress.level, kfs0[kfs0.length - 1].level));
    }

    // "Your stats" also starts the Module/Stage dropdowns on the equipped
    // module at the stage reached. Only one module's effect applies at a
    // time, even when several are leveled (see `currentEquip` in
    // cloudflare/depot-import/index.js's extractOwnedOperatorProgress()).
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
      const named = candidates[candidates.length - 1];
      heading.textContent = tr(named, "name") || `Talent ${i + 1}`;
      markMt(heading, named, "name");
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
        desc.textContent = formatDescription(tr(cand, "description"), cand.blackboard);
        markMt(desc, cand, "description");
        row.appendChild(desc);
        block.appendChild(row);
      });
      talentsInfoEl.appendChild(block);
    });
  }

  // --- base skills --------------------------------------------------------

  // building_data: chars[charId].buffChar is a list of base-skill slots,
  // each a list of tiers (buffData: { buffId, cond: { phase, level } }) where
  // a later tier replaces the earlier one once unlocked; buffs[buffId] has
  // the tier's name, room, icon and description. EN, with CN filling in
  // CN-only operators. Loaded once, without holding up the rest of the page;
  // a failed load isn't cached, so the next operator shown retries.
  let baseSkillsPromise = null;
  function loadBaseSkills() {
    if (!baseSkillsPromise) {
      baseSkillsPromise = (async () => {
        const data = { chars: {}, buffs: {} };
        for (const server of [SERVERS.CN, SERVERS.EN]) {
          try {
            const json = await fixedJson(await gameDataFetch(server, "building_data"));
            Object.assign(data.chars, json.chars || {});
            Object.assign(data.buffs, json.buffs || {});
          } catch (err) {
            console.warn(`Couldn't load ${server} base skills:`, err);
          }
        }
        if (!Object.keys(data.chars).length) baseSkillsPromise = null;
        return data;
      })();
    }
    return baseSkillsPromise;
  }

  const BASE_ROOM_NAMES = {
    CONTROL: "Control Center",
    MANUFACTURE: "Factory",
    TRADING: "Trading Post",
    POWER: "Power Plant",
    DORMITORY: "Dormitory",
    MEETING: "Reception Room",
    HIRE: "Office",
    WORKSHOP: "Workshop",
    TRAINING: "Training Room",
  };

  // Base-skill text marks values and keywords with tags: <@cc.vup>+15%</>
  // (an increase), <@cc.vdown> (a decrease), <@cc.kw> (a keyword),
  // <@cc.rem> (a side note) and <$cc...> (a glossary term). Each becomes a
  // styled span; anything else is plain text.
  const BASE_TEXT_CLASSES = { "cc.vup": "opBaseUp", "cc.vdown": "opBaseDown", "cc.kw": "opBaseKeyword", "cc.rem": "opBaseNote" };
  function appendBaseSkillText(parent, text) {
    const stack = [parent];
    const re = /<([@$])([^>]*)>|<\/>/g;
    let last = 0;
    let m;
    const addText = (s) => {
      if (s) stack[stack.length - 1].appendChild(document.createTextNode(s.replace(/</g, "")));
    };
    while ((m = re.exec(text || ""))) {
      addText(text.slice(last, m.index));
      last = re.lastIndex;
      if (m[0] === "</>") {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const span = document.createElement("span");
      const styleKey = m[2].split(".").slice(0, 2).join(".");
      span.className = m[1] === "$" ? "opBaseTerm" : BASE_TEXT_CLASSES[styleKey] || "";
      stack[stack.length - 1].appendChild(span);
      stack.push(span);
    }
    addText((text || "").slice(last));
  }

  function renderBaseSkills(op) {
    baseSkillsInfoEl.innerHTML = "";
    baseSkillsInfoEl.appendChild(textNote("Loading base skills…"));
    const charId = op.charId;
    loadBaseSkills().then((data) => {
      if (currentCharId !== charId) return; // another operator is showing now
      baseSkillsInfoEl.innerHTML = "";
      // Amiya's Guard/Medic forms share her base skills.
      const entry = data.chars[charId] || (charId.includes("amiya") ? data.chars.char_002_amiya : null);
      if (!entry && !Object.keys(data.chars).length) {
        baseSkillsInfoEl.appendChild(textNote("Couldn't load base skills."));
        return;
      }
      const slots = (Array.isArray(entry && entry.buffChar) ? entry.buffChar : [])
        .map((slot) => (Array.isArray(slot && slot.buffData) ? slot.buffData : []).filter((t) => t && data.buffs[t.buffId]))
        .filter((tiers) => tiers.length);
      if (!slots.length) {
        baseSkillsInfoEl.appendChild(textNote("No base skills."));
        return;
      }
      for (const tiers of slots) {
        const block = document.createElement("div");
        block.className = "opTalentBlock opBaseSkillBlock";
        for (const tier of tiers) {
          const buff = data.buffs[tier.buffId];
          const row = document.createElement("div");
          row.className = "opBaseSkillRow";

          const iconWrap = document.createElement("span");
          iconWrap.className = "opBaseSkillIcon";
          if (/^#[0-9a-f]{3,8}$/i.test(buff.buffColor || "")) iconWrap.style.backgroundColor = buff.buffColor;
          if (buff.skillIcon) {
            const img = document.createElement("img");
            img.alt = "";
            img.loading = "lazy";
            setIconWithFallback(img, uri_building_skill(buff.skillIcon), uri_building_skill(buff.skillIcon, ASSET_SOURCE.ACESHIP), false);
            iconWrap.appendChild(img);
          }
          row.appendChild(iconWrap);

          const body = document.createElement("div");
          body.className = "opBaseSkillBody";
          const head = document.createElement("div");
          head.className = "opBaseSkillHead";
          const name = document.createElement("span");
          name.className = "opTalentHeading opBaseSkillName";
          name.textContent = tr(buff, "buffName") || tier.buffId;
          markMt(name, buff, "buffName");
          head.appendChild(name);
          const room = document.createElement("span");
          room.className = "opBaseSkillRoom";
          room.textContent = BASE_ROOM_NAMES[buff.roomType] || buff.roomType || "";
          head.appendChild(room);
          body.appendChild(head);

          const unlock = document.createElement("div");
          unlock.className = "opTalentUnlock";
          const parts = [];
          const phaseNum = phaseNumber(tier.cond && tier.cond.phase);
          if (phaseNum != null) parts.push(`Elite ${phaseNum}`);
          if (tier.cond && tier.cond.level > 1) parts.push(`Lv${tier.cond.level}`);
          unlock.textContent = parts.join(" · ") || "Base";
          body.appendChild(unlock);

          const desc = document.createElement("div");
          desc.className = "opTalentDescription";
          appendBaseSkillText(desc, tr(buff, "description"));
          markMt(desc, buff, "description");
          body.appendChild(desc);

          row.appendChild(body);
          block.appendChild(row);
        }
        baseSkillsInfoEl.appendChild(block);
      }
    });
  }

  function renderPotentials(op, view, progress) {
    potentialsInfoEl.innerHTML = "";
    const ranks = op.potentialRanks || [];
    if (!ranks.length) {
      potentialsInfoEl.appendChild(textNote("No potential upgrades."));
      return;
    }
    // "Your stats": grey out (not hide, like the grid's owned filter) any
    // rank beyond the synced potentialRank; potentialRanks[i] is reached at
    // Potential (i+2).
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
      desc.textContent = tr(rank, "description") || "";
      markMt(desc, rank, "description");
      row.appendChild(label);
      row.appendChild(desc);
      potentialsInfoEl.appendChild(row);
    });
  }

  // Uses skill_table.json's iconId when the skill has one (otherwise the
  // skill id itself). Local mirror, then Aceship, then hidden -- like
  // setAvatarIcon() in util.js, minus its cnOnly placeholder (a missing
  // skill icon doesn't signal an unreleased operator).
  function setSkillIcon(imgEl, iconKey) {
    setIconWithFallback(imgEl, uri_skill(iconKey), uri_skill(iconKey, ASSET_SOURCE.ACESHIP), false);
  }

  function skillLevelLabel(i) {
    return i < 7 ? `Lv${i + 1}` : `M${i - 6}`;
  }

  // One range slider per skill, Lv1 through M3 (indices 0-9, or 0-6 for a
  // non-masterable skill), like the Elite/Level controls in renderStats(),
  // so a 10-level masterable skill doesn't take over the page.
  function renderSkills(op, view, progress) {
    skillsInfoEl.innerHTML = "";
    const refs = Array.isArray(op.skills) ? op.skills : [];
    if (!refs.length) {
      skillsInfoEl.appendChild(textNote("No skills."));
      return;
    }

    // "Your stats": the account's Skill Level (1-7, shared by all skills)
    // and, at 7, each skill's own mastery rank (specializeLevel, 0-3),
    // matched by skillId rather than position in case the synced order
    // differs from op.skills. skillLevelLabel() maps slider indices to
    // "Lv<n>"/"M<n>".
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
      nameEl.textContent = (levels && levels[0] && tr(levels[0], "name")) || `Skill ${idx + 1}`;
      if (levels && levels[0]) markMt(nameEl, levels[0], "name");
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
        descEl.textContent = lvl ? formatDescription(tr(lvl, "description"), lvl.blackboard) : "";
        descEl.classList.remove("mtText");
        if (lvl) markMt(descEl, lvl, "description");
      }

      slider.addEventListener("input", () => update(parseInt(slider.value, 10)));

      // "Maxed" starts at the highest level, like the stats controls. "Your
      // stats" starts at this skill's actual level: the shared Skill Level
      // below 7, or 7 plus this skill's mastery rank at 7.
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

  // One stage of a module. The module record's own name/description is
  // flavor text; the per-stage effects (stat bonuses and talent/trait
  // text) live in battle_equip_table.json, keyed by uniEquipId, one entry
  // per stage (1-3). A stage can have either kind of effect, both, or
  // neither beyond its stat bump, so the effect list is built from
  // whatever is present.
  function renderModuleStage(phase) {
    const stage = document.createElement("div");
    stage.className = "opModuleStage";
    const heading = document.createElement("div");
    heading.className = "opModuleStageHeading";
    heading.textContent = `Stage ${phase.equipLevel}`;
    stage.appendChild(heading);

    // "{}"-instead-of-"[]" guard (see formatDescription()): a stage with no
    // stat deltas can come back that way.
    const deltas = (Array.isArray(phase.attributeBlackboard) ? phase.attributeBlackboard : []).filter((b) => b && b.key && b.value);
    if (deltas.length) {
      const statsLine = document.createElement("div");
      statsLine.className = "opModuleStageStats";
      statsLine.textContent = deltas
        .map((b) => `${moduleStatLabel(b.key)} ${formatModuleStatDelta(b.key, b.value)}`)
        .join(", ");
      stage.appendChild(statsLine);
    }

    // battle_equip_table.json isn't uniform: a part can be null, a bundle
    // can lack candidates or have a non-array there, and so on. Each level
    // is guarded so one odd part is skipped instead of throwing and dropping
    // the whole module to renderModules()' fallback notice. phase.parts can
    // also be "{}" for a stage with no parts (see formatDescription()).
    (Array.isArray(phase.parts) ? phase.parts : []).forEach((part) => {
      if (!part) return;
      [part.addOrOverrideTalentDataBundle, part.overrideTraitDataBundle].forEach((bundle) => {
        const candidates = bundle && bundle.candidates;
        if (!Array.isArray(candidates)) return;
        candidates.forEach((cand) => {
          if (!cand) return;
          // Trait-override candidates (usually Stage 1's part) store their text
          // in "overrideDescripton" (sic -- the upstream field name) when they
          // replace the base trait, or "additionalDescription" when they add to
          // it. Both keys exist with one of them null, so all four fields are
          // checked (e.g. Mountain's modules use overrideDescripton for Stage 1).
          const field = ["description", "upgradeDescription", "additionalDescription", "overrideDescripton"].find((f) => cand[f]);
          if (!field) return;
          const effect = document.createElement("div");
          effect.className = "opModuleStageEffect";
          effect.textContent = formatDescription(tr(cand, field), cand.blackboard);
          markMt(effect, cand, field);
          stage.appendChild(effect);
        });
      });
    });

    return stage;
  }

  // Module lore (uniEquipDesc), kept out of uniequip_table in the slim game
  // data (see game_data.py) and fetched once, on first use: EN, with CN
  // filling in modules EN doesn't have yet. A failed load isn't cached, so
  // opening another module's lore retries.
  let moduleLorePromise = null;
  function loadModuleLore() {
    if (!moduleLorePromise) {
      moduleLorePromise = (async () => {
        const lore = {};
        for (const server of [SERVERS.CN, SERVERS.EN]) {
          try {
            const res = await gameDataFetch(server, "uniequip_lore");
            if (res.ok) Object.assign(lore, await res.json());
          } catch (err) {
            console.warn(`Couldn't load ${server} module lore:`, err);
          }
        }
        if (!Object.keys(lore).length) moduleLorePromise = null;
        return lore;
      })();
    }
    return moduleLorePromise;
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
      // Each module renders inside its own try/catch: battle_equip_table.json
      // varies in shape, and one module failing to parse shouldn't take the
      // rest of the section with it.
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
        name.textContent = tr(mod, "uniEquipName") || "";
        markMt(name, mod, "uniEquipName");
        heading.appendChild(name);

        // "Your stats": only one module's effect applies at a time (see the
        // `currentEquip` comment in renderStats()), so mark the equipped one --
        // the Stage greying below only reflects the level reached.
        if (owned && progress.currentEquip && progress.currentEquip === mod.uniEquipId) {
          const badge = document.createElement("span");
          badge.className = "opModuleEquippedBadge";
          badge.textContent = "Equipped";
          heading.appendChild(badge);
        }

        // The lore text (uniEquipDesc) is flavor, not numbers, so it's collapsed
        // by default to keep the stage effects above the fold. A toggle arrow
        // (pushed right by margin-left: auto in CSS) reveals it. The text is
        // fetched the first time any module's lore is opened (see
        // loadModuleLore()), unless the record already carries it.
        const desc = document.createElement("div");
        desc.className = "opModuleDescription hidden";
        const loreToggle = document.createElement("button");
        loreToggle.type = "button";
        loreToggle.className = "opModuleLoreToggle";
        loreToggle.textContent = "▾";
        loreToggle.setAttribute("aria-expanded", "false");
        loreToggle.setAttribute("aria-label", "Show module lore");
        let loreFilled = false;
        loreToggle.addEventListener("click", async () => {
          const isHidden = desc.classList.toggle("hidden");
          const expanded = !isHidden;
          loreToggle.textContent = expanded ? "▴" : "▾";
          loreToggle.setAttribute("aria-expanded", String(expanded));
          loreToggle.setAttribute("aria-label", expanded ? "Hide module lore" : "Show module lore");
          if (!expanded || loreFilled) return;
          let text = mod.uniEquipDesc;
          if (!text) {
            desc.textContent = "Loading…";
            text = (await loadModuleLore())[mod.uniEquipId];
          }
          desc.textContent = text ? formatDescription(text, null) : "No lore text for this module.";
          loreFilled = !!text;
        });
        heading.appendChild(loreToggle);
        row.appendChild(heading);
        row.appendChild(desc);

        const equipData = battleEquipTable[mod.uniEquipId];
        const phases = (equipData && Array.isArray(equipData.phases) && equipData.phases) || [];
        if (phases.length) {
          const stageList = document.createElement("div");
          stageList.className = "opModuleStageList";
          // "Your stats": grey out (not hide) stages beyond the one this account
          // has reached. A module that isn't unlocked (missing from
          // progress.modules) greys out every stage.
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

  // Sets the "Add to planner" label from the saved planner roster. The
  // click handler below calls this from the modal's onClose rather than
  // right after adding, the same add-then-open sequence as calendar.js's
  // openOperatorModalFromChip() (see its comment for the event-timing race
  // that avoids there; here it just keeps the two consistent).
  function refreshAddToPlannerButton(op) {
    const roster = getPref("planner", "roster", [], (v) => Array.isArray(v));
    const inPlanner = roster.some((e) => e && e.charId === op.charId);
    addToPlannerBtn.textContent = inPlanner ? "✓ In planner (click to edit)" : "+ Add to planner";
    addToPlannerBtn.classList.toggle("inPlanner", inPlanner);
  }

  // A new roster entry's "current" state from the account's synced
  // progress, rather than OperatorEditModal.defaultState()'s E0/Lv1, so
  // adding an owned operator starts from where it really is. Each field is
  // clamped to the same limits as OperatorEditModal.clampState(); a
  // missing or out-of-range field falls back to its "nothing yet" value,
  // so the modal always gets a valid state.
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

  // Re-renders the sections that depend on the "Maxed"/"Your stats"
  // toggle: Stats, Potentials, Skills, Modules, and Skins (for unowned-skin
  // dimming). Release and Talents don't depend on it; renderOperator()
  // renders those itself.
  function renderStatDependentSections(op) {
    const view = effectiveView();
    renderStats(op, view, currentProgress);
    renderPotentials(op, view, currentProgress);
    renderSkills(op, view, currentProgress);
    renderModules(op, view, currentProgress);
    renderSkins(op);
  }

  function renderOperator(charId) {
    // Close any open skin preview: switching operators re-renders in place
    // (jump search, grid, Back/Forward), so it would otherwise stay over the
    // new operator's page.
    hideSkinPreview();
    currentCharId = charId;
    // hasOwnProperty, so "?id=constructor" / "?id=__proto__" don't pick up
    // the plain object's built-ins as if they were operators.
    const op = charId && Object.prototype.hasOwnProperty.call(charTable, charId) ? charTable[charId] : null;
    if (!op) {
      contentEl.classList.add("hidden");
      if (charId) {
        // A bad/unknown "?id=" -- show the error in place of the browse
        // grid rather than alongside it.
        browseEl.classList.add("hidden");
        statusEl.classList.remove("hidden");
        statusEl.textContent = `Couldn't find an operator with id "${charId}".`;
      } else {
        // Landing state: no operator picked yet -- show the browse grid.
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
      // Set by operator_online.py's scrape_PRTS() when the PRTS wiki's
      // obtainMethod for this operator has none of the standard/kernel/
      // limited/collab gacha-pool keywords -- in practice an operator only
      // ever given out through event rewards or shops. Without this it would
      // fall through to the "Standard pool" default.
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

    const mt = usesMachineTranslation(op);
    mtNoticeEl.classList.toggle("hidden", !mt);
    mtToggleEl.textContent = showOriginalZh ? "Show English" : "Show original Chinese";

    renderReleaseInfo(op);
    renderTalents(op);
    renderBaseSkills(op);
    renderStatDependentSections(op); // also renders Skins
    refreshAddToPlannerButton(op);

    jumpBox.clear();
  }

  // Shows another operator (or the grid, for null) as a new history entry,
  // so Back returns to where you were instead of leaving the site. The
  // scroll position of the view being left is saved on its own entry and
  // put back when you return to it (see the popstate handler below).
  function navigateTo(charId) {
    const current = charIdFromUrl() || null;
    if (current !== (charId || null)) {
      history.replaceState({ ...(history.state || {}), scrollY: window.scrollY }, "");
      const params = new URLSearchParams(location.search);
      if (charId) params.set("id", charId);
      else params.delete("id");
      const qs = params.toString();
      // fromGrid: the entry before this one is the browse grid -- lets
      // "<- All operators" go Back to it (see below).
      history.pushState({ fromGrid: current === null }, "", qs ? "?" + qs : location.pathname);
    }
    renderOperator(charId);
    window.scrollTo({ top: 0 });
  }
  // Restoring scroll ourselves (from the saved scrollY) -- the browser's
  // automatic restoration would run before the view is re-rendered.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  // --- browsable grid (landing state) -------------------------------------
  // The whole roster as boxes -- portrait, name, and a border/label tinted
  // by rarity (opRarity1-6 in operator-extra.css) -- with class/rarity/
  // owned filters and a sort order. The jump search box is a separate
  // quick-jump; this is for browsing when you don't know who you want.

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

  // Ascending by EN release date (oldest first); operators with no EN date
  // yet sort to the end. Used by the "Release date" sort and as the
  // rarity sort's tie-break.
  function compareByReleaseDate(a, b) {
    // onlineTime is a "YYYY-MM-DD HH:MM:SS"-style string, so it's parsed
    // with timestampMs() (util.js); subtracting the raw strings would give
    // NaN. A missing or unparseable value sorts last.
    const at = timestampMs(a.onlineTime);
    const bt = timestampMs(b.onlineTime);
    const aVal = isNaN(at) ? Infinity : at;
    const bVal = isNaN(bt) ? Infinity : bt;
    if (aVal !== bVal) return aVal - bVal;

    // Tied on EN date -- usually because neither has one yet (both
    // Infinity). Fall back to the CN release date, which always comes first
    // and is known earlier (see operator_release_dates.json's build in
    // akgcc-extra-data/operator_online.py), so this group still sorts
    // chronologically and an operator with a known CN date sorts ahead of
    // one with none. Name breaks any remaining tie.
    const acn = timestampMs(a.cnOnlineTime);
    const bcn = timestampMs(b.cnOnlineTime);
    const acnVal = isNaN(acn) ? Infinity : acn;
    const bcnVal = isNaN(bcn) ? Infinity : bcn;
    return acnVal - bcnVal || a.name.localeCompare(b.name);
  }

  // The synced owned-operator roster (js/account-sync.js, from
  // cloudflare/depot-import/index.js's extractOwnedOperators()), read
  // fresh on each call so a re-sync shows up on the next render without
  // change detection. Returns null -- not an empty Set -- when there's no
  // roster, so callers can tell "nothing owned" from "unknown" and don't
  // grey out every operator on missing data.
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
    } // else already name-sorted (operatorList's own order)

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
        // Ctrl/Cmd/Shift/middle-click: let the browser open the link in a
        // new tab or window as usual.
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigateTo(op.charId);
      };

      // Greyed out rather than removed when on the "wrong" side of the owned
      // filter, so the grid keeps its overall shape.
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

  // --- jump-to-operator search ---------------------------------------------

  const jumpBox = createSearchBox({
    input: jumpInput,
    results: jumpResultsEl,
    items: () => (dataReady ? operatorList : []),
    buildRow: buildOperatorResultRow,
    onPick: (op) => navigateTo(op.charId),
  });

  // "<- All operators": back to the browse grid, in place. If the grid is
  // the previous history entry (you came from it), that's just Back --
  // which also restores where you'd scrolled to; otherwise it's a new
  // entry like any other navigation.
  backLinkEl.addEventListener("click", (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (history.state && history.state.fromGrid) history.back();
    else navigateTo(null);
  });

  // Back/Forward: the URL has already changed; re-render to match and put
  // the scroll position back where it was on that entry.
  window.addEventListener("popstate", (e) => {
    if (!dataReady) return;
    renderOperator(charIdFromUrl());
    window.scrollTo({ top: (e.state && e.state.scrollY) || 0 });
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
