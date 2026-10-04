(function () {
  const upcomingEl = document.getElementById("upcomingList");
  const pastEl = document.getElementById("pastList");
  const lagHintEl = document.getElementById("lagHint");
  const viewToggle = document.getElementById("viewToggle");
  const statusFiltersEl = document.getElementById("statusFilters");
  const sortSelect = document.getElementById("sortSelect");
  const sortGroup = document.getElementById("sortGroup");
  const calendarViewRoot = document.getElementById("calendarViewRoot");
  const calendarContent = document.getElementById("calendarContent");
  const eventPreviewEl = document.getElementById("eventPreview");
  const eventPreviewCloseBtn = document.getElementById("eventPreviewClose");
  const eventPreviewImgEl = document.getElementById("eventPreviewImg");
  const eventPreviewBodyEl = document.getElementById("eventPreviewBody");
  const legendAnnouncedItem = document.getElementById("legendAnnouncedItem");
  const filterAnnouncedItem = document.getElementById("filterAnnouncedItem");
  const weekGridEl = document.getElementById("weekGrid");
  const weekLabelEl = document.getElementById("weekLabel");
  const prevWeekBtn = document.getElementById("prevWeekBtn");
  const nextWeekBtn = document.getElementById("nextWeekBtn");
  const todayBtn = document.getElementById("todayBtn");
  const dataFreshnessEl = document.getElementById("dataFreshness");

  const GRACE_DAYS = 30;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  // The calendar view is a continuous, scrollable stream of week rows. This
  // many weeks are rendered on the very first load, centered on the
  // current week; after that, scrolling near either edge of what's
  // rendered so far loads another batch on demand (see the scroll
  // listener near the bottom), so the whole calendar is reachable just by
  // scrolling, with Prev/Next Week and Today as a faster way to jump.
  const WEEKS_BEFORE = 4;
  const WEEKS_AFTER = 10;
  const LOAD_BATCH_WEEKS = 4;
  const LOAD_THRESHOLD_PX = 500;

  const STATUS_LABEL = {
    confirmed: "CONFIRMED",
    announced: "ANNOUNCED",
    estimated: "ESTIMATED",
    cnExclusive: "CN EXCLUSIVE",
  };

  let allEvents = [];
  let currentView = "calendar"; // "calendar" | "list"
  let sortMode = "date"; // "date" | "name"
  let activeStatuses = new Set(["confirmed", "announced", "estimated", "cnExclusive"]);

  // Restore any settings saved from a previous visit (see js/prefs.js).
  // Deliberately NOT included here: which week the calendar view was
  // scrolled to -- every visit starts back at today, on purpose.
  currentView = getPref(
    "calendar",
    "view",
    currentView,
    (v) => v === "calendar" || v === "list",
  );
  sortMode = getPref("calendar", "sort", sortMode, (v) => v === "date" || v === "name");
  activeStatuses = new Set(
    getPref("calendar", "statusFilters", Array.from(activeStatuses), (v) =>
      Array.isArray(v) && v.every((s) => Object.keys(STATUS_LABEL).includes(s)),
    ),
  );
  // The controls above are hardcoded in the HTML to match the defaults
  // just overwritten -- reflect whatever was actually restored back into
  // the DOM so the UI matches these variables from the very first paint.
  for (const b of viewToggle.querySelectorAll(".viewToggleBtn")) {
    b.classList.toggle("active", b.dataset.view === currentView);
  }
  for (const input of statusFiltersEl.querySelectorAll("input[type=checkbox]")) {
    input.checked = activeStatuses.has(input.value);
  }
  sortSelect.value = sortMode;

  // Calendar-view-only state. The grid is built once (renderCalendarInitial)
  // and then only ever grown (prependWeeks/appendWeeks) or has its chip
  // contents refreshed in place (refreshCalendarChips) -- never torn down
  // and rebuilt -- so scroll position survives filter changes and view
  // toggles.
  let calendarInitialized = false;
  let renderedStart = null; // first rendered day (Monday-aligned), inclusive
  let renderedEnd = null; // one day past the last rendered day
  let weekRows = []; // [{weekStart, el}], ascending, el = that week's Monday .calDay
  const dayCellsByDayNum = new Map(); // dayNum -> that day's .calChips element
  let scrollTickScheduled = false;
  // The very first render happens before events.json has loaded (see the
  // bottom of this file), so the initial scroll-to-today position is
  // computed against an empty grid -- every .calDay is still just its
  // min-height, with no event chips yet. Once real data lands, chip
  // content changes row heights (a day with two or three chips is taller
  // than an empty one), which shifts every later row's offsetTop -- so
  // the scroll position has to be recomputed once, against the real
  // layout, or the page opens a few rows off from today. This flag marks
  // "real data has loaded but that recompute hasn't happened yet".
  let needsInitialScrollFix = false;

  function startOfWeek(d) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = (c.getDay() + 6) % 7; // days since the most recent Monday
    c.setDate(c.getDate() - diff);
    return c;
  }

  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  // Label for the header: not an exact date range, just which month(s) and
  // year(s) are currently in view -- e.g. "September 2026" or, when the
  // visible rows straddle a month (or year) boundary, "September –
  // October 2026" / "December 2026 – January 2027".
  function fmtMonthRangeLabel(startDate, endDate) {
    const startMonth = startDate.toLocaleDateString(undefined, { month: "long" });
    const endMonth = endDate.toLocaleDateString(undefined, { month: "long" });
    const startYear = startDate.getFullYear();
    const endYear = endDate.getFullYear();
    if (startYear === endYear && startMonth === endMonth) return `${startMonth} ${startYear}`;
    if (startYear === endYear) return `${startMonth} – ${endMonth} ${startYear}`;
    return `${startMonth} ${startYear} – ${endMonth} ${endYear}`;
  }

  function toDayNum(d) {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return Math.floor(c.getTime() / DAY_MS);
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  // A few source rows have an end date earlier than their start date (a
  // mistyped year on the wiki, most likely -- events.py now guards against
  // this for newly-estimated dates, but already-cached JSON, or a
  // *confirmed* Global end straight off the wiki, can still have it). Rather
  // than trust it, every place that needs "the end of this window" goes
  // through this helper instead of reading globalEnd/cnEnd directly.
  function effectiveEnd(startIso, endIso) {
    const start = new Date(startIso);
    if (!endIso) return start;
    const end = new Date(endIso);
    return end < start ? start : end;
  }

  function fmtRange(startIso, endIso) {
    if (!startIso) return "Unknown";
    if (!endIso) return fmtDate(startIso);
    if (new Date(endIso) < new Date(startIso)) return fmtDate(startIso);
    return `${fmtDate(startIso)} – ${fmtDate(endIso)}`;
  }

  function daysBetween(a, b) {
    return Math.round((b - a) / DAY_MS);
  }

  // Best-effort "this event looks tied to these new operators" match, used
  // to power the planner links in the event preview panel (see
  // showEventPreview() below). There's no scraped gacha-banner calendar to
  // draw on -- events.py only scrapes story/side events, not headhunting
  // banners -- but a new operator's EN release almost always lands on the
  // same day as the event it debuts alongside, so matching by release-date
  // proximity is a reasonable stand-in.
  //
  // Both events.json's globalStart ("...T17:00:00") and operator_release_
  // dates.json's onlineTime ("...17:00:00", space-separated instead of "T")
  // use the same plain, no-UTC-offset timestamp convention -- comparing just
  // the Y-M-D portion (via Date.UTC, so this doesn't drift with whatever
  // timezone the browser is in) avoids the ambiguity of parsing either one
  // as a full timestamp.
  function dayKeyFromTimestamp(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    if (!m) return null;
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
  }

  const OPERATOR_MATCH_WINDOW_DAYS = 1;
  // A real debut is 1-4 operators, occasionally more for a collab/
  // anniversary batch -- this also happens to be exactly what filters out
  // the one known false-positive case: EN's original Jan 2020 launch
  // back-dated ~90 operators' onlineTime to the same couple of days as the
  // catch-up "Opening Event", which would otherwise show as one event
  // "debuting" nearly the entire early roster.
  const OPERATOR_MATCH_MAX = 6;

  // Mutates each matching event in `events`, setting ev.operators to
  // [{charId, name, icon}, ...] -- the shape showEventPreview() already
  // expects (that rendering existed before this matching did; it's what
  // first suggested tying the two together).
  function matchOperatorsToEvents(events, charTable) {
    const byDay = new Map(); // dayNum -> [operator record, ...]
    for (const op of Object.values(charTable)) {
      const day = dayKeyFromTimestamp(op.onlineTime);
      if (day == null) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(op);
    }
    for (const ev of events) {
      const day = dayKeyFromTimestamp(ev.globalStart);
      if (day == null) continue;
      const seen = new Set();
      const matches = [];
      for (let d = day - OPERATOR_MATCH_WINDOW_DAYS; d <= day + OPERATOR_MATCH_WINDOW_DAYS; d++) {
        for (const op of byDay.get(d) || []) {
          if (seen.has(op.charId)) continue;
          seen.add(op.charId);
          matches.push(op);
        }
      }
      if (matches.length && matches.length <= OPERATOR_MATCH_MAX) {
        ev.operators = matches
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((op) => ({ charId: op.charId, name: op.name, icon: uri_avatar(op.charId) }));
      }
    }
  }

  function countdownLabel(globalStartIso, now) {
    const d = daysBetween(now, new Date(globalStartIso));
    if (d === 0) return "today";
    if (d > 0) return `in ${d} day${d === 1 ? "" : "s"}`;
    return `${-d} day${d === -1 ? "" : "s"} ago`;
  }

  // Confirmed events are exactly what Yostar has set. An event that's
  // only ever had an *estimated* Global date, and whose estimated window
  // closed more than GRACE_DAYS ago with still no confirmation, is treated
  // as CN exclusive instead of "upcoming forever" -- it's either not coming
  // to Global at all, or running unusually late, and the grace period is
  // there so an event that's simply a bit delayed doesn't flip red early.
  function getStatus(ev, now) {
    if (ev.globalConfirmed) return "confirmed";
    // Manually pinned via overrides.json -- treated as its own tier,
    // never falls through to "CN exclusive" no matter how old its window
    // gets, since it's officially known to be coming rather than guessed.
    if (ev.announced) return "announced";
    const end = effectiveEnd(ev.globalStart, ev.globalEnd);
    if (now.getTime() - end.getTime() > GRACE_DAYS * DAY_MS) return "cnExclusive";
    return "estimated";
  }

  // "Announced" only ever shows up when something is currently pinned via
  // overrides.json -- most of the time nothing is, so its legend swatch and
  // filter checkbox would just be clutter for a status that never appears.
  // Hide both whenever no loaded event is currently in that state.
  function updateAnnouncedVisibility() {
    const hasAnnounced = allEvents.some((ev) => ev._status === "announced");
    const display = hasAnnounced ? "" : "none";
    if (legendAnnouncedItem) legendAnnouncedItem.style.display = display;
    if (filterAnnouncedItem) filterAnnouncedItem.style.display = display;
  }

  // Builds a /wiki/<page> URL from a MediaWiki page name. Segments are
  // encoded individually (not the whole string) so a literal "/" in a
  // subpage name like "Event/Rerun" stays a subpage path instead of being
  // percent-encoded into one long, broken slug.
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

  // Shared hover tooltip for calendar-grid chips, showing an event's name
  // and dates. Built once and repositioned/repopulated per chip on hover,
  // rather than one tooltip element per chip -- the grid can have hundreds
  // of chips on screen at once, and only ever one tooltip is visible at a
  // time. No banner art here (that lives in the click-to-open preview
  // panel instead -- see showEventPreview) so hovering stays lightweight.
  const hoverTooltipEl = document.createElement("div");
  hoverTooltipEl.className = "eventHoverTooltip";
  const hoverTooltipNameEl = document.createElement("div");
  hoverTooltipNameEl.className = "eventHoverTooltipName";
  const hoverTooltipDatesEl = document.createElement("div");
  hoverTooltipDatesEl.className = "eventHoverTooltipDates";
  hoverTooltipEl.appendChild(hoverTooltipNameEl);
  hoverTooltipEl.appendChild(hoverTooltipDatesEl);
  document.body.appendChild(hoverTooltipEl);

  function showHoverTooltip(ev, anchorEl) {
    hoverTooltipNameEl.textContent = ev.event;
    hoverTooltipDatesEl.textContent = fmtRange(ev.globalStart, ev.globalEnd);
    hoverTooltipEl.classList.add("visible");

    // Anchor below the chip by default, flipping above it (or clamping
    // sideways) if there isn't room -- the tooltip's own size depends on
    // its content, so this has to run after the content above is set.
    const anchorRect = anchorEl.getBoundingClientRect();
    const ttRect = hoverTooltipEl.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + 6;
    if (left + ttRect.width > window.innerWidth - 8) {
      left = window.innerWidth - ttRect.width - 8;
    }
    if (left < 8) left = 8;
    if (top + ttRect.height > window.innerHeight - 8) {
      top = anchorRect.top - ttRect.height - 6;
    }
    hoverTooltipEl.style.left = `${left}px`;
    hoverTooltipEl.style.top = `${top}px`;
  }

  function hideHoverTooltip() {
    hoverTooltipEl.classList.remove("visible");
  }

  // Wires up a chip or card (a plain, non-<a> element -- see buildChip()/
  // buildCard()) to behave like a button: clickable and keyboard-activable
  // (Enter/Space), calling onActivate() either way. stopPropagation() on
  // the click matters here -- the preview panel's own "click outside to
  // close" listener is on document, and without this, opening the preview
  // would immediately close it again as that same click bubbles up.
  function makeClickable(el, onActivate) {
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onActivate();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    });
  }

  // The bigger event preview panel: opened by clicking any chip or card,
  // sitting between the legend/controls row and the calendar/list content
  // (see calendar/index.html). Its image/close-button/body wrapper are
  // fixed markup; only eventPreviewBodyEl's contents are rebuilt per event,
  // the same pattern buildCard() already uses for the list view.
  function showEventPreview(ev) {
    eventPreviewEl.className = "eventPreview visible " + ev._status;

    if (ev.image) {
      eventPreviewImgEl.src = ev.image;
      eventPreviewImgEl.style.display = "";
    } else {
      eventPreviewImgEl.removeAttribute("src");
      eventPreviewImgEl.style.display = "none";
    }

    eventPreviewBodyEl.innerHTML = "";

    const name = document.createElement("div");
    name.className = "eventPreviewName";
    name.textContent = ev.event;
    const badge = document.createElement("span");
    badge.className = "eventPreviewBadge " + ev._status;
    badge.textContent = STATUS_LABEL[ev._status];
    name.appendChild(badge);
    eventPreviewBodyEl.appendChild(name);

    const dates = document.createElement("div");
    dates.className = "eventPreviewDates";
    if (ev.cnStart) {
      const cnLine = document.createElement("div");
      cnLine.className = "cnDate";
      cnLine.textContent = `CN: ${fmtRange(ev.cnStart, ev.cnEnd)}`;
      dates.appendChild(cnLine);
    }
    const globalLine = document.createElement("div");
    globalLine.className = "globalDate";
    globalLine.textContent = `Global: ${fmtRange(ev.globalStart, ev.globalEnd)}`;
    dates.appendChild(globalLine);
    const countdown = document.createElement("div");
    countdown.className = "countdown";
    countdown.textContent = countdownLabel(ev.globalStart, new Date());
    dates.appendChild(countdown);
    eventPreviewBodyEl.appendChild(dates);

    if (ev.announced && ev.source) {
      const sourceLine = document.createElement("div");
      sourceLine.className = "eventPreviewSource";
      sourceLine.textContent = `Announced via ${ev.source}`;
      if (ev.note) sourceLine.title = ev.note;
      eventPreviewBodyEl.appendChild(sourceLine);
    }

    if (ev.operators && ev.operators.length) {
      const opsSection = document.createElement("div");
      opsSection.className = "eventPreviewOperators";
      const opsHeading = document.createElement("div");
      opsHeading.className = "eventPreviewOperatorsHeading";
      opsHeading.textContent = "New operators";
      opsSection.appendChild(opsHeading);
      const opsList = document.createElement("div");
      opsList.className = "eventPreviewOperatorsList";
      // Read fresh each time this panel opens (rather than once at load)
      // so it reflects whatever was added/removed since the page loaded --
      // getPref() is cheap enough to call per chip build.
      const rosterCharIds = new Set(
        getPref("planner", "roster", [], (v) => Array.isArray(v))
          .filter((e) => e && typeof e.charId === "string")
          .map((e) => e.charId),
      );
      ev.operators.forEach((op) => {
        const inPlanner = rosterCharIds.has(op.charId);
        // Every chip is a real <button> now, whether or not the operator
        // is already in the roster -- clicking it always opens the same
        // edit card in place (adding the operator first if it isn't
        // already on the roster), the way planner.js's own
        // selectSearchResult() does when you add one from its search box.
        // This used to be a link to /planner/?add=charId instead, but
        // that navigated away from the calendar entirely rather than
        // popping the card open here.
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "eventPreviewOperatorChip" + (inPlanner ? " inPlanner" : "");
        chip.title = inPlanner
          ? `${op.name} is in your planner roster -- click to edit`
          : `Add ${op.name} to your planner roster`;
        if (op.icon) {
          const icon = document.createElement("img");
          icon.className = "eventPreviewOperatorIcon";
          icon.src = op.icon;
          icon.alt = "";
          chip.appendChild(icon);
        }
        const name = document.createElement("span");
        name.className = "eventPreviewOperatorName";
        name.textContent = op.name;
        chip.appendChild(name);
        const action = document.createElement("span");
        action.className = "eventPreviewOperatorAction";
        action.textContent = inPlanner ? "✓ In planner" : "+ Add to planner";
        chip.appendChild(action);
        chip.addEventListener("click", () => openOperatorModalFromChip(op, ev));
        opsList.appendChild(chip);
      });
      opsSection.appendChild(opsList);
      eventPreviewBodyEl.appendChild(opsSection);
    }

    if (ev.skins && ev.skins.length) {
      const skinsSection = document.createElement("div");
      skinsSection.className = "eventPreviewSkins";
      const skinsHeading = document.createElement("div");
      skinsHeading.className = "eventPreviewSkinsHeading";
      skinsHeading.textContent = "New skins";
      skinsSection.appendChild(skinsHeading);
      const skinsList = document.createElement("div");
      skinsList.className = "eventPreviewSkinsList";
      // Sorted by operator name, same as the operators section above --
      // skinName alone would scatter one operator's own skins apart from
      // each other whenever a batch introduces more than one for them.
      ev.skins
        .slice()
        .sort((a, b) => (a.operatorName || "").localeCompare(b.operatorName || ""))
        .forEach((skin) => {
          // No charId (the wiki-scraped operator name on events.py's side
          // didn't resolve to one, or this skin was named on a page but
          // never cross-referenced) -- still show the name rather than
          // silently dropping it, just not as a link to anywhere.
          const chip = skin.charId ? document.createElement("a") : document.createElement("span");
          chip.className = "eventPreviewSkinChip";
          if (skin.charId) {
            chip.href = `/operator/?id=${encodeURIComponent(skin.charId)}`;
            const icon = document.createElement("img");
            icon.className = "eventPreviewSkinIcon";
            icon.src = uri_avatar(skin.charId);
            icon.alt = "";
            chip.appendChild(icon);
          }
          const name = document.createElement("span");
          name.className = "eventPreviewSkinName";
          name.textContent = skin.operatorName ? `${skin.skinName} (${skin.operatorName})` : skin.skinName;
          chip.appendChild(name);
          // Out on CN already but not yet confirmed for Global (events.py
          // flags it cnOnly -- see index_outfit_brand_releases()): shown
          // so an upcoming event lists what it's expected to bring, but
          // tagged, since it's the same "estimated" caveat the event's own
          // badge carries, not a promise.
          if (skin.cnOnly) {
            chip.classList.add("eventPreviewSkinChipUnconfirmed");
            chip.title = "Out on CN, not yet confirmed for Global";
            const tag = document.createElement("span");
            tag.className = "eventPreviewSkinTag";
            tag.textContent = "CN";
            chip.appendChild(tag);
          }
          skinsList.appendChild(chip);
        });
      skinsSection.appendChild(skinsList);
      eventPreviewBodyEl.appendChild(skinsSection);
    }

    const wikiHref = wikiUrl(ev.wikiPage || ev.event);
    if (wikiHref) {
      const link = document.createElement("a");
      link.className = "eventPreviewLink";
      link.href = wikiHref;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "View on wiki ↗";
      eventPreviewBodyEl.appendChild(link);
    }

    // Clicking a chip deep in the grid (or a card near the bottom of a
    // long list) can open the panel off-screen above the current scroll
    // position -- bring it into view rather than leaving the person to
    // notice and scroll up themselves.
    eventPreviewEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Opens the shared operator edit modal (js/operator-edit-modal.js) for
  // the operator an "Add to planner"/"In planner" chip was clicked for --
  // adding it to the roster first if it wasn't already there, the same
  // add-then-open sequence planner.js's own selectSearchResult() uses.
  // The modal is injected into <body>, a sibling of #eventPreview rather
  // than a descendant of it, so it stays open (and the calendar page
  // underneath it stays put) regardless of what the preview panel does.
  //
  // The chip's own "Add to planner"/"In planner" label is deliberately
  // NOT refreshed synchronously here, even right after adding -- doing
  // so would rebuild (detach + recreate) the very chip this click is
  // still bubbling from, and loadCharTable()'s promise can resolve *in
  // the middle* of that bubble (Chromium runs a microtask checkpoint
  // between each event listener), which would make the "click landed
  // outside the preview panel" check below see a detached, already-
  // orphaned target and close the panel out from under the modal that
  // was just opened. Refreshing once the modal actually closes (via
  // onClose) sidesteps that race entirely, since by then this click's
  // dispatch has long finished.
  function openOperatorModalFromChip(op, ev) {
    OperatorEditModal.loadCharTable()
      .then((charTable) => {
        const fullOp = charTable[op.charId];
        if (!fullOp) return; // shouldn't happen -- op came from this same table
        let roster = getPref("planner", "roster", [], (v) => Array.isArray(v));
        let entry = roster.find((e) => e && e.charId === op.charId);
        if (!entry) {
          entry = {
            charId: op.charId,
            current: OperatorEditModal.defaultState(),
            target: OperatorEditModal.defaultTargetState(fullOp),
          };
          roster = roster.concat([entry]);
          setPref("planner", "roster", roster);
        }
        OperatorEditModal.open(fullOp, entry, {
          onChange: () => setPref("planner", "roster", roster),
          onRemove: () => {
            roster = roster.filter((e) => e !== entry);
            setPref("planner", "roster", roster);
            OperatorEditModal.close();
          },
          onClose: () => showEventPreview(ev),
        });
      })
      .catch((err) => console.warn("Couldn't load operator data for the edit card:", err));
  }

  function hideEventPreview() {
    eventPreviewEl.classList.remove("visible");
  }

  eventPreviewCloseBtn.addEventListener("click", hideEventPreview);

  document.addEventListener("keydown", (e) => {
    // Let the modal's own Escape handler close itself first -- otherwise
    // Escape while editing an operator would also dismiss the event
    // preview panel underneath it.
    if (e.key === "Escape" && !OperatorEditModal.isOpen()) hideEventPreview();
  });

  // Closes the preview on a click anywhere outside it. Safe from
  // immediately closing a panel that was just opened -- see
  // makeClickable()'s stopPropagation(). The modal is injected as a
  // sibling of #eventPreview (not a descendant), so without this guard
  // every click inside it -- picking a phase, typing a level -- would
  // also be seen as "outside the preview" and close the panel under it.
  document.addEventListener("click", (e) => {
    if (!eventPreviewEl.classList.contains("visible")) return;
    if (eventPreviewEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest("#operatorEditModal")) return;
    hideEventPreview();
  });

  function buildCard(ev, now) {
    const status = ev._status;
    const card = document.createElement("div");
    card.className = "eventCard " + status;
    makeClickable(card, () => showEventPreview(ev));

    if (ev.image) {
      const thumb = document.createElement("img");
      thumb.className = "eventThumb";
      thumb.src = ev.image;
      thumb.alt = "";
      thumb.loading = "lazy";
      card.appendChild(thumb);
    }

    const name = document.createElement("div");
    name.className = "eventName";
    name.textContent = ev.event;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = STATUS_LABEL[status];
    name.appendChild(badge);

    const dates = document.createElement("div");
    dates.className = "eventDates";

    if (ev.cnStart) {
      const cnLine = document.createElement("span");
      cnLine.className = "cnDate";
      cnLine.textContent = `CN: ${fmtRange(ev.cnStart, ev.cnEnd)}`;
      dates.appendChild(cnLine);
    }

    const globalLine = document.createElement("span");
    globalLine.className = "globalDate";
    globalLine.textContent = `Global: ${fmtRange(ev.globalStart, ev.globalEnd)}`;
    dates.appendChild(globalLine);

    if (ev.announced && ev.source) {
      const sourceLine = document.createElement("span");
      sourceLine.className = "announcedSource";
      sourceLine.textContent = `Announced via ${ev.source}`;
      if (ev.note) sourceLine.title = ev.note;
      dates.appendChild(sourceLine);
    }

    const countdown = document.createElement("span");
    countdown.className = "countdown";
    countdown.textContent = countdownLabel(ev.globalStart, now);
    dates.appendChild(countdown);

    card.appendChild(name);
    card.appendChild(dates);
    return card;
  }

  function buildChip(ev) {
    const chip = document.createElement("div");
    chip.className = "calEventChip " + ev._status;
    chip.textContent = ev.event;
    // No native title attribute here -- the custom hover tooltip below
    // (which also carries the art) shows the same name/date info, and a
    // native tooltip on top of it just doubles up visually.
    chip.addEventListener("mouseenter", () => showHoverTooltip(ev, chip));
    chip.addEventListener("mouseleave", hideHoverTooltip);
    makeClickable(chip, () => showEventPreview(ev));
    return chip;
  }

  function applyFilter(events) {
    return events.filter((ev) => activeStatuses.has(ev._status));
  }

  // Precomputed, filtered events with integer day-number ranges, used by
  // both the calendar view (to decide which chips land on which day) and
  // refreshCalendarChips (to redraw chips in place after a filter change).
  function computeFilteredRanges() {
    return applyFilter(allEvents).map((ev) => ({
      ev,
      startDay: toDayNum(new Date(ev.globalStart)),
      endDay: toDayNum(effectiveEnd(ev.globalStart, ev.globalEnd)),
    }));
  }

  function renderList() {
    const now = new Date();
    const filtered = applyFilter(allEvents);

    const upcoming = filtered.filter((e) => new Date(e.globalStart) >= now);
    const past = filtered.filter((e) => new Date(e.globalStart) < now);

    if (sortMode === "name") {
      upcoming.sort((a, b) => a.event.localeCompare(b.event));
      past.sort((a, b) => a.event.localeCompare(b.event));
    } else {
      upcoming.sort((a, b) => new Date(a.globalStart) - new Date(b.globalStart));
      past.sort((a, b) => new Date(b.globalStart) - new Date(a.globalStart));
    }

    upcomingEl.innerHTML = "";
    if (upcoming.length === 0) {
      const empty = document.createElement("div");
      empty.className = "eventListEmpty";
      empty.textContent = "Nothing upcoming matches the current filters.";
      upcomingEl.appendChild(empty);
    } else {
      for (const ev of upcoming) upcomingEl.appendChild(buildCard(ev, now));
    }

    pastEl.innerHTML = "";
    if (past.length === 0) {
      const empty = document.createElement("div");
      empty.className = "eventListEmpty";
      empty.textContent = "Nothing in the past matches the current filters.";
      pastEl.appendChild(empty);
    } else {
      for (const ev of past) pastEl.appendChild(buildCard(ev, now));
    }
  }

  // Builds one day cell. filtered = computeFilteredRanges() output.
  // forceMonthLabel is only used for the very first cell ever rendered, so
  // the top of the scroll area always has its bearings even when day 1 of
  // that month isn't the first visible cell.
  function buildDayCell(cellDate, filtered, todayDayNum, forceMonthLabel) {
    const cellDayNum = toDayNum(cellDate);
    const cell = document.createElement("div");
    cell.className = "calDay";
    if (cellDayNum === todayDayNum) cell.classList.add("today");

    const dayNum = document.createElement("div");
    dayNum.className = "calDayNum";
    const dayCircle = document.createElement("span");
    dayCircle.className = "calDayNumCircle";
    dayCircle.textContent = String(cellDate.getDate());
    dayNum.appendChild(dayCircle);
    if (cellDate.getDate() === 1 || forceMonthLabel) {
      const monthLabel = document.createElement("span");
      monthLabel.className = "calDayMonth";
      monthLabel.textContent = cellDate.toLocaleDateString(undefined, { month: "short" });
      dayNum.appendChild(monthLabel);
    }
    cell.appendChild(dayNum);

    const chipWrap = document.createElement("div");
    chipWrap.className = "calChips";
    for (const { ev, startDay, endDay } of filtered) {
      if (cellDayNum >= startDay && cellDayNum <= endDay) {
        chipWrap.appendChild(buildChip(ev));
      }
    }
    cell.appendChild(chipWrap);

    dayCellsByDayNum.set(cellDayNum, chipWrap);
    return cell;
  }

  function headerHeight() {
    const head = weekGridEl.querySelector(".calWeekday");
    return head ? head.offsetHeight : 0;
  }

  // Scrolls so the current week sits right under the sticky weekday
  // header, using whatever the grid's layout actually is right now (see
  // needsInitialScrollFix above for why this needs to be callable more
  // than once against the same rendered rows).
  function positionOnToday() {
    const initialWeek = startOfWeek(new Date());
    const todayRow = weekRows.find((w) => w.weekStart.getTime() === initialWeek.getTime());
    if (todayRow) {
      weekGridEl.scrollTop = Math.max(0, todayRow.el.offsetTop - headerHeight());
    }
    updateWeekLabel();
  }

  // The very first calendar render: builds WEEKS_BEFORE + 1 + WEEKS_AFTER
  // weeks centered on the current week, and scrolls so the current week
  // sits right under the sticky weekday header. Only ever called once --
  // after this, the grid is only grown (prependWeeks/appendWeeks) or has
  // its chips refreshed in place, never rebuilt, so scroll position is
  // never lost to a filter change or a view toggle.
  function renderCalendarInitial() {
    const now = new Date();
    const todayDayNum = toDayNum(now);
    const initialWeek = startOfWeek(now);
    const gridStart = addDays(initialWeek, -WEEKS_BEFORE * 7);
    const totalDays = (WEEKS_BEFORE + 1 + WEEKS_AFTER) * 7;
    const filtered = computeFilteredRanges();

    weekGridEl.innerHTML = "";
    dayCellsByDayNum.clear();
    weekRows = [];

    for (const wd of WEEKDAY_NAMES) {
      const head = document.createElement("div");
      head.className = "calWeekday";
      head.textContent = wd;
      weekGridEl.appendChild(head);
    }

    for (let i = 0; i < totalDays; i++) {
      const cellDate = addDays(gridStart, i);
      const cell = buildDayCell(cellDate, filtered, todayDayNum, i === 0);
      weekGridEl.appendChild(cell);
      if (i % 7 === 0) weekRows.push({ weekStart: cellDate, el: cell });
    }

    renderedStart = gridStart;
    renderedEnd = addDays(gridStart, totalDays);

    positionOnToday();
  }

  // Redraws every already-rendered day's chips in place (status filter
  // changed) without touching renderedStart/renderedEnd, weekRows, or
  // scroll position.
  function refreshCalendarChips() {
    const filtered = computeFilteredRanges();
    for (const [dayNum, chipWrapEl] of dayCellsByDayNum.entries()) {
      chipWrapEl.innerHTML = "";
      for (const { ev, startDay, endDay } of filtered) {
        if (dayNum >= startDay && dayNum <= endDay) {
          chipWrapEl.appendChild(buildChip(ev));
        }
      }
    }
  }

  // Grows the rendered range backward by n weeks, keeping the user's
  // current view stable (scrollTop is nudged by exactly the height that
  // was just inserted above it).
  function prependWeeks(n) {
    const now = new Date();
    const todayDayNum = toDayNum(now);
    const filtered = computeFilteredRanges();
    const newStart = addDays(renderedStart, -n * 7);
    const frag = document.createDocumentFragment();
    const newRows = [];
    for (let i = 0; i < n * 7; i++) {
      const cellDate = addDays(newStart, i);
      const cell = buildDayCell(cellDate, filtered, todayDayNum, false);
      frag.appendChild(cell);
      if (i % 7 === 0) newRows.push({ weekStart: cellDate, el: cell });
    }
    const oldScrollHeight = weekGridEl.scrollHeight;
    // The first 7 children are always the (never-touched) weekday header
    // cells, so the current first day cell is always at index 7.
    const marker = weekGridEl.children[7] || null;
    weekGridEl.insertBefore(frag, marker);
    weekRows.unshift(...newRows);
    renderedStart = newStart;
    weekGridEl.scrollTop += weekGridEl.scrollHeight - oldScrollHeight;
  }

  // Grows the rendered range forward by n weeks.
  function appendWeeks(n) {
    const now = new Date();
    const todayDayNum = toDayNum(now);
    const filtered = computeFilteredRanges();
    const frag = document.createDocumentFragment();
    const newRows = [];
    for (let i = 0; i < n * 7; i++) {
      const cellDate = addDays(renderedEnd, i);
      const cell = buildDayCell(cellDate, filtered, todayDayNum, false);
      frag.appendChild(cell);
      if (i % 7 === 0) newRows.push({ weekStart: cellDate, el: cell });
    }
    weekGridEl.appendChild(frag);
    weekRows.push(...newRows);
    renderedEnd = addDays(renderedEnd, n * 7);
  }

  // The week currently at (or just above) the top of the visible scrolled
  // area -- weekRows is always kept in ascending order, so this is the
  // last row whose top has scrolled to/past the header.
  function findTopWeekStart() {
    if (weekRows.length === 0) return null;
    const scrollPos = weekGridEl.scrollTop + headerHeight() + 1;
    let current = weekRows[0];
    for (const w of weekRows) {
      if (w.el.offsetTop <= scrollPos) current = w;
      else break;
    }
    return current.weekStart;
  }

  // The first and last day currently visible anywhere in the scrolled
  // viewport (not just the top row) -- used to label the header with
  // whichever month(s)/year(s) are actually on screen right now.
  function findVisibleDateRange() {
    if (weekRows.length === 0) return null;
    const viewTop = weekGridEl.scrollTop + headerHeight();
    const viewBottom = weekGridEl.scrollTop + weekGridEl.clientHeight;
    let topRow = weekRows[0];
    for (const w of weekRows) {
      if (w.el.offsetTop + w.el.offsetHeight > viewTop) {
        topRow = w;
        break;
      }
      topRow = w;
    }
    let bottomRow = weekRows[weekRows.length - 1];
    for (let i = weekRows.length - 1; i >= 0; i--) {
      if (weekRows[i].el.offsetTop < viewBottom) {
        bottomRow = weekRows[i];
        break;
      }
      bottomRow = weekRows[i];
    }
    return { start: topRow.weekStart, end: addDays(bottomRow.weekStart, 6) };
  }

  function updateWeekLabel() {
    const range = findVisibleDateRange();
    if (range) weekLabelEl.textContent = fmtMonthRangeLabel(range.start, range.end);
  }

  // Scrolls (optionally smoothly) so the given Monday-aligned week sits
  // just below the header, extending the rendered range first if the
  // target week isn't loaded yet.
  function scrollToWeek(weekStart, smooth) {
    let guard = 0;
    while (weekStart.getTime() < renderedStart.getTime() && guard++ < 500) {
      prependWeeks(LOAD_BATCH_WEEKS);
    }
    guard = 0;
    while (weekStart.getTime() >= renderedEnd.getTime() && guard++ < 500) {
      appendWeeks(LOAD_BATCH_WEEKS);
    }
    const row = weekRows.find((w) => w.weekStart.getTime() === weekStart.getTime());
    if (!row) return;
    const target = Math.max(0, row.el.offsetTop - headerHeight());
    if (typeof weekGridEl.scrollTo === "function") {
      weekGridEl.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
    } else {
      weekGridEl.scrollTop = target;
    }
  }

  // Keeps the calendar scrollable in both directions indefinitely: once
  // the user scrolls within LOAD_THRESHOLD_PX of either edge of what's
  // rendered so far, another batch of weeks is loaded on that side. Old
  // weeks are never trimmed back out -- fine for a normal browsing
  // session, since the whole dataset is only a couple hundred events.
  function handleScrollTick() {
    let guard = 0;
    while (weekGridEl.scrollTop < LOAD_THRESHOLD_PX && guard++ < 50) {
      prependWeeks(LOAD_BATCH_WEEKS);
    }
    guard = 0;
    while (
      weekGridEl.scrollHeight - weekGridEl.scrollTop - weekGridEl.clientHeight < LOAD_THRESHOLD_PX &&
      guard++ < 50
    ) {
      appendWeeks(LOAD_BATCH_WEEKS);
    }
    updateWeekLabel();
  }

  weekGridEl.addEventListener("scroll", () => {
    hideHoverTooltip();
    if (!calendarInitialized || scrollTickScheduled) return;
    scrollTickScheduled = true;
    requestAnimationFrame(() => {
      scrollTickScheduled = false;
      handleScrollTick();
    });
  });

  function render() {
    // Whatever's currently previewed may no longer be visible (a filter
    // change hid its status, or the view just switched) -- closing it
    // here rather than trying to track whether it's still valid keeps
    // this simple, and re-opening it is one click away either way.
    hideEventPreview();
    if (currentView === "calendar") {
      calendarViewRoot.style.display = "";
      calendarContent.style.display = "none";
      sortGroup.style.display = "none";
      if (!calendarInitialized) {
        renderCalendarInitial();
        calendarInitialized = true;
      } else {
        refreshCalendarChips();
        if (needsInitialScrollFix) {
          needsInitialScrollFix = false;
          positionOnToday();
        }
      }
    } else {
      calendarViewRoot.style.display = "none";
      calendarContent.style.display = "";
      sortGroup.style.display = "";
      renderList();
    }
  }

  viewToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".viewToggleBtn");
    if (!btn) return;
    currentView = btn.dataset.view;
    for (const b of viewToggle.querySelectorAll(".viewToggleBtn")) {
      b.classList.toggle("active", b === btn);
    }
    setPref("calendar", "view", currentView);
    render();
  });

  statusFiltersEl.addEventListener("change", () => {
    activeStatuses = new Set(
      Array.from(statusFiltersEl.querySelectorAll("input:checked")).map((el) => el.value),
    );
    setPref("calendar", "statusFilters", Array.from(activeStatuses));
    render();
  });

  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value;
    setPref("calendar", "sort", sortMode);
    render();
  });

  prevWeekBtn.addEventListener("click", () => {
    const top = findTopWeekStart() || startOfWeek(new Date());
    scrollToWeek(addDays(top, -7), true);
  });
  nextWeekBtn.addEventListener("click", () => {
    const top = findTopWeekStart() || startOfWeek(new Date());
    scrollToWeek(addDays(top, 7), true);
  });
  todayBtn.addEventListener("click", () => {
    scrollToWeek(startOfWeek(new Date()), true);
  });

  // Render the (empty) grid immediately so the page isn't blank while the
  // JSON fetch below is in flight.
  render();

  (async function load() {
    try {
      const res = await fetch(extraDataUrl("events.json"));
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const data = await res.json();
      const now = new Date();
      allEvents = (data.events || []).map((ev) => ({ ...ev, _status: getStatus(ev, now) }));
      updateAnnouncedVisibility();
      // Real chip content is about to exist for the first time -- the
      // scroll-to-today position computed on the empty grid no longer
      // reflects the real row heights, so it needs to be redone once
      // render() below reaches the calendar view with this data in place.
      needsInitialScrollFix = true;

      const hasCurrentLag = data.currentLagDays != null;
      const lagDays = hasCurrentLag ? data.currentLagDays : data.medianLagDays;
      if (lagDays != null) {
        lagHintEl.textContent = hasCurrentLag
          ? `Current CN→Global lag used for estimates: ~${Math.round(lagDays)} days`
          : `Historical CN→Global lag: ~${Math.round(lagDays)} days (dataset average -- switches to the current lag after the next data refresh)`;
      }
      // generatedAt is only as fresh as events.py's last successful daily
      // run -- see the "Update banner history" GitHub Action.
      if (data.generatedAt && dataFreshnessEl) {
        dataFreshnessEl.textContent = ` · Updated ${fmtDate(data.generatedAt)}`;
      }

      render();

      // Best-effort operator-release matching (see matchOperatorsToEvents()
      // above) for the "Add to planner" chips in the preview panel.
      // Deliberately fetched *after* the render above so a slow or failed
      // character-data load never holds up the calendar itself -- anyone
      // who opens the preview before this resolves just won't see operator
      // chips on that one open. Routed through OperatorEditModal.loadCharTable()
      // (js/operator-edit-modal.js) rather than a separate get_char_table()
      // call here -- that table already carries onlineTime (extra_data,
      // needed for matching) *and* modules (needed by the edit modal a chip
      // opens), and both this matching step and the modal want the exact
      // same table, so there's no reason to fetch character_table.json twice.
      try {
        const charTable = await OperatorEditModal.loadCharTable();
        matchOperatorsToEvents(allEvents, charTable);
      } catch (err) {
        console.warn("Couldn't load operator release-date data for planner chips:", err);
      }
    } catch (err) {
      console.error("Failed to load events.json:", err);
      calendarViewRoot.style.display = "none";
      sortGroup.style.display = "none";
      calendarContent.style.display = "";
      upcomingEl.innerHTML = "";
      const errEl = document.createElement("div");
      errEl.className = "eventListEmpty";
      errEl.textContent =
        "Couldn't load event data (see console for details). It may not have run yet -- check the repo's json/events.json.";
      upcomingEl.appendChild(errEl);
      pastEl.innerHTML = "";
    }
  })();
})();
