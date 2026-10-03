(function () {
  // Maintainer-only scan: walks every skin in skin_table.json (same data
  // and same filtering the /operator/ page's own skin gallery uses -- see
  // its loadData()/skinDisplayName()) and checks, via a HEAD request per
  // mirror, whether that skin's avatar and full-illustration image
  // actually resolve right now. Exists because a few reported "broken"
  // skins (recent collab-exclusive content, mainly) turned out to be a
  // real gap in the third-party image mirrors this site reads from, not a
  // bug in the site itself -- this gives a full accounting of which skins
  // are currently affected instead of finding them one at a time by
  // clicking through the operator roster.
  //
  // Opt-in only: never runs on page load, only when the button is
  // pressed, since a full pass is a few thousand small network requests.

  const startBtn = document.getElementById("sadStartBtn");
  const showCnOnlyToggle = document.getElementById("sadShowCnOnly");
  const showAllToggle = document.getElementById("sadShowAll");
  const progressEl = document.getElementById("sadProgress");
  const progressFillEl = document.getElementById("sadProgressFill");
  const progressLabelEl = document.getElementById("sadProgressLabel");
  const summaryEl = document.getElementById("sadSummary");
  const tableEl = document.getElementById("sadTable");
  const tableBodyEl = document.getElementById("sadTableBody");

  let scanResults = null; // set once a scan finishes; re-rendered on toggle change

  // Same label scheme as operator-page.js's own skinDisplayName() -- kept
  // as a small local copy rather than a shared export since this is the
  // only other place that needs it.
  function skinDisplayName(skin) {
    const d = (skin && skin.displaySkin) || {};
    if (d.skinName) return d.skinName;
    const m = /^ILLUST_(\d+)$/.exec(d.skinGroupId || "");
    if (m) return m[1] === "0" ? "Default outfit" : `Elite ${m[1]} art`;
    return "Outfit";
  }

  // Trimmed-down version of OperatorEditModal.loadCharTable() -- only the
  // charId/name/cnOnly fields this page needs, skipping that module's own
  // uniequip_table.json fetch (module data, irrelevant here) and the DOM
  // it otherwise injects on first use.
  async function loadCharTableWithCnFlag() {
    const charTable = await get_char_table(false, SERVERS.EN, false);
    try {
      const cnChars = await get_char_table(false, SERVERS.CN, false);
      for (const [charId, op] of Object.entries(cnChars)) {
        if (!charTable[charId]) {
          op.cnOnly = true;
          charTable[charId] = op;
        }
      }
    } catch (err) {
      console.warn("Couldn't load CN-exclusive character data:", err);
    }
    return charTable;
  }

  async function loadSkinTable(server) {
    const res = await fetch(`${DATA_BASE[server]}/gamedata/excel/skin_table.json`);
    const json = await fixedJson(res);
    return (json && json.charSkins) || {};
  }

  // Same EN+CN top-up merge as operator-page.js's loadData(), except this
  // also records which skinIds only came from the CN fetch -- needed to
  // tell "CN-only skin, missing mirror art is expected" apart from "EN
  // skin with a real coverage gap" at the per-skin level (an otherwise
  // EN-available operator can still have one CN-only skin not yet
  // released on EN).
  async function loadAllSkins() {
    const skins = await loadSkinTable(SERVERS.EN);
    const cnOnlySkinIds = new Set();
    try {
      const cnSkins = await loadSkinTable(SERVERS.CN);
      for (const [skinId, data] of Object.entries(cnSkins)) {
        if (!skins[skinId]) {
          skins[skinId] = data;
          cnOnlySkinIds.add(skinId);
        }
      }
    } catch (err) {
      console.warn("Couldn't load CN-exclusive skin data:", err);
    }
    return { skins, cnOnlySkinIds };
  }

  async function urlExists(url) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      return res.ok;
    } catch (err) {
      return false;
    }
  }

  // LOCAL first (confirmed ~100% reliable for avatars in prior research),
  // only falls through to the ACESHIP HEAD request when LOCAL actually
  // misses -- keeps the common case down to one request per skin instead
  // of two.
  async function checkAvatar(avatarId) {
    if (await urlExists(uri_skin_avatar(avatarId))) return "LOCAL";
    if (await urlExists(uri_skin_avatar(avatarId, ASSET_SOURCE.ACESHIP))) return "ACESHIP";
    return null;
  }

  // portraitId, not avatarId -- see uri_skin_illust()'s own comment in
  // util.js for why those differ for the base/"Default outfit" entry.
  async function checkFullArt(portraitId) {
    if (await urlExists(uri_skin_illust(portraitId))) return "ACESHIP";
    return null;
  }

  // Small fixed-concurrency pool -- a few thousand sequential HEAD
  // requests would take too long, and firing all of them at once risks
  // the browser's own per-host connection limit and jsDelivr rate
  // limiting. 12 is comfortably under both in testing.
  async function runPool(items, worker, concurrency, onProgress) {
    let nextIndex = 0;
    let completed = 0;
    const results = new Array(items.length);
    async function runOne() {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        results[i] = await worker(items[i], i);
        completed++;
        onProgress(completed, items.length);
      }
    }
    const workerCount = Math.min(concurrency, items.length) || 1;
    await Promise.all(Array.from({ length: workerCount }, runOne));
    return results;
  }

  function setProgress(done, total) {
    progressEl.classList.remove("hidden");
    const pct = total ? Math.round((done / total) * 100) : 0;
    progressFillEl.style.width = pct + "%";
    progressLabelEl.textContent = `Checked ${done} / ${total} skins (${pct}%)`;
  }

  function statusCell(status) {
    const span = document.createElement("span");
    if (status) {
      span.className = "sadStatusOk";
      span.textContent = status === "LOCAL" ? "OK (local mirror)" : "OK (Aceship mirror)";
    } else {
      span.className = "sadStatusMissing";
      span.textContent = "Missing on both mirrors";
    }
    return span;
  }

  function renderResults() {
    if (!scanResults) return;
    const showCnOnly = showCnOnlyToggle.checked;
    const showAll = showAllToggle.checked;

    const rows = scanResults.filter((r) => {
      if (r.cnOnly && !showCnOnly) return false;
      if (!showAll && r.avatarStatus && r.fullArtStatus) return false;
      return true;
    });

    const totalChecked = scanResults.length;
    const cnOnlyCount = scanResults.filter((r) => r.cnOnly).length;
    const nonCnOnly = scanResults.filter((r) => !r.cnOnly);
    const missingFullArt = nonCnOnly.filter((r) => !r.fullArtStatus).length;
    const missingAvatar = nonCnOnly.filter((r) => !r.avatarStatus).length;

    summaryEl.classList.remove("hidden");
    summaryEl.innerHTML = "";
    const p1 = document.createElement("p");
    p1.textContent = `${totalChecked} skins checked (${cnOnlyCount} CN-only, excluded from the counts below).`;
    summaryEl.appendChild(p1);
    const p2 = document.createElement("p");
    p2.innerHTML = `<strong>${missingFullArt}</strong> skin(s) have no full illustration on either mirror right now.`;
    summaryEl.appendChild(p2);
    if (missingAvatar > 0) {
      const p3 = document.createElement("p");
      p3.className = "sadStatusMissing";
      p3.innerHTML = `<strong>${missingAvatar}</strong> skin(s) are missing their avatar too -- these would show as a broken/blank icon in the grid, not just a missing "full size" preview. Worth a closer look.`;
      summaryEl.appendChild(p3);
    }

    tableBodyEl.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      if (r.cnOnly) tr.className = "sadRowCnOnly";

      const opCell = document.createElement("td");
      opCell.textContent = r.cnOnly && r.operatorCnName ? `${r.operatorName} (${r.operatorCnName})` : r.operatorName;
      tr.appendChild(opCell);

      const skinCell = document.createElement("td");
      const link = document.createElement("a");
      link.href = `/operator/?id=${encodeURIComponent(r.charId)}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = r.skinName;
      skinCell.appendChild(link);
      tr.appendChild(skinCell);

      const groupCell = document.createElement("td");
      groupCell.textContent = r.skinGroupName || "";
      tr.appendChild(groupCell);

      const avatarCell = document.createElement("td");
      avatarCell.appendChild(statusCell(r.avatarStatus));
      tr.appendChild(avatarCell);

      const fullArtCell = document.createElement("td");
      fullArtCell.appendChild(statusCell(r.fullArtStatus));
      tr.appendChild(fullArtCell);

      tableBodyEl.appendChild(tr);
    }
    tableEl.classList.toggle("hidden", rows.length === 0);
  }

  async function startScan() {
    startBtn.disabled = true;
    startBtn.textContent = "Scanning…";
    summaryEl.classList.add("hidden");
    tableEl.classList.add("hidden");
    setProgress(0, 1);

    const [charTable, { skins, cnOnlySkinIds }] = await Promise.all([
      loadCharTableWithCnFlag(),
      loadAllSkins(),
    ]);

    // Same filtering as operator-page.js's own skinsByCharId build --
    // drops token_*-prefixed enemy/summon re-skins, which never have a
    // matching charTable entry.
    const items = [];
    for (const [skinId, skin] of Object.entries(skins)) {
      if (!skin || !skin.charId || !charTable[skin.charId]) continue;
      const op = charTable[skin.charId];
      items.push({
        skinId,
        skin,
        charId: skin.charId,
        operatorName: op.name,
        operatorCnName: op.cnName,
        cnOnly: !!op.cnOnly || cnOnlySkinIds.has(skinId),
      });
    }

    const results = await runPool(
      items,
      async (item) => {
        const avatarId = item.skin.avatarId || item.skin.skinId;
        const portraitId = item.skin.portraitId || avatarId;
        const [avatarStatus, fullArtStatus] = await Promise.all([
          checkAvatar(avatarId),
          checkFullArt(portraitId),
        ]);
        return {
          charId: item.charId,
          operatorName: item.operatorName,
          operatorCnName: item.operatorCnName,
          cnOnly: item.cnOnly,
          skinName: skinDisplayName(item.skin),
          skinGroupName: (item.skin.displaySkin && item.skin.displaySkin.skinGroupName) || "",
          sortId: (item.skin.displaySkin && item.skin.displaySkin.sortId) || 0,
          avatarStatus,
          fullArtStatus,
        };
      },
      12,
      setProgress,
    );

    results.sort((a, b) => a.operatorName.localeCompare(b.operatorName) || a.sortId - b.sortId);
    scanResults = results;
    progressLabelEl.textContent += " -- done";
    startBtn.disabled = false;
    startBtn.textContent = "Scan again";
    renderResults();
  }

  startBtn.addEventListener("click", () => {
    startScan().catch((err) => {
      console.error(err);
      progressLabelEl.textContent = "Scan failed: " + err.message;
      startBtn.disabled = false;
      startBtn.textContent = "Start scan";
    });
  });
  showCnOnlyToggle.addEventListener("change", renderResults);
  showAllToggle.addEventListener("change", renderResults);
})();
