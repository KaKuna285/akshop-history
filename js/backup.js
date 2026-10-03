// "Back up or restore your data" -- home page only. The entire site's
// persisted state (Planner's depot/roster, synced account data, and
// every page's own view/sort/filter prefs) lives in one localStorage
// blob (see js/prefs.js's PREFS_KEY) -- this just lets you get that
// blob out as a file, and back in again, since none of it syncs
// anywhere on its own and clearing site data (or switching browsers)
// would otherwise lose it for good.
//
// Mirrors AccountSync's own UI conventions on purpose (same
// account-sync.css classes, same staged fetch-then-confirm pattern for
// the destructive step) rather than inventing a new visual language or
// using a native confirm() dialog -- this codebase doesn't use
// confirm() anywhere else.
const Backup = (function () {
  function filenameNow() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `akshop-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  }

  function exportData() {
    const blob = akPrefsLoadBlob();
    const json = JSON.stringify(blob, null, 2);
    const file = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = filenameNow();
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the download a moment to actually start before freeing the
    // blob URL -- revoking it immediately can race the download in some
    // browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.readAsText(file);
    });
  }

  // One line summarizing what's actually in a parsed backup blob, for
  // the confirm step -- so "Restore this backup" isn't a leap of faith.
  // Deliberately generic about every section it doesn't specifically
  // recognize (new pages will add their own prefs sections over time
  // without this needing to know about them).
  function describeBlob(blob) {
    const parts = [];
    const account = blob.account && blob.account.profile;
    if (account && account.nickname) {
      const level = account.level != null ? ` · Lv ${account.level}` : "";
      parts.push(`a synced account (${account.nickname}${level})`);
    }
    const planner = blob.planner;
    if (planner && typeof planner === "object") {
      const rosterCount = Array.isArray(planner.roster) ? planner.roster.length : 0;
      const depotCount = planner.depot && typeof planner.depot === "object" ? Object.keys(planner.depot).length : 0;
      const bits = [];
      if (rosterCount) bits.push(`${rosterCount} planner operator${rosterCount === 1 ? "" : "s"}`);
      if (depotCount) bits.push(`${depotCount} depot item${depotCount === 1 ? "" : "s"}`);
      if (bits.length) parts.push(bits.join(" and "));
    }
    const otherSections = Object.keys(blob).filter((k) => k !== "account" && k !== "planner");
    if (otherSections.length) {
      parts.push(`saved settings for ${otherSections.join(", ")}`);
    }
    if (!parts.length) return "This file doesn't look like it has any akshop data in it.";
    return `This file has: ${parts.join("; ")}.`;
  }

  function mount(container) {
    if (!container) return;

    container.innerHTML =
      '<p class="accountSyncNotice">' +
        "Everything saved on this device for this site -- your Planner depot and roster, your " +
        "synced account data, and every page's view settings -- lives only in this browser. " +
        "Download a backup to keep a copy, or to move it to another browser or device." +
      "</p>" +
      '<div class="accountSyncActions">' +
        '<button type="button" id="backupExportBtn">Download backup</button>' +
        '<label for="backupFileInput" class="accountSyncLinkBtn backupFileLabel" tabindex="0" role="button">Restore from a file&hellip;</label>' +
        '<input type="file" id="backupFileInput" class="backupFileInput" accept="application/json,.json" />' +
      "</div>" +
      '<div id="backupStatus" class="accountSyncStatus"></div>' +
      '<div id="backupConfirm" class="accountSyncConfirm hidden">' +
        '<p id="backupSummary"></p>' +
        '<div class="accountSyncActions">' +
          '<button type="button" id="backupApply">Restore this backup</button>' +
          '<button type="button" id="backupCancel" class="accountSyncCancelBtn">Cancel</button>' +
        "</div>" +
      "</div>";

    const fileInput = container.querySelector("#backupFileInput");
    const fileLabel = container.querySelector(".backupFileLabel");
    const exportBtn = container.querySelector("#backupExportBtn");
    const statusEl = container.querySelector("#backupStatus");
    const confirmEl = container.querySelector("#backupConfirm");
    const summaryEl = container.querySelector("#backupSummary");
    const applyBtn = container.querySelector("#backupApply");
    const cancelBtn = container.querySelector("#backupCancel");

    // Holds the parsed-but-not-yet-applied file between picking it and
    // confirming "Restore this backup" -- same shape as AccountSync's
    // own `pending`, for the same reason: nothing is written to storage
    // until the user explicitly confirms.
    let pending = null;

    function setStatus(text, isError) {
      statusEl.textContent = text || "";
      statusEl.classList.toggle("accountSyncStatusError", !!isError);
    }

    async function handleFile(file) {
      if (!file) return;
      setStatus("Reading file...");
      try {
        const text = await readFileAsText(file);
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          throw new Error("That file isn't valid JSON.");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("That doesn't look like an akshop backup file.");
        }
        pending = parsed;
        summaryEl.textContent =
          `${describeBlob(pending)} Restoring will replace everything currently saved on this ` +
          "device with what's in this file.";
        confirmEl.classList.remove("hidden");
        setStatus("");
      } catch (err) {
        setStatus(err.message || "Couldn't read that file.", true);
      } finally {
        // Reset so picking the same file again still fires "change".
        fileInput.value = "";
      }
    }

    function apply() {
      if (!pending) return;
      akPrefsSaveBlob(pending);
      confirmEl.classList.add("hidden");
      summaryEl.textContent = "";
      pending = null;
      setStatus("Restored. Reloading...");
      // Every page (including this one -- the nav badge, AccountSync's
      // own "synced as" view) reads prefs once at load time, so a
      // reload is the simplest way to make the restored data actually
      // take effect everywhere rather than only on the next navigation.
      setTimeout(() => location.reload(), 600);
    }

    function cancel() {
      pending = null;
      confirmEl.classList.add("hidden");
      summaryEl.textContent = "";
      setStatus("");
    }

    exportBtn.addEventListener("click", () => {
      exportData();
      setStatus("Backup downloaded.");
    });
    fileInput.addEventListener("change", () => handleFile(fileInput.files && fileInput.files[0]));
    // <label for> already opens the file picker on click; this just
    // makes it reachable from the keyboard too, same as a real button.
    fileLabel.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
    applyBtn.addEventListener("click", apply);
    cancelBtn.addEventListener("click", cancel);
  }

  return { exportData, mount };
})();
