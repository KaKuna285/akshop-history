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

  // --- tabs (Operators / Medals) ------------------------------------------
  // Operators is the primary tab -- shown first and selected by default,
  // same convention as Planner's Roster/Your Depot tabs (js/planner.js's
  // switchTab()) -- copied here rather than shared, since this page and
  // Planner don't share any JS either.

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
  // "Account progress" beyond the roster table: how many of the game's
  // medals (achievements) this account has obtained, grouped the way the
  // catalog itself groups them (medalType). The catalog side of this is
  // solid -- medal_table.json was fetched and inspected directly while
  // building this feature. The account side (which medals a sync actually
  // reports as obtained) is the least-confirmed data this whole site
  // reads (see cloudflare/depot-import.js's extractObtainedMedals()), so
  // this gates the entire section on AccountSync.getObtainedMedals() not
  // being null rather than ever showing a confidently-wrong 0%.

  // Label map matching the real in-game "Path to Glory" menu names, named
  // per medalType. IMPORTANT, confirmed by directly re-inspecting
  // medal_table.json (multiple mirrors, exhaustive distinct-value search):
  // this file only EVER contains 3 medalType values -- playerMedal,
  // stageMedal, campMedal. The in-game menu actually has ten tabs (Records,
  // Episodes, Annihilation, SSS, Progress, Chronicles, Traveler From Afar,
  // Base, Event, Secret) -- the other seven (SSS/Tower, Progress/Growth,
  // Chronicles/Story, Traveler From Afar/Rogue, Base/Build, Event/Activity)
  // are tracked through entirely separate subsystem tables (roguelike,
  // tower, infrastructure, activity rewards) that this site doesn't read
  // at all, so there's no data here to show them from -- they're left out
  // entirely rather than shown as a permanently-empty category, which
  // would misleadingly read as "you have 0 of these" instead of "this site
  // can't see these yet". "Secret" also isn't its own medalType -- it's
  // the existing isHidden flag, pulled out into its own group below
  // (see renderMedalsSection()) for any medal that's both hidden and not
  // yet obtained, same as the real menu does.
  const MEDAL_TYPE_NAMES = {
    playerMedal: "Records Medal",
    stageMedal: "Episodes Medal",
    campMedal: "Annihilation",
  };
  // Render order for the known types; anything else (a brand new medalType
  // the game adds later) falls back to humanizeMedalType() below and is
  // appended after these, in first-seen order -- see renderMedalsSection().
  const MEDAL_TYPE_ORDER = ["playerMedal", "stageMedal", "campMedal"];
  const SECRET_GROUP_LABEL = "Secret Medal";

  function humanizeMedalType(type) {
    const words = String(type || "")
      .replace(/Medal$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim();
    if (!words) return "Other";
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  // There's no reliable data field marking a medal as permanently missed
  // (expireTimes exists but wasn't confirmed to mean that, and plenty of
  // non-expired medals have odd values there too) -- same "no trustworthy
  // signal, so maintain it by hand" situation as util.js's own
  // LINKAGE_LIMITEDS list. Add a medalId below (see a medal's own id in
  // the catalog) for anything you've confirmed is gone for good, and the
  // "hide medals I can no longer obtain" toggle (only shown once this list
  // actually has something in it) will filter it out of both the grid and
  // the overall/group counts.
  const MANUALLY_UNOBTAINABLE_MEDAL_IDS = new Set([
    // "medal_camp_rotate_05",
  ]);

  // Same 3-tier grey/blue/gold scale operator rarity already uses
  // elsewhere on the site (css/operator-extra.css's --rarity-color for
  // 1-2★/4★/6★), reused here rather than inventing a separate palette
  // for medals' own T1/T2/T3 rarity field.
  const MEDAL_RARITY_COLORS = { T1: "#9f9f9f", T2: "#00b2f6", T3: "#ffae00" };

  // EN-only, same as the rest of the account-sync feature (the Worker
  // only ever logs into an EN/Yostar account) -- no CN-merge fallback
  // here the way OperatorEditModal.loadCharTable() has one, since a
  // medal obtained on an EN account is always in EN's own catalog.
  async function loadMedalTable() {
    const res = await fetch(`${DATA_BASE[SERVERS.EN]}/gamedata/excel/medal_table.json`);
    const json = await fixedJson(res);
    return Array.isArray(json.medalList) ? json.medalList : [];
  }

  // The last-rendered sync's obtained-medals map, kept at module scope so
  // renderMedalChip()'s click handler (closed over a specific medal
  // already) can still look up that medal's obtained entry.
  let obtainedMedals = null;

  // The last-loaded catalog, medalId -> medal, kept at module scope so
  // showMedalPreview() can resolve a "meta" medal's preMedalIdList (see
  // below) into the names of the medals it requires.
  let medalById = new Map();

  // --- Annihilation (campMedal) sub-grouping by event ---------------------
  // medal_table.json has no dedicated event/collection field (confirmed
  // while building this) -- unlockParam[0] is the closest thing to a
  // stable per-real-world-Operation identifier (e.g. "camp_01" for a
  // permanent chapter, "camp_r_05" for a rotating one), reused here as
  // the grouping key. A medal missing that (shouldn't normally happen for
  // this type, but stay defensive) goes in its own "no event" bucket,
  // shown first -- same placement described seeing in-game.
  const EVENT_LABEL_SUFFIXES = [/ Annihilation Medal$/, / Operation Medal$/, / Medal$/];
  function eventLabelFor(medal) {
    const name = medal.medalName || "";
    for (const suffix of EVENT_LABEL_SUFFIXES) {
      const stripped = name.replace(suffix, "");
      if (stripped && stripped !== name) return stripped;
    }
    return name || "Unknown operation";
  }
  function groupCampMedalsByEvent(medals) {
    const order = [];
    const groups = new Map();
    medals.forEach((medal) => {
      const key = medal.unlockParam && medal.unlockParam[0] ? medal.unlockParam[0] : null;
      if (!groups.has(key)) {
        groups.set(key, { label: key === null ? null : eventLabelFor(medal), medals: [], maxDisplayTime: -Infinity });
        order.push(key);
      }
      const g = groups.get(key);
      g.medals.push(medal);
      if (typeof medal.displayTime === "number" && medal.displayTime > g.maxDisplayTime) {
        g.maxDisplayTime = medal.displayTime;
      }
    });
    const noEvent = groups.has(null) ? [groups.get(null)] : [];
    const withEvent = order.filter((k) => k !== null).map((k) => groups.get(k));
    withEvent.sort((a, b) => b.maxDisplayTime - a.maxDisplayTime);
    return noEvent.concat(withEvent);
  }

  // --- medal detail panel --------------------------------------------
  // Opens on clicking any medal chip -- see #medalPreview in account/
  // index.html and its own comment there. A hidden (isHidden), not-yet-
  // obtained medal's real name/description/getMethod only ever show up
  // here, after a deliberate click; the chip itself keeps showing "???"
  // regardless (see renderMedalChip() below), so this is the one place
  // that's allowed to spoil it.

  function formatObtainedDate(ts) {
    if (typeof ts !== "number" || ts <= 0) return null;
    // Every other timestamp this site reads from game data (medal_table.
    // json's own displayTime, event dates, etc.) is Unix seconds, not
    // milliseconds -- same assumption here for consistency, though (like
    // the rest of obtainedMedals) the obtain timestamp's own field name
    // was a guess on the Worker side, so this stays defensive about
    // producing a garbage date rather than trusting it blindly.
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime()) || d.getFullYear() < 2017 || d.getFullYear() > 2100) return null;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  // preMedalIdList (a "meta" medal's prerequisites, e.g. a Talent
  // Recognition Medal II that requires I first) is an array of medalId
  // strings when populated -- confirmed via real chained examples while
  // building this. When a medal has none, the raw JSON can come back as
  // an empty `{}` object rather than `[]` (a known datamining quirk of
  // this game's empty List fields), so this treats anything that isn't a
  // real array as "no prerequisites" rather than erroring on it.
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

    // The real in-game icon -- shown only once (if) it actually loads;
    // the fa-medal glyph underneath (.medalPreviewIcon::before, in css/
    // account-extra.css) stays the permanent fallback, since no second
    // mirror is known to carry these the way operator art has one (see
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
  }

  function hideMedalPreview() {
    medalPreviewOverlayEl.classList.add("hidden");
  }

  medalPreviewCloseBtn.addEventListener("click", hideMedalPreview);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !medalPreviewOverlayEl.classList.contains("hidden")) hideMedalPreview();
  });

  // A popup modal now (was an inline panel at the top of the page) --
  // same overlay-click-to-close pattern as the shared operator edit
  // modal (see js/operator-edit-modal.js's ensureDom()): only closes when
  // the click lands on the backdrop itself, not anything inside the panel.
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
      // Always the real medal, even when still hidden+unobtained -- "the
      // chip says ???" and "clicking it reveals what it actually is" are
      // two different, deliberate states; only the chip itself stays
      // spoiler-protected.
      showMedalPreview(medal, obtainedEntry);
    });

    return chip;
  }

  // Builds one "(obtained / total)" heading element -- shared by both the
  // main medalType groups and each Annihilation event sub-group below.
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

      // Only worth showing the toggle at all once the manually-maintained
      // override list (see its own comment above) actually has something
      // in it -- otherwise it's a control that visibly does nothing.
      hideUnobtainableLabelEl.classList.toggle("hidden", MANUALLY_UNOBTAINABLE_MEDAL_IDS.size === 0);
      const hideUnobtainable = hideUnobtainableEl.checked;

      // "Of what's still obtainable" when the toggle is on -- a medal
      // that's gone for good shouldn't count against you, so it's
      // dropped from both the grid AND the overall/group totals below,
      // not just hidden visually. A medal you already obtained before it
      // went away is never dropped by this, regardless of the toggle.
      const visibleMedals = medalList.filter((medal) => {
        if (!medal || typeof medal.medalId !== "string") return false;
        if (!hideUnobtainable) return true;
        const obtained = !!obtainedMedals[medal.medalId];
        return obtained || !MANUALLY_UNOBTAINABLE_MEDAL_IDS.has(medal.medalId);
      });

      // Pull out "Secret Medal" first -- any medal that's both still
      // hidden (isHidden) AND not yet obtained, regardless of its
      // medalType, same as the real "Path to Glory" menu's own Secret
      // tab. Once obtained, a formerly-hidden medal moves into its real
      // type group below instead (it's no longer a secret).
      const secretMedals = [];
      const typedGroups = new Map();
      const typeOrder = [];
      visibleMedals.forEach((medal) => {
        const obtained = !!obtainedMedals[medal.medalId];
        if (!obtained && medal.isHidden) {
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

        if (type === "campMedal") {
          // Annihilation nests one level deeper -- a mini-heading per
          // real-world Operation (see groupCampMedalsByEvent() above),
          // with medals that couldn't be matched to one shown first.
          groupCampMedalsByEvent(medals).forEach((eventGroup) => {
            const obtainedInEvent = eventGroup.medals.filter((m) => obtainedMedals[m.medalId]).length;
            const eventEl = document.createElement("div");
            eventEl.className = "accountPageMedalEventGroup";
            eventEl.appendChild(
              buildGroupHeading(
                eventGroup.label || "Other",
                obtainedInEvent,
                eventGroup.medals.length,
                "accountPageMedalEventHeading",
                "accountPageMedalGroupCount",
              ),
            );
            eventEl.appendChild(buildChipsRow(eventGroup.medals));
            groupEl.appendChild(eventEl);
          });
        } else {
          groupEl.appendChild(buildChipsRow(medals));
        }

        medalsGroupsEl.appendChild(groupEl);
      });

      if (secretMedals.length) {
        totalKnown += secretMedals.length; // obtainedInGroup is always 0 here, by construction
        const groupEl = document.createElement("div");
        groupEl.className = "accountPageMedalGroup";
        groupEl.appendChild(
          buildGroupHeading(SECRET_GROUP_LABEL, 0, secretMedals.length, "accountPageMedalGroupHeading", "accountPageMedalGroupCount"),
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
