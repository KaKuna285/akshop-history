// The planner's edit card: current/target Elite, level, skill level,
// mastery and module stages for one roster entry. Shared by the planner
// page (roster cards, "Add operator" search), the calendar page (an
// event's "Add to planner"/"In planner" chips) and the operator page
// ("Add to planner"), so each opens the same card in place.
//
// Self-contained:
// - Its own DOM, injected into <body> on the first open(), so no page
//   carries the modal's markup.
// - The state helpers (maxPhase, clampState, defaultState, etc.), exported
//   so planner.js and operator-page.js use the same rules for a valid state.
// - loadCharTable(): a cached EN+CN character-data fetch for callers that
//   don't load their own (calendar, operator and account pages). The
//   planner passes its own `op` records to open() instead.
//
// It never touches roster storage: open() is handed the `entry` object to
// mutate in place and reports every change through the onChange/onRemove
// callbacks; the caller saves and re-renders whatever it owns.
const OperatorEditModal = (function () {
  let overlayEl, iconEl, nameEl, closeEl, statesEl, extraEl, removeEl;
  let currentOp = null;
  let currentEntry = null;
  let currentCallbacks = null;
  let charTablePromise = null;

  function ensureDom() {
    if (overlayEl) return;
    overlayEl = document.createElement("div");
    overlayEl.id = "operatorEditModal";
    overlayEl.className = "modalOverlay hidden";
    overlayEl.innerHTML =
      '<div class="modalPanel" role="dialog" aria-modal="true" aria-labelledby="modalName">' +
      '<div class="modalHeader">' +
      '<div class="modalOperator">' +
      '<img class="modalIcon" alt="" />' +
      '<span class="modalName" id="modalName"></span>' +
      "</div>" +
      '<button type="button" class="modalClose" aria-label="Close">×</button>' +
      "</div>" +
      '<div class="modalStates"></div>' +
      '<div class="modalExtra"></div>' +
      '<button type="button" class="modalRemove">Remove operator</button>' +
      "</div>";
    document.body.appendChild(overlayEl);

    iconEl = overlayEl.querySelector(".modalIcon");
    nameEl = overlayEl.querySelector(".modalName");
    closeEl = overlayEl.querySelector(".modalClose");
    statesEl = overlayEl.querySelector(".modalStates");
    extraEl = overlayEl.querySelector(".modalExtra");
    removeEl = overlayEl.querySelector(".modalRemove");

    closeEl.addEventListener("click", close);
    overlayEl.addEventListener("click", (e) => {
      if (e.target === overlayEl) close();
    });
    removeEl.addEventListener("click", () => {
      if (currentCallbacks && currentCallbacks.onRemove) currentCallbacks.onRemove();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlayEl.classList.contains("hidden")) close();
    });
  }

  // --- state helpers (exported -- see file header) ---
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
  // Clamps a state's phase/level/skillLevel/mastery/modules to what's
  // valid for this operator, in place. Used on saved (possibly malformed)
  // roster entries and whenever the phase changes, which moves the
  // level's valid range.
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
  // No `op` needed -- every operator starts at E0 Lv1 with nothing
  // selected, regardless of their own phase/skill/module ceilings.
  function defaultState() {
    return { phase: 0, level: 1, skillLevel: 1, mastery: {}, modules: {} };
  }
  // A newly-added operator's target is a common goal -- E2 level 1 (or
  // their highest phase), skill level 7 -- so the summary has something
  // to show right away. Mastery and modules default to None.
  function defaultTargetState(op) {
    return {
      phase: Math.min(2, maxPhase(op)),
      level: 1,
      skillLevel: hasSkills(op) ? 7 : 1,
      mastery: {},
      modules: {},
    };
  }

  // --- field builders ------------------------------------------------------

  function buildStateFields(op, entry, which) {
    const state = entry[which];
    const wrap = document.createElement("div");
    wrap.className = "rosterRowState";
    const label = document.createElement("div");
    label.className = "rosterRowStateLabel";
    label.textContent = which === "current" ? "Current" : "Target";
    wrap.appendChild(label);

    const fields = document.createElement("div");
    fields.className = "rosterRowStateFields";

    const who = which === "current" ? "Current" : "Target";
    const phaseSelect = document.createElement("select");
    phaseSelect.setAttribute("aria-label", `${who} Elite phase`);
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
      onFieldChange();
    };
    fields.appendChild(phaseSelect);

    const levelInput = document.createElement("input");
    levelInput.type = "number";
    levelInput.setAttribute("aria-label", `${who} level`);
    levelInput.min = "1";
    levelInput.max = String(maxLevelFor(op, state.phase));
    levelInput.value = String(state.level);
    levelInput.onchange = () => {
      const v = parseInt(levelInput.value, 10);
      state.level = Number.isFinite(v) ? v : state.level;
      clampState(op, state);
      onFieldChange();
    };
    fields.appendChild(levelInput);

    if (hasSkills(op)) {
      const skillSelect = document.createElement("select");
      skillSelect.setAttribute("aria-label", `${who} skill level`);
      for (let s = 1; s <= 7; s++) {
        const opt = document.createElement("option");
        opt.value = String(s);
        opt.textContent = "Sk.Lv " + s;
        if (s === state.skillLevel) opt.selected = true;
        skillSelect.appendChild(opt);
      }
      skillSelect.onchange = () => {
        state.skillLevel = parseInt(skillSelect.value, 10);
        onFieldChange();
      };
      fields.appendChild(skillSelect);
    }

    wrap.appendChild(fields);
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
      sel.setAttribute("aria-label", `${label}, ${which}`);
      for (let n = 0; n <= max; n++) {
        const opt = document.createElement("option");
        opt.value = String(n);
        opt.textContent = formatFn(n);
        if (n === (state[stateKey][subKey] || 0)) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = () => {
        state[stateKey][subKey] = parseInt(sel.value, 10);
        onFieldChange();
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

  // Mastery (per skill) and module (per module) rows, each a compact
  // "label [current] -> [target]" line below buildStateFields()'s
  // two-column layout. Returns null when there are none.
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

  // Every field change goes through here: report it to the caller (to
  // save and refresh its own UI), then rebuild the modal's fields, since
  // e.g. a phase change moves the level field's valid range.
  function onFieldChange() {
    if (currentCallbacks && currentCallbacks.onChange) currentCallbacks.onChange(currentEntry);
    refresh();
  }

  function refresh() {
    if (!currentOp || !currentEntry) return;
    setAvatarIcon(iconEl, currentEntry.charId, currentOp.cnOnly);
    nameEl.textContent = currentOp.name;
    nameEl.parentNode.querySelectorAll(".cnBadge").forEach((el) => el.remove());
    if (currentOp.cnOnly) nameEl.insertAdjacentElement("afterend", buildCnBadge(currentOp));

    // Rebuilding replaces every control, including the one being edited
    // from the keyboard -- remember which one had focus (by position) and
    // put focus back on its replacement.
    const controls = () => [...statesEl.querySelectorAll("select, input"), ...extraEl.querySelectorAll("select, input")];
    const focusedIndex = controls().indexOf(document.activeElement);

    statesEl.innerHTML = "";
    statesEl.appendChild(buildStateFields(currentOp, currentEntry, "current"));
    statesEl.appendChild(buildStateFields(currentOp, currentEntry, "target"));

    extraEl.innerHTML = "";
    const extra = buildExtraFields(currentOp, currentEntry);
    if (extra) extraEl.appendChild(extra);

    if (focusedIndex >= 0) {
      const replacement = controls()[focusedIndex];
      if (replacement) replacement.focus({ preventScroll: true });
    }
  }

  let releaseFocus = null;

  // op: that charId's character-table record (phases/skills/modules --
  //     see loadCharTable() below for a ready-made source of these).
  // entry: the roster entry to edit in place ({ charId, current, target }).
  // callbacks.onChange(entry): called after every field edit.
  // callbacks.onRemove(): called when "Remove operator" is clicked --
  //     the caller removes the entry from its roster, then calls close().
  // callbacks.onClose(): called once the modal closes, by any means (X
  //     button, overlay click, Escape, or a close() from onRemove) -- the
  //     hook for reacting to "done editing".
  function open(op, entry, callbacks) {
    ensureDom();
    currentOp = op;
    currentEntry = entry;
    currentCallbacks = callbacks || {};
    refresh();
    overlayEl.classList.remove("hidden");
    if (!releaseFocus) releaseFocus = holdFocusIn(overlayEl.querySelector(".modalPanel"));
  }

  function close() {
    if (overlayEl) overlayEl.classList.add("hidden");
    if (releaseFocus) {
      releaseFocus();
      releaseFocus = null;
    }
    const callbacks = currentCallbacks;
    currentOp = null;
    currentEntry = null;
    currentCallbacks = null;
    if (callbacks && callbacks.onClose) callbacks.onClose();
  }

  function isOpen() {
    return !!(overlayEl && !overlayEl.classList.contains("hidden"));
  }

  // Fetches (once per page load) the EN+CN character data the modal
  // needs: phases, skills, and modules (from uniequip_table, grouped by
  // charId the same way as the planner's loadData()). Uses
  // get_char_table()'s extra_data, so records also carry release dates
  // and isLimited for other callers. No item or cost tables: the modal
  // doesn't show costs.
  function loadCharTable() {
    if (charTablePromise) return charTablePromise;
    charTablePromise = (async () => {
      const [charTable, equipRes] = await Promise.all([
        get_char_table(false, SERVERS.EN, true),
        gameDataFetch(SERVERS.EN, "uniequip_table"),
      ]);
      const equipJson = await fixedJson(equipRes);
      const equipDict = equipJson.equipDict || equipJson;

      // Best-effort CN merge for anything not yet released on EN, the same
      // as the planner's loadData(): a CN failure still leaves EN data.
      try {
        const [cnChars, cnEquipRes] = await Promise.all([
          get_char_table(false, SERVERS.CN, true),
          gameDataFetch(SERVERS.CN, "uniequip_table"),
        ]);
        for (const [charId, op] of Object.entries(cnChars)) {
          if (!charTable[charId]) {
            op.cnOnly = true;
            if (op.appellation && /[A-Za-z]/.test(op.appellation)) {
              op.cnName = op.name;
              op.name = op.appellation;
            }
            charTable[charId] = op;
          }
        }
        const cnEquipJson = await fixedJson(cnEquipRes);
        const cnEquipDict = cnEquipJson.equipDict || cnEquipJson;
        for (const [uniEquipId, equip] of Object.entries(cnEquipDict)) {
          if (!equipDict[uniEquipId]) equipDict[uniEquipId] = equip;
        }
      } catch (err) {
        console.warn("Couldn't load CN-exclusive operator data for the edit card:", err);
      }

      const modulesByChar = {};
      for (const equip of Object.values(equipDict)) {
        if (!equip.charId || !equip.itemCost || !equip.typeName2) continue;
        (modulesByChar[equip.charId] = modulesByChar[equip.charId] || []).push(equip);
      }
      for (const list of Object.values(modulesByChar)) {
        list.sort((a, b) => (a.charEquipOrder || 0) - (b.charEquipOrder || 0));
      }
      Object.values(charTable).forEach((op) => {
        op.modules = modulesByChar[op.charId] || [];
      });

      return charTable;
    })();
    return charTablePromise;
  }

  return {
    open,
    close,
    isOpen,
    loadCharTable,
    defaultState,
    defaultTargetState,
    maxPhase,
    maxLevelFor,
    maxMastery,
    hasSkills,
    clampState,
  };
})();
