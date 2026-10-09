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
// sometimes for hours, not just the usual few minutes. A query param that
// changes every hour makes each hour's URL new to that CDN, so data is
// never more than about an hour behind the daily update. Within the hour
// the URL stays the same, so the browser's own cache (raw.githubusercontent
// sends max-age=300, then revalidates cheaply) can actually work -- a
// per-load timestamp re-downloaded every file on every page view.
const DATA_CACHE_BUCKET_MS = 3600 * 1000;
function extraDataUrl(filename) {
  return `${EXTRA_DATA_REPO_RAW_BASE}${filename}?_=${Math.floor(Date.now() / DATA_CACHE_BUCKET_MS)}`;
}

// Base URL of the standalone Cloudflare Worker that implements the
// Operator Planner's "import from Arknights account" feature (see
// cloudflare/depot-import/index.js for the Worker itself, and its own header
// comment for deploy steps). No trailing slash. Leave this blank to keep
// that feature hidden entirely -- the planner only shows the import UI
// once this is set to a real deployed Worker URL.
const DEPOT_IMPORT_ENDPOINT = "https://akshop-depot-import.freddyhansson.workers.dev";

// This site's permanent copy of the myrtle.moe assets the operator page
// uses -- skin illustrations and animated chibis -- kept in Cloudflare R2
// by the site Worker (worker/index.js, route /mirror/myrtle/). Each file is
// fetched from myrtle.moe once and served from R2 after that. Leave blank
// to fetch from myrtle.moe directly (e.g. a copy of the site without the
// Worker and bucket).
const MYRTLE_MIRROR_BASE = "https://ak.athansson.com/mirror/myrtle/";

// The same R2 mirror's copy of the ArknightsAssets2 dump (CN game client
// assets on GitHub, updated daily) -- full art for CN-only operators and
// skins, which myrtle.moe doesn't have. Blank to fetch from GitHub directly.
const CN_ART_MIRROR_BASE = "https://ak.athansson.com/mirror/aa2/";

// Cloudflare Image Transformations on this site's own zone (dashboard:
// Images -> Transformations, enabled for the zone, with this site's own
// domain as an allowed source origin). The skin preview fetches its full
// illustration through this: Cloudflare reads it from the mirror above,
// converts it to WebP/AVIF at preview size, and caches the result. If it
// isn't set up, or the free monthly quota runs out, the page falls back
// to the mirror's original PNG. Leave blank to skip it.
const IMAGE_TRANSFORM_BASE = "https://ak.athansson.com/cdn-cgi/image/";
