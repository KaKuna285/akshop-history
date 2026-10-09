// Saved settings and data (filters, views, sort order, the planner roster
// and depot, account sync) for every page. Backed by localStorage rather
// than cookies: nothing here needs to go to the server, and cookies would
// be sent with every request and are capped around 4KB. Load this after
// config.js and before account-sync.js and any page's own script.
//
// Everything lives under one versioned localStorage key holding one JSON
// object, with a section per page, e.g.
// { calendar: { view: "list" }, store: { server: "EN" } }, so each page
// only touches its own section. Bumping the version suffix on PREFS_KEY
// (for a breaking change to the stored shape) discards the old data
// rather than migrating it.
//
// Every read/write is defensive: localStorage can throw (private
// browsing in some browsers, site data disabled, storage full or blocked
// by policy) or hold something unexpected (a hand-edited value, an option
// that's since been renamed or removed). Callers always get back a usable
// value, at worst the default they'd use if nothing were stored.
const PREFS_KEY = "akshop.prefs.v1";

function akPrefsLoadBlob() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

function akPrefsSaveBlob(blob) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(blob));
  } catch (err) {
    // Storage unavailable or full -- the setting just won't stick for
    // next time, which is a silent no-op rather than a broken page.
  }
}

// Reads one saved value. Returns `fallback` when nothing was ever saved
// for this section/key, storage isn't available, or (when `validate` is
// given) the stored value fails validation -- e.g. it names a filter
// option that's since been renamed or removed.
function getPref(section, key, fallback, validate) {
  const blob = akPrefsLoadBlob();
  const sectionData = blob[section];
  if (!sectionData || typeof sectionData !== "object" || !(key in sectionData)) {
    return fallback;
  }
  const value = sectionData[key];
  if (validate && !validate(value)) return fallback;
  return value;
}

// Writes one value under section/key, leaving every other saved section
// and key (including this page's other keys) untouched.
function setPref(section, key, value) {
  const blob = akPrefsLoadBlob();
  if (!blob[section] || typeof blob[section] !== "object") {
    blob[section] = {};
  }
  blob[section][key] = value;
  akPrefsSaveBlob(blob);
}
