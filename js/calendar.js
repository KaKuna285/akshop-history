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
  const weekGridEl = document.getElementById("weekGrid");
  const weekLabelEl = document.getElementById("weekLabel");
  const prevWeekBtn = document.getElementById("prevWeekBtn");
  const nextWeekBtn = document.getElementById("nextWeekBtn");
  const todayBtn = document.getElementById("todayBtn");

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
    estimated: "ESTIMATED",
    cnExclusive: "CN EXCLUSIVE",
  };

  let allEvents = [];
  let currentView = "calendar"; // "calendar" | "list"
  let sortMode = "date"; // "date" | "name"
  let activeStatuses = new Set(["confirmed", "estimated", "cnExclusive"]);

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

  function startOfWeek(d) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = (c.getDay() + 6) % 7; // days since the most recent Monday
    c.setDate(c.getDate() - diff);
    return c;
  }

  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  function fmtWeekLabel(weekStart) {
    const weekEnd = addDays(weekStart, 6);
    const opts = { month: "short", day: "numeric" };
    return `${weekStart.toLocaleDateString(undefined, opts)} – ${weekEnd.toLocaleDateString(
      undefined,
      opts,
    )}, ${weekEnd.getFullYear()}`;
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

  function countdownLabel(globalStartIso, now) {
    const d = daysBetween(now, new Date(globalStartIso));
    if (d === 0) return "today";
    if (d > 0) return `in ${d} day${d === 1 ? "" : "s"}`;
    return `${-d} day${d === -1 ? "" : "s"} ago`;
  }

  // Confirmed events are exactly what Gryphline has set. An event that's
  // only ever had an *estimated* Global date, and whose estimated window
  // closed more than GRACE_DAYS ago with still no confirmation, is treated
  // as CN exclusive instead of "upcoming forever" -- it's either not coming
  // to Global at all, or running unusually late, and the grace period is
  // there so an event that's simply a bit delayed doesn't flip red early.
  function getStatus(ev, now) {
    if (ev.globalConfirmed) return "confirmed";
    const end = effectiveEnd(ev.globalStart, ev.globalEnd);
    if (now.getTime() - end.getTime() > GRACE_DAYS * DAY_MS) return "cnExclusive";
    return "estimated";
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

  function buildCard(ev, now) {
    const status = ev._status;
    const href = wikiUrl(ev.wikiPage || ev.event);
    const card = document.createElement(href ? "a" : "div");
    card.className = "eventCard " + status;
    if (href) {
      card.href = href;
      card.target = "_blank";
      card.rel = "noopener";
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

    const countdown = document.createElement("span");
    countdown.className = "countdown";
    countdown.textContent = countdownLabel(ev.globalStart, now);
    dates.appendChild(countdown);

    card.appendChild(name);
    card.appendChild(dates);
    return card;
  }

  function buildChip(ev) {
    const href = wikiUrl(ev.wikiPage || ev.event);
    const chip = document.createElement(href ? "a" : "div");
    chip.className = "calEventChip " + ev._status;
    chip.textContent = ev.event;
    chip.title = `${ev.event} – ${fmtRange(ev.globalStart, ev.globalEnd)}`;
    if (href) {
      chip.href = href;
      chip.target = "_blank";
      chip.rel = "noopener";
    }
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

    const todayRow = weekRows.find((w) => w.weekStart.getTime() === initialWeek.getTime());
    if (todayRow) {
      weekGridEl.scrollTop = Math.max(0, todayRow.el.offsetTop - headerHeight());
    }
    weekLabelEl.textContent = fmtWeekLabel(initialWeek);
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
    const top = findTopWeekStart();
    if (top) weekLabelEl.textContent = fmtWeekLabel(top);
  }

  weekGridEl.addEventListener("scroll", () => {
    if (!calendarInitialized || scrollTickScheduled) return;
    scrollTickScheduled = true;
    requestAnimationFrame(() => {
      scrollTickScheduled = false;
      handleScrollTick();
    });
  });

  function render() {
    if (currentView === "calendar") {
      calendarViewRoot.style.display = "";
      calendarContent.style.display = "none";
      sortGroup.style.display = "none";
      if (!calendarInitialized) {
        renderCalendarInitial();
        calendarInitialized = true;
      } else {
        refreshCalendarChips();
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
    render();
  });

  statusFiltersEl.addEventListener("change", () => {
    activeStatuses = new Set(
      Array.from(statusFiltersEl.querySelectorAll("input:checked")).map((el) => el.value),
    );
    render();
  });

  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value;
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
      const res = await fetch(`${EXTRA_DATA_REPO_RAW_BASE}events.json`);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const data = await res.json();
      const now = new Date();
      allEvents = (data.events || []).map((ev) => ({ ...ev, _status: getStatus(ev, now) }));

      const lagDays = data.currentLagDays != null ? data.currentLagDays : data.medianLagDays;
      if (lagDays != null) {
        lagHintEl.textContent = `Current CN→Global lag used for estimates: ~${Math.round(
          lagDays,
        )} days (from the most recent confirmed date)`;
      }

      render();
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
