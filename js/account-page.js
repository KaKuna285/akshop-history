(function () {
  // "My account" overview: profile summary, sync freshness, and every
  // owned operator's synced progress as a sortable table. A read-only
  // dashboard for the sync feature -- the actual email/code/fetch form
  // still only lives on the home page (js/account-sync.js's mount()),
  // and this page's own "Re-sync" action just links back there.
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
