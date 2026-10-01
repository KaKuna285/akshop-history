(function () {
  // Covers operator level, Elite promotion, skill level (1-7, shared
  // across all of an operator's skills), skill mastery (M1-M3, per
  // individual skill), and module stages, for a roster of operators
  // combined into one running total -- reduced by a depot of materials
  // (and LMD, and EXP -- both are real, searchable items in the game
  // data, ids "4001" and "5001" respectively) you already own, if
  // you've entered any. Nothing here tracks a real in-game inventory
  // automatically; the depot is just numbers you type in once and it
  // remembers.
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
  // promotion LMD cost; item_table.json, for material names/icons (and
  // LMD/EXP's own names/icons); and uniequip_table.json, for module stage
  // costs (equipDict, keyed by uniEquipId, each entry carrying its own
  // charId back-reference -- there's no separate charId -> module-list
  // table, so that list is built here by filtering). Unlike every other
  // cost source on this page, a module's itemCost list embeds its LMD cost
  // directly as a normal entry (id "4001", type "GOLD") instead of a
  // separate LMD-only table -- addCosts() (in util.js, alongside
  // calcOperatorCost()) is what routes a GOLD-type entry into the LMD
  // total rather than the material list, so that one difference doesn't
  // need special-casing anywhere else.
  //
  // Roster entries render as compact cards on the left of the Roster tab;
  // clicking one opens the edit modal (current/target phase, level, skill
  // level, mastery, modules) rather than editing inline, which leaves the
  // "what you still need" list room to read as an actual list on the
  // right instead of a cramped, wrapped cloud of chips.

  // EN is the primary/default server; CN is merged in on top of it in
  // loadData() below to cover operators/materials not yet released on EN
  // (flagged cnOnly and badged in the UI) -- see the merge block there.
  const SERVER = SERVERS.EN;

  // The community asset mirror uri_avatar()/uri_item() default to (LOCAL,
  // an akgcc/arkdata jsdelivr mirror) doesn't have full coverage -- some
  // rarer materials' icons 404 there. Rather than leave a broken-image
  // glyph in the material list, fall back to the Aceship mirror (a
  // separately-maintained, more complete asset repo already wired up as
  // ASSET_SOURCE.ACESHIP in util.js) and, if that also fails, hide the
  // <img> so the icon's circular background shows as an empty placeholder
  // instead of a jarring broken-image icon.
  //
  // Both of those sources are mirrors of RELEASED client data (an EN
  // client asset dump, and an EN-focused community art repo respectively)
  // -- an operator/material that isn't out on EN yet has no art in either
  // one, by construction, regardless of iconId/charId correctness. There's
  // no reliable third-party mirror of actual CN client art currently
  // reachable (checked: a dedicated CN asset-dump repo exists but its real
  // path layout isn't discoverable, and wiki sites that do show this art
  // block scripted access). So for a cnOnly entity specifically, once both
  // real sources fail, show a small generated "CN" placeholder instead of
  // the plain blank circle -- same "nothing to show yet" outcome, but it
  // reads as expected/labeled rather than looking like a broken image.
  //
  // CN_ICON_PLACEHOLDER/setIconWithFallback/setAvatarIcon/buildCnBadge
  // used to live here too, but are also needed by the calendar page (for
  // the shared operator edit modal -- see js/operator-edit-modal.js) and
  // now live in util.js, already loaded by both pages, instead.
  function setItemIcon(imgEl, iconId, isCnOnly) {
    if (!iconId) {
      if (isCnOnly) {
        imgEl.src = CN_ICON_PLACEHOLDER;
      } else {
        imgEl.classList.add("iconMissing");
      }
      return;
    }
    setIconWithFallback(imgEl, uri_item(iconId), uri_item(iconId, ASSET_SOURCE.ACESHIP), isCnOnly);
  }

  // buildCnBadge() (small "CN" tag for anything flagged cnOnly during the
  // EN+CN merge in loadData() -- not yet released on the EN server) also
  // moved to util.js alongside setAvatarIcon(), for the same reason.

  // LMD and EXP are real, individually-iconed items in the game data
  // (ids "4001" and "5001") -- kept searchable/addable in the depot like
  // any other material, but their owned amounts subtract from the LMD/EXP
  // totals directly rather than ever appearing as a generic material row.
  const LMD_ITEM_ID = "4001";
  const EXP_ITEM_ID = "5001";

  const planLinkStatusEl = document.getElementById("planLinkStatus");
  const tabBtnRoster = document.getElementById("tabBtnRoster");
  const tabBtnDepot = document.getElementById("tabBtnDepot");
  const tabPanelRoster = document.getElementById("tabPanelRoster");
  const tabPanelDepot = document.getElementById("tabPanelDepot");
  const searchInput = document.getElementById("operatorSearch");
  const searchResultsEl = document.getElementById("operatorSearchResults");
  const rosterCardsEl = document.getElementById("rosterCards");
  const rosterEmptyEl = document.getElementById("rosterEmpty");
  const summaryEl = document.getElementById("plannerSummary");
  const summaryLmdEl = document.getElementById("summaryLmd");
  const summaryExpEl = document.getElementById("summaryExp");
  const summaryLmdOwnedEl = document.getElementById("summaryLmdOwned");
  const summaryExpOwnedEl = document.getElementById("summaryExpOwned");
  const summaryCoveredNoteEl = document.getElementById("summaryCoveredNote");
  const summaryMaterialsEl = document.getElementById("summaryMaterials");
  const depotSearchInput = document.getElementById("depotSearch");
  const depotSearchResultsEl = document.getElementById("depotSearchResults");
  const depotListEl = document.getElementById("depotList");
  const depotEmptyEl = document.getElementById("depotEmpty");
  const depotImportEl = document.getElementById("depotImport");
  const depotImportKeyEl = document.getElementById("depotImportKey");
  const depotImportEmailEl = document.getElementById("depotImportEmail");
  const depotImportSendCodeBtn = document.getElementById("depotImportSendCode");
  const depotImportCodeRowEl = document.getElementById("depotImportCodeRow");
  const depotImportCodeEl = document.getElementById("depotImportCode");
  const depotImportFetchRowEl = document.getElementById("depotImportFetchRow");
  const depotImportFetchBtn = document.getElementById("depotImportFetch");
  const depotImportStatusEl = document.getElementById("depotImportStatus");
  const depotImportConfirmEl = document.getElementById("depotImportConfirm");
  const depotImportSummaryEl = document.getElementById("depotImportSummary");
  const depotImportApplyBtn = document.getElementById("depotImportApply");
  const depotImportCancelBtn = document.getElementById("depotImportCancel");
  // The edit modal itself (current/target phase, level, skill, mastery,
  // modules) is owned by js/operator-edit-modal.js -- shared with the
  // calendar page, which opens the exact same card in place rather than
  // navigating here. See openOperatorModal() below.

  let charTable = null; // charId -> operator record (rarity already 0-5 numeric, see util.js)
  let operatorList = []; // playable operators, sorted by name, for search
  let gameConst = null; // { characterExpMap, characterUpgradeCostMap, evolveGoldCost }
  let itemTable = null; // itemId -> { name, iconId, rarity, ... }
  let itemList = []; // item records (incl. LMD/EXP), sorted by name, for the depot search
  let roster = []; // [{ charId, current: {...}, target: {...} }] -- see defaultState()
  let depot = {}; // itemId -> count you already own (incl. "4001" LMD, "5001" EXP)
  let dataReady = false;
  let highlightedIndex = -1;
  let currentResults = [];
  let depotHighlightedIndex = -1;
  let depotCurrentResults = [];

  // A one-time migration for anyone who used this page back when it was
  // called "materials" -- their roster/depot/active-tab were saved under
  // the "materials" prefs section, and this page now reads/writes
  // "planner" instead. Rename the section in place (once) rather than
  // silently discarding their saved data.
  (function migrateFromMaterialsSection() {
    const blob = akPrefsLoadBlob();
    if (blob.materials && !blob.planner) {
      blob.planner = blob.materials;
      delete blob.materials;
      akPrefsSaveBlob(blob);
    }
  })();

  function loadRosterPref() {
    return getPref("planner", "roster", [], (v) => Array.isArray(v));
  }
  function saveRosterPref() {
    setPref("planner", "roster", roster);
  }
  function loadDepotPref() {
    return getPref("planner", "depot", {}, (v) => v && typeof v === "object");
  }
  function saveDepotPref() {
    setPref("planner", "depot", depot);
  }
  function loadActiveTabPref() {
    return getPref("planner", "activeTab", "roster", (v) => v === "roster" || v === "depot");
  }
  function saveActiveTabPref(tab) {
    setPref("planner", "activeTab", tab);
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
    const [chars, const_, items, equipRes] = await Promise.all([
      get_char_table(false, SERVER, false),
      loadGameConst(SERVER),
      loadItemTable(SERVER),
      fetch(`${DATA_BASE[SERVER]}/gamedata/excel/uniequip_table.json`),
    ]);
    charTable = chars;
    gameConst = const_;
    itemTable = items;
    const equipJson = await fixedJson(equipRes);
    const equipDict = equipJson.equipDict || equipJson;

    // Operators/materials not yet released on EN simply have no entry in
    // EN's own tables at all -- there's no per-record flag to check.
    // Fetching CN's copies of the same three files and adding whatever
    // charIds/itemIds are missing from EN (flagged cnOnly so the UI can
    // badge them) covers those without disturbing anything EN already
    // has. This is best-effort: if the CN mirror is slow or down, EN data
    // should still load and work normally, just without CN-exclusive
    // entries for that session.
    try {
      const [cnChars, cnItemRes, cnEquipRes] = await Promise.all([
        get_char_table(false, SERVERS.CN, false),
        fetch(`${DATA_BASE[SERVERS.CN]}/gamedata/excel/item_table.json`),
        fetch(`${DATA_BASE[SERVERS.CN]}/gamedata/excel/uniequip_table.json`),
      ]);
      for (const [charId, op] of Object.entries(cnChars)) {
        if (!charTable[charId]) {
          op.cnOnly = true;
          // CN's own character_table.json has no English localization for
          // an operator EN hasn't gotten yet -- "name" is in Chinese, so
          // searching/reading it by an English term wouldn't work at all.
          // "appellation" is the operator's internal codename and is
          // always Latin (this is how every other AK tool displays
          // not-yet-localized operators too) -- use that as the
          // searchable/displayed name instead, keeping the original
          // Chinese name (cnName) around only for the CN badge's tooltip.
          if (op.appellation && /[A-Za-z]/.test(op.appellation)) {
            op.cnName = op.name;
            op.name = op.appellation;
          }
          charTable[charId] = op;
        }
      }
      const cnItemJson = await fixedJson(cnItemRes);
      const cnItemTable = cnItemJson.items || cnItemJson;
      for (const [itemId, it] of Object.entries(cnItemTable)) {
        if (!itemTable[itemId]) {
          it.cnOnly = true;
          itemTable[itemId] = it;
        }
      }
      const cnEquipJson = await fixedJson(cnEquipRes);
      const cnEquipDict = cnEquipJson.equipDict || cnEquipJson;
      for (const [uniEquipId, equip] of Object.entries(cnEquipDict)) {
        if (!equipDict[uniEquipId]) equipDict[uniEquipId] = equip;
      }
    } catch (err) {
      console.warn(
        "Couldn't load CN-exclusive operator/material data (EN data still loaded fine):",
        err,
      );
    }

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

    // LMD and EXP are real items too (ids "4001"/"5001") and stay in this
    // list -- searchable and addable to the depot like any other
    // material, same as they are in-game.
    itemList = Object.values(itemTable)
      .filter((it) => it && it.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // --- cost calculation ---------------------------------------------------
  // addCosts()/calcOperatorCost() now live in util.js -- shared with the
  // operator page's own "cost to fully max" table -- so calcOperatorCost()
  // here takes gameConst explicitly rather than closing over this page's
  // own module-level variable.

  function calcRosterTotals() {
    const totals = { lmd: 0, exp: 0, materials: {} };
    for (const entry of roster) {
      const op = charTable[entry.charId];
      if (!op) continue;
      const cost = calcOperatorCost(op, entry.current, entry.target, gameConst);
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

  // Deep-link support: /planner/?add=charId[,charId2,...], set by the
  // calendar page's "Add to planner" links (js/calendar.js) next to an
  // event's newly-released operators. Adds whichever charIds are
  // recognized, switches to the Roster tab, leaves a short status note,
  // and strips "add" from the URL so refreshing or bookmarking the page
  // doesn't keep re-adding it on every load.
  function applyAddFromLink() {
    const params = new URLSearchParams(location.search);
    const raw = params.get("add");
    if (raw) {
      const added = [];
      const alreadyHad = [];
      for (const charId of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
        const op = charTable[charId];
        if (!op) continue; // unknown/stale charId in the URL -- ignore silently
        if (roster.some((e) => e.charId === charId)) {
          alreadyHad.push(op.name);
        } else {
          addOperator(charId);
          added.push(op.name);
        }
      }
      if (added.length || alreadyHad.length) {
        switchTab("roster");
        const parts = [];
        if (added.length) parts.push(`Added ${added.join(", ")} to your roster.`);
        if (alreadyHad.length) parts.push(`Already in your roster: ${alreadyHad.join(", ")}.`);
        planLinkStatusEl.textContent = parts.join(" ");
        planLinkStatusEl.classList.remove("hidden");
      }
    }
    if (params.has("add")) {
      params.delete("add");
      const newSearch = params.toString();
      history.replaceState(
        null,
        "",
        location.pathname + (newSearch ? `?${newSearch}` : "") + location.hash,
      );
    }
  }

  function removeOperator(index) {
    roster.splice(index, 1);
    saveRosterPref();
    OperatorEditModal.close(); // indices shift on removal -- simplest to just close
    renderRoster();
    renderSummary();
  }

  // --- rendering: roster cards --------------------------------------------

  // A multi-line summary of where an operator is vs. where they're headed,
  // set as the card's hover tooltip (native title attribute) rather than
  // shown inline, so the card itself stays compact. Elite/level always
  // shows; skill level shows as a current->target range UNLESS at least
  // one mastery target is set, in which case the skill-level line is
  // replaced entirely by the selected masteries (one "S{skill}M{rank}"
  // entry per skill with a nonzero target, e.g. "S2M3"); modules only
  // appear when a nonzero target stage is set, as "Mod {letter} Lv. {n}".
  function formatCardTooltip(op, entry) {
    const c = entry.current;
    const t = entry.target;
    const lines = [];

    let eliteLine = `E${c.phase} Lv${c.level}`;
    if (c.phase !== t.phase || c.level !== t.level) {
      eliteLine += ` → E${t.phase} Lv${t.level}`;
    }
    lines.push(eliteLine);

    if (hasSkills(op)) {
      const masteries = [];
      (op.skills || []).forEach((skill, idx) => {
        const tgtM = (t.mastery && t.mastery[idx]) || 0;
        if (tgtM > 0) masteries.push(`S${idx + 1}M${tgtM}`);
      });
      if (masteries.length) {
        lines.push(masteries.join(", "));
      } else if (c.skillLevel !== t.skillLevel) {
        lines.push(`Sk.Lv ${c.skillLevel} → ${t.skillLevel}`);
      } else {
        lines.push(`Sk.Lv ${c.skillLevel}`);
      }
    }

    (op.modules || []).forEach((mod) => {
      const tgtS = (t.modules && t.modules[mod.uniEquipId]) || 0;
      if (tgtS > 0) {
        lines.push(`Mod ${mod.typeName2 || "?"} Lv. ${tgtS}`);
      }
    });

    return lines.join("\n");
  }

  function renderRoster() {
    rosterCardsEl.innerHTML = "";
    // #rosterLayout (and the "Add operator" search bar inside it) always
    // stays visible now, even with an empty/loading roster -- only the
    // empty-state message vs. the card list toggles within it.
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
      const card = document.createElement("div");
      card.className = "operatorCard";
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");

      const icon = document.createElement("img");
      icon.className = "operatorCardIcon";
      setAvatarIcon(icon, entry.charId, op.cnOnly);
      icon.alt = "";
      card.appendChild(icon);

      const info = document.createElement("div");
      info.className = "operatorCardInfo";
      const name = document.createElement("span");
      name.className = "operatorCardName";
      name.textContent = op.name;
      info.appendChild(name);
      if (op.cnOnly) info.appendChild(buildCnBadge(op));
      card.appendChild(info);
      card.title = formatCardTooltip(op, entry);

      const detailsLink = document.createElement("a");
      detailsLink.className = "operatorCardDetails";
      detailsLink.href = `/operator/?id=${encodeURIComponent(entry.charId)}`;
      detailsLink.title = `View ${op.name}'s operator page`;
      detailsLink.setAttribute("aria-label", `View ${op.name}'s operator page`);
      detailsLink.textContent = "ⓘ";
      // Otherwise this bubbles up to the card's own onclick below and
      // opens the edit modal instead of following the link.
      detailsLink.onclick = (e) => e.stopPropagation();
      card.appendChild(detailsLink);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "operatorCardRemove";
      removeBtn.setAttribute("aria-label", `Remove ${op.name}`);
      removeBtn.textContent = "×";
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        removeOperator(index);
      };
      card.appendChild(removeBtn);

      card.onclick = () => openOperatorModal(index);
      card.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openOperatorModal(index);
        }
      };

      rosterCardsEl.appendChild(card);
    });
  }

  // --- edit modal ----------------------------------------------------------
  //
  // The actual modal (DOM, fields, current/target/mastery/module rows) is
  // js/operator-edit-modal.js, shared as-is with the calendar page so
  // "Add to planner" there opens this exact same card in place instead of
  // navigating here. This is just the thin wiring: which roster index is
  // being edited, and what to do when it changes or is removed.
  function openOperatorModal(index) {
    const entry = roster[index];
    if (!entry) return;
    const op = charTable[entry.charId];
    if (!op) return;
    OperatorEditModal.open(op, entry, {
      onChange: () => {
        saveRosterPref();
        renderRoster();
        renderSummary();
      },
      onRemove: () => removeOperator(index),
    });
  }

  // --- rendering: summary --------------------------------------------------

  function itemRarity(id) {
    const it = itemTable[id];
    if (!it || !it.rarity) return 0;
    return RARITY_MAP[it.rarity] ?? 0;
  }

  // LMD/EXP tiles show what's still needed after the depot's owned
  // amount, same idea as a material row's shortfall -- but since the
  // tile itself can't be hidden the way a fully-covered material row is,
  // a full cover gets its own short note instead of "(have X of Y)".
  function formatOwnedNote(owned, needed) {
    if (owned <= 0) return null;
    if (needed - owned <= 0) return "Fully covered by your depot";
    return `(have ${owned.toLocaleString()} of ${needed.toLocaleString()})`;
  }

  // Builds one material row, shared by every category in the grouped
  // summary list below -- identical markup to what used to be inlined
  // directly in renderSummary()'s loop.
  function buildSummaryMaterialRow(id, totals) {
    const owned = depot[id] || 0;
    const shortfall = totals.materials[id] - owned;
    const it = itemTable[id];
    const row = document.createElement("div");
    row.className = "summaryMaterialRow";
    const icon = document.createElement("img");
    icon.className = "summaryMaterialIcon";
    setItemIcon(icon, it && it.iconId, it && it.cnOnly);
    icon.alt = "";
    row.appendChild(icon);
    const labelWrap = document.createElement("span");
    labelWrap.className = "summaryMaterialNameWrap";
    const label = document.createElement("span");
    label.className = "summaryMaterialName";
    label.textContent = (it && it.name) || id;
    labelWrap.appendChild(label);
    if (it && it.cnOnly) labelWrap.appendChild(buildCnBadge(it));
    row.appendChild(labelWrap);
    const countEl = document.createElement("span");
    countEl.className = "summaryMaterialCount";
    countEl.textContent = "×" + shortfall.toLocaleString();
    row.appendChild(countEl);
    if (owned > 0) {
      const ownedEl = document.createElement("span");
      ownedEl.className = "summaryMaterialOwned";
      ownedEl.textContent = `(have ${owned.toLocaleString()} of ${totals.materials[id].toLocaleString()})`;
      row.appendChild(ownedEl);
    }
    return row;
  }

  // Which bucket a material's shortfall row belongs in. Module tokens
  // ("mod_unlock_token", "mod_update_token_1/2") are identified by their
  // itemId prefix -- that's stable regardless of localization. Chips
  // (class chips, dualchips, and their "... Pack" bulk forms) and skill
  // summary books don't share an id pattern the way module tokens do,
  // but their EN names do: every chip's name contains "Chip" and every
  // skill-level book is named "Skill Summary - N". Everything left over
  // is an ordinary farmable material.
  function categorizeMaterial(id) {
    if (id.startsWith("mod_")) return "module";
    const name = (itemTable[id] && itemTable[id].name) || "";
    if (/skill summary/i.test(name)) return "skill";
    if (/chip/i.test(name)) return "chip";
    return "farm";
  }

  function renderSummary() {
    if (!dataReady || !roster.length) {
      summaryEl.classList.add("hidden");
      return;
    }
    summaryEl.classList.remove("hidden");
    const totals = calcRosterTotals();

    const lmdOwned = depot[LMD_ITEM_ID] || 0;
    const expOwned = depot[EXP_ITEM_ID] || 0;
    summaryLmdEl.textContent = Math.max(0, totals.lmd - lmdOwned).toLocaleString();
    summaryExpEl.textContent = Math.max(0, totals.exp - expOwned).toLocaleString();
    const lmdNote = formatOwnedNote(lmdOwned, totals.lmd);
    const expNote = formatOwnedNote(expOwned, totals.exp);
    summaryLmdOwnedEl.textContent = lmdNote || "";
    summaryLmdOwnedEl.classList.toggle("hidden", !lmdNote);
    summaryExpOwnedEl.textContent = expNote || "";
    summaryExpOwnedEl.classList.toggle("hidden", !expNote);

    // Materials the depot already fully covers are left out of the list
    // entirely -- the point of tracking what you own is to see what's
    // still missing, not to re-show something you don't need more of.
    // LMD/EXP never belong in this list at all (they have their own
    // tiles above), even though nothing currently routes them here.
    const neededIds = Object.keys(totals.materials).filter(
      (id) => totals.materials[id] > 0 && id !== LMD_ITEM_ID && id !== EXP_ITEM_ID,
    );
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
    const byRarityThenName = (a, b) => {
      const r = itemRarity(b) - itemRarity(a);
      if (r !== 0) return r;
      const nameA = (itemTable[a] && itemTable[a].name) || a;
      const nameB = (itemTable[b] && itemTable[b].name) || b;
      return nameA.localeCompare(nameB);
    };

    // Group the shortfall list into a few recognizable buckets instead
    // of one long undifferentiated list: chips, skill summaries, and
    // module tokens each get their own (usually short) section, while
    // the remaining, usually much longer, pool of ordinary farmable
    // materials stays one section broken up by rarity rather than
    // getting a heading per item.
    const buckets = { chip: [], skill: [], module: [], farm: [] };
    for (const id of shortfallIds) buckets[categorizeMaterial(id)].push(id);
    for (const key of Object.keys(buckets)) buckets[key].sort(byRarityThenName);

    const appendHeading = (className, text) => {
      const heading = document.createElement("div");
      heading.className = className;
      heading.textContent = text;
      summaryMaterialsEl.appendChild(heading);
    };
    const appendRows = (ids) => {
      for (const id of ids) summaryMaterialsEl.appendChild(buildSummaryMaterialRow(id, totals));
    };

    if (buckets.chip.length) {
      appendHeading("summaryCategoryHeading", "Chips");
      appendRows(buckets.chip);
    }
    if (buckets.skill.length) {
      appendHeading("summaryCategoryHeading", "Skill Summaries");
      appendRows(buckets.skill);
    }
    if (buckets.module.length) {
      appendHeading("summaryCategoryHeading", "Module Items");
      appendRows(buckets.module);
    }
    if (buckets.farm.length) {
      appendHeading("summaryCategoryHeading", "Farming Materials");
      let lastRarity = null;
      for (const id of buckets.farm) {
        const rarity = itemRarity(id);
        if (rarity !== lastRarity) {
          appendHeading("summaryRarityHeading", rarity + 1 + "★");
          lastRarity = rarity;
        }
        summaryMaterialsEl.appendChild(buildSummaryMaterialRow(id, totals));
      }
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
      const detailsLink = document.createElement("a");
      detailsLink.className = "operatorSearchResultDetails";
      detailsLink.href = `/operator/?id=${encodeURIComponent(op.charId)}`;
      detailsLink.title = `View ${op.name}'s operator page`;
      detailsLink.setAttribute("aria-label", `View ${op.name}'s operator page`);
      detailsLink.textContent = "ⓘ";
      // Otherwise this bubbles up to the row's own onclick below and adds
      // the operator to the roster instead of following the link.
      detailsLink.onclick = (e) => e.stopPropagation();
      row.appendChild(detailsLink);
      row.onclick = () => selectSearchResult(op);
      searchResultsEl.appendChild(row);
    });
    searchResultsEl.classList.remove("hidden");
  }

  function selectSearchResult(op) {
    addOperator(op.charId);
    searchInput.value = "";
    renderSearchResults([]);
    const index = roster.findIndex((e) => e.charId === op.charId);
    if (index >= 0) {
      openOperatorModal(index);
    } else {
      searchInput.focus();
    }
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

  // Builds one editable depot row -- same icon/name layout as a Roster-tab
  // material row, but with an amount you can actually change instead of a
  // read-only shortfall figure. The count displays with thousands
  // separators (large LMD/EXP totals are otherwise unreadable) and shows
  // plain digits only while focused, so editing isn't fighting commas.
  function buildDepotRow(id) {
    const it = itemTable[id];
    const displayName = (it && it.name) || id;
    const row = document.createElement("div");
    row.className = "depotRow";
    const icon = document.createElement("img");
    icon.className = "depotRowIcon";
    setItemIcon(icon, it && it.iconId, it && it.cnOnly);
    icon.alt = "";
    row.appendChild(icon);
    const nameWrap = document.createElement("span");
    nameWrap.className = "depotRowNameWrap";
    const name = document.createElement("span");
    name.className = "depotRowName";
    name.textContent = displayName;
    nameWrap.appendChild(name);
    if (it && it.cnOnly) nameWrap.appendChild(buildCnBadge(it));
    row.appendChild(nameWrap);

    const commit = (rawValue) => {
      const digits = rawValue.replace(/[^0-9]/g, "");
      const v = digits ? parseInt(digits, 10) : NaN;
      if (Number.isFinite(v) && v > 0) {
        depot[id] = v;
      } else {
        delete depot[id];
      }
      saveDepotPref();
      renderDepot();
      renderSummary();
    };

    const countInput = document.createElement("input");
    countInput.type = "text";
    countInput.inputMode = "numeric";
    countInput.autocomplete = "off";
    countInput.className = "depotRowCount";
    countInput.setAttribute("aria-label", `Amount of ${displayName} you own`);
    countInput.value = (depot[id] || 0).toLocaleString();
    countInput.addEventListener("focus", () => {
      countInput.value = String(depot[id] || 0);
      countInput.select();
    });
    countInput.addEventListener("blur", () => {
      countInput.value = (depot[id] || 0).toLocaleString();
    });
    countInput.onchange = () => commit(countInput.value);
    row.appendChild(countInput);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "depotRowRemove";
    removeBtn.setAttribute("aria-label", `Remove ${displayName}`);
    removeBtn.textContent = "×";
    removeBtn.onclick = () => {
      delete depot[id];
      saveDepotPref();
      renderDepot();
      renderSummary();
    };
    row.appendChild(removeBtn);

    return row;
  }

  function renderDepot() {
    depotListEl.innerHTML = "";
    const ids = Object.keys(depot);
    if (!ids.length) {
      depotEmptyEl.classList.remove("hidden");
      return;
    }
    depotEmptyEl.classList.add("hidden");

    const byRarityThenName = (a, b) => {
      const r = itemRarity(b) - itemRarity(a);
      if (r !== 0) return r;
      const nameA = (itemTable[a] && itemTable[a].name) || a;
      const nameB = (itemTable[b] && itemTable[b].name) || b;
      return nameA.localeCompare(nameB);
    };

    // Same grouping the Roster tab's "materials needed" list uses (see
    // renderSummary/categorizeMaterial), plus LMD/EXP pulled to the very
    // top -- they're just ordinary editable rows here (no dedicated tile
    // the way the Roster tab gives them), but they still shouldn't get
    // lost alphabetically in the middle of everything else.
    const currencyIds = ids.filter((id) => id === LMD_ITEM_ID || id === EXP_ITEM_ID);
    currencyIds.sort((a) => (a === LMD_ITEM_ID ? -1 : 1));
    const buckets = { chip: [], skill: [], module: [], farm: [] };
    for (const id of ids) {
      if (id === LMD_ITEM_ID || id === EXP_ITEM_ID) continue;
      buckets[categorizeMaterial(id)].push(id);
    }
    for (const key of Object.keys(buckets)) buckets[key].sort(byRarityThenName);

    const appendHeading = (className, text) => {
      const heading = document.createElement("div");
      heading.className = className;
      heading.textContent = text;
      depotListEl.appendChild(heading);
    };
    const appendRows = (rowIds) => {
      for (const id of rowIds) depotListEl.appendChild(buildDepotRow(id));
    };

    if (currencyIds.length) {
      appendHeading("summaryCategoryHeading", "LMD & EXP");
      appendRows(currencyIds);
    }
    if (buckets.chip.length) {
      appendHeading("summaryCategoryHeading", "Chips");
      appendRows(buckets.chip);
    }
    if (buckets.skill.length) {
      appendHeading("summaryCategoryHeading", "Skill Summaries");
      appendRows(buckets.skill);
    }
    if (buckets.module.length) {
      appendHeading("summaryCategoryHeading", "Module Items");
      appendRows(buckets.module);
    }
    if (buckets.farm.length) {
      appendHeading("summaryCategoryHeading", "Farming Materials");
      let lastRarity = null;
      for (const id of buckets.farm) {
        const rarity = itemRarity(id);
        if (rarity !== lastRarity) {
          appendHeading("summaryRarityHeading", rarity + 1 + "★");
          lastRarity = rarity;
        }
        depotListEl.appendChild(buildDepotRow(id));
      }
    }
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
      setItemIcon(icon, it.iconId, it.cnOnly);
      icon.alt = "";
      const name = document.createElement("span");
      name.className = "operatorSearchResultName";
      name.textContent = it.name;
      row.appendChild(icon);
      row.appendChild(name);
      if (it.cnOnly) row.appendChild(buildCnBadge(it));
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

  // --- depot import (Arknights EN account, via cloudflare/depot-import.js) --

  // Holds the fetched-but-not-yet-applied result between "Import depot"
  // and "Replace my depot with this" -- nothing here is saved to prefs
  // until the user confirms, and it's discarded either way (applied or
  // cancelled), never left sitting around.
  let depotImportPending = null;

  function setDepotImportStatus(text, isError) {
    depotImportStatusEl.textContent = text || "";
    depotImportStatusEl.classList.toggle("depotImportStatusError", !!isError);
  }

  async function depotImportRequestCode() {
    const key = depotImportKeyEl.value.trim();
    const email = depotImportEmailEl.value.trim();
    if (!email) {
      setDepotImportStatus("Enter your account email first.", true);
      return;
    }
    depotImportSendCodeBtn.disabled = true;
    setDepotImportStatus("Sending code...");
    try {
      const res = await fetch(`${DEPOT_IMPORT_ENDPOINT}/request-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Access-Key": key },
        body: JSON.stringify({ email }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      depotImportCodeRowEl.classList.remove("hidden");
      depotImportFetchRowEl.classList.remove("hidden");
      depotImportCodeEl.focus();
      setDepotImportStatus("Code sent -- check your email, then enter it below.");
    } catch (err) {
      setDepotImportStatus(err.message || "Couldn't send the code.", true);
    } finally {
      depotImportSendCodeBtn.disabled = false;
    }
  }

  async function depotImportFetchDepot() {
    const key = depotImportKeyEl.value.trim();
    const email = depotImportEmailEl.value.trim();
    const code = depotImportCodeEl.value.trim();
    if (!code) {
      setDepotImportStatus("Enter the code from your email first.", true);
      return;
    }
    depotImportFetchBtn.disabled = true;
    setDepotImportStatus("Fetching your depot...");
    try {
      const res = await fetch(`${DEPOT_IMPORT_ENDPOINT}/fetch-depot`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Access-Key": key },
        body: JSON.stringify({ email, code }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      depotImportPending = body.depot || {};
      const itemCount = Object.keys(depotImportPending).length;
      const who = body.nickname
        ? `${body.nickname}${body.level ? ` (Lv ${body.level})` : ""}`
        : "your account";
      depotImportSummaryEl.textContent =
        `Fetched ${itemCount.toLocaleString()} item${itemCount === 1 ? "" : "s"} from ${who}. ` +
        `This will replace your current depot entirely -- anything you've tracked manually and ` +
        `isn't in this list will be removed.`;
      depotImportConfirmEl.classList.remove("hidden");
      setDepotImportStatus("");
    } catch (err) {
      setDepotImportStatus(err.message || "Couldn't fetch your depot.", true);
    } finally {
      depotImportFetchBtn.disabled = false;
    }
  }

  function depotImportApply() {
    if (!depotImportPending) return;
    depot = depotImportPending;
    sanitizeDepot(); // drops anything that isn't a real, known item
    saveDepotPref();
    renderDepot();
    renderSummary();
    depotImportCancel();
    depotImportKeyEl.value = "";
    depotImportEmailEl.value = "";
    depotImportCodeEl.value = "";
    depotImportCodeRowEl.classList.add("hidden");
    depotImportFetchRowEl.classList.add("hidden");
    setDepotImportStatus("Depot replaced from your account.");
    depotImportEl.open = false;
  }

  function depotImportCancel() {
    depotImportPending = null;
    depotImportConfirmEl.classList.add("hidden");
    depotImportSummaryEl.textContent = "";
  }

  depotImportSendCodeBtn.addEventListener("click", depotImportRequestCode);
  depotImportFetchBtn.addEventListener("click", depotImportFetchDepot);
  depotImportApplyBtn.addEventListener("click", depotImportApply);
  depotImportCancelBtn.addEventListener("click", depotImportCancel);
  if (DEPOT_IMPORT_ENDPOINT) {
    depotImportEl.classList.remove("hidden");
  }

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
      applyAddFromLink();
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
