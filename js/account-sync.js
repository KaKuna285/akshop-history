// Account sync: links an Arknights account and reads its depot, roster,
// per-operator progress, medals and skins. Every page loads this file
// (after config.js and prefs.js) so the "Synced as <name>" nav badge shows
// everywhere; only the home page calls mount() to show the sync form.
//
// Talks to the Cloudflare Worker in cloudflare/depot-import/index.js (base
// URL: DEPOT_IMPORT_ENDPOINT in js/config.js). Its fetch-depot response
// carries `nickname`/`level`, the depot, `ownedOperators`,
// `ownedOperatorProgress`, `obtainedMedals` and `ownedSkins` -- see that
// file's extract*() functions for each shape and how well-confirmed it is
// (obtainedMedals is the least certain).
//
// State is saved in the shared prefs blob (js/prefs.js) under its own
// "account" section, separate from "planner" (which holds the depot), so
// any page can tell whether and as whom you're synced.
const AccountSync = (function () {
  const SECTION = "account";

  function getAccount() {
    return getPref(SECTION, "profile", null, (v) => v && typeof v === "object" && v.nickname);
  }

  function saveAccount(nickname, level, ownedOperators, ownedOperatorProgress, obtainedMedals, ownedSkins) {
    setPref(SECTION, "profile", {
      nickname,
      level: level || null,
      // Array of charIds ("char_002_amiya", ...), or null when the last sync
      // couldn't read a roster (see extractOwnedOperators() in the Worker).
      // Kept distinct from [] so callers can tell "synced, owns nothing" from
      // "unknown".
      ownedOperators: Array.isArray(ownedOperators) ? ownedOperators : null,
      // charId -> { evolvePhase, level, potentialRank, mainSkillLvl, skills,
      // modules, currentEquip }, for the operator page's "Your stats" toggle
      // (shape: extractOwnedOperatorProgress() in the Worker). Can be null
      // while ownedOperators isn't: a sync made by an older Worker has a
      // roster but no per-operator detail.
      ownedOperatorProgress:
        ownedOperatorProgress && typeof ownedOperatorProgress === "object" ? ownedOperatorProgress : null,
      // medalId -> { ts }, for the /account page's medal progress (shape:
      // extractObtainedMedals() in the Worker). Nullable on its own, for the
      // same reason as above.
      obtainedMedals: obtainedMedals && typeof obtainedMedals === "object" ? obtainedMedals : null,
      // skinId -> { ts }, for the operator page's "grey out owned" skins
      // toggle (shape: extractOwnedSkins() in the Worker). Nullable on its own,
      // for the same reason as above.
      ownedSkins: ownedSkins && typeof ownedSkins === "object" ? ownedSkins : null,
      syncedAt: new Date().toISOString(),
    });
  }

  // Array of owned charIds from the last sync, or null if never synced or
  // the sync had no roster data.
  function getOwnedOperators() {
    const account = getAccount();
    return account ? account.ownedOperators || null : null;
  }

  // One owned operator's synced progress ({ evolvePhase, level,
  // potentialRank, mainSkillLvl, skills, modules, currentEquip }), or null
  // if there's no sync, the operator isn't owned, or the sync has no
  // per-operator progress.
  function getOperatorProgress(charId) {
    const account = getAccount();
    const all = account && account.ownedOperatorProgress;
    return all && charId && all[charId] ? all[charId] : null;
  }

  // medalId -> { ts } from the last sync, or null if there's no sync or it
  // had no medal data. The /account page shows medal progress only when
  // this is non-null: null means "unknown", not "zero medals", and treating
  // it as zero would show a wrong 0%.
  function getObtainedMedals() {
    const account = getAccount();
    return account ? account.obtainedMedals || null : null;
  }

  // skinId -> { ts } from the last sync, or null if there's no sync or it
  // had no skin data. The operator page shows its "grey out owned" toggle
  // only when this is non-null, so the toggle never appears without data
  // to act on.
  function getOwnedSkins() {
    const account = getAccount();
    return account ? account.ownedSkins || null : null;
  }

  // --- shared progress formatting -------------------------------------
  // Short display strings for one owned operator's synced progress, shared
  // by the operator page's header and the /account roster table so both
  // describe an operator the same way. `op` is a character_table record as
  // returned by OperatorEditModal.loadCharTable() (needs
  // op.skills[].levelUpCostCond and op.modules); `progress` is one
  // ownedOperatorProgress entry.

  // "Skill 7 (M2/M0)": below skill level 7 all skills share one level, so
  // just that; at 7, each masterable skill's mastery rank (0 if none) in
  // op.skills order. Returns null when there's nothing to show, so callers
  // can tell "no data" from a real "Skill 1".
  function formatSkillSummary(op, progress) {
    if (!progress || typeof progress.mainSkillLvl !== "number") return null;
    if (progress.mainSkillLvl < 7) return `Skill ${progress.mainSkillLvl}`;
    const masteries = (Array.isArray(op && op.skills) ? op.skills : [])
      .map((ref) => {
        const cap = ref && ref.levelUpCostCond ? ref.levelUpCostCond.length : 0;
        if (!cap) return null;
        const entry = Array.isArray(progress.skills)
          ? progress.skills.find((s) => s && s.skillId === ref.skillId)
          : null;
        return `M${(entry && entry.specializeLevel) || 0}`;
      })
      .filter(Boolean);
    return masteries.length ? `Skill 7 (${masteries.join("/")})` : "Skill 7";
  }

  // "Reflexive Thinking Stage 2" ("<typeName2> <stage>"; typeName2 is the
  // "A"/"B"/... label the Stats section's module dropdown also uses) for
  // the equipped module. Only the equipped one counts (see the Worker's
  // extractOwnedOperatorProgress() note on currentEquip). null when none
  // is equipped or it isn't one of this operator's modules (stale data).
  function formatModuleSummary(op, progress) {
    if (!progress || !progress.currentEquip || !progress.modules) return null;
    const stage = progress.modules[progress.currentEquip];
    if (!stage) return null;
    const mod = (Array.isArray(op && op.modules) ? op.modules : []).find(
      (m) => m.uniEquipId === progress.currentEquip,
    );
    if (!mod) return null;
    return `${mod.typeName2 || "Module"} ${stage}`;
  }

  // One-line "Owned · E1 · Lv55 · Potential 3 · Skill 7 (M2) · Reflexive
  // Thinking Stage 2" summary; just "Owned" when the sync has no progress
  // data for this operator.
  function formatInvestmentSummary(op, progress) {
    if (!progress) return "Owned";
    const parts = [];
    if (typeof progress.evolvePhase === "number") parts.push(`E${progress.evolvePhase}`);
    if (typeof progress.level === "number") parts.push(`Lv${progress.level}`);
    if (typeof progress.potentialRank === "number") parts.push(`Potential ${progress.potentialRank + 1}`);
    const skill = formatSkillSummary(op, progress);
    if (skill) parts.push(skill);
    const mod = formatModuleSummary(op, progress);
    if (mod) parts.push(mod);
    return parts.length ? `Owned · ${parts.join(" · ")}` : "Owned";
  }

  // --- nav badge ----------------------------------------------------

  // Adds, updates or removes the "Synced as <name>" link in #topNav's
  // nav-right, before the first icon button. Runs on every page load (end
  // of this file) and again after a sync on the home page.
  function renderNavBadge() {
    const navRight = document.querySelector("#topNav .nav-right");
    if (!navRight) return; // page has no shared top nav at all
    let badge = document.getElementById("accountNavBadge");
    const account = getAccount();
    if (!account) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("a");
      badge.id = "accountNavBadge";
      badge.className = "accountNavBadge";
      // Links to the read-only /account overview; the sync form itself is on
      // the home page (and /account links back to it).
      badge.href = "/account/";
      const firstIconButton = navRight.querySelector(".rightButton");
      navRight.insertBefore(badge, firstIconButton || null);
    }
    badge.textContent = account.level != null
      ? `${account.nickname} (Lv ${account.level})`
      : account.nickname;
    badge.title = "Synced Arknights account -- view your account overview";
  }

  // --- a compact status line, for Planner's Depot tab ----------------

  // One line pointing at the home page's sync form, so Planner shows the
  // same sync state as everywhere else.
  function renderStatusLine(container) {
    if (!container) return;
    const account = getAccount();
    container.innerHTML = "";
    const p = document.createElement("p");
    p.className = "accountSyncStatusLine";
    if (account) {
      const label = account.level != null
        ? `${account.nickname} (Lv ${account.level})`
        : account.nickname;
      p.textContent = `Synced as ${label}. `;
      const link = document.createElement("a");
      link.href = "/";
      link.textContent = "Re-sync your depot from the home page";
      p.appendChild(link);
      p.appendChild(document.createTextNode("."));
    } else if (typeof DEPOT_IMPORT_ENDPOINT !== "undefined" && DEPOT_IMPORT_ENDPOINT) {
      const link = document.createElement("a");
      link.href = "/";
      link.textContent = "Sync your Arknights account";
      p.appendChild(link);
      p.appendChild(document.createTextNode(" from the home page to import your depot automatically."));
    } else {
      return; // feature not configured on this deployment -- say nothing
    }
    container.appendChild(p);
  }

  // --- the actual sync flow ------------------------------------------

  // Builds the full email/code/fetch/confirm form inside `container`, an
  // existing empty element. Used on the home page.
  function mount(container) {
    if (!container) return;
    if (typeof DEPOT_IMPORT_ENDPOINT === "undefined" || !DEPOT_IMPORT_ENDPOINT) {
      return; // no Worker configured for this deployment: show nothing
    }

    container.innerHTML =
      '<div id="accountSyncSynced" class="accountSyncSynced hidden">' +
        '<p id="accountSyncSyncedText"></p>' +
        '<button type="button" id="accountSyncResync" class="accountSyncLinkBtn">Use a different account</button>' +
      "</div>" +
      '<div id="accountSyncForm">' +
        '<p class="accountSyncNotice">' +
          "This logs in the same way the game's mobile app does, using a " +
          "one-time code Yostar emails to your account. It is not an " +
          "official Hypergryph or Yostar integration. Nothing about " +
          "your account login details gets stored on the server after " +
          "the import." +
        "</p>" +
        '<div class="accountSyncRow">' +
          '<label for="accountSyncEmail">Account email</label>' +
          '<input type="email" id="accountSyncEmail" autocomplete="off" />' +
        "</div>" +
        '<details class="accountSyncAdvanced">' +
          '<summary>Access key (only if one\'s been set up)</summary>' +
          '<div class="accountSyncRow">' +
            '<label for="accountSyncKey">Access key</label>' +
            '<input type="password" id="accountSyncKey" autocomplete="off" />' +
          "</div>" +
        "</details>" +
        '<div class="accountSyncActions">' +
          '<button type="button" id="accountSyncSendCode">Send code</button>' +
        "</div>" +
        '<div class="accountSyncRow hidden" id="accountSyncCodeRow">' +
          '<label for="accountSyncCode">Code from email</label>' +
          '<input type="text" id="accountSyncCode" autocomplete="off" inputmode="numeric" />' +
        "</div>" +
        '<div class="accountSyncActions hidden" id="accountSyncFetchRow">' +
          '<button type="button" id="accountSyncFetch">Sync account</button>' +
        "</div>" +
        '<div id="accountSyncStatus" class="accountSyncStatus"></div>' +
        '<div id="accountSyncConfirm" class="accountSyncConfirm hidden">' +
          '<p id="accountSyncSummary"></p>' +
          '<div class="accountSyncActions">' +
            '<button type="button" id="accountSyncApply">Replace my depot with this</button>' +
            '<button type="button" id="accountSyncCancel" class="accountSyncCancelBtn">Cancel</button>' +
          "</div>" +
        "</div>" +
      "</div>";

    const syncedViewEl = container.querySelector("#accountSyncSynced");
    const syncedTextEl = container.querySelector("#accountSyncSyncedText");
    const resyncBtn = container.querySelector("#accountSyncResync");
    const formEl = container.querySelector("#accountSyncForm");
    const emailEl = container.querySelector("#accountSyncEmail");
    const keyEl = container.querySelector("#accountSyncKey");
    const sendCodeBtn = container.querySelector("#accountSyncSendCode");
    const codeRowEl = container.querySelector("#accountSyncCodeRow");
    const codeEl = container.querySelector("#accountSyncCode");
    const fetchRowEl = container.querySelector("#accountSyncFetchRow");
    const fetchBtn = container.querySelector("#accountSyncFetch");
    const statusEl = container.querySelector("#accountSyncStatus");
    const confirmEl = container.querySelector("#accountSyncConfirm");
    const summaryEl = container.querySelector("#accountSyncSummary");
    const applyBtn = container.querySelector("#accountSyncApply");
    const cancelBtn = container.querySelector("#accountSyncCancel");

    // The fetched result between "Sync account" and "Replace my depot with
    // this". Nothing is saved until the user confirms, and it's discarded
    // either way.
    let pending = null;

    function setStatus(text, isError) {
      statusEl.textContent = text || "";
      statusEl.classList.toggle("accountSyncStatusError", !!isError);
    }

    function showSyncedView() {
      const account = getAccount();
      if (!account) {
        showForm();
        return;
      }
      const label = account.level != null
        ? `${account.nickname} (Lv ${account.level})`
        : account.nickname;
      syncedTextEl.textContent = "";
      syncedTextEl.appendChild(document.createTextNode(`Synced as ${label}. `));
      const overviewLink = document.createElement("a");
      overviewLink.href = "/account/";
      overviewLink.textContent = "View your account overview";
      syncedTextEl.appendChild(overviewLink);
      syncedTextEl.appendChild(document.createTextNode("."));
      syncedViewEl.classList.remove("hidden");
      formEl.classList.add("hidden");
    }

    function showForm() {
      syncedViewEl.classList.add("hidden");
      formEl.classList.remove("hidden");
    }

    async function requestCode() {
      const key = keyEl.value.trim();
      const email = emailEl.value.trim();
      if (!email) {
        setStatus("Enter your account email first.", true);
        return;
      }
      sendCodeBtn.disabled = true;
      setStatus("Sending code...");
      try {
        const res = await fetch(`${DEPOT_IMPORT_ENDPOINT}/request-code`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Access-Key": key },
          body: JSON.stringify({ email }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
        codeRowEl.classList.remove("hidden");
        fetchRowEl.classList.remove("hidden");
        codeEl.focus();
        setStatus("Code sent -- check your email, then enter it below.");
      } catch (err) {
        setStatus(err.message || "Couldn't send the code.", true);
      } finally {
        sendCodeBtn.disabled = false;
      }
    }

    async function fetchAccount() {
      const key = keyEl.value.trim();
      const email = emailEl.value.trim();
      const code = codeEl.value.trim();
      if (!code) {
        setStatus("Enter the code from your email first.", true);
        return;
      }
      fetchBtn.disabled = true;
      setStatus("Fetching your account...");
      try {
        const res = await fetch(`${DEPOT_IMPORT_ENDPOINT}/fetch-depot`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Access-Key": key },
          body: JSON.stringify({ email, code }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
        pending = {
          depot: body.depot || {},
          nickname: body.nickname || null,
          level: body.level || null,
          ownedOperators: Array.isArray(body.ownedOperators) ? body.ownedOperators : null,
          ownedOperatorProgress:
            body.ownedOperatorProgress && typeof body.ownedOperatorProgress === "object"
              ? body.ownedOperatorProgress
              : null,
          obtainedMedals:
            body.obtainedMedals && typeof body.obtainedMedals === "object" ? body.obtainedMedals : null,
          ownedSkins: body.ownedSkins && typeof body.ownedSkins === "object" ? body.ownedSkins : null,
        };
        const itemCount = Object.keys(pending.depot).length;
        const who = pending.nickname
          ? `${pending.nickname}${pending.level ? ` (Lv ${pending.level})` : ""}`
          : "your account";
        const rosterNote = pending.ownedOperators
          ? ` and ${pending.ownedOperators.length.toLocaleString()} owned operator${pending.ownedOperators.length === 1 ? "" : "s"}`
          : "";
        const skinsNote = pending.ownedSkins
          ? ` (${Object.keys(pending.ownedSkins).length.toLocaleString()} owned skin${Object.keys(pending.ownedSkins).length === 1 ? "" : "s"})`
          : "";
        summaryEl.textContent =
          `Fetched ${itemCount.toLocaleString()} item${itemCount === 1 ? "" : "s"}${rosterNote}${skinsNote} from ${who}. ` +
          `This will replace your current depot entirely (in the Operator Planner) -- anything ` +
          `you've tracked manually and isn't in this list will be removed.`;
        confirmEl.classList.remove("hidden");
        setStatus("");
      } catch (err) {
        setStatus(err.message || "Couldn't fetch your account.", true);
      } finally {
        fetchBtn.disabled = false;
      }
    }

    function apply() {
      if (!pending) return;
      // The depot goes straight into Planner's prefs; Planner re-validates it
      // against the item table on its next load (see planner.js's boot
      // sequence), so no check is needed here.
      setPref("planner", "depot", pending.depot);
      saveAccount(
        pending.nickname || "Unknown Doctor",
        pending.level,
        pending.ownedOperators,
        pending.ownedOperatorProgress,
        pending.obtainedMedals,
        pending.ownedSkins,
      );
      renderNavBadge();
      const medalNote = pending.obtainedMedals
        ? " Your account overview also has your medal progress now."
        : "";
      const skinNote = pending.ownedSkins
        ? " The operator page's skin gallery can grey out skins you already own, too."
        : "";
      setStatus(
        (pending.ownedOperators
          ? "Synced. Your depot will show up next time you open the Planner, your roster is now available to the operator page's owned/not-owned filter" +
              (pending.ownedOperatorProgress
                ? ", and owned operators there can show your actual stats instead of maxed."
                : " -- though this sync didn't include per-operator progress, so those pages will still show maxed stats for now.")
          : "Synced. Your depot will show up next time you open the Planner. (Your operator roster wasn't included in this sync -- the owned/not-owned filter on the operator page won't have anything to go on yet.)") +
          medalNote +
          skinNote,
      );
      confirmEl.classList.add("hidden");
      summaryEl.textContent = "";
      emailEl.value = "";
      keyEl.value = "";
      codeEl.value = "";
      codeRowEl.classList.add("hidden");
      fetchRowEl.classList.add("hidden");
      pending = null;
      showSyncedView();
    }

    function cancel() {
      pending = null;
      confirmEl.classList.add("hidden");
      summaryEl.textContent = "";
    }

    sendCodeBtn.addEventListener("click", requestCode);
    fetchBtn.addEventListener("click", fetchAccount);
    applyBtn.addEventListener("click", apply);
    cancelBtn.addEventListener("click", cancel);
    resyncBtn.addEventListener("click", showForm);

    if (getAccount()) {
      showSyncedView();
    } else {
      showForm();
    }
  }

  return {
    getAccount,
    saveAccount,
    getOwnedOperators,
    getOperatorProgress,
    getObtainedMedals,
    getOwnedSkins,
    formatSkillSummary,
    formatModuleSummary,
    formatInvestmentSummary,
    renderNavBadge,
    renderStatusLine,
    mount,
  };
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", AccountSync.renderNavBadge);
} else {
  AccountSync.renderNavBadge();
}
