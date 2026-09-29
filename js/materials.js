(function () {
  // v1 scope: operator level, Elite promotion, and skill level (1-7, shared
  // across all of an operator's skills) for a roster of operators, combined
  // into one running total. NOT yet covered here (planned as fast-follows):
  // skill mastery (M1-M3, per individual skill), module stages, and
  // tracking materials you already own.
  //
  // All the cost data this page needs is plain, static JSON already served
  // by the same raw game-data mirror util.js's DATA_BASE points at -- no
  // new scraper/GitHub Action needed. get_char_table() (from util.js)
  // already fetches character_table.json for the shop page and, along the
  // way, keeps each operator's own "phases" (Elite promotion cost),
  // "skills" (mastery cost, unused here), and "allSkillLvlup" (shared
  // skill-level cost) fields untouched -- so it's reused as-is here rather
  // than fetching character_table.json a second time. Two more files are
  // fetched fresh: gamedata_const.json, for the per-rarity/phase/level
  // EXP+LMD curve and the per-rarity/phase Elite promotion LMD cost, and
  // item_table.json, purely for material names/icons.

  const SERVER = SERVERS.EN; // v1: EN data only

  const searchInput = document.getElementById("operatorSearch");
  const searchResultsEl = document.getElementById("operatorSearchResults");
  const rosterEl = document.getElementById("roster");
  const rosterEmptyEl = document.getElementById("rosterEmpty");
  const summaryEl = document.getElementById("materialsSummary");
  const summaryLmdEl = document.getElementById("summaryLmd");
  const summaryExpEl = document.getElementById("summaryExp");
  const summaryMaterialsEl = document.getElementById("summaryMaterials");

  let charTable = null; // charId -> operator record (rarity already 0-5 numeric, see util.js)
  let operatorList = []; // playable operators, sorted by name, for search
  let gameConst = null; // { characterExpMap, characterUpgradeCostMap, evolveGoldCost }
  let itemTable = null; // itemId -> { name, iconId, rarity, ... }
  let roster = []; // [{ charId, current: {phase, level, skillLevel}, target: {...} }]
  let dataReady = false;
  let highlightedIndex = -1;
  let currentResults = [];

  function loadRosterPref() {
    return getPref("materials", "roster", [], (v) => Array.isArray(v));
  }
  function saveRosterPref() {
    setPref("materials", "roster", roster);
  }

  // --- data loading -----------------------------------------------------

  async function loadData() {
    const [chars, constRes, itemRes] = await Promise.all([
      get_char_table(false, SERVER, false),
      fetch(`${DATA_BASE[SERVER]}/gamedata/excel/gamedata_const.json`),
      fetch(`${DATA_BASE[SERVER]}/gamedata/excel/item_table.json`),
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

    operatorList = Object.values(charTable)
      .filter((op) => op.phases && op.phases.length)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // --- cost calculation ---------------------------------------------------

  function addMaterials(into, list) {
    if (!list) return;
    for (const { id, count } of list) {
      into[id] = (into[id] || 0) + count;
    }
  }

  function calcOperatorCost(op, current, target) {
    let lmd = 0;
    let exp = 0;
    const materials = {};
    const rarity = op.rarity; // already remapped to a 0-5 int by get_char_table()

    // Elite promotions crossed. phases[p].evolveCost is the cost to
    // promote INTO phase p (so phase 0 is always null); evolveGoldCost is
    // the matching LMD-only cost, indexed [rarity][p - 1].
    for (let p = current.phase + 1; p <= target.phase; p++) {
      const goldRow = gameConst.evolveGoldCost[rarity];
      const gold = goldRow ? goldRow[p - 1] : undefined;
      if (typeof gold === "number" && gold > 0) lmd += gold;
      const phaseData = op.phases[p];
      if (phaseData) addMaterials(materials, phaseData.evolveCost);
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
        if (typeof e === "number" && e > 0) exp += e;
        if (typeof l === "number" && l > 0) lmd += l;
      }
    }

    // Skill level (1-7), shared across every skill the operator has at
    // once. allSkillLvlup[i] is the cost to go from skill level i+1 to
    // i+2, so index 0..5 covers levels 1->7. Operators with no skills at
    // all (a handful of very low rarities) have nothing here.
    if (op.allSkillLvlup && op.allSkillLvlup.length) {
      for (let lvl = current.skillLevel; lvl < target.skillLevel; lvl++) {
        const entry = op.allSkillLvlup[lvl - 1];
        if (entry) addMaterials(materials, entry.lvlUpCost);
      }
    }

    return { lmd, exp, materials };
  }

  function calcRosterTotals() {
    let lmd = 0;
    let exp = 0;
    const materials = {};
    for (const entry of roster) {
      const op = charTable[entry.charId];
      if (!op) continue;
      const cost = calcOperatorCost(op, entry.current, entry.target);
      lmd += cost.lmd;
      exp += cost.exp;
      for (const [id, count] of Object.entries(cost.materials)) {
        materials[id] = (materials[id] || 0) + count;
      }
    }
    return { lmd, exp, materials };
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

  // Keeps a state object's phase/level/skillLevel within whatever's
  // actually valid for this operator -- needed both right after restoring
  // a possibly-stale saved roster, and whenever the phase field changes
  // and the level field's own valid range shifts under it.
  function clampState(op, state) {
    state.phase = Math.max(0, Math.min(state.phase, maxPhase(op)));
    state.level = Math.max(1, Math.min(state.level, maxLevelFor(op, state.phase)));
    if (hasSkills(op)) {
      state.skillLevel = Math.max(1, Math.min(state.skillLevel, 7));
    } else {
      state.skillLevel = 1;
    }
  }

  function defaultState(op) {
    return { phase: 0, level: 1, skillLevel: 1 };
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
    const target = defaultState(op);
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

      const opBlock = document.createElement("div");
      opBlock.className = "rosterRowOperator";
      const icon = document.createElement("img");
      icon.className = "rosterRowIcon";
      icon.src = uri_avatar(entry.charId);
      icon.alt = "";
      const name = document.createElement("span");
      name.className = "rosterRowName";
      name.textContent = op.name;
      opBlock.appendChild(icon);
      opBlock.appendChild(name);
      row.appendChild(opBlock);

      const statesBlock = document.createElement("div");
      statesBlock.className = "rosterRowStates";
      statesBlock.appendChild(buildStateFields(op, entry, "current", index));
      statesBlock.appendChild(buildStateFields(op, entry, "target", index));
      row.appendChild(statesBlock);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "rosterRowRemove";
      removeBtn.setAttribute("aria-label", `Remove ${op.name}`);
      removeBtn.textContent = "×";
      removeBtn.onclick = () => removeOperator(index);
      row.appendChild(removeBtn);

      rosterEl.appendChild(row);
    });
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

    summaryMaterialsEl.innerHTML = "";
    const ids = Object.keys(totals.materials).sort((a, b) => {
      const r = itemRarity(b) - itemRarity(a);
      if (r !== 0) return r;
      const nameA = (itemTable[a] && itemTable[a].name) || a;
      const nameB = (itemTable[b] && itemTable[b].name) || b;
      return nameA.localeCompare(nameB);
    });
    for (const id of ids) {
      const count = totals.materials[id];
      if (!count) continue;
      const it = itemTable[id];
      const chip = document.createElement("div");
      chip.className = "summaryMaterialChip";
      if (it && it.iconId) {
        const icon = document.createElement("img");
        icon.className = "summaryMaterialIcon";
        icon.src = uri_item(it.iconId);
        icon.alt = "";
        chip.appendChild(icon);
      }
      const label = document.createElement("span");
      label.className = "summaryMaterialName";
      label.textContent = (it && it.name) || id;
      chip.appendChild(label);
      const countEl = document.createElement("span");
      countEl.className = "summaryMaterialCount";
      countEl.textContent = "×" + count.toLocaleString();
      chip.appendChild(countEl);
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
      icon.src = uri_avatar(op.charId);
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

  // --- boot -----------------------------------------------------------

  roster = loadRosterPref();
  searchInput.disabled = true;
  searchInput.placeholder = "Loading operator data...";
  renderRoster(); // shows the "Loading..." state immediately

  loadData()
    .then(() => {
      dataReady = true;
      sanitizeRoster();
      saveRosterPref();
      searchInput.disabled = false;
      searchInput.placeholder = "Type a name...";
      renderRoster();
      renderSummary();
    })
    .catch((err) => {
      console.error("Failed to load operator/material data:", err);
      rosterEmptyEl.textContent =
        "Couldn't load operator data (see console for details).";
      rosterEmptyEl.classList.remove("hidden");
    });
})();
