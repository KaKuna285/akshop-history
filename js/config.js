// Shared config for every page. Load this before any other script -- they
// all reference EXTRA_DATA_REPO_RAW_BASE (via extraDataUrl() or util.js).

// Where the daily pipeline's output (akgcc-extra-data/json/: shop history,
// operator release dates, events, meta.json, and the slim game data under
// gamedata/) is fetched from. Point this at your own repo's raw JSON if you
// run your own copy (see the README's setup section).
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
// cloudflare/depot-import/index.js for the Worker itself, and its own header
// comment for deploy steps). No trailing slash. Leave this blank to keep
// that feature hidden entirely -- the planner only shows the import UI
// once this is set to a real deployed Worker URL.
const DEPOT_IMPORT_ENDPOINT = "https://akshop-depot-import.freddyhansson.workers.dev";

// Cloudflare Image Transformations on this site's own zone (dashboard:
// Images -> Transformations, enabled for the zone, with api.myrtle.moe
// added as an allowed source origin). The operator page's skin preview
// fetches its full illustration through this: Cloudflare pulls the art
// from myrtle.moe once, converts it to WebP/AVIF, and serves later views
// from its own cache, so myrtle.moe sees about one request per skin
// instead of one per visitor. If it isn't set up, or the free monthly
// quota runs out, the page falls back to fetching from myrtle.moe
// directly. Leave blank to always fetch directly.
const IMAGE_TRANSFORM_BASE = "https://ak.athansson.com/cdn-cgi/image/";
