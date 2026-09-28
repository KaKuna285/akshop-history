(async function () {
  const upcomingEl = document.getElementById("upcomingList");
  const pastEl = document.getElementById("pastList");
  const lagHintEl = document.getElementById("lagHint");

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
    return Math.round((b - a) / (24 * 60 * 60 * 1000));
  }

  function countdownLabel(globalStartIso, now) {
    const d = daysBetween(now, new Date(globalStartIso));
    if (d === 0) return "today";
    if (d > 0) return `in ${d} day${d === 1 ? "" : "s"}`;
    return `${-d} day${d === -1 ? "" : "s"} ago`;
  }

  function buildCard(ev, now) {
    const card = document.createElement("div");
    card.className = "eventCard " + (ev.globalConfirmed ? "confirmed" : "estimated");

    const name = document.createElement("div");
    name.className = "eventName";
    name.textContent = ev.event;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = ev.globalConfirmed ? "CONFIRMED" : "ESTIMATED";
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

  try {
    const res = await fetch(`${EXTRA_DATA_REPO_RAW_BASE}events.json`);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const data = await res.json();
    const events = data.events || [];
    const now = new Date();

    if (data.medianLagDays != null) {
      lagHintEl.textContent = `Historical CN→Global lag used for estimates: ~${Math.round(
        data.medianLagDays,
      )} days`;
    }

    const upcoming = events
      .filter((e) => new Date(e.globalStart) >= now)
      .sort((a, b) => new Date(a.globalStart) - new Date(b.globalStart));
    const past = events
      .filter((e) => new Date(e.globalStart) < now)
      .sort((a, b) => new Date(b.globalStart) - new Date(a.globalStart));

    upcomingEl.innerHTML = "";
    if (upcoming.length === 0) {
      const empty = document.createElement("div");
      empty.className = "eventListEmpty";
      empty.textContent = "Nothing upcoming in the data yet.";
      upcomingEl.appendChild(empty);
    } else {
      for (const ev of upcoming) upcomingEl.appendChild(buildCard(ev, now));
    }

    pastEl.innerHTML = "";
    for (const ev of past) pastEl.appendChild(buildCard(ev, now));
  } catch (err) {
    console.error("Failed to load events.json:", err);
    upcomingEl.innerHTML = "";
    const errEl = document.createElement("div");
    errEl.className = "eventListEmpty";
    errEl.textContent =
      "Couldn't load event data (see console for details). It may not have run yet -- check the repo's json/events.json.";
    upcomingEl.appendChild(errEl);
  }
})();
