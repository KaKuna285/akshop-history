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
  // public knowledge of the game, not pulled from a verified in-game
  // string table (no reliably-fetchable copy of that mapping was found
  // while building this) -- an id missing from either table just falls
  // back to a lightly-capitalized version of the raw id instead of
  // guessing, so a gap here never looks wrong, just plainer than ideal.
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
  const releaseInfoEl = document.getElementById("opReleaseInfo");
  const statsInfoEl = document.getElementById("opStatsInfo");
  const talentsInfoEl = document.getElementById("opTalentsInfo");
  const potentialsInfoEl = document.getElementById("opPotentialsInfo");
  const skillsInfoEl = document.getElementById("opSkillsInfo");
  const modulesInfoEl = document.getElementById("opModulesInfo");

  let charTable = null; // charId -> operator record (EN+CN merged, via OperatorEditModal.loadCharTable())
  let operatorList = []; // playable operators, sorted by name, for the jump-search box
  let skillTable = {}; // skillId -> { levels: [...] } (EN+CN merged)
  let battleEquipTable = {}; // uniEquipId -> { phases: [...] } (EN+CN merged)
  let events = []; // events.json's events[] -- best-effort, may stay empty
  let dataReady = false;
  let currentCharId = null;
  let jumpHighlighted = -1;
  let jumpResults = [];

  // --- best-effort id -> display name lookups (see the file header for
  // why these are reconstructed rather than fetched) -----------------------

  const SUBCLASS_NAMES = {
    // Vanguard
    pioneer: "Pioneer",
    charger: "Charger",
    tactician: "Tactician",
    bearer: "Flagbearer",
    agent: "Agent",
    // Guard
    fighter: "Fighter",
    artsfghter: "Arts Fighter",
    sword: "Swordmaster",
    lord: "Lord",
    musha: "Musha",
    reaper: "Reaper",
    librator: "Liberator",
    centurion: "Centurion",
    crusher: "Crusher",
    instructor: "Instructor",
    // Defender
    protector: "Protector",
    unyield: "Juggernaut",
    fortress: "Fortress",
    artsprotector: "Arts Protector",
    duelist: "Duelist",
    // Medic
    physician: "Medic",
    ringhealer: "Ringhealer",
    healer: "Therapist",
    wandermedic: "Wandering Medic",
    // Sniper
    fastshot: "Marksman",
    longrange: "Deadeye Sniper",
    closerange: "Heavyshooter",
    reaperrange: "Spreadshooter",
    bombarder: "Besieger",
    artilleryman: "Artilleryman",
    funnel: "Flinger",
    // Caster
    splashcaster: "Splash Caster",
    corecaster: "Core Caster",
    chain: "Chain Caster",
    mech: "Mech-accord Caster",
    aoecaster: "Primary Caster",
    // Supporter
    slower: "Decel Binder",
    summoner: "Summoner",
    craftsman: "Augmentor",
    // Specialist
    executor: "Executioner",
    pusher: "Pusher",
    stalker: "Ambusher",
    geek: "Geek",
    hookmaster: "Hookmaster",
    merchant: "Merchant",
    dollkeeper: "Dollkeeper",
    underminer: "Underminer",
    traper: "Trapmaster",
    // Specialist (crowd control / special shapes)
    blastcaster: "Blast Caster",
    phalanx: "Phalanx Caster",
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
    (blackboard || []).forEach((b) => {
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

  async function loadData() {
    const [chars, skills, battleEquip] = await Promise.all([
      OperatorEditModal.loadCharTable(),
      loadSkillTable(SERVER),
      loadBattleEquipTable(SERVER),
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

  // Every stats view on this page assumes max Potential (Potential 6 --
  // all 5 upgrade ranks applied, same assumption OperatorEditModal's own
  // maxState() makes for the planner/calendar pages), so every BUFF-type
  // rank's modifiers are summed once per operator rather than offered as
  // a togglable option.
  function potentialStatBonuses(op) {
    const totals = {};
    (op.potentialRanks || []).forEach((rank) => {
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
    (phase.attributeBlackboard || []).forEach((b) => {
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
  function renderStats(op) {
    statsInfoEl.innerHTML = "";
    const phases = (op.phases || []).filter((ph) => ph && ph.attributesKeyFrames && ph.attributesKeyFrames.length);
    if (!phases.length) {
      statsInfoEl.appendChild(textNote("No stats data available."));
      return;
    }

    const potentialBonuses = potentialStatBonuses(op);
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
    note.textContent = modules.length
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

    // Starts at max Elite, max level, no module equipped -- same view
    // the page used to show (fixed) as its "after" column, so the
    // default look doesn't change.
    let eliteIdx = phases.length - 1;
    let level = phases[eliteIdx].attributesKeyFrames[phases[eliteIdx].attributesKeyFrames.length - 1].level;

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
    const talents = (op.talents || []).filter((t) => t && t.candidates && t.candidates.length);
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

  function renderPotentials(op) {
    potentialsInfoEl.innerHTML = "";
    const ranks = op.potentialRanks || [];
    if (!ranks.length) {
      potentialsInfoEl.appendChild(textNote("No potential upgrades."));
      return;
    }
    ranks.forEach((rank, i) => {
      const row = document.createElement("div");
      row.className = "opPotentialRow";
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
  function renderSkills(op) {
    skillsInfoEl.innerHTML = "";
    const refs = Array.isArray(op.skills) ? op.skills : [];
    if (!refs.length) {
      skillsInfoEl.appendChild(textNote("No skills."));
      return;
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

      // Defaults to the highest mastery rank, same "show the best state
      // first" default as the stats sliders above.
      update(levels.length - 1);
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

    const deltas = (phase.attributeBlackboard || []).filter((b) => b && b.key && b.value);
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
    (phase.parts || []).forEach((part) => {
      if (!part) return;
      [part.addOrOverrideTalentDataBundle, part.overrideTraitDataBundle].forEach((bundle) => {
        const candidates = bundle && bundle.candidates;
        if (!Array.isArray(candidates)) return;
        candidates.forEach((cand) => {
          if (!cand) return;
          const text = cand.description || cand.upgradeDescription || cand.additionalDescription;
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

  function renderModules(op) {
    modulesInfoEl.innerHTML = "";
    const modules = (op.modules || []).filter(Boolean);
    if (!modules.length) {
      modulesInfoEl.appendChild(textNote("No modules."));
      return;
    }
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
        row.appendChild(heading);
        if (mod.uniEquipDesc) {
          const desc = document.createElement("div");
          desc.className = "opModuleDescription";
          desc.textContent = formatDescription(mod.uniEquipDesc, null);
          row.appendChild(desc);
        }

        const equipData = battleEquipTable[mod.uniEquipId];
        const phases = (equipData && Array.isArray(equipData.phases) && equipData.phases) || [];
        if (phases.length) {
          const stageList = document.createElement("div");
          stageList.className = "opModuleStageList";
          phases.forEach((phase) => {
            if (phase) stageList.appendChild(renderModuleStage(phase));
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

  addToPlannerBtn.addEventListener("click", () => {
    const op = charTable && charTable[currentCharId];
    if (!op) return;
    let roster = getPref("planner", "roster", [], (v) => Array.isArray(v));
    let entry = roster.find((e) => e && e.charId === op.charId);
    if (!entry) {
      entry = {
        charId: op.charId,
        current: OperatorEditModal.defaultState(),
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

  function renderOperator(charId) {
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
    }
    poolBadgeEl.textContent = poolLabel;
    poolBadgeEl.className = "opBadge opPoolBadge " + poolClass;

    renderReleaseInfo(op);
    renderStats(op);
    renderTalents(op);
    renderPotentials(op);
    renderSkills(op);
    renderModules(op);
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
    return aVal - bVal || a.name.localeCompare(b.name);
  }

  function renderGrid() {
    gridEl.innerHTML = "";
    const classVal = classFilterEl.value;
    const rarityVal = rarityFilterEl.value;
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
  sortByEl.value = getPref("operator", "sortBy", sortByEl.value, (v) => v === "name" || v === "rarity" || v === "release");
  sortByEl.addEventListener("change", () => {
    setPref("operator", "sortBy", sortByEl.value);
    renderGrid();
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
