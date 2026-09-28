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
  const monthGridEl = document.getElementById("monthGrid");
  const monthLabelEl = document.getElementById("monthLabel");
  const prevMonthBtn = document.getElementById("prevMonthBtn");
  const nextMonthBtn = document.getElementById("nextMonthBtn");
  const todayBtn = document.getElementById("todayBtn");

  const GRACE_DAYS = 30;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const STATUS_LABEL = {
    confirmed: "CONFIRMED",
    estimated: "ESTIMATED",
    cnExclusive: "CN EXCLUSIVE",
  };

  let allEvents = [];
  let currentView = "calendar"; // "calendar" | "list"
  let sortMode = "date"; // "date" | "name"
  let activeStatuses = new Set(["confirmed", "estimated", "cnExclusive"]);
  let visibleMonth = startOfMonth(new Date());

  function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
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

  function fmtRange(startIso, endIso) {
    if (!startIso) return "Unknown";
    if (!endIso) return fmtDate(startIso);
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
    const endIso = ev.globalEnd || ev.globalStart;
    const end = new Date(endIso);
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

  function applyFilter(events) {
    return events.filter((ev) => activeStatuses.has(ev._status));
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

  function renderCalendar() {
    const now = new Date();
    const filtered = applyFilter(allEvents).map((ev) => ({
      ev,
      startDay: toDayNum(new Date(ev.globalStart)),
      endDay: toDayNum(new Date(ev.globalEnd || ev.globalStart)),
    }));

    const year = visibleMonth.getFullYear();
    const month = visibleMonth.getMonth();
    monthLabelEl.textContent = visibleMonth.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
    });

    const gridStart = new Date(year, month, 1);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());
    const todayDayNum = toDayNum(now);

    monthGridEl.innerHTML = "";

    for (const wd of WEEKDAY_NAMES) {
      const head = document.createElement("div");
      head.className = "calWeekday";
      head.textContent = wd;
      monthGridEl.appendChild(head);
    }

    for (let i = 0; i < 42; i++) {
      const cellDate = new Date(gridStart);
      cellDate.setDate(gridStart.getDate() + i);
      const cellDayNum = toDayNum(cellDate);
      const cell = document.createElement("div");
      cell.className = "calDay";
      if (cellDate.getMonth() !== month) cell.classList.add("otherMonth");
      if (cellDayNum === todayDayNum) cell.classList.add("today");

      const dayNum = document.createElement("div");
      dayNum.className = "calDayNum";
      dayNum.textContent = String(cellDate.getDate());
      cell.appendChild(dayNum);

      const chipWrap = document.createElement("div");
      chipWrap.className = "calChips";
      for (const { ev, startDay, endDay } of filtered) {
        if (cellDayNum >= startDay && cellDayNum <= endDay) {
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
          chipWrap.appendChild(chip);
        }
      }
      cell.appendChild(chipWrap);
      monthGridEl.appendChild(cell);
    }
  }

  function render() {
    if (currentView === "calendar") {
      calendarViewRoot.style.display = "";
      calendarContent.style.display = "none";
      sortGroup.style.display = "none";
      renderCalendar();
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

  prevMonthBtn.addEventListener("click", () => {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  nextMonthBtn.addEventListener("click", () => {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
    renderCalendar();
  });
  todayBtn.addEventListener("click", () => {
    visibleMonth = startOfMonth(new Date());
    renderCalendar();
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

      if (data.medianLagDays != null) {
        lagHintEl.textContent = `Historical CN→Global lag used for estimates: ~${Math.round(
          data.medianLagDays,
        )} days`;
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
