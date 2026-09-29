(function () {
  // Covers operator level, Elite promotion, skill level (1-7, shared
  // across all of an operator's skills), skill mastery (M1-M3, per
  // individual skill), and module stages, for a roster of operators
  // combined into one running total -- reduced by a depot of materials
  // you already own, if you've entered any. Nothing here tracks a real
  // in-game inventory automatically; the depot is just numbers you type
  // in once and it remembers.
  //
  // All the cost data this page needs is plain, static JSON already served
  // by the same raw game-data mirror util.js's DATA_BASE points at -- no
  // new scraper/GitHub Action needed. get_char_table() (from util.js)
  // already fetches character_table.json for the shop page and, along the
  // way, keeps each operator's own "phases" (Elite promotion cost),
  // "skills" (mastery cost, via each skill's own levelUpCostCond), and
  // "allSkillLvlup" (shared skill-level cost) fields untouched -- so it's
  // reused as-is here rather than fetching character_table.json a second
  // time. Three more files are fetched fresh: gamedata_const.json, for the
  // per-rarity/phase/level EXP+LMD curve and the per-rarity/phase Elite
  // promotion LMD cost; item_table.json, for material names/icons; and
  // uniequip_table.json, for module stage costs (equipDict, keyed by
  // uniEquipId, each entry carrying its own charId back-reference -- there's
  // no separate charId -> module-list table, so that list is built here by
  // filtering). Unlike every other cost source on this page, a module's
  // itemCost list embeds its LMD cost directly as a normal entry (id
  // "4001", type "GOLD") instead of a separate LMD-only table -- addCosts()
  // below is what routes a GOLD-type entry into the LMD total rather than
  // the material list, so that one difference doesn't need special-casing
  // anywhere else.

  const SERVER = SERVERS.EN; // v1: EN data only

  // The community asset mirror uri_avatar()/uri_item() default to (LOCAL,
  // an akgcc/arkdata jsdelivr mirror) doesn't have full coverage -- some
  // rarer materials' icons 404 there. Rather than leave a broken-image
  // glyph in the material list, fall back to the Aceship mirror (a
  // separately-maintained, more complete asset repo already wired up as
  // ASSET_SOURCE.ACESHIP in util.js) and, if that also fails, hide the
  // <img> so the icon's circular background shows as an empty placeholder
  // instead of a jarring broken-image icon.
  function setIconWithFallback(imgEl, primarySrc, fallbackSrc) {
    imgEl.src = primarySrc;
    imgEl.onerror = () => {
      if (fallbackSrc && fallbackSrc !== primarySrc) {
        imgEl.onerror = () => {
          imgEl.onerror = null;
          imgEl.classList.add("iconMissing");
        };
        imgEl.src = fallbackSrc;
      } else {
        imgEl.onerror = null;
        imgEl.classList.add("iconMissing");
      }
    };
  }
  function setAvatarIcon(imgEl, charId) {
    setIconWithFallback(
      imgEl,
      uri_avatar(charId),
      uri_avatar(charId, ASSET_SOURCE.ACESHIP),
    );
  }
  function setItemIcon(imgEl, iconId) {
    if (!iconId) {
      imgEl.classList.add("iconMissing");
      return;
    }
    setIconWithFallback(imgEl, uri_item(iconId), uri_item(iconId, ASSET_SOURCE.ACESHIP));
  }

  const tabBtnRoster = document.getElementById("tabBtnRoster");
  const tabBtnDepot = document.getElementById("tabBtnDepot");
  const tabPanelRoster = document.getElementById("tabPanelRoster");
  const tabPanelDepot = document.getElementById("tabPanelDepot");
  const searchInput = document.getElementById("operatorSearch");
  const searchResultsEl = document.getElementById("operatorSearchResults");
  const rosterEl = document.getElementById("roster");
  const rosterEmptyEl = document.getElementById("rosterEmpty");
  const summaryEl = document.getElementById("materialsSummary");
  const summaryLmdEl = document.getElementById("summaryLmd");
  const summaryExpEl = document.getElementById("summaryExp");
  const summaryCoveredNoteEl = document.getElementById("summaryCoveredNote");
  const summaryMaterialsEl = document.getElementById("summaryMaterials");
  const depotSearchInput = document.getElementById("depotSearch");
  const depotSearchResultsEl = document.getElementById("depotSearchResults");
  const depotListEl = document.getElementById("depotList");
  const depotEmptyEl = document.getElementById("depotEmpty");

  let charTable = null; // charId -> operator record (rarity already 0-5 numeric, see util.js)
  let operatorList = []; // playable operators, sorted by name, for search
  let gameConst = null; // { characterExpMap, characterUpgradeCostMap, evolveGoldCost }
  let itemTable = null; // itemId -> { name, iconId, rarity, ... }
  let itemList = []; // item records, sorted by name, for the depot search
  let roster = []; // [{ charId, current: {...}, target: {...} }] -- see defaultState()
  let depot = {}; // itemId -> count you already own
  let dataReady = false;
  let highlightedIndex = -1;
  let currentResults = [];
  let depotHighlightedIndex = -1;
  let depotCurrentResults = [];

  function loadRosterPref() {
    return getPref("materials", "roster", [], (v) => Array.isArray(v));
  }
  function saveRosterPref() {
    setPref("materials", "roster", roster);
  }
  function loadDepotPref() {
    return getPref("materials", "depot", {}, (v) => v && typeof v === "object");
  }
  function saveDepotPref() {
    setPref("materials", "depot", depot);
  }
  function loadActiveTabPref() {
    return getPref("materials", "activeTab", "roster", (v) => v === "roster" || v === "depot");
  }
  function saveActiveTabPref(tab) {
    setPref("materials", "activeTab", tab);
  }

  // --- tabs --------------------------------------------------------------

  function switchTab(tab) {
    const onRoster = tab === "roster";
    tabBtnRoster.classList.toggle("active", onRoster);
    tabBtnRoster.setAttribute("aria-selected", String(onRoster));
    tabBtnDepot.classList.toggle("active", !onRoster);
    tabBtnDepot.setAttribute("aria-selected", String(!onRoster));
    tabPanelRoster.classList.toggle("hidden", !onRoster);
    tabPanelDepot.classList.toggle("hidden", onRoster);
    saveActiveTabPref(tab);
  }

  tabBtnRoster.addEventListener("click", () => switchTab("roster"));
  tabBtnDepot.addEventListener("click", () => switchTab("depot"));

  // --- data loading -----------------------------------------------------

  async function loadData() {
    const [chars, constRes, itemRes, equipRes] = await Promise.all([
      get_char_table(false, SERVER, false),
      fetch(`${DATA_BASE[SERVER]}/gamedata/excel/gamedata_const.json`),
      fetch(`${DATA_BASE[SERVER]}/gamedata/excel/item_table.json`),
      fetch(`${DATA_BASE[SERVER]}/gamedata/excel/uniequip_table.json`),
    ]);
    charTable = chars;
    const constJson = await fixedJson(constRes);
    gameConst = {
      characterExpMap: constJson.characterExpMap || [],
      characterUpgradeCostMap: constJson.characterUpgradeCostMap || [],
      evolveGoldCost: constJson.evolveGoldCost || [],
    };
    const itemJson = await fixedJson(itemRes);
    itemTable = itemJson.items || itemJson;
    const equipJson = await fixedJson(equipRes);
    const equipDict = equipJson.equipDict || equipJson;

    // Group modules by charId (there's no ready-made charId -> module-list
    // table) and drop the non-upgradeable placeholder entries every
    // operator has (itemCost/typeName2 both null -- their base "no
    // module" outfit, not a real selectable module).
    const modulesByChar = {};
    for (const equip of Object.values(equipDict)) {
      if (!equip.charId || !equip.itemCost || !equip.typeName2) continue;
      (modulesByChar[equip.charId] = modulesByChar[equip.charId] || []).push(equip);
    }
    for (const list of Object.values(modulesByChar)) {
      list.sort((a, b) => (a.charEquipOrder || 0) - (b.charEquipOrder || 0));
    }

    operatorList = Object.values(charTable)
      .filter((op) => op.phases && op.phases.length)
      .sort((a, b) => a.name.localeCompare(b.name));
    operatorList.forEach((op) => {
      op.modules = modulesByChar[op.charId] || [];
    });

    itemList = Object.values(itemTable)
      .filter((it) => it && it.name && it.itemId !== "4001")
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // --- cost calculation ---------------------------------------------------

  // Most cost lists on this page are materials-only (LMD tracked
  // separately), but a module's itemCost mixes its LMD cost directly in
  // as a normal entry (id "4001", type "GOLD") -- routing that into `cost
  // .lmd` here, rather than the material list, keeps every other caller
  // (elite promotion, skill level, mastery) unaware of that difference.
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

  function calcOperatorCost(op, current, target) {
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

  function calcRosterTotals() {
    const totals = { lmd: 0, exp: 0, materials: {} };
    for (const entry of roster) {
      const op = charTable[entry.charId];
      if (!op) continue;
      const cost = calcOperatorCost(op, entry.current, entry.target);
      totals.lmd += cost.lmd;
      totals.exp += cost.exp;
      for (const [id, count] of Object.entries(cost.materials)) {
        totals.materials[id] = (totals.materials[id] || 0) + count;
      }
    }
    return totals;
  }

  // --- state helpers --------------------------------------------------

  function maxPhase(op) {
    return op.phases.length - 1;
  }
  function maxLevelFor(op, phase) {
    const p = op.phases[phase];
    return p ? p.maxLevel : 1;
  }
  function hasSkills(op) {
    return !!(op.allSkillLvlup && op.allSkillLvlup.length);
  }
  function maxMastery(op, skillIdx) {
    const skill = op.skills && op.skills[skillIdx];
    return skill && skill.levelUpCostCond ? skill.levelUpCostCond.length : 0;
  }

  // Keeps a state object's phase/level/skillLevel/mastery/modules within
  // whatever's actually valid for this operator -- needed both right
  // after restoring a possibly-stale saved roster (an operator's own
  // skill/module list can't shrink in practice, but this also guards
  // against a saved roster entry that's just malformed) and whenever the
  // phase field changes and the level field's own valid range shifts
  // under it.
  function clampState(op, state) {
    state.phase = Math.max(0, Math.min(state.phase, maxPhase(op)));
    state.level = Math.max(1, Math.min(state.level, maxLevelFor(op, state.phase)));
    if (hasSkills(op)) {
      state.skillLevel = Math.max(1, Math.min(state.skillLevel, 7));
    } else {
      state.skillLevel = 1;
    }

    const mastery = {};
    (op.skills || []).forEach((skill, idx) => {
      const cap = maxMastery(op, idx);
      const v = (state.mastery && state.mastery[idx]) || 0;
      mastery[idx] = Math.max(0, Math.min(v, cap));
    });
    state.mastery = mastery;

    const modules = {};
    (op.modules || []).forEach((mod) => {
      const v = (state.modules && state.modules[mod.uniEquipId]) || 0;
      modules[mod.uniEquipId] = Math.max(0, Math.min(v, 3));
    });
    state.modules = modules;
  }

  function defaultState(op) {
    return { phase: 0, level: 1, skillLevel: 1, mastery: {}, modules: {} };
  }

  // A newly-added operator's target starts at a common "just promoted"
  // goal -- E2 level 1, skill level 7 -- rather than mirroring their
  // (equally blank) current state, so there's usually something to see
  // in the summary right away. Mastery/module ranks still default to
  // None, since there's no similarly common default for those.
  function defaultTargetState(op) {
    return {
      phase: Math.min(2, maxPhase(op)),
      level: 1,
      skillLevel: hasSkills(op) ? 7 : 1,
      mastery: {},
      modules: {},
    };
  }

  function sanitizeRoster() {
    roster = roster
      .filter((entry) => entry && typeof entry.charId === "string" && charTable[entry.charId])
      .map((entry) => {
        const op = charTable[entry.charId];
        const current = Object.assign(defaultState(op), entry.current || {});
        const target = Object.assign(defaultState(op), entry.target || {});
        clampState(op, current);
        clampState(op, target);
        return { charId: entry.charId, current, target };
      });
  }

  function addOperator(charId) {
    if (roster.some((e) => e.charId === charId)) return;
    const op = charTable[charId];
    if (!op) return;
    const current = defaultState(op);
    const target = defaultTargetState(op);
    roster.push({ charId, current, target });
    saveRosterPref();
    renderRoster();
    renderSummary();
  }

  function removeOperator(index) {
    roster.splice(index, 1);
    saveRosterPref();
    renderRoster();
    renderSummary();
  }

  // --- rendering: roster --------------------------------------------------

  function renderRoster() {
    rosterEl.innerHTML = "";
    if (!dataReady) {
      rosterEmptyEl.textContent = "Loading operator data...";
      rosterEmptyEl.classList.remove("hidden");
      return;
    }
    if (!roster.length) {
      rosterEmptyEl.textContent = "No operators added yet -- search for one above to get started.";
      rosterEmptyEl.classList.remove("hidden");
      return;
    }
    rosterEmptyEl.classList.add("hidden");

    roster.forEach((entry, index) => {
      const op = charTable[entry.charId];
      if (!op) return;
      const row = document.createElement("div");
      row.className = "rosterRow";

      const mainRow = document.createElement("div");
      mainRow.className = "rosterRowMain";

      const opBlock = document.createElement("div");
      opBlock.className = "rosterRowOperator";
      const icon = document.createElement("img");
      icon.className = "rosterRowIcon";
      setAvatarIcon(icon, entry.charId);
      icon.alt = "";
      const name = document.createElement("span");
      name.className = "rosterRowName";
      name.textContent = op.name;
      opBlock.appendChild(icon);
      opBlock.appendChild(name);
      mainRow.appendChild(opBlock);

      const statesBlock = document.createElement("div");
      statesBlock.className = "rosterRowStates";
      statesBlock.appendChild(buildStateFields(op, entry, "current", index));
      statesBlock.appendChild(buildStateFields(op, entry, "target", index));
      mainRow.appendChild(statesBlock);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "rosterRowRemove";
      removeBtn.setAttribute("aria-label", `Remove ${op.name}`);
      removeBtn.textContent = "×";
      removeBtn.onclick = () => removeOperator(index);
      mainRow.appendChild(removeBtn);

      row.appendChild(mainRow);

      const extra = buildExtraFields(op, entry);
      if (extra) row.appendChild(extra);

      rosterEl.appendChild(row);
    });
  }

  // Mastery (per skill) and module (per module) rows -- each is its own
  // independent current -> target rank, so they're rendered as compact
  // "label [current] -> [target]" lines below the main phase/level/skill
  // row rather than folded into buildStateFields's two-column layout.
  function buildExtraFields(op, entry) {
    const masterySkills = (op.skills || []).filter((_, idx) => maxMastery(op, idx) > 0);
    const modules = op.modules || [];
    if (!masterySkills.length && !modules.length) return null;

    const wrap = document.createElement("div");
    wrap.className = "rosterRowExtra";

    op.skills &&
      op.skills.forEach((skill, idx) => {
        const cap = maxMastery(op, idx);
        if (!cap) return;
        wrap.appendChild(
          buildRankRow(`Skill ${idx + 1} Mastery`, entry, "mastery", idx, cap, (n) =>
            n === 0 ? "None" : "M" + n,
          ),
        );
      });

    modules.forEach((mod) => {
      const label = ("Module " + (mod.typeName2 || "")).trim();
      wrap.appendChild(
        buildRankRow(label, entry, "modules", mod.uniEquipId, 3, (n) =>
          n === 0 ? "None" : "Stage " + n,
        ),
      );
    });

    return wrap;
  }

  function buildRankRow(label, entry, stateKey, subKey, max, formatFn) {
    const row = document.createElement("div");
    row.className = "rosterRowRank";
    const labelEl = document.createElement("span");
    labelEl.className = "rosterRowRankLabel";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const buildSelect = (which) => {
      const state = entry[which];
      const sel = document.createElement("select");
      for (let n = 0; n <= max; n++) {
        const opt = document.createElement("option");
        opt.value = String(n);
        opt.textContent = formatFn(n);
        if (n === (state[stateKey][subKey] || 0)) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = () => {
        state[stateKey][subKey] = parseInt(sel.value, 10);
        saveRosterPref();
        renderSummary();
      };
      return sel;
    };

    row.appendChild(buildSelect("current"));
    const arrow = document.createElement("span");
    arrow.className = "rosterRowRankArrow";
    arrow.textContent = "→";
    row.appendChild(arrow);
    row.appendChild(buildSelect("target"));
    return row;
  }

  function buildStateFields(op, entry, which, index) {
    const state = entry[which];
    const wrap = document.createElement("div");
    wrap.className = "rosterRowState";
    const label = document.createElement("div");
    label.className = "rosterRowStateLabel";
    label.textContent = which === "current" ? "Current" : "Target";
    wrap.appendChild(label);

    const fields = document.createElement("div");
    fields.className = "rosterRowStateFields";

    const phaseSelect = document.createElement("select");
    for (let p = 0; p <= maxPhase(op); p++) {
      const opt = document.createElement("option");
      opt.value = String(p);
      opt.textContent = "E" + p;
      if (p === state.phase) opt.selected = true;
      phaseSelect.appendChild(opt);
    }
    phaseSelect.onchange = () => {
      state.phase = parseInt(phaseSelect.value, 10);
      clampState(op, state);
      saveRosterPref();
      renderRoster();
      renderSummary();
    };
    fields.appendChild(phaseSelect);

    const levelInput = document.createElement("input");
    levelInput.type = "number";
    levelInput.min = "1";
    levelInput.max = String(maxLevelFor(op, state.phase));
    levelInput.value = String(state.level);
    levelInput.onchange = () => {
      const v = parseInt(levelInput.value, 10);
      state.level = Number.isFinite(v) ? v : state.level;
      clampState(op, state);
      saveRosterPref();
      renderRoster();
      renderSummary();
    };
    fields.appendChild(levelInput);

    if (hasSkills(op)) {
      const skillSelect = document.createElement("select");
      for (let s = 1; s <= 7; s++) {
        const opt = document.createElement("option");
        opt.value = String(s);
        opt.textContent = "Sk.Lv " + s;
        if (s === state.skillLevel) opt.selected = true;
        skillSelect.appendChild(opt);
      }
      skillSelect.onchange = () => {
        state.skillLevel = parseInt(skillSelect.value, 10);
        saveRosterPref();
        renderRoster();
        renderSummary();
      };
      fields.appendChild(skillSelect);
    }

    wrap.appendChild(fields);
    return wrap;
  }

  // --- rendering: summary --------------------------------------------------

  function itemRarity(id) {
    const it = itemTable[id];
    if (!it || !it.rarity) return 0;
    return RARITY_MAP[it.rarity] ?? 0;
  }

  function renderSummary() {
    if (!dataReady || !roster.length) {
      summaryEl.classList.add("hidden");
      return;
    }
    summaryEl.classList.remove("hidden");
    const totals = calcRosterTotals();
    summaryLmdEl.textContent = totals.lmd.toLocaleString();
    summaryExpEl.textContent = totals.exp.toLocaleString();

    // Materials the depot already fully covers are left out of the list
    // entirely -- the point of tracking what you own is to see what's
    // still missing, not to re-show something you don't need more of.
    const neededIds = Object.keys(totals.materials).filter((id) => totals.materials[id] > 0);
    const shortfallIds = neededIds.filter((id) => {
      const owned = depot[id] || 0;
      return totals.materials[id] - owned > 0;
    });
    const coveredCount = neededIds.length - shortfallIds.length;
    if (coveredCount > 0) {
      summaryCoveredNoteEl.textContent =
        coveredCount === 1
          ? "1 material is fully covered by your depot and left off the list below."
          : `${coveredCount} materials are fully covered by your depot and left off the list below.`;
      summaryCoveredNoteEl.classList.remove("hidden");
    } else {
      summaryCoveredNoteEl.classList.add("hidden");
    }

    summaryMaterialsEl.innerHTML = "";
    const ids = shortfallIds.sort((a, b) => {
      const r = itemRarity(b) - itemRarity(a);
      if (r !== 0) return r;
      const nameA = (itemTable[a] && itemTable[a].name) || a;
      const nameB = (itemTable[b] && itemTable[b].name) || b;
      return nameA.localeCompare(nameB);
    });
    for (const id of ids) {
      const owned = depot[id] || 0;
      const shortfall = totals.materials[id] - owned;
      const it = itemTable[id];
      const chip = document.createElement("div");
      chip.className = "summaryMaterialChip";
      const icon = document.createElement("img");
      icon.className = "summaryMaterialIcon";
      setItemIcon(icon, it && it.iconId);
      icon.alt = "";
      chip.appendChild(icon);
      const label = document.createElement("span");
      label.className = "summaryMaterialName";
      label.textContent = (it && it.name) || id;
      chip.appendChild(label);
      const countEl = document.createElement("span");
      countEl.className = "summaryMaterialCount";
      countEl.textContent = "×" + shortfall.toLocaleString();
      chip.appendChild(countEl);
      if (owned > 0) {
        const ownedEl = document.createElement("span");
        ownedEl.className = "summaryMaterialOwned";
        ownedEl.textContent = `(have ${owned.toLocaleString()} of ${totals.materials[id].toLocaleString()})`;
        chip.appendChild(ownedEl);
      }
      summaryMaterialsEl.appendChild(chip);
    }
  }

  // --- operator search -----------------------------------------------------

  function renderSearchResults(results) {
    currentResults = results;
    highlightedIndex = results.length ? 0 : -1;
    searchResultsEl.innerHTML = "";
    if (!results.length) {
      searchResultsEl.classList.add("hidden");
      return;
    }
    results.forEach((op, i) => {
      const row = document.createElement("div");
      row.className = "operatorSearchResult" + (i === highlightedIndex ? " highlighted" : "");
      const icon = document.createElement("img");
      icon.className = "operatorSearchResultIcon";
      setAvatarIcon(icon, op.charId);
      icon.alt = "";
      const name = document.createElement("span");
      name.className = "operatorSearchResultName";
      name.textContent = op.name;
      const rarity = document.createElement("span");
      rarity.className = "operatorSearchResultRarity";
      rarity.textContent = (op.rarity + 1) + "★";
      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(rarity);
      row.onclick = () => selectSearchResult(op);
      searchResultsEl.appendChild(row);
    });
    searchResultsEl.classList.remove("hidden");
  }

  function selectSearchResult(op) {
    addOperator(op.charId);
    searchInput.value = "";
    renderSearchResults([]);
    searchInput.focus();
  }

  function updateHighlight() {
    Array.from(searchResultsEl.children).forEach((el, i) => {
      el.classList.toggle("highlighted", i === highlightedIndex);
    });
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!dataReady || !q) {
      renderSearchResults([]);
      return;
    }
    const results = operatorList
      .filter((op) => (op.name).toLowerCase().includes(q))
      .slice(0, 20);
    renderSearchResults(results);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (searchResultsEl.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightedIndex = Math.min(highlightedIndex + 1, currentResults.length - 1);
      updateHighlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightedIndex = Math.max(highlightedIndex - 1, 0);
      updateHighlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (currentResults[highlightedIndex]) selectSearchResult(currentResults[highlightedIndex]);
    } else if (e.key === "Escape") {
      renderSearchResults([]);
    }
  });

  document.addEventListener("click", (e) => {
    if (!searchResultsEl.contains(e.target) && e.target !== searchInput) {
      renderSearchResults([]);
    }
  });

  // --- depot -----------------------------------------------------------

  // Drops anything that no longer resolves to a real item, or that's
  // gone non-positive -- the same kind of defensive pass sanitizeRoster()
  // does for the roster, for a saved depot blob that could be stale or
  // hand-edited.
  function sanitizeDepot() {
    const clean = {};
    for (const [id, count] of Object.entries(depot)) {
      if (itemTable[id] && Number.isFinite(count) && count > 0) {
        clean[id] = Math.floor(count);
      }
    }
    depot = clean;
  }

  function addDepotItem(itemId) {
    if (depot[itemId]) return; // already tracked -- edit its count instead
    depot[itemId] = 1;
    saveDepotPref();
    renderDepot();
    renderSummary();
  }

  function renderDepot() {
    depotListEl.innerHTML = "";
    const ids = Object.keys(depot);
    if (!ids.length) {
      depotEmptyEl.classList.remove("hidden");
      return;
    }
    depotEmptyEl.classList.add("hidden");
    ids
      .sort((a, b) => {
        const nameA = (itemTable[a] && itemTable[a].name) || a;
        const nameB = (itemTable[b] && itemTable[b].name) || b;
        return nameA.localeCompare(nameB);
      })
      .forEach((id) => {
        const it = itemTable[id];
        const row = document.createElement("div");
        row.className = "depotRow";
        const icon = document.createElement("img");
        icon.className = "depotRowIcon";
        setItemIcon(icon, it && it.iconId);
        icon.alt = "";
        row.appendChild(icon);
        const name = document.createElement("span");
        name.className = "depotRowName";
        name.textContent = (it && it.name) || id;
        row.appendChild(name);
        const countInput = document.createElement("input");
        countInput.type = "number";
        countInput.min = "0";
        countInput.value = String(depot[id]);
        countInput.onchange = () => {
          const v = parseInt(countInput.value, 10);
          if (Number.isFinite(v) && v > 0) {
            depot[id] = v;
          } else {
            delete depot[id];
          }
          saveDepotPref();
          renderDepot();
          renderSummary();
        };
        row.appendChild(countInput);
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "depotRowRemove";
        removeBtn.setAttribute("aria-label", `Remove ${(it && it.name) || id}`);
        removeBtn.textContent = "×";
        removeBtn.onclick = () => {
          delete depot[id];
          saveDepotPref();
          renderDepot();
          renderSummary();
        };
        row.appendChild(removeBtn);
        depotListEl.appendChild(row);
      });
  }

  // --- depot search (mirrors the operator search above, over itemList) ---

  function renderDepotSearchResults(results) {
    depotCurrentResults = results;
    depotHighlightedIndex = results.length ? 0 : -1;
    depotSearchResultsEl.innerHTML = "";
    if (!results.length) {
      depotSearchResultsEl.classList.add("hidden");
      return;
    }
    results.forEach((it, i) => {
      const row = document.createElement("div");
      row.className =
        "operatorSearchResult" + (i === depotHighlightedIndex ? " highlighted" : "");
      const icon = document.createElement("img");
      icon.className = "operatorSearchResultIcon";
      setItemIcon(icon, it.iconId);
      icon.alt = "";
      const name = document.createElement("span");
      name.className = "operatorSearchResultName";
      name.textContent = it.name;
      row.appendChild(icon);
      row.appendChild(name);
      row.onclick = () => selectDepotSearchResult(it);
      depotSearchResultsEl.appendChild(row);
    });
    depotSearchResultsEl.classList.remove("hidden");
  }

  function selectDepotSearchResult(it) {
    addDepotItem(it.itemId);
    depotSearchInput.value = "";
    renderDepotSearchResults([]);
    depotSearchInput.focus();
  }

  function updateDepotHighlight() {
    Array.from(depotSearchResultsEl.children).forEach((el, i) => {
      el.classList.toggle("highlighted", i === depotHighlightedIndex);
    });
  }

  depotSearchInput.addEventListener("input", () => {
    const q = depotSearchInput.value.trim().toLowerCase();
    if (!dataReady || !q) {
      renderDepotSearchResults([]);
      return;
    }
    const results = itemList.filter((it) => it.name.toLowerCase().includes(q)).slice(0, 20);
    renderDepotSearchResults(results);
  });

  depotSearchInput.addEventListener("keydown", (e) => {
    if (depotSearchResultsEl.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      depotHighlightedIndex = Math.min(depotHighlightedIndex + 1, depotCurrentResults.length - 1);
      updateDepotHighlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      depotHighlightedIndex = Math.max(depotHighlightedIndex - 1, 0);
      updateDepotHighlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (depotCurrentResults[depotHighlightedIndex]) {
        selectDepotSearchResult(depotCurrentResults[depotHighlightedIndex]);
      }
    } else if (e.key === "Escape") {
      renderDepotSearchResults([]);
    }
  });

  document.addEventListener("click", (e) => {
    if (!depotSearchResultsEl.contains(e.target) && e.target !== depotSearchInput) {
      renderDepotSearchResults([]);
    }
  });

  // --- boot -----------------------------------------------------------

  roster = loadRosterPref();
  depot = loadDepotPref();
  switchTab(loadActiveTabPref());
  searchInput.disabled = true;
  searchInput.placeholder = "Loading operator data...";
  depotSearchInput.disabled = true;
  depotSearchInput.placeholder = "Loading item data...";
  renderRoster(); // shows the "Loading..." state immediately

  loadData()
    .then(() => {
      dataReady = true;
      sanitizeRoster();
      saveRosterPref();
      sanitizeDepot();
      saveDepotPref();
      searchInput.disabled = false;
      searchInput.placeholder = "Type a name...";
      depotSearchInput.disabled = false;
      depotSearchInput.placeholder = "Type a material name...";
      renderRoster();
      renderDepot();
      renderSummary();
    })
    .catch((err) => {
      console.error("Failed to load operator/material data:", err);
      rosterEmptyEl.textContent =
        "Couldn't load operator data (see console for details).";
      rosterEmptyEl.classList.remove("hidden");
      depotEmptyEl.textContent =
        "Couldn't load item data (see console for details).";
      depotEmptyEl.classList.remove("hidden");
    });
})();
