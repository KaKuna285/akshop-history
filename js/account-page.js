(function () {
  // "My account" overview: profile summary, sync freshness, medal
  // progress, and every owned operator's synced progress as a sortable
  // table. A read-only dashboard for the sync feature -- the actual
  // email/code/fetch form still only lives on the home page
  // (js/account-sync.js's mount()), and this page's own "Re-sync" action
  // just links back there.
  //
  // Reached from any page's nav badge once an account is synced (see
  // AccountSync.renderNavBadge()) -- there's nothing to show here before
  // a first sync, so this isn't in the main site nav; visiting it
  // without one just points back at the home page (see
  // #accountPageNotSynced below) rather than showing an empty dashboard.

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

  let roster = []; // [{ op, progress }], built once charTable + account are both ready

  // --- sync freshness --------------------------------------------------
  // Three bands rather than a bare day count, since "is this still worth
  // trusting" is the actual question -- the owned/not-owned filter and
  // the operator page's "Your stats" toggle are both only as good as how
  // recently this was synced. Thresholds are a judgment call (a day of
  // play rarely changes your roster meaningfully; a month very well
  // might), not read from anywhere authoritative.
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

    // Depot is Planner's data, not AccountSync's own -- read straight
    // from its prefs key the same way Planner itself does, rather than
    // AccountSync needing to know about it. Purely informational here
    // (no edit/replace controls -- that's still Planner's job).
    const depot = getPref("planner", "depot", {}, (v) => v && typeof v === "object");
    const itemCount = Object.keys(depot).length;
    if (itemCount) {
      const depotLine = document.createElement("div");
      depotLine.className = "accountPageDepotLine";
      depotLine.textContent = `Depot: ${itemCount.toLocaleString()} item${itemCount === 1 ? "" : "s"} tracked in the Operator Planner.`;
      metaEl.appendChild(depotLine);
    }
  }

  // --- medals section ----------------------------------------------------
  // "Account progress" beyond the roster table: how many of the game's
  // medals (achievements) this account has obtained, grouped the way the
  // catalog itself groups them (medalType). The catalog side of this is
  // solid -- medal_table.json was fetched and inspected directly while
  // building this feature. The account side (which medals a sync actually
  // reports as obtained) is the least-confirmed data this whole site
  // reads (see cloudflare/depot-import.js's extractObtainedMedals()), so
  // this gates the entire section on AccountSync.getObtainedMedals() not
  // being null rather than ever showing a confidently-wrong 0%.

  // Small local label map, same "own small helper per consumer" reasoning
  // operator-edit-modal.js already uses for its own enum labels -- plus a
  // humanizing fallback for any medalType this map doesn't know about yet
  // (new medal types get added to the game after this list was written).
  const MEDAL_TYPE_NAMES = {
    playerMedal: "Player",
    stageMedal: "Stage",
    campMedal: "Event",
  };

  function humanizeMedalType(type) {
    const words = String(type || "")
      .replace(/Medal$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim();
    if (!words) return "Other";
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  // EN-only, same as the rest of the account-sync feature (the Worker
  // only ever logs into an EN/Yostar account) -- no CN-merge fallback
  // here the way OperatorEditModal.loadCharTable() has one, since a
  // medal obtained on an EN account is always in EN's own catalog.
  async function loadMedalTable() {
    const res = await fetch(`${DATA_BASE[SERVERS.EN]}/gamedata/excel/medal_table.json`);
    const json = await fixedJson(res);
    return Array.isArray(json.medalList) ? json.medalList : [];
  }

  async function renderMedalsSection() {
    const obtained = AccountSync.getObtainedMedals();
    if (!obtained) {
      medalsCountEl.textContent = "—";
      medalsBarEl.classList.add("hidden");
      medalsGroupsEl.innerHTML = "";
      medalsNoDataEl.classList.remove("hidden");
      return;
    }

    try {
      const medalList = await loadMedalTable();

      // Group by medalType, preserving medalList's own order both across
      // groups (first-seen order) and within each group -- no re-sorting,
      // so this never introduces an ordering assumption the catalog
      // itself doesn't make.
      const order = [];
      const groups = new Map();
      medalList.forEach((medal) => {
        if (!medal || typeof medal.medalId !== "string") return;
        const type = medal.medalType || "";
        if (!groups.has(type)) {
          groups.set(type, []);
          order.push(type);
        }
        groups.get(type).push(medal);
      });

      let totalKnown = 0;
      let totalObtained = 0;
      medalsGroupsEl.innerHTML = "";

      order.forEach((type) => {
        const medals = groups.get(type);
        const obtainedInGroup = medals.filter((m) => obtained[m.medalId]).length;
        totalKnown += medals.length;
        totalObtained += obtainedInGroup;

        const groupEl = document.createElement("div");
        groupEl.className = "accountPageMedalGroup";

        const headingEl = document.createElement("div");
        headingEl.className = "accountPageMedalGroupHeading";
        headingEl.textContent = `${MEDAL_TYPE_NAMES[type] || humanizeMedalType(type)} (${obtainedInGroup} / ${medals.length})`;
        groupEl.appendChild(headingEl);

        const chipsEl = document.createElement("div");
        chipsEl.className = "accountPageMedalChips";

        medals.forEach((medal) => {
          const isObtained = !!obtained[medal.medalId];
          const chip = document.createElement("div");
          const nameLineEl = document.createElement("div");
          nameLineEl.className = "accountPageMedalChipName";

          if (isObtained) {
            chip.className = "accountPageMedalChip accountPageMedalChip-obtained";
            nameLineEl.textContent = medal.medalName || "Medal";
            chip.appendChild(nameLineEl);
          } else if (medal.isHidden) {
            // Spoiler-protected: don't reveal the name or how to get it
            // until it's actually obtained.
            chip.className = "accountPageMedalChip accountPageMedalChip-hidden";
            nameLineEl.textContent = "???";
            chip.appendChild(nameLineEl);
          } else {
            chip.className = "accountPageMedalChip accountPageMedalChip-missing";
            nameLineEl.textContent = medal.medalName || "Medal";
            chip.appendChild(nameLineEl);
            if (medal.getMethod) {
              const hintEl = document.createElement("div");
              hintEl.className = "accountPageMedalChipHint";
              hintEl.textContent = medal.getMethod;
              chip.appendChild(hintEl);
            }
          }
          chipsEl.appendChild(chip);
        });

        groupEl.appendChild(chipsEl);
        medalsGroupsEl.appendChild(groupEl);
      });

      medalsNoDataEl.classList.add("hidden");
      medalsBarEl.classList.remove("hidden");
      medalsCountEl.textContent = `${totalObtained} / ${totalKnown}`;
      medalsBarFillEl.style.width = totalKnown ? `${(totalObtained / totalKnown) * 100}%` : "0%";
    } catch (err) {
      console.error("Failed to load medal catalog for the account overview:", err);
      medalsBarEl.classList.add("hidden");
      medalsGroupsEl.innerHTML = "";
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

  async function init() {
    const account = AccountSync.getAccount();
    if (!account) {
      statusEl.classList.add("hidden");
      notSyncedEl.classList.remove("hidden");
      return;
    }

    renderProfile(account);

    // Runs independently of the roster load below -- a failed medal
    // catalog fetch (or no medal data in this sync) shouldn't block the
    // roster table from showing, and vice versa.
    renderMedalsSection().catch((err) => {
      console.error("Unexpected error rendering the medals section:", err);
    });

    const ownedIds = AccountSync.getOwnedOperators() || [];
    if (!ownedIds.length) {
      // Synced, but either the roster read failed or the account
      // genuinely has nothing yet (new account) -- show the profile
      // card either way, just with an empty-roster note instead of a
      // table with nothing in it.
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
