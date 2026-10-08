// The "set current/target Elite, level, skill level, mastery, and module
// stages" card -- shared between the planner page (opened from a roster
// card, or right after adding one via search) and the calendar page
// (opened from an event's "Add to planner"/"In planner" operator chips,
// so setting an operator's target doesn't require leaving the calendar).
// Both pages use exactly this one module rather than each keeping their
// own copy of the editing UI, so the two can't drift apart from each
// other over time.
//
// Deliberately self-contained:
// - Its own DOM, injected into <body> the first time open() is called
//   (so no page has to carry the modal's markup in its own HTML).
// - The state-math helpers (maxPhase, clampState, defaultState, etc.) --
//   small, stable game-mechanics math. This module owns them and exports
//   them; planner.js uses these same functions rather than keeping its own
//   copy, so the planner and this card can't disagree on what a valid
//   state is.
// - Its own (separately cached) character-data fetch, for a caller --
//   like calendar.js -- that doesn't already have a full charTable
//   loaded. A caller that already has one (the planner page) just
//   passes its own `op` record straight into open() and never calls
//   loadCharTable() at all.
//
// This module never touches roster storage itself -- open() is handed
// the exact `entry` object to mutate in place, and every change is
// reported back through the `onChange`/`onRemove` callbacks passed in,
// leaving the caller in charge of actually persisting/re-rendering
// whatever it owns (planner.js's in-memory roster + its own UI;
// calendar.js's localStorage-backed roster + its chip labels).
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

  // --- state-math helpers (also used by planner.js -- see file header) ---
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
  // No `op` needed -- every operator starts at E0 Lv1 with nothing
  // selected, regardless of their own phase/skill/module ceilings.
  function defaultState() {
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
  // The fully-maxed state for an operator: max Elite phase at its own max
  // level, skill level 7 (if the operator has skills at all), every skill
  // at its own mastery cap (M3, or fewer if a skill's levelUpCostCond is
  // shorter), and every module at stage 3. Used as the "target" state for
  // an E0/Lv1 -> everything-maxed cost total (see calcOperatorCost() in
  // util.js), e.g. for the operator page's "cost to fully max" table.
  function maxState(op) {
    const phase = maxPhase(op);
    const mastery = {};
    (op.skills || []).forEach((skill, idx) => {
      mastery[idx] = maxMastery(op, idx);
    });
    const modules = {};
    (op.modules || []).forEach((mod) => {
      modules[mod.uniEquipId] = 3;
    });
    return {
      phase,
      level: maxLevelFor(op, phase),
      skillLevel: hasSkills(op) ? 7 : 1,
      mastery,
      modules,
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
      onFieldChange();
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
      onFieldChange();
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

  // Mastery (per skill) and module (per module) rows -- each is its own
  // independent current -> target rank, so they're rendered as compact
  // "label [current] -> [target]" lines rather than folded into
  // buildStateFields's two-column layout.
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

  // Every field change goes through here: report it to whoever opened the
  // modal (to persist + refresh their own UI), then rebuild this modal's
  // own fields (a phase change moves the level field's valid range, for
  // instance, so the modal never shows a stale control while it's open).
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

    statesEl.innerHTML = "";
    statesEl.appendChild(buildStateFields(currentOp, currentEntry, "current"));
    statesEl.appendChild(buildStateFields(currentOp, currentEntry, "target"));

    extraEl.innerHTML = "";
    const extra = buildExtraFields(currentOp, currentEntry);
    if (extra) extraEl.appendChild(extra);
  }

  // op: that charId's character-table record (phases/skills/modules --
  //     see loadCharTable() below for a ready-made source of these).
  // entry: the roster entry to edit in place ({ charId, current, target }).
  // callbacks.onChange(entry): called after every field edit.
  // callbacks.onRemove(): called when "Remove operator" is clicked --
  //     the caller decides what removal actually means for its own
  //     roster, then should call close() itself once it has.
  // callbacks.onClose(): called once the modal is actually closed, by
  //     whatever means (X button, clicking the overlay, Escape, or a
  //     close() a caller's own onRemove triggered) -- the one place a
  //     caller that only wants to react to "the person is done editing"
  //     (e.g. to refresh a still-open summary elsewhere on the page)
  //     needs to hook, rather than duplicating that logic across every
  //     way the modal can close.
  function open(op, entry, callbacks) {
    ensureDom();
    currentOp = op;
    currentEntry = entry;
    currentCallbacks = callbacks || {};
    refresh();
    overlayEl.classList.remove("hidden");
  }

  function close() {
    if (overlayEl) overlayEl.classList.add("hidden");
    const callbacks = currentCallbacks;
    currentOp = null;
    currentEntry = null;
    currentCallbacks = null;
    if (callbacks && callbacks.onClose) callbacks.onClose();
  }

  function isOpen() {
    return !!(overlayEl && !overlayEl.classList.contains("hidden"));
  }

  // Fetches (once -- cached for the rest of the page's life) just enough
  // EN+CN character data for this modal to work with: phases, skills, and
  // (via its own uniequip_table.json fetch + charId grouping, mirroring
  // what the planner page's own loadData() does for the same reason)
  // modules. No item_table.json/gamedata_const.json here -- a caller that
  // also needs cost totals (the planner page) already loads its own
  // fuller copy of those through get_char_table() directly, and this
  // module never needed them for anything the modal itself shows.
  function loadCharTable() {
    if (charTablePromise) return charTablePromise;
    charTablePromise = (async () => {
      const [charTable, equipRes] = await Promise.all([
        get_char_table(false, SERVERS.EN, true),
        gameDataFetch(SERVERS.EN, "uniequip_table"),
      ]);
      const equipJson = await fixedJson(equipRes);
      const equipDict = equipJson.equipDict || equipJson;

      // Best-effort CN merge for anything not yet released on EN, same
      // approach (and same "never let a slow/down CN mirror break EN
      // data" reasoning) as the planner page's own loadData().
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
    maxState,
    maxPhase,
    maxLevelFor,
    maxMastery,
    hasSkills,
    clampState,
  };
})();
