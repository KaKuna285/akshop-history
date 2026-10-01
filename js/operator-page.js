(function () {
  // Per-operator hub page: release dates (EN/CN + the event it likely
  // debuted alongside, best-effort), shop-rotation history (or a
  // predicted debut date if the operator hasn't hit the shop yet), and
  // the full LMD/EXP/materials cost to take them from Elite 0 Level 1 to
  // fully maxed -- plus an "Add to planner" button wired to the same
  // shared edit modal the planner and calendar pages use.
  //
  // Routing is a plain `?id=charId` query string (set CONFIG below, no
  // build-time page generation on this static site) -- same deep-link
  // convention as the planner's own `?add=charId`. Picking a different
  // operator from the jump-search box or a "released alongside" link
  // re-renders in place (history.replaceState, not a real navigation)
  // rather than reloading the page, since every data source below is
  // already loaded for every operator at once.
  //
  // Every data source here is something another page on this site
  // already fetches and normalizes -- reused as-is rather than re-fetched
  // or re-implemented:
  //   - OperatorEditModal.loadCharTable() (operator-edit-modal.js): EN+CN
  //     merged character data (phases/skills/allSkillLvlup/modules), the
  //     exact same table the shared edit modal itself uses.
  //   - loadGameConst()/loadItemTable()/calcOperatorCost() (util.js): the
  //     planner page's own cost-calculation engine, extracted there
  //     specifically so this page could reuse it for a single operator's
  //     "cost to fully max" total instead of a whole roster's.
  //   - normalizeShopHistory()/predictShopDebut() (util.js): the store
  //     page's banner_history.json normalization and shop-debut
  //     prediction math, likewise extracted there for reuse here.
  //   - OperatorEditModal.maxState(op) (operator-edit-modal.js): the
  //     "target" state for the cost table above -- E0/Lv1
  //     (OperatorEditModal.defaultState()) to fully maxed.
  //
  // Account-linked "your actual progression" data (the "current" state
  // the cost table starts from) is a deferred follow-up -- this page
  // always starts the cost table from a fresh E0/Lv1, same as a brand
  // new planner roster entry.

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
  const numberBadgeEl = document.getElementById("opNumberBadge");
  const poolBadgeEl = document.getElementById("opPoolBadge");
  const addToPlannerBtn = document.getElementById("opAddToPlannerBtn");
  const releaseInfoEl = document.getElementById("opReleaseInfo");
  const shopInfoEl = document.getElementById("opShopInfo");
  const costLmdEl = document.getElementById("opCostLmd");
  const costExpEl = document.getElementById("opCostExp");
  const costMaterialsEl = document.getElementById("opCostMaterials");

  let charTable = null; // charId -> operator record (EN+CN merged, via OperatorEditModal.loadCharTable())
  let operatorList = []; // playable operators, sorted by name, for the jump-search box
  let gameConst = null; // { characterExpMap, characterUpgradeCostMap, evolveGoldCost }
  let itemTable = null; // itemId -> { name, iconId, rarity, ... }
  let shopByCharId = {}; // EN-server normalizeShopHistory() result: charId -> banner_history entry
  let events = []; // events.json's events[] -- best-effort, may stay empty
  let dataReady = false;
  let currentCharId = null;
  let jumpHighlighted = -1;
  let jumpResults = [];

  // setItemIcon()/setAvatarIcon()/buildCnBadge() split the same way the
  // planner page's own loadData()/setItemIcon() do: the generic
  // icon-with-fallback plumbing lives in util.js (shared with the
  // calendar page's edit modal), while this tiny item-specific wrapper
  // stays local to whichever page actually renders material rows.
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

  function itemRarity(id) {
    const it = itemTable[id];
    if (!it || !it.rarity) return 0;
    return RARITY_MAP[it.rarity] ?? 0;
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
    el.className = "opShopNote";
    el.textContent = text;
    return el;
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

  async function loadData() {
    const [chars, const_, items] = await Promise.all([
      OperatorEditModal.loadCharTable(),
      loadGameConst(SERVER),
      loadItemTable(SERVER),
    ]);
    charTable = chars;
    gameConst = const_;
    itemTable = items;

    operatorList = Object.values(charTable)
      .map((op) => ({ charId: op.charId, name: op.name, rarity: op.rarity, cnOnly: op.cnOnly }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Shop history and event data are both best-effort: a failed/slow
    // fetch of either just leaves that one section of the page without
    // anything to show, rather than blocking the header/cost table that
    // don't need them.
    try {
      const res = await fetch(extraDataUrl("banner_history.json"));
      const js = await fixedJson(res);
      shopByCharId = normalizeShopHistory(js.NA || {}, charTable);
    } catch (err) {
      console.warn("Couldn't load shop history:", err);
    }
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

  function renderShopInfo(op) {
    shopInfoEl.innerHTML = "";
    const isKernel = op.classicPotentialItemId != null;
    if (isKernel) {
      shopInfoEl.appendChild(
        textNote("Kernel-pool operators are obtained via Headhunting Permit exchange, not added to the shop."),
      );
      return;
    }

    const entry = shopByCharId[op.charId];
    if (entry && entry.shop && entry.shop.length) {
      const list = document.createElement("div");
      list.className = "opShopList";
      let prevDate = entry.first;
      entry.shop.forEach((s, i) => {
        const days = Math.round((s.date - prevDate) / DAY_MS);
        const row = document.createElement("div");
        row.className = "opShopRow";
        const dateEl = document.createElement("span");
        dateEl.className = "opShopDate";
        dateEl.textContent = fmtDate(s.date);
        const gapEl = document.createElement("span");
        gapEl.className = "opShopGap";
        gapEl.textContent = `${days} day${days === 1 ? "" : "s"} after ${i === 0 ? "release" : "the previous appearance"}`;
        row.appendChild(dateEl);
        row.appendChild(gapEl);
        list.appendChild(row);
        prevDate = s.date;
      });
      shopInfoEl.appendChild(list);
      return;
    }

    // Never appeared in the shop yet -- explain why, or predict when,
    // following the exact same eligibility rules as the store page's own
    // tooltip (js/shoplist.js's showIconTooltip()).
    if (op.isLimited) {
      shopInfoEl.appendChild(
        textNote("Limited-pool operators aren't expected to appear in the shop on a predictable schedule."),
      );
      return;
    }
    if (op.rarity === 3) {
      // TIER_4 remaps to 3 -- see RARITY_MAP in util.js.
      shopInfoEl.appendChild(textNote("4★ operators are never added to the shop."));
      return;
    }
    const opInfo = {
      charId: op.charId,
      rarity: op.rarity,
      isKernel: false,
      isLimited: false,
      hasShopHistory: false,
    };
    const prediction = predictShopDebut(opInfo, shopByCharId, charTable);
    if (!prediction) {
      shopInfoEl.appendChild(
        textNote("Hasn't appeared in the shop yet, and there's no same-rarity Standard-pool shop debut yet to predict from."),
      );
      return;
    }
    const note = document.createElement("div");
    note.className = "opShopPrediction";
    const dateLine = document.createElement("div");
    dateLine.className = "opShopPredictionDate";
    dateLine.textContent = `Predicted shop debut: ~${fmtDate(prediction.predictedDate)}`;
    const detailLine = document.createElement("div");
    detailLine.className = "opShopPredictionDetail";
    detailLine.textContent = `#${prediction.position} in line · anchored to ${prediction.anchorOp}'s shop debut (${fmtDate(prediction.anchorDate)})`;
    note.appendChild(dateLine);
    note.appendChild(detailLine);
    shopInfoEl.appendChild(note);
  }

  function renderCostTable(op) {
    const current = OperatorEditModal.defaultState();
    const target = OperatorEditModal.maxState(op);
    const cost = calcOperatorCost(op, current, target, gameConst);
    costLmdEl.textContent = cost.lmd.toLocaleString();
    costExpEl.textContent = cost.exp.toLocaleString();

    costMaterialsEl.innerHTML = "";
    const ids = Object.keys(cost.materials)
      .filter((id) => cost.materials[id] > 0)
      .sort((a, b) => {
        const diff = itemRarity(b) - itemRarity(a);
        if (diff) return diff;
        const nameA = (itemTable[a] && itemTable[a].name) || a;
        const nameB = (itemTable[b] && itemTable[b].name) || b;
        return nameA.localeCompare(nameB);
      });
    if (!ids.length) {
      costMaterialsEl.appendChild(textNote("No extra materials needed -- just LMD and EXP."));
      return;
    }
    ids.forEach((id) => {
      const it = itemTable[id];
      const row = document.createElement("div");
      row.className = "opCostMaterialRow";
      const icon = document.createElement("img");
      icon.className = "opCostMaterialIcon";
      setItemIcon(icon, it && it.iconId, it && it.cnOnly);
      icon.alt = "";
      row.appendChild(icon);
      const nameWrap = document.createElement("span");
      nameWrap.className = "opCostMaterialNameWrap";
      const name = document.createElement("span");
      name.className = "opCostMaterialName";
      name.textContent = (it && it.name) || id;
      nameWrap.appendChild(name);
      if (it && it.cnOnly) nameWrap.appendChild(buildCnBadge(it));
      row.appendChild(nameWrap);
      const count = document.createElement("span");
      count.className = "opCostMaterialCount";
      count.textContent = "×" + cost.materials[id].toLocaleString();
      row.appendChild(count);
      costMaterialsEl.appendChild(row);
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
    numberBadgeEl.textContent = op.displayNumber || "";

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
    renderShopInfo(op);
    renderCostTable(op);
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
