// Shared config for every page in this fork. Load this before util.js,
// shoplist.js, or calendar.js -- they all reference EXTRA_DATA_REPO_RAW_BASE.

// Where banner_history.json / operator_release_dates.json / events.json
// are fetched from. Point this at YOUR OWN fork's raw JSON (set up with
// its own scraper schedule -- see .github/workflows/) instead of
// depending on akgcc/akgcc-extra-data's own (twice-weekly) refresh
// cadence.
const EXTRA_DATA_REPO_RAW_BASE =
  "https://raw.githubusercontent.com/KaKuna285/akshop-history/main/akgcc-extra-data/json/";

// raw.githubusercontent.com sits behind a CDN, and a branch path like the
// one above (as opposed to one pinned to a specific commit) can keep
// serving an old cached response well after a push updates the file --
// sometimes for hours, not just the usual few minutes. Appending a
// cache-busting query param makes every page load a distinct URL as far
// as that CDN is concerned, forcing a real fetch from origin instead of
// risking a stale cached hit.
function extraDataUrl(filename) {
  return `${EXTRA_DATA_REPO_RAW_BASE}${filename}?_=${Date.now()}`;
}

// Base URL of the standalone Cloudflare Worker that implements the
// Operator Planner's "import from Arknights account" feature (see
// cloudflare/depot-import.js for the Worker itself, and its own header
// comment for deploy steps). No trailing slash. Leave this blank to keep
// that feature hidden entirely -- the planner only shows the import UI
// once this is set to a real deployed Worker URL.
const DEPOT_IMPORT_ENDPOINT = "";
