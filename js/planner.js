(function () {
  // Operator Planner: totals the LMD, EXP and materials a roster of
  // operators needs to reach their targets -- operator level, Elite
  // promotion, skill level (1-7, shared across an operator's skills),
  // mastery (M1-M3, per skill) and module stages -- minus whatever the
  // depot says you already own. The depot is just numbers you enter (or
  // import through account sync); LMD and EXP are ordinary items in it
  // (ids "4001" and "5001").
  //
  // Cost data, all via util.js:
  //  - get_char_table(): each operator's "phases" (Elite promotion cost),
  //    "skills" (mastery cost, via levelUpCostCond) and "allSkillLvlup"
  //    (skill-level cost)
  //  - loadGameConst(): the EXP/LMD level curve and Elite promotion LMD
  //  - loadItemTable(): material names/icons/rarity
  //  - uniequip_table: module stage costs. equipDict is keyed by
  //    uniEquipId with a charId on each entry; there's no charId ->
  //    modules table, so loadData() builds one.
  // A module's itemCost includes its LMD as a normal entry (id "4001",
  // type "GOLD"); addCosts() in util.js routes it into the LMD total.
  //
  // Roster entries render as compact cards on the Roster tab; clicking one
  // opens the shared edit modal (js/operator-edit-modal.js) rather than
  // editing inline, leaving room for the "what you still need" list.

  // --- state helpers --------------------------------------------------
  // From js/operator-edit-modal.js (loaded before this file), so the
  // roster logic here and the edit card agree on what a valid state is.
  const {
    hasSkills,
    clampState,
    defaultState,
    defaultTargetState,
  } = OperatorEditModal;


  // EN is the primary server; loadData() merges CN in on top of it for
  // operators/materials not yet released on EN (flagged cnOnly and badged
  // in the UI).
  const SERVER = SERVERS.EN;

  // Material icon, with the same mirror fallback and CN placeholder as
  // setAvatarIcon() in util.js. An item with no iconId goes straight to
  // the placeholder (cnOnly) or the hidden "missing" state.
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

  // LMD and EXP are real items in the game data, searchable/addable in the
  // depot like any other material, but their owned amounts subtract from
  // the LMD/EXP totals rather than appearing as material rows.
  const LMD_ITEM_ID = "4001";
  const EXP_ITEM_ID = "5001";
  // Shown first in the depot, in this order, under their own heading.
  // Orundum and Originite Prime aren't upgrade costs; they're listed for
  // reference only.
  const CURRENCY_ITEM_IDS = [LMD_ITEM_ID, EXP_ITEM_ID, "4003", "4002"];

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
  const accountSyncPlannerStatusEl = document.getElementById("accountSyncPlannerStatus");

  let charTable = null; // charId -> operator record (rarity already 0-5 numeric, see util.js)
  let operatorList = []; // playable operators, sorted by name, for search
  let gameConst = null; // { characterExpMap, characterUpgradeCostMap, evolveGoldCost }
  let itemTable = null; // itemId -> { name, iconId, rarity, ... }
  let itemList = []; // item records (incl. LMD/EXP), sorted by name, for the depot search
  let roster = []; // [{ charId, current: {...}, target: {...} }] -- see defaultState()
  let depot = {}; // itemId -> count you already own (incl. "4001" LMD, "5001" EXP)
  // Saved entries that don't resolve to anything in this session's game
  // data. Usually that means the best-effort CN data didn't load (see
  // loadData()), so a CN-only operator or item can't be shown -- they're
  // kept as-is and written back on every save rather than deleted, and
  // show up again on the next load that has the CN data.
  let heldRoster = [];
  let heldDepot = {};
  let cnDataLoaded = false;
  let dataReady = false;

  // Older saves keep the roster/depot/active tab under a "materials" prefs
  // section (the page's former name). Move it to "planner", once, so that
  // data isn't lost.
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
    setPref("planner", "roster", roster.concat(heldRoster));
  }
  function loadDepotPref() {
    return getPref("planner", "depot", {}, (v) => v && typeof v === "object");
  }
  function saveDepotPref() {
    setPref("planner", "depot", Object.assign({}, heldDepot, depot));
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
      gameDataFetch(SERVER, "uniequip_table"),
    ]);
    charTable = chars;
    gameConst = const_;
    itemTable = items;
    const equipJson = await fixedJson(equipRes);
    const equipDict = equipJson.equipDict || equipJson;

    // Operators/materials not yet released on EN have no entry in EN's
    // tables at all. CN's copies of the same three tables fill those in:
    // anything missing from EN is added, flagged cnOnly so the UI can
    // badge it; EN entries are left alone. Best-effort: if the CN data
    // fails to load, EN still works, just without CN-only entries.
    try {
      const [cnChars, cnItemRes, cnEquipRes] = await Promise.all([
        get_char_table(false, SERVERS.CN, false),
        gameDataFetch(SERVERS.CN, "item_table"),
        gameDataFetch(SERVERS.CN, "uniequip_table"),
      ]);
      for (const [charId, op] of Object.entries(cnChars)) {
        if (!charTable[charId]) {
          op.cnOnly = true;
          // CN's "name" is in Chinese, so it can't be searched in English.
          // "appellation" is the operator's Latin-script codename (what
          // other AK tools show for not-yet-localized operators), so use
          // that as the name and keep the Chinese one (cnName) for the CN
          // badge's tooltip.
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
      cnDataLoaded = true;
    } catch (err) {
      console.warn(
        "Couldn't load CN-exclusive operator/material data (EN data still loaded fine):",
        err,
      );
    }

    // Group modules by charId, skipping each operator's base "no module"
    // entry (itemCost/typeName2 both null), which isn't upgradeable.
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

    // Includes LMD and EXP, so they can be added to the depot.
    itemList = Object.values(itemTable)
      .filter((it) => it && it.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // --- cost calculation ---------------------------------------------------
  // Per-operator costs come from calcOperatorCost() in util.js.

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

  // Normalizes saved entries against the game data. An entry whose charId
  // isn't in this session's data is only dropped when the CN data loaded
  // too (so it really is unknown); otherwise it's held, see heldRoster.
  function sanitizeRoster() {
    heldRoster = [];
    roster = roster
      .filter((entry) => {
        if (!entry || typeof entry.charId !== "string") return false;
        if (Object.prototype.hasOwnProperty.call(charTable, entry.charId)) return true;
        if (!cnDataLoaded) heldRoster.push(entry);
        return false;
      })
      .map((entry) => {
        const op = charTable[entry.charId];
        const current = Object.assign(defaultState(op), entry.current || {});
        const target = Object.assign(defaultState(op), entry.target || {});
        clampState(op, current);
        clampState(op, target);
        return { charId: entry.charId, current, target };
      });
  }

  // charTable is a plain object, so "constructor" or "__proto__" (from a
  // crafted ?add= link) would otherwise look like an operator.
  function knownOperator(charId) {
    return Object.prototype.hasOwnProperty.call(charTable, charId) ? charTable[charId] : null;
  }

  function addOperator(charId) {
    if (roster.some((e) => e.charId === charId)) return;
    const op = knownOperator(charId);
    if (!op) return;
    const current = defaultState(op);
    const target = defaultTargetState(op);
    roster.push({ charId, current, target });
    saveRosterPref();
    renderRoster();
    renderSummary();
  }

  // Deep link: /planner/?add=charId[,charId2,...]. Adds whichever charIds
  // are recognized, switches to the Roster tab, shows a short status note,
  // and strips "add" from the URL so a refresh or bookmark doesn't add
  // them again.
  function applyAddFromLink() {
    const params = new URLSearchParams(location.search);
    const raw = params.get("add");
    if (raw) {
      const added = [];
      const alreadyHad = [];
      for (const charId of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
        const op = knownOperator(charId);
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

  // The card's hover tooltip (title attribute): current vs. target, so the
  // card itself stays compact. Elite/level always shows. The skill line
  // is the mastery targets ("S2M3", one per skill with a nonzero target)
  // if any are set, else the skill level (as a range if it changes).
  // Modules show only with a nonzero target, as "Mod {letter} Lv. {n}".
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
    // #rosterLayout (with the "Add operator" search box) stays visible even
    // while loading or empty; only the empty-state message toggles.
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
      card.dataset.focusKey = `roster:${entry.charId}`; // see holdFocusIn() in util.js
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
  // The modal itself is js/operator-edit-modal.js (shared with the
  // calendar and operator pages). This is just the wiring: which roster
  // entry is being edited, and what to do when it changes or is removed.
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

  // One row of the "materials needed" list: icon, name, shortfall, and
  // "(have X of Y)" when the depot covers part of it.
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

    // Materials the depot fully covers are left out of the list (a note
    // says how many). LMD/EXP have their own tiles, so they're excluded
    // here too, as a safeguard (the cost data doesn't normally put them
    // in materials).
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

    // Chips, skill summaries and module items each get their own section;
    // ordinary farmable materials are one section with a heading per
    // rarity.
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

  createSearchBox({
    input: searchInput,
    results: searchResultsEl,
    items: () => (dataReady ? operatorList : []),
    buildRow: (op) => {
      const row = buildOperatorResultRow(op);
      const detailsLink = document.createElement("a");
      detailsLink.className = "operatorSearchResultDetails";
      detailsLink.href = `/operator/?id=${encodeURIComponent(op.charId)}`;
      detailsLink.title = `View ${op.name}'s operator page`;
      detailsLink.setAttribute("aria-label", `View ${op.name}'s operator page`);
      detailsLink.textContent = "ⓘ";
      // Follows the link without also picking the row.
      detailsLink.addEventListener("click", (e) => e.stopPropagation());
      row.appendChild(detailsLink);
      return row;
    },
    onPick: (op) => {
      addOperator(op.charId);
      const index = roster.findIndex((e) => e.charId === op.charId);
      if (index >= 0) {
        openOperatorModal(index);
      } else {
        searchInput.focus();
      }
    },
  });

  // --- depot -----------------------------------------------------------

  // Cleans up a saved depot (possibly stale or hand-edited): drops
  // non-positive counts and unknown items (held instead while the CN data
  // is missing, like sanitizeRoster()), and floors counts to integers.
  function sanitizeDepot() {
    const clean = {};
    heldDepot = {};
    for (const [id, count] of Object.entries(depot)) {
      if (!Number.isFinite(count) || count <= 0) continue;
      if (Object.prototype.hasOwnProperty.call(itemTable, id)) clean[id] = Math.floor(count);
      else if (!cnDataLoaded) heldDepot[id] = Math.floor(count); // see heldRoster
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

  // One editable depot row: same icon/name layout as a Roster-tab material
  // row, with an editable amount. The count shows thousands separators
  // (large LMD/EXP amounts are otherwise hard to read) and plain digits
  // while focused, so editing doesn't fight the commas.
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

    // Same grouping as the Roster tab's "materials needed" list (see
    // renderSummary()/categorizeMaterial()), with the currencies in their
    // own section at the top.
    const currencyIds = CURRENCY_ITEM_IDS.filter((id) => Object.prototype.hasOwnProperty.call(depot, id));
    const buckets = { chip: [], skill: [], module: [], farm: [] };
    for (const id of ids) {
      if (CURRENCY_ITEM_IDS.includes(id)) continue;
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
      appendHeading("summaryCategoryHeading", "Currencies & EXP");
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

  // --- depot search ----------------------------------------------------

  createSearchBox({
    input: depotSearchInput,
    results: depotSearchResultsEl,
    items: () => (dataReady ? itemList : []),
    buildRow: (it) => {
      const row = document.createElement("div");
      row.className = "operatorSearchResult";
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
      return row;
    },
    onPick: (it) => {
      addDepotItem(it.itemId);
      depotSearchInput.focus();
    },
  });

  // --- account sync status -------------------------------------------
  // The sync form is on the home page (js/account-sync.js); this line
  // shows what it last saved.

  AccountSync.renderStatusLine(accountSyncPlannerStatusEl);

  // Another tab changed the saved roster or depot (adding from an operator
  // page or the calendar, an account sync, or this page open twice): load
  // it again, so this tab's next save doesn't write its stale copy over
  // that change. An open edit card is closed, since the entry it was
  // editing may have moved or gone.
  window.addEventListener("storage", (e) => {
    if (e.key !== PREFS_KEY && e.key !== null) return; // null: storage cleared
    if (!dataReady) return; // the boot sequence reads the saved data itself
    if (OperatorEditModal.isOpen()) OperatorEditModal.close();
    roster = loadRosterPref();
    depot = loadDepotPref();
    sanitizeRoster();
    sanitizeDepot();
    renderRoster();
    renderDepot();
    renderSummary();
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
