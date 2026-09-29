// Shared "remember your settings" utility, used by every page in this
// fork to persist filter/view/sort choices across visits. Backed by
// localStorage rather than real HTTP cookies -- cookies are sent with
// every request (including static assets) for zero benefit here,
// they're capped around 4KB with a fussier expiry/path API, and purely
// functional client-side storage like this doesn't carry the
// GDPR/ePrivacy cookie-consent-banner obligations that tracking cookies
// do. Load this after config.js and before any page's own script --
// calendar.js and shoplist.js both call getPref/setPref below.
//
// Everything is namespaced under one single versioned localStorage key
// holding one JSON object, subsectioned by page ("calendar", "store",
// ...) -- e.g. { calendar: { view: "list" }, store: { server: "EN" } }
// -- so a future page can claim its own section without ever touching
// another page's stored data or this file itself. Bumping the version
// suffix on PREFS_KEY (if the stored shape ever needs a breaking
// change) naturally discards anything stored under the old key rather
// than trying to migrate it.
//
// Every read/write is defensive: localStorage can throw (private
// browsing in some browsers, site data disabled, storage full or
// blocked by policy) or hold something unexpected (a hand-edited
// devtools value, an option that's since been renamed or removed), and
// none of that should ever break the page -- callers always get back a
// usable value, at worst the same default they'd have used if nothing
// were stored at all.
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
