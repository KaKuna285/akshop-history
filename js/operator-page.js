(function () {
  // Per-operator hub page: release dates (EN/CN + the event it likely
  // debuted alongside, best-effort), stats at Elite 0 and at max Elite,
  // talents, potential upgrades, skills at every level and mastery rank,
  // and modules -- plus an "Add to planner" button wired to the same
  // shared edit modal the planner and calendar pages use.
  //
  // Routing is a plain `?id=charId` query string (no build-time page
  // generation on this static site) -- same deep-link convention as the
  // planner's own `?add=charId`. Picking a different operator from the
  // jump-search box or a "released alongside" link re-renders in place
  // (history.replaceState, not a real navigation) rather than reloading
  // the page, since every data source below is already loaded for every
  // operator at once.
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
  const contentEl = document.getElementById("operatorContent");
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
  // description -- and wrap emphasized words in the game's own
  // "<@ba.something>...</>" rich-text markup, which isn't real HTML.
  // Strips the markup down to plain text and fills in every token this
  // can resolve; leaves one it can't (an unusual key, or an entirely
  // separate templating convention some newer skills use) exactly as
  // written rather than silently dropping it, so a miss is visible
  // instead of quietly wrong.
  function formatDescription(text, blackboard) {
    if (!text) return "";
    let out = text.replace(/<@[^>]*>/g, "").replace(/<\/>/g, "");
    const bbMap = {};
    (blackboard || []).forEach((b) => {
      if (b && b.key) bbMap[String(b.key).toLowerCase()] = b.value;
    });
    out = out.replace(/\{(-?)([a-zA-Z0-9_.]+)(:([^}]+))?\}/g, (whole, neg, key, _m, fmt) => {
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
      .map((op) => ({ charId: op.charId, name: op.name, rarity: op.rarity, cnOnly: op.cnOnly }))
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

  // Elite 0 Level 1 vs. max Elite at its own max level -- read straight
  // off each phase's own keyframe data (every phase stores exactly an
  // E-start and an E-end snapshot), so this never needs the interpolation
  // math a level in between the two would require.
  function renderStats(op) {
    statsInfoEl.innerHTML = "";
    const phases = op.phases || [];
    const firstPhase = phases[0];
    const lastPhase = phases[phases.length - 1];
    const firstKF = firstPhase && firstPhase.attributesKeyFrames && firstPhase.attributesKeyFrames[0];
    const lastKFList = lastPhase && lastPhase.attributesKeyFrames;
    const lastKF = lastKFList && lastKFList[lastKFList.length - 1];
    if (!firstKF || !lastKF) {
      statsInfoEl.appendChild(textNote("No stats data available."));
      return;
    }
    const table = document.createElement("table");
    table.className = "opStatsTable";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["", `Elite 0, Lv${firstKF.level}`, `Elite ${phases.length - 1}, Lv${lastKF.level}`].forEach((text) => {
      const th = document.createElement("th");
      th.textContent = text;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const rows = [
      ["HP", "maxHp", (v) => Math.round(v).toLocaleString()],
      ["ATK", "atk", (v) => Math.round(v).toLocaleString()],
      ["DEF", "def", (v) => Math.round(v).toLocaleString()],
      ["RES", "magicResistance", (v) => Math.round(v) + "%"],
      ["Redeploy Cost (DP)", "cost", (v) => String(v)],
      ["Block", "blockCnt", (v) => String(v)],
      ["Attack Interval", "baseAttackTime", (v) => v + "s"],
    ];
    rows.forEach(([label, key, fmt]) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = label;
      tr.appendChild(th);
      [firstKF, lastKF].forEach((kf) => {
        const td = document.createElement("td");
        const v = kf.data ? kf.data[key] : undefined;
        td.textContent = v == null ? "—" : fmt(v);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    statsInfoEl.appendChild(table);
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
      heading.textContent = (levels && levels[0] && levels[0].name) || `Skill ${idx + 1}`;
      block.appendChild(heading);
      if (!levels || !levels.length) {
        block.appendChild(textNote("Skill data not available."));
        skillsInfoEl.appendChild(block);
        return;
      }
      const list = document.createElement("div");
      list.className = "opSkillLevelList";
      levels.forEach((lvl, i) => {
        const row = document.createElement("div");
        row.className = "opSkillLevelRow" + (i >= 7 ? " opSkillLevelMastery" : "");
        const labelEl = document.createElement("span");
        labelEl.className = "opSkillLevelLabel";
        labelEl.textContent = i < 7 ? `Lv${i + 1}` : `M${i - 6}`;
        row.appendChild(labelEl);
        const sp = lvl.spData || {};
        const spParts = [];
        if (sp.spCost != null) spParts.push(`${sp.spCost} SP`);
        if (sp.initSp) spParts.push(`${sp.initSp} initial`);
        const spEl = document.createElement("span");
        spEl.className = "opSkillLevelSp";
        spEl.textContent = spParts.join(", ");
        row.appendChild(spEl);
        const descEl = document.createElement("span");
        descEl.className = "opSkillLevelDescription";
        descEl.textContent = formatDescription(lvl.description, lvl.blackboard);
        row.appendChild(descEl);
        list.appendChild(row);
      });
      block.appendChild(list);
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

    (phase.parts || []).forEach((part) => {
      [part.addOrOverrideTalentDataBundle, part.overrideTraitDataBundle].forEach((bundle) => {
        const candidates = bundle && bundle.candidates;
        if (!candidates) return;
        candidates.forEach((cand) => {
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
    const modules = op.modules || [];
    if (!modules.length) {
      modulesInfoEl.appendChild(textNote("No modules."));
      return;
    }
    modules.forEach((mod) => {
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
      const phases = (equipData && equipData.phases) || [];
      if (phases.length) {
        const stageList = document.createElement("div");
        stageList.className = "opModuleStageList";
        phases.forEach((phase) => stageList.appendChild(renderModuleStage(phase)));
        row.appendChild(stageList);
      }

      modulesInfoEl.appendChild(row);
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
      statusEl.classList.remove("hidden");
      statusEl.textContent = charId
        ? `Couldn't find an operator with id "${charId}".`
        : "Search for an operator above to see their details.";
      document.title = "Arknights Operator Details";
      return;
    }

    statusEl.classList.add("hidden");
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

  // Back/forward between two operators (both via the jump box, or a
  // "?id=" link from elsewhere on the site) re-renders in place rather
  // than reloading, since the browser already updates location.search
  // for us before this fires.
  window.addEventListener("popstate", () => {
    if (dataReady) renderOperator(charIdFromUrl());
  });

  loadData()
    .then(() => renderOperator(charIdFromUrl()))
    .catch((err) => {
      console.error("Failed to load operator page data:", err);
      statusEl.textContent = "Couldn't load operator data. Please try refreshing.";
    });
})();
