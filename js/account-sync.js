// Shared "sync your Arknights account" feature. This used to live only
// inside the Operator Planner's Depot tab as an "Import from Arknights
// account" disclosure -- it's moved here, and onto the home page, so
// it's one feature usable (and visible) from anywhere on the site,
// rather than something you had to already be inside Planner to
// discover. Every page loads this file (after config.js and prefs.js)
// so the "Synced as <name>" nav badge shows up everywhere, but only the
// home page actually calls mount() to show the full sync form.
//
// Talks to the exact same Cloudflare Worker as before
// (cloudflare/depot-import.js, base URL in js/config.js's
// DEPOT_IMPORT_ENDPOINT) -- no backend changes needed. That Worker's
// fetch-depot response already includes `nickname`/`level` alongside the
// depot; previously those were only used for a one-time confirmation
// sentence and then thrown away.
//
// Right now a sync only ever fetches your depot (inventory) -- your
// actual operator roster (owned operators, their levels/skills/modules)
// isn't fetched yet. That's expected to follow later; calling this
// whole feature "account sync" rather than "depot import" is in
// anticipation of that, so this file's shape doesn't need another
// rename when it happens.
//
// Persisted state lives in the shared prefs blob (see js/prefs.js)
// under its own "account" section -- separate from "planner" (which
// still owns the actual depot data) so any page can answer "are we
// synced, and as who" without needing to know anything about Planner's
// own prefs shape, and so a future operator-roster sync has an obvious
// place to extend the same "account" section rather than needing a
// third one.
const AccountSync = (function () {
  const SECTION = "account";

  function getAccount() {
    return getPref(SECTION, "profile", null, (v) => v && typeof v === "object" && v.nickname);
  }

  function saveAccount(nickname, level, ownedOperators) {
    setPref(SECTION, "profile", {
      nickname,
      level: level || null,
      // Array of charIds ("char_002_amiya", ...), or null when the last
      // sync couldn't read a roster at all (see cloudflare/depot-import.js's
      // extractOwnedOperators()) -- kept apart from an empty array on
      // purpose so getOwnedOperators() callers (the operator page's
      // owned/not-owned filter) can tell "synced, owns nothing" from
      // "we don't actually know" instead of assuming the former.
      ownedOperators: Array.isArray(ownedOperators) ? ownedOperators : null,
      syncedAt: new Date().toISOString(),
    });
  }

  // Array of owned charIds from the last sync, or null if never synced
  // or the last sync didn't include roster data. Exists as its own
  // function (rather than making every caller reach into getAccount()'s
  // shape directly) so the operator page's filter doesn't need to know
  // this lives under "profile" internally.
  function getOwnedOperators() {
    const account = getAccount();
    return account ? account.ownedOperators || null : null;
  }

  // --- nav badge ----------------------------------------------------

  // Inserts (or updates, or removes) a small "Synced as <name>" link
  // into #topNav's nav-right, between the siteNav links and the first
  // icon button (home -- or, on the calendar page, about-then-home).
  // Runs automatically on every page load (bottom of this file) since
  // every page loads this script, and is safe to call again right
  // after a sync completes on the home page to refresh it immediately.
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
      badge.href = "/";
      const firstIconButton = navRight.querySelector(".rightButton");
      navRight.insertBefore(badge, firstIconButton || null);
    }
    badge.textContent = account.level != null
      ? `${account.nickname} (Lv ${account.level})`
      : account.nickname;
    badge.title = "Synced Arknights account -- manage on the home page";
  }

  // --- a compact status line, for Planner's Depot tab ----------------

  // Planner no longer has its own copy of the sync form (see mount()
  // below) -- just this one line pointing at the home page, so the two
  // places can't drift out of sync with each other about what state
  // "synced" even means.
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

  // Builds the full email/code/fetch/confirm form inside `container` --
  // an existing, empty element already on the page. Only ever called on
  // the home page today, but kept generic (not hardcoded to any one
  // page's surrounding markup) in case a future page wants it too.
  function mount(container) {
    if (!container) return;
    if (typeof DEPOT_IMPORT_ENDPOINT === "undefined" || !DEPOT_IMPORT_ENDPOINT) {
      return; // no Worker deployed for this fork -- stay invisible, as before
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

    // Holds the fetched-but-not-yet-applied result between "Sync
    // account" and "Replace my depot with this" -- nothing here is
    // saved until the user confirms, and it's discarded either way
    // (applied or cancelled), never left sitting around.
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
      syncedTextEl.textContent = `Synced as ${label}.`;
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
        };
        const itemCount = Object.keys(pending.depot).length;
        const who = pending.nickname
          ? `${pending.nickname}${pending.level ? ` (Lv ${pending.level})` : ""}`
          : "your account";
        const rosterNote = pending.ownedOperators
          ? ` and ${pending.ownedOperators.length.toLocaleString()} owned operator${pending.ownedOperators.length === 1 ? "" : "s"}`
          : "";
        summaryEl.textContent =
          `Fetched ${itemCount.toLocaleString()} item${itemCount === 1 ? "" : "s"}${rosterNote} from ${who}. ` +
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
      // The depot gets written straight into Planner's own prefs key --
      // Planner already re-validates whatever it finds there against the
      // real item table on its own next load (see planner.js's boot
      // sequence), so there's no need to duplicate that check here just
      // because this form isn't running on the planner page.
      setPref("planner", "depot", pending.depot);
      saveAccount(pending.nickname || "Unknown Doctor", pending.level, pending.ownedOperators);
      renderNavBadge();
      setStatus(
        pending.ownedOperators
          ? "Synced. Your depot will show up next time you open the Planner, and your roster is now available to the operator page's owned/not-owned filter."
          : "Synced. Your depot will show up next time you open the Planner. (Your operator roster wasn't included in this sync -- the owned/not-owned filter on the operator page won't have anything to go on yet.)",
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

  return { getAccount, saveAccount, getOwnedOperators, renderNavBadge, renderStatusLine, mount };
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", AccountSync.renderNavBadge);
} else {
  AccountSync.renderNavBadge();
}
