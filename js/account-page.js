(function () {
  // "My account" overview: profile summary, sync freshness, medal
  // progress, and every owned operator's synced progress as a sortable
  // table. Read-only: the email/code/fetch sync form lives only on the
  // home page (js/account-sync.js's mount()), and this page's "Re-sync"
  // action links back there.
  //
  // Reached from any page's nav badge once an account is synced (see
  // AccountSync.renderNavBadge()), so it isn't in the main site nav.
  // Visiting it before a first sync shows #accountPageNotSynced, which
  // points back at the home page.

  const DAY_MS = 24 * 60 * 60 * 1000;

  const statusEl = document.getElementById("accountPageStatus");
  const notSyncedEl = document.getElementById("accountPageNotSynced");
  const contentEl = document.getElementById("accountPageContent");
  const nameEl = document.getElementById("accountPageName");
  const metaEl = document.getElementById("accountPageMeta");
  const rosterCountEl = document.getElementById("accountPageRosterCount");
  const sortEl = document.getElementById("accountPageSort");
  const noProgressNoteEl = document.getElementById("accountPageNoProgressNote");
  const bodyEl = document.getElementById("accountPageRosterBody");

  const medalsCountEl = document.getElementById("accountPageMedalsCount");
  const medalsNoDataEl = document.getElementById("accountPageMedalsNoDataNote");
  const medalsBarEl = document.getElementById("accountPageMedalsBar");
  const medalsBarFillEl = document.getElementById("accountPageMedalsBarFill");
  const medalsGroupsEl = document.getElementById("accountPageMedalsGroups");
  const hideUnobtainableLabelEl = document.getElementById("accountPageHideUnobtainableLabel");
  const hideUnobtainableEl = document.getElementById("accountPageHideUnobtainable");
  const medalPreviewOverlayEl = document.getElementById("medalPreviewOverlay");
  const medalPreviewEl = document.getElementById("medalPreview");
  const medalPreviewCloseBtn = document.getElementById("medalPreviewClose");
  const medalPreviewIconImgEl = document.getElementById("medalPreviewIconImg");
  const medalPreviewNameEl = document.getElementById("medalPreviewName");
  const medalPreviewMetaEl = document.getElementById("medalPreviewMeta");
  const medalPreviewDescriptionEl = document.getElementById("medalPreviewDescription");
  const medalPreviewGetMethodEl = document.getElementById("medalPreviewGetMethod");
  const medalPreviewRequiresEl = document.getElementById("medalPreviewRequires");

  const tabBtnRoster = document.getElementById("tabBtnRoster");
  const tabBtnMedals = document.getElementById("tabBtnMedals");
  const tabPanelRoster = document.getElementById("tabPanelRoster");
  const tabPanelMedals = document.getElementById("tabPanelMedals");

  let roster = []; // [{ op, progress }], built once charTable + account are both ready

  // --- sync freshness --------------------------------------------------
  // Three bands (fresh/aging/stale) rather than a bare day count, since
  // the real question is whether the synced data is still trustworthy --
  // the owned-operator filter and the operator page's "Your stats" toggle
  // are only as good as the last sync. The thresholds are a judgment call.
  function syncFreshness(syncedAt) {
    const t = syncedAt ? new Date(syncedAt).getTime() : NaN;
    if (isNaN(t)) return { text: "Sync date unknown.", level: "stale" };
    const days = Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
    let text;
    if (days === 0) text = "Synced today.";
    else if (days === 1) text = "Synced 1 day ago.";
    else text = `Synced ${days} days ago.`;
    const level = days > 30 ? "stale" : days > 7 ? "aging" : "fresh";
    return { text, level, days };
  }

  // Headhunting costs 600 Orundum per pull; Originite Prime converts to
  // 180 Orundum each.
  const ORUNDUM_PER_PULL = 600;
  const ORUNDUM_PER_PRIME = 180;

  function renderProfile(account) {
    const label = account.level != null ? `${account.nickname} (Lv ${account.level})` : account.nickname;
    nameEl.textContent = label;

    metaEl.innerHTML = "";
    const freshness = syncFreshness(account.syncedAt);
    const freshnessEl = document.createElement("span");
    freshnessEl.className = `accountPageFreshness accountPageFreshness-${freshness.level}`;
    freshnessEl.textContent = freshness.text;
    metaEl.appendChild(freshnessEl);
    if (freshness.level !== "fresh") {
      metaEl.appendChild(
        document.createTextNode(
          freshness.level === "stale"
            ? " This is pretty old -- re-sync to keep your roster, depot, and owned-operator filter accurate."
            : " Consider re-syncing if you've played since then.",
        ),
      );
    }

    // The depot is Planner's data, not AccountSync's, so it's read
    // straight from Planner's prefs key. Informational only; editing
    // happens in the Planner.
    const depot = getPref("planner", "depot", {}, (v) => v && typeof v === "object");
    const itemCount = Object.keys(depot).length;
    if (itemCount) {
      const depotLine = document.createElement("div");
      depotLine.className = "accountPageDepotLine";
      depotLine.textContent = `Depot: ${itemCount.toLocaleString()} item${itemCount === 1 ? "" : "s"} tracked in the Operator Planner.`;
      metaEl.appendChild(depotLine);
    }

    const pulls = pullCounts(depot);
    if (pulls.standard || pulls.withPrime || pulls.kernel) {
      const pullsEl = document.createElement("div");
      pullsEl.className = "accountPagePulls";
      const line = (label, text, title) => {
        const row = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = label + ": ";
        row.appendChild(strong);
        row.appendChild(document.createTextNode(text));
        row.title = title;
        pullsEl.appendChild(row);
      };
      line(
        "Pulls",
        pulls.withPrime > pulls.standard
          ? `${pulls.standard.toLocaleString()} (${pulls.withPrime.toLocaleString()} with Originite Prime)`
          : pulls.standard.toLocaleString(),
        `Headhunting Permits + Ten-roll Permits x10 + Orundum / ${ORUNDUM_PER_PULL}. ` +
          `In parentheses: also converting Originite Prime at ${ORUNDUM_PER_PRIME} Orundum each.`,
      );
      if (pulls.kernel) {
        line("Kernel pulls", pulls.kernel.toLocaleString(), "Kernel Headhunting Permits + Ten-roll Kernel Permits x10 (Kernel banners only).");
      }
      metaEl.appendChild(pullsEl);
    }
  }

  // Headhunting pulls the depot can pay for. Standard pulls come from
  // permits and Orundum; withPrime also converts Originite Prime into
  // Orundum. Kernel permits only work on Kernel banners, so they're
  // counted separately. Banner-specific limited permits aren't counted.
  function pullCounts(depot) {
    const n = (id) => {
      const v = depot[id];
      return typeof v === "number" && v > 0 ? Math.floor(v) : 0;
    };
    const permits = n("7003") + 10 * n("7004");
    const orundum = n("4003");
    return {
      standard: permits + Math.floor(orundum / ORUNDUM_PER_PULL),
      withPrime: permits + Math.floor((orundum + n("4002") * ORUNDUM_PER_PRIME) / ORUNDUM_PER_PULL),
      kernel: n("classic_gacha") + 10 * n("classic_gacha_10"),
    };
  }

  // --- tabs (Operators / Medals) ------------------------------------------
  // Operators is the primary tab, shown first and selected by default --
  // the same convention as Planner's Roster/Your Depot tabs (js/planner.js's
  // switchTab()). The two pages don't share tab code.

  function loadActiveTabPref() {
    return getPref("account", "overviewTab", "roster", (v) => v === "roster" || v === "medals");
  }
  function saveActiveTabPref(tab) {
    setPref("account", "overviewTab", tab);
  }

  function switchTab(tab) {
    const onRoster = tab === "roster";
    tabBtnRoster.classList.toggle("active", onRoster);
    tabBtnRoster.setAttribute("aria-selected", String(onRoster));
    tabBtnMedals.classList.toggle("active", !onRoster);
    tabBtnMedals.setAttribute("aria-selected", String(!onRoster));
    tabPanelRoster.classList.toggle("hidden", !onRoster);
    tabPanelMedals.classList.toggle("hidden", onRoster);
    if (onRoster) hideMedalPreview(); // don't leave a stale detail panel open behind the tab
    saveActiveTabPref(tab);
  }

  tabBtnRoster.addEventListener("click", () => switchTab("roster"));
  tabBtnMedals.addEventListener("click", () => switchTab("medals"));

  // --- medals section ----------------------------------------------------
  // How many of the game's medals (achievements) this account has
  // obtained, grouped by the catalog's medalType. Which medals a sync
  // reports as obtained is the least-confirmed data the site reads (see
  // cloudflare/depot-import/index.js's extractObtainedMedals()), so the
  // whole section is gated on AccountSync.getObtainedMedals() not being
  // null rather than ever showing a confidently-wrong 0%.

  // Group labels per medalType, matching the in-game "Path to Glory" menu.
  // The catalog has ten medalType values: these nine plus hiddenMedal.
  // hiddenMedal is deliberately left out -- it matches the isHidden flag
  // exactly (every hiddenMedal-type medal has isHidden:true and vice
  // versa), so renderMedalsSection() puts those in a separate "Secret
  // Medal" group, like the in-game menu's own Secret tab. (medal_table.json
  // is large; a truncated fetch of it can look like it has fewer types.)
  const MEDAL_TYPE_NAMES = {
    playerMedal: "Records Medal",
    stageMedal: "Episodes Medal",
    campMedal: "Annihilation",
    towerMedal: "SSS Medal",
    growthMedal: "Progress Medal",
    storyMedal: "Chronicles",
    rogueMedal: "Traveler From",
    buildMedal: "Base Medal",
    activityMedal: "Event Medal",
  };
  // Render order for the known types (the in-game tab order). Any other
  // medalType (e.g. one the game adds later) is labelled by
  // humanizeMedalType() and appended after these in first-seen order --
  // see renderMedalsSection().
  const MEDAL_TYPE_ORDER = [
    "playerMedal",
    "stageMedal",
    "campMedal",
    "towerMedal",
    "growthMedal",
    "storyMedal",
    "rogueMedal",
    "buildMedal",
    "activityMedal",
  ];
  const SECRET_GROUP_LABEL = "Secret Medal";

  function humanizeMedalType(type) {
    const words = String(type || "")
      .replace(/Medal$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim();
    if (!words) return "Other";
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  // No data field reliably marks a medal as permanently missed
  // (expireTimes isn't confirmed to mean that, and many current medals
  // have odd values there), so this list is maintained by hand. Add the
  // medalId of any medal confirmed gone for good; the "hide medals I can
  // no longer obtain" toggle (shown only when this list is non-empty)
  // then drops it from both the grid and the overall/group counts.
  const MANUALLY_UNOBTAINABLE_MEDAL_IDS = new Set([
    // "medal_camp_rotate_05",
  ]);

  // Medal rarity T1/T2/T3 reuses the grey/blue/gold of operator rarity
  // (css/operator-extra.css's --rarity-color for 1-2★/4★/6★).
  const MEDAL_RARITY_COLORS = { T1: "#9f9f9f", T2: "#00b2f6", T3: "#ffae00" };

  // EN-only, like the rest of the account-sync feature (the Worker only
  // logs into EN/Yostar accounts). Unlike OperatorEditModal.loadCharTable()
  // there's no CN-merge fallback: a medal obtained on an EN account is
  // always in EN's own catalog.
  async function loadMedalTable() {
    const res = await gameDataFetch(SERVERS.EN, "medal_table");
    const json = await fixedJson(res);
    return Array.isArray(json.medalList) ? json.medalList : [];
  }

  // The last-rendered sync's obtained-medals map (medalId -> entry), read
  // by renderMedalChip().
  let obtainedMedals = null;

  // The last-loaded catalog, medalId -> medal, kept at module scope so
  // showMedalPreview() can resolve a "meta" medal's preMedalIdList (see
  // below) into the names of the medals it requires.
  let medalById = new Map();

  // --- medal detail panel --------------------------------------------
  // Opens on clicking any medal chip -- see #medalPreview in
  // account/index.html. A hidden (isHidden), not-yet-obtained medal's
  // real name/description/getMethod appear only here, after a deliberate
  // click; its chip always shows "???" (see renderMedalChip()).

  function formatObtainedDate(ts) {
    if (typeof ts !== "number" || ts <= 0) return null;
    // The obtained timestamp (the sync's `fts` field, see
    // cloudflare/depot-import/index.js) is Unix seconds, like other game
    // data timestamps. Implausible years are rejected rather than shown.
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime()) || d.getFullYear() < 2017 || d.getFullYear() > 2100) return null;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  // preMedalIdList (a "meta" medal's prerequisites, e.g. a Talent
  // Recognition Medal II that requires I first) is an array of medalIds
  // when populated. An empty one can come through as `{}` rather than
  // `[]` (a quirk of this game's empty List fields in the datamined
  // JSON), so anything that isn't an array means "no prerequisites".
  function requiredMedalNames(medal) {
    const ids = Array.isArray(medal.preMedalIdList) ? medal.preMedalIdList : [];
    return ids.map((id) => {
      const req = medalById.get(id);
      return (req && req.medalName) || id;
    });
  }

  function showMedalPreview(medal, obtainedEntry) {
    const rarityColor = MEDAL_RARITY_COLORS[medal.rarity] || "#f8d511";
    medalPreviewEl.style.setProperty("--medal-rarity-color", rarityColor);

    // The in-game icon is shown only once it loads; the fa-medal glyph
    // underneath (.medalPreviewIcon::before, in css/account-extra.css) is
    // the fallback, since there's no second mirror for medal icons (see
    // js/util.js's uri_medal()).
    medalPreviewIconImgEl.onload = () => {
      medalPreviewIconImgEl.style.display = "block";
    };
    medalPreviewIconImgEl.onerror = () => {
      medalPreviewIconImgEl.style.display = "none";
    };
    medalPreviewIconImgEl.style.display = "none";
    medalPreviewIconImgEl.src = uri_medal(medal.medalId);

    medalPreviewNameEl.textContent = medal.medalName || "Medal";

    const metaParts = [MEDAL_TYPE_NAMES[medal.medalType] || humanizeMedalType(medal.medalType)];
    if (medal.rarity) metaParts.push(medal.rarity);
    medalPreviewMetaEl.textContent = "";
    medalPreviewMetaEl.appendChild(document.createTextNode(metaParts.join(" · ") + " · "));
    const statusEl2 = document.createElement("span");
    if (obtainedEntry) {
      statusEl2.className = "medalPreviewObtained";
      const dateStr = formatObtainedDate(obtainedEntry.ts);
      statusEl2.textContent = dateStr ? `Obtained ${dateStr}` : "Obtained";
    } else {
      statusEl2.textContent = "Not yet obtained";
    }
    medalPreviewMetaEl.appendChild(statusEl2);

    medalPreviewDescriptionEl.textContent = medal.description || "";
    medalPreviewGetMethodEl.textContent = medal.getMethod || "";
    medalPreviewRequiresEl.textContent = requiredMedalNames(medal).join(", ");

    medalPreviewOverlayEl.classList.remove("hidden");
    medalPreviewOverlayEl.scrollTop = 0;
    if (!releaseMedalPreviewFocus) releaseMedalPreviewFocus = holdFocusIn(medalPreviewEl);
  }

  let releaseMedalPreviewFocus = null;
  function hideMedalPreview() {
    medalPreviewOverlayEl.classList.add("hidden");
    if (releaseMedalPreviewFocus) {
      releaseMedalPreviewFocus();
      releaseMedalPreviewFocus = null;
    }
  }

  medalPreviewCloseBtn.addEventListener("click", hideMedalPreview);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !medalPreviewOverlayEl.classList.contains("hidden")) hideMedalPreview();
  });

  // Same overlay-click-to-close pattern as the shared operator edit modal
  // (see js/operator-edit-modal.js's ensureDom()): only a click on the
  // backdrop itself closes it, not one inside the panel.
  medalPreviewOverlayEl.addEventListener("click", (e) => {
    if (e.target === medalPreviewOverlayEl) hideMedalPreview();
  });

  function renderMedalChip(medal) {
    const obtainedEntry = obtainedMedals[medal.medalId];
    const isObtained = !!obtainedEntry;
    const isHidden = !isObtained && medal.isHidden;

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `medalChip ${isObtained ? "medalChip-obtained" : isHidden ? "medalChip-hidden" : "medalChip-missing"}`;
    chip.style.setProperty("--medal-rarity-color", MEDAL_RARITY_COLORS[medal.rarity] || "#9f9f9f");
    chip.title = isHidden ? "???" : medal.medalName || "Medal";

    const iconEl = document.createElement("span");
    iconEl.className = "medalChipIcon";
    chip.appendChild(iconEl);

    const nameEl = document.createElement("span");
    nameEl.className = "medalChipName";
    nameEl.textContent = isHidden ? "???" : medal.medalName || "Medal";
    chip.appendChild(nameEl);

    chip.addEventListener("click", () => {
      // Always opens the real medal, even when hidden and unobtained --
      // only the chip itself is spoiler-protected.
      showMedalPreview(medal, obtainedEntry);
    });

    return chip;
  }

  // Builds one "Label (obtained / total)" group heading.
  function buildGroupHeading(label, obtainedCount, total, headingClass, countClass) {
    const headingEl = document.createElement("div");
    headingEl.className = headingClass;
    headingEl.textContent = `${label} `;
    const countEl = document.createElement("span");
    countEl.className = countClass;
    countEl.textContent = `(${obtainedCount} / ${total})`;
    headingEl.appendChild(countEl);
    return headingEl;
  }

  function buildChipsRow(medals) {
    const chipsEl = document.createElement("div");
    chipsEl.className = "accountPageMedalChips";
    medals.forEach((medal) => chipsEl.appendChild(renderMedalChip(medal)));
    return chipsEl;
  }

  async function renderMedalsSection() {
    obtainedMedals = AccountSync.getObtainedMedals();
    if (!obtainedMedals) {
      medalsCountEl.textContent = "—";
      medalsBarEl.classList.add("hidden");
      medalsGroupsEl.innerHTML = "";
      hideUnobtainableLabelEl.classList.add("hidden");
      hideMedalPreview();
      medalsNoDataEl.classList.remove("hidden");
      return;
    }

    try {
      const medalList = await loadMedalTable();
      medalById = new Map(
        medalList.filter((m) => m && typeof m.medalId === "string").map((m) => [m.medalId, m]),
      );

      // The toggle is only shown when MANUALLY_UNOBTAINABLE_MEDAL_IDS has
      // entries; otherwise it would visibly do nothing.
      hideUnobtainableLabelEl.classList.toggle("hidden", MANUALLY_UNOBTAINABLE_MEDAL_IDS.size === 0);
      const hideUnobtainable = hideUnobtainableEl.checked;

      // With the toggle on, a medal that's gone for good shouldn't count
      // against you, so it's dropped from both the grid and the totals,
      // not just hidden. A medal already obtained is never dropped.
      const visibleMedals = medalList.filter((medal) => {
        if (!medal || typeof medal.medalId !== "string") return false;
        if (!hideUnobtainable) return true;
        const obtained = !!obtainedMedals[medal.medalId];
        return obtained || !MANUALLY_UNOBTAINABLE_MEDAL_IDS.has(medal.medalId);
      });

      // Pull out the "Secret Medal" group first: every hiddenMedal-type
      // medal (see MEDAL_TYPE_NAMES), obtained or not, plus any other medal
      // that's still hidden and unobtained (in case a future medal sets
      // isHidden without being typed hiddenMedal). An obtained secret medal
      // stays in this group, as in the in-game menu's Secret tab.
      const secretMedals = [];
      const typedGroups = new Map();
      const typeOrder = [];
      visibleMedals.forEach((medal) => {
        const obtained = !!obtainedMedals[medal.medalId];
        if (medal.medalType === "hiddenMedal" || (!obtained && medal.isHidden)) {
          secretMedals.push(medal);
          return;
        }
        const type = medal.medalType || "";
        if (!typedGroups.has(type)) {
          typedGroups.set(type, []);
          typeOrder.push(type);
        }
        typedGroups.get(type).push(medal);
      });

      const renderOrder = MEDAL_TYPE_ORDER.filter((t) => typedGroups.has(t)).concat(
        typeOrder.filter((t) => !MEDAL_TYPE_ORDER.includes(t)),
      );

      let totalKnown = 0;
      let totalObtained = 0;
      medalsGroupsEl.innerHTML = "";

      renderOrder.forEach((type) => {
        const medals = typedGroups.get(type);
        const obtainedInGroup = medals.filter((m) => obtainedMedals[m.medalId]).length;
        totalKnown += medals.length;
        totalObtained += obtainedInGroup;

        const label = MEDAL_TYPE_NAMES[type] || humanizeMedalType(type);
        const groupEl = document.createElement("div");
        groupEl.className = "accountPageMedalGroup";
        groupEl.appendChild(
          buildGroupHeading(label, obtainedInGroup, medals.length, "accountPageMedalGroupHeading", "accountPageMedalGroupCount"),
        );

        groupEl.appendChild(buildChipsRow(medals));

        medalsGroupsEl.appendChild(groupEl);
      });

      if (secretMedals.length) {
        // Obtained hiddenMedal-type medals stay in this group, so count them.
        const obtainedInSecret = secretMedals.filter((m) => obtainedMedals[m.medalId]).length;
        totalKnown += secretMedals.length;
        totalObtained += obtainedInSecret;
        const groupEl = document.createElement("div");
        groupEl.className = "accountPageMedalGroup";
        groupEl.appendChild(
          buildGroupHeading(SECRET_GROUP_LABEL, obtainedInSecret, secretMedals.length, "accountPageMedalGroupHeading", "accountPageMedalGroupCount"),
        );
        groupEl.appendChild(buildChipsRow(secretMedals));
        medalsGroupsEl.appendChild(groupEl);
      }

      medalsNoDataEl.classList.add("hidden");
      medalsBarEl.classList.remove("hidden");
      medalsCountEl.textContent = `${totalObtained} / ${totalKnown}`;
      medalsBarFillEl.style.width = totalKnown ? `${(totalObtained / totalKnown) * 100}%` : "0%";
    } catch (err) {
      console.error("Failed to load medal catalog for the account overview:", err);
      medalsBarEl.classList.add("hidden");
      medalsGroupsEl.innerHTML = "";
      hideUnobtainableLabelEl.classList.add("hidden");
      hideMedalPreview();
      medalsCountEl.textContent = "—";
      medalsNoDataEl.textContent = "Couldn't load medal data right now -- try refreshing.";
      medalsNoDataEl.classList.remove("hidden");
    }
  }

  // --- roster table ------------------------------------------------------

  function compareRoster(a, b, sortBy) {
    if (sortBy === "rarity") {
      return b.op.rarity - a.op.rarity || a.op.name.localeCompare(b.op.name);
    }
    if (sortBy === "level") {
      // Unsynced-progress operators (-1) sort after every real level,
      // rather than tying with a genuine Lv1 at the bottom.
      const al = a.progress && typeof a.progress.level === "number" ? a.progress.level : -1;
      const bl = b.progress && typeof b.progress.level === "number" ? b.progress.level : -1;
      return bl - al || a.op.name.localeCompare(b.op.name);
    }
    return a.op.name.localeCompare(b.op.name);
  }

  function renderRoster() {
    const sortBy = sortEl.value;
    const sorted = roster.slice().sort((a, b) => compareRoster(a, b, sortBy));
    rosterCountEl.textContent = String(roster.length);
    bodyEl.innerHTML = "";

    let anyMissingProgress = false;
    sorted.forEach(({ op, progress }) => {
      if (!progress) anyMissingProgress = true;
      const tr = document.createElement("tr");

      const iconTd = document.createElement("td");
      iconTd.className = "accountPageRosterIconCell";
      const icon = document.createElement("img");
      icon.className = "accountPageRosterIcon";
      icon.alt = "";
      icon.loading = "lazy";
      setAvatarIcon(icon, op.charId, op.cnOnly);
      iconTd.appendChild(icon);
      tr.appendChild(iconTd);

      const nameTd = document.createElement("td");
      const link = document.createElement("a");
      link.href = `/operator/?id=${encodeURIComponent(op.charId)}`;
      link.textContent = op.name;
      nameTd.appendChild(link);
      tr.appendChild(nameTd);

      const rarityTd = document.createElement("td");
      rarityTd.textContent = `${op.rarity + 1}★`;
      tr.appendChild(rarityTd);

      const eliteLevelTd = document.createElement("td");
      eliteLevelTd.textContent =
        progress && typeof progress.evolvePhase === "number" && typeof progress.level === "number"
          ? `E${progress.evolvePhase} Lv${progress.level}`
          : "—";
      tr.appendChild(eliteLevelTd);

      const potentialTd = document.createElement("td");
      potentialTd.textContent =
        progress && typeof progress.potentialRank === "number" ? `Potential ${progress.potentialRank + 1}` : "—";
      tr.appendChild(potentialTd);

      const skillTd = document.createElement("td");
      skillTd.textContent = AccountSync.formatSkillSummary(op, progress) || "—";
      tr.appendChild(skillTd);

      const moduleTd = document.createElement("td");
      moduleTd.textContent = AccountSync.formatModuleSummary(op, progress) || "—";
      tr.appendChild(moduleTd);

      bodyEl.appendChild(tr);
    });

    noProgressNoteEl.classList.toggle("hidden", !anyMissingProgress);
  }

  sortEl.addEventListener("change", () => {
    setPref("account", "overviewSort", sortEl.value);
    renderRoster();
  });

  hideUnobtainableEl.addEventListener("change", () => {
    setPref("account", "hideUnobtainableMedals", hideUnobtainableEl.checked);
    renderMedalsSection().catch((err) => {
      console.error("Unexpected error re-rendering the medals section:", err);
    });
  });

  async function init() {
    const account = AccountSync.getAccount();
    if (!account) {
      statusEl.classList.add("hidden");
      notSyncedEl.classList.remove("hidden");
      return;
    }

    renderProfile(account);
    switchTab(loadActiveTabPref());

    hideUnobtainableEl.checked = getPref("account", "hideUnobtainableMedals", false, (v) => typeof v === "boolean");

    // Runs independently of the roster load below, so a failed medal
    // catalog fetch (or no medal data in this sync) doesn't block the
    // roster table, and vice versa.
    renderMedalsSection().catch((err) => {
      console.error("Unexpected error rendering the medals section:", err);
    });

    const ownedIds = AccountSync.getOwnedOperators() || [];
    if (!ownedIds.length) {
      // Synced, but the roster read failed or the account is new and
      // has no operators: show the profile card with an empty-roster
      // note instead of an empty table.
      statusEl.classList.add("hidden");
      contentEl.classList.remove("hidden");
      rosterCountEl.textContent = "0";
      bodyEl.innerHTML = "";
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.className = "accountPageRosterEmpty";
      td.textContent = "No synced operator roster yet -- re-sync from the home page to populate this.";
      tr.appendChild(td);
      bodyEl.appendChild(tr);
      return;
    }

    try {
      const charTable = await OperatorEditModal.loadCharTable();
      roster = ownedIds
        .map((charId) => {
          const op = charTable[charId];
          if (!op) return null; // not in this fork's loaded data -- skip rather than guess
          return { op, progress: AccountSync.getOperatorProgress(charId) };
        })
        .filter(Boolean);

      sortEl.value = getPref("account", "overviewSort", "name", (v) => v === "name" || v === "rarity" || v === "level");
      statusEl.classList.add("hidden");
      contentEl.classList.remove("hidden");
      renderRoster();
    } catch (err) {
      console.error("Failed to load operator data for the account overview:", err);
      statusEl.textContent = "Couldn't load operator data. Please try refreshing.";
    }
  }

  init();
})();
