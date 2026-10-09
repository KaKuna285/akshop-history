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
  // The calendar view is a continuous, scrollable stream of week rows. The
  // first render covers WEEKS_BEFORE + 1 + WEEKS_AFTER weeks around the
  // current week; scrolling near either edge loads another batch (see
  // handleScrollTick()). Prev/Next Week and Today jump directly.
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

  // Restore saved settings (see js/prefs.js). The scrolled-to week is
  // deliberately not saved -- every visit starts at today.
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
  // The HTML hardcodes the default control states; sync them to the
  // restored values so the UI matches from the first paint.
  for (const b of viewToggle.querySelectorAll(".viewToggleBtn")) {
    b.classList.toggle("active", b.dataset.view === currentView);
  }
  for (const input of statusFiltersEl.querySelectorAll("input[type=checkbox]")) {
    input.checked = activeStatuses.has(input.value);
  }
  sortSelect.value = sortMode;

  // Calendar-view-only state. The grid is built once (renderCalendarInitial)
  // and after that only grown (prependWeeks/appendWeeks) or has its chips
  // refreshed in place (refreshCalendarChips), never rebuilt, so scroll
  // position survives filter changes and view toggles.
  let calendarInitialized = false;
  let renderedStart = null; // first rendered day (Monday-aligned), inclusive
  let renderedEnd = null; // one day past the last rendered day
  let weekRows = []; // [{weekStart, el}], ascending, el = that week's Monday .calDay
  const dayCellsByDayNum = new Map(); // dayNum -> that day's .calChips element
  let scrollTickScheduled = false;
  // The first render happens before events.json loads, so the initial
  // scroll-to-today is computed against an empty grid. Event chips then
  // make rows taller and shift every later row's offsetTop, so the scroll
  // position has to be recomputed once against the real layout. This flag
  // means "data has loaded but that recompute hasn't happened yet".
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

  // Header label naming the month(s) and year(s) in view, e.g.
  // "September 2026", "September – October 2026" or
  // "December 2026 – January 2027".
  function fmtMonthRangeLabel(startDate, endDate) {
    const startMonth = startDate.toLocaleDateString(undefined, { month: "long" });
    const endMonth = endDate.toLocaleDateString(undefined, { month: "long" });
    const startYear = startDate.getFullYear();
    const endYear = endDate.getFullYear();
    if (startYear === endYear && startMonth === endMonth) return `${startMonth} ${startYear}`;
    if (startYear === endYear) return `${startMonth} – ${endMonth} ${startYear}`;
    return `${startMonth} ${startYear} – ${endMonth} ${endYear}`;
  }

  // A whole-day number in the viewer's own calendar, for a Date or a data
  // timestamp (parsed by parseTimestamp() in util.js -- the date the data
  // says, whatever the viewer's timezone). NaN if unusable.
  function toDayNum(d) {
    const p = parseTimestamp(d);
    if (!p) return NaN;
    const c = new Date(p.getTime());
    c.setHours(0, 0, 0, 0);
    return Math.floor(c.getTime() / DAY_MS);
  }

  // Some source rows have an end date earlier than their start date (most
  // likely a mistyped year on the wiki). events.py guards estimated dates
  // against this, but a confirmed Global end taken straight from the wiki
  // can still have it, so every "end of this window" lookup goes through
  // this helper instead of reading globalEnd/cnEnd directly.
  function effectiveEnd(startIso, endIso) {
    const start = parseTimestamp(startIso);
    const end = parseTimestamp(endIso);
    if (!end || !start) return start || end;
    return end < start ? start : end;
  }

  function fmtRange(startIso, endIso) {
    if (!startIso) return "Unknown";
    if (!endIso) return fmtDate(startIso);
    if (timestampMs(endIso) < timestampMs(startIso)) return fmtDate(startIso);
    return `${fmtDate(startIso)} – ${fmtDate(endIso)}`;
  }

  // Best-effort "this event debuts these operators" match, for the planner
  // chips in the event preview panel (see showEventPreview()). events.py
  // scrapes story/side events, not headhunting banners, but a new
  // operator's EN release almost always lands on the same day as the event
  // it debuts alongside, so release-date proximity is a reasonable
  // stand-in. Dates are compared by day via dayKeyFromTimestamp()
  // (js/util.js).

  const OPERATOR_MATCH_WINDOW_DAYS = 1;
  // A real debut is 1-4 operators, occasionally more for a collab/
  // anniversary batch. The cap also filters out EN's Jan 2020 launch,
  // which back-dated ~90 operators' onlineTime to the same couple of days
  // as the catch-up "Opening Event".
  const OPERATOR_MATCH_MAX = 6;

  // Sets ev.operators = [{charId, name, icon}, ...] on each event in
  // `events` that has a match -- the shape showEventPreview() renders.
  function matchOperatorsToEvents(events, charTable) {
    const byDay = new Map(); // dayNum -> [operator record, ...]
    for (const op of Object.values(charTable)) {
      const day = dayKeyFromTimestamp(op.onlineTime);
      if (day == null) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(op);
    }
    for (const ev of events) {
      // A game-mode theme (Integrated Strategies / Reclamation Algorithm;
      // events.py tags these with `mode`) often drops the same day as a
      // SideStory, and that day's operators belong to the SideStory. Date
      // proximity can't tell them apart, so themes are skipped.
      if (ev.mode) continue;
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

  // Whole calendar days, not hours: an event starting later today is
  // "today", not "in 1 day" or "0 days ago" depending on the clock. An
  // event that has started but not ended yet is running, not "N days ago".
  function countdownLabel(ev, now) {
    const today = toDayNum(now);
    const start = toDayNum(ev.globalStart);
    const end = toDayNum(effectiveEnd(ev.globalStart, ev.globalEnd));
    if (isNaN(start)) return "";
    const plural = (n) => `${n} day${n === 1 ? "" : "s"}`;
    if (start > today) return start - today === 1 ? "tomorrow" : `in ${plural(start - today)}`;
    if (start === today) return "starts today";
    if (today <= end) return end === today ? "running \u2013 ends today" : `running \u2013 ${plural(end - today)} left`;
    return `ended ${plural(today - end)} ago`;
  }

  // Confirmed events are exactly what Yostar has set. An event with only
  // an estimated Global date whose window closed more than GRACE_DAYS ago
  // is treated as CN exclusive rather than "upcoming forever". The grace
  // period keeps a slightly delayed event from flipping early.
  function getStatus(ev, now) {
    if (ev.globalConfirmed) return "confirmed";
    // Manually pinned via overrides.json: officially known to be coming,
    // so it never falls through to "CN exclusive" however old its window.
    if (ev.announced) return "announced";
    const end = effectiveEnd(ev.globalStart, ev.globalEnd);
    if (now.getTime() - end.getTime() > GRACE_DAYS * DAY_MS) return "cnExclusive";
    return "estimated";
  }

  // events.py records every move of an unfinished event's date or status in
  // `dateHistory` (oldest first; see update_date_history()). The latest move
  // is highlighted for RECENT_CHANGE_DAYS, so someone who last looked a
  // week or two ago can see what changed.
  const RECENT_CHANGE_DAYS = 14;

  function describeDateChange(ev, now) {
    const h = ev.dateHistory;
    if (!Array.isArray(h) || h.length < 2) return null;
    const last = h[h.length - 1];
    const prev = h[h.length - 2];
    const at = parseTimestamp(last.at);
    if (!at || now.getTime() - at.getTime() > RECENT_CHANGE_DAYS * DAY_MS) return null;
    const days = toDayNum(last.start) - toDayNum(prev.start);
    const by = Math.abs(days);
    const shift = `${by} day${by === 1 ? "" : "s"} ${days > 0 ? "later" : "earlier"}`;
    let text;
    let kind = "moved";
    if (last.reason === "confirmed" || last.reason === "announced") {
      kind = "firmed";
      const word = last.reason === "confirmed" ? "Now confirmed" : "Now announced";
      const was = prev.status === "announced" ? "the announcement" : "the estimate";
      text = days === 0 ? `${word} \u2013 matches ${was}` : `${word} \u2013 ${shift} than ${was}`;
    } else if (last.reason === "rescheduled") {
      text = `Rescheduled \u2013 ${shift}`;
    } else {
      const why = last.reason === "cn" ? "CN date changed" : "CN\u2192Global lag updated";
      text = days === 0 ? "Estimate updated" : `Estimate moved ${shift} (${why})`;
    }
    return { kind, text, at };
  }

  // "Announced" only appears when something is pinned via overrides.json,
  // which is usually nothing. Hide its legend swatch and filter checkbox
  // whenever no loaded event has that status.
  function updateAnnouncedVisibility() {
    const hasAnnounced = allEvents.some((ev) => ev._status === "announced");
    const display = hasAnnounced ? "" : "none";
    if (legendAnnouncedItem) legendAnnouncedItem.style.display = display;
    if (filterAnnouncedItem) filterAnnouncedItem.style.display = display;
  }

  // Shared hover tooltip for calendar-grid chips (event name and dates).
  // One element is reused for every chip, since the grid can hold hundreds
  // of chips. Banner art lives in the click-to-open preview panel (see
  // showEventPreview) so hovering stays lightweight.
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

    // Anchor below the chip, flipping above it (or clamping sideways) if
    // there isn't room. The tooltip's size depends on its content, so this
    // runs after the content is set.
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

  // Makes a chip or card (a plain, non-<a> element -- see buildChip()/
  // buildCard()) behave like a button: click or Enter/Space calls
  // onActivate(). stopPropagation() is required: the preview panel's
  // "click outside to close" listener is on document, and would otherwise
  // close the panel as the opening click bubbles up.
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

  // The event preview panel, opened by clicking any chip or card. It sits
  // between the legend/controls row and the calendar/list content (see
  // calendar/index.html). The image, close button and body wrapper are
  // fixed markup; only eventPreviewBodyEl's contents are rebuilt per event.
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
    countdown.textContent = countdownLabel(ev, new Date());
    dates.appendChild(countdown);
    eventPreviewBodyEl.appendChild(dates);

    const change = describeDateChange(ev, new Date());
    if (change) {
      const changeLine = document.createElement("div");
      changeLine.className = "eventPreviewDateChange " + change.kind;
      changeLine.textContent = change.text;
      changeLine.title = `Changed ${fmtDate(change.at)}`;
      eventPreviewBodyEl.appendChild(changeLine);
    }
    if (Array.isArray(ev.dateHistory) && ev.dateHistory.length > 1) {
      const histEl = document.createElement("div");
      histEl.className = "eventPreviewHistory";
      const histHeading = document.createElement("div");
      histHeading.className = "eventPreviewHistoryHeading";
      histHeading.textContent = "Date history";
      histEl.appendChild(histHeading);
      ev.dateHistory.forEach((h, i) => {
        const row = document.createElement("div");
        row.className = "eventPreviewHistoryRow";
        const label = STATUS_LABEL[h.status] || h.status;
        row.textContent = `${fmtDate(h.at)} \u2013 ${i === 0 ? "first seen" : "changed to"} ${fmtDate(h.start)} (${label.toLowerCase()})`;
        histEl.appendChild(row);
      });
      eventPreviewBodyEl.appendChild(histEl);
    }

    if (ev.mode) {
      // Not a limited-time event: a theme's wiki entry only has a release
      // date (events.py gives it a fixed one-week window), and the content
      // itself stays playable afterwards.
      const modeLine = document.createElement("div");
      modeLine.className = "eventPreviewSource";
      modeLine.textContent = `${ev.mode} theme \u2013 release date shown, content stays available`;
      eventPreviewBodyEl.appendChild(modeLine);
    }

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
      // Read fresh each time the panel opens so it reflects roster changes
      // made since page load.
      const rosterCharIds = new Set(
        getPref("planner", "roster", [], (v) => Array.isArray(v))
          .filter((e) => e && typeof e.charId === "string")
          .map((e) => e.charId),
      );
      ev.operators.forEach((op) => {
        const inPlanner = rosterCharIds.has(op.charId);
        // Clicking opens the operator edit card in place, adding the
        // operator to the roster first if needed -- the same as picking
        // one from the planner's "Add operator" search box.
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
      // Sorted by operator name, like the operators section, so one
      // operator's skins stay together.
      ev.skins
        .slice()
        .sort((a, b) => (a.operatorName || "").localeCompare(b.operatorName || ""))
        .forEach((skin) => {
          // A skin without a charId (events.py couldn't resolve the
          // wiki-scraped operator name) is still shown, just not as a link.
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
          // Out on CN but not yet confirmed for Global (events.py flags it
          // cnOnly -- see index_outfit_brand_releases()). Shown so an
          // upcoming event lists what it's expected to bring, but tagged
          // as unconfirmed.
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

    // A chip deep in the grid (or a card low in a long list) can open the
    // panel off-screen above the scroll position, so bring it into view.
    eventPreviewEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Opens the shared operator edit modal (js/operator-edit-modal.js) for a
  // clicked "Add to planner"/"In planner" chip, adding the operator to the
  // roster first if needed -- the same add-then-open sequence as the
  // planner's "Add operator" search box (its createSearchBox() onPick).
  // The modal is injected into <body> as a sibling of #eventPreview, so it
  // stays open regardless of what the preview panel does.
  //
  // The chip labels are refreshed only when the modal closes (onClose),
  // not right after adding. Rebuilding the panel synchronously would
  // detach the chip this click is still bubbling from, and
  // loadCharTable()'s promise can resolve mid-bubble (Chromium runs a
  // microtask checkpoint between event listeners). The "click outside the
  // preview" listener below would then see a detached target and close
  // the panel under the newly opened modal.
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

  // Closes the preview on a click anywhere outside it (the opening click
  // never reaches here -- see makeClickable()'s stopPropagation()). Clicks
  // inside the operator edit modal are ignored: it's a sibling of
  // #eventPreview, not a descendant, so they'd otherwise count as outside.
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

    const change = describeDateChange(ev, now);
    if (change) {
      const changeLine = document.createElement("span");
      changeLine.className = "dateChange " + change.kind;
      changeLine.textContent = change.text;
      changeLine.title = `Changed ${fmtDate(change.at)}`;
      dates.appendChild(changeLine);
    }

    const countdown = document.createElement("span");
    countdown.className = "countdown";
    countdown.textContent = countdownLabel(ev, now);
    dates.appendChild(countdown);

    card.appendChild(name);
    card.appendChild(dates);
    return card;
  }

  function buildChip(ev) {
    const chip = document.createElement("div");
    chip.className = "calEventChip " + ev._status;
    chip.textContent = ev.event;
    // No native title attribute: the custom hover tooltip shows the same
    // name and dates, and both at once would double up.
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
      startDay: toDayNum(ev.globalStart),
      endDay: toDayNum(effectiveEnd(ev.globalStart, ev.globalEnd)),
    }));
  }

  function renderList() {
    const now = new Date();
    const filtered = applyFilter(allEvents);

    // By calendar day: anything that hasn't ended yet -- including events
    // running right now -- is under "Now and upcoming".
    const today = toDayNum(now);
    const isPast = (e) => toDayNum(effectiveEnd(e.globalStart, e.globalEnd)) < today;
    const upcoming = filtered.filter((e) => !isPast(e));
    const past = filtered.filter(isPast);

    if (sortMode === "name") {
      upcoming.sort((a, b) => a.event.localeCompare(b.event));
      past.sort((a, b) => a.event.localeCompare(b.event));
    } else {
      upcoming.sort((a, b) => timestampMs(a.globalStart) - timestampMs(b.globalStart));
      past.sort((a, b) => timestampMs(b.globalStart) - timestampMs(a.globalStart));
    }

    upcomingEl.innerHTML = "";
    if (upcoming.length === 0) {
      const empty = document.createElement("div");
      empty.className = "eventListEmpty";
      empty.textContent = "Nothing running or upcoming matches the current filters.";
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
  // forceMonthLabel is set for the first cell rendered, so the top of the
  // grid shows a month even when it doesn't start on the 1st.
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
  // header, using the grid's current layout (see needsInitialScrollFix for
  // why this can run more than once).
  function positionOnToday() {
    const initialWeek = startOfWeek(new Date());
    const todayRow = weekRows.find((w) => w.weekStart.getTime() === initialWeek.getTime());
    if (todayRow) {
      weekGridEl.scrollTop = Math.max(0, todayRow.el.offsetTop - headerHeight());
    }
    updateWeekLabel();
  }

  // The first calendar render: builds WEEKS_BEFORE + 1 + WEEKS_AFTER weeks
  // around the current week and scrolls to it. Called only once (see the
  // calendar-view state comment at the top).
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

  // Redraws every rendered day's chips in place (e.g. after a filter
  // change) without touching renderedStart/renderedEnd, weekRows, or
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
    // The first 7 children are the weekday header cells, so the first day
    // cell is at index 7.
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

  // The week at the top of the visible area: the last row (weekRows is
  // ascending) whose top has scrolled to or past the header.
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

  // The first and last day visible anywhere in the viewport, used for the
  // header's month/year label.
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

  // Keeps the calendar scrollable in both directions: within
  // LOAD_THRESHOLD_PX of either rendered edge, another batch of weeks is
  // loaded on that side. Rendered weeks are never trimmed; the dataset is
  // only a couple hundred events.
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
    // The previewed event may no longer be visible after a filter change
    // or view switch, so always close the preview.
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
      // Row heights are about to change; redo scroll-to-today once
      // render() reaches the calendar view (see needsInitialScrollFix).
      needsInitialScrollFix = true;

      const hasCurrentLag = data.currentLagDays != null;
      const lagDays = hasCurrentLag ? data.currentLagDays : data.medianLagDays;
      if (lagDays != null) {
        lagHintEl.textContent = hasCurrentLag
          ? `Current CN→Global lag used for estimates: ~${Math.round(lagDays)} days`
          : `Historical CN→Global lag: ~${Math.round(lagDays)} days (dataset average -- switches to the current lag after the next data refresh)`;
      }
      // generatedAt is only as fresh as events.py's last successful daily
      // run (the "Update banner history" GitHub Action); DataHealth also
      // checks meta.json, from health.py, for whether that run was healthy.
      DataHealth.mount(dataFreshnessEl, { generatedAt: data.generatedAt, warnings: data.warnings });

      render();

      // Operator-release matching (see matchOperatorsToEvents()) for the
      // "Add to planner" chips. Fetched after the render so a slow or
      // failed character-data load never holds up the calendar; a preview
      // opened before this resolves just has no operator chips.
      // OperatorEditModal.loadCharTable() returns the table the edit modal
      // also uses (it carries onlineTime for matching and modules for the
      // modal), so character_table.json is fetched only once.
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
