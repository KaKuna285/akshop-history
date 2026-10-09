// Shared config for every page. Load this before any other script -- they
// all reference EXTRA_DATA_REPO_RAW_BASE (via extraDataUrl() or util.js).

// Where the daily pipeline's output (akgcc-extra-data/json/: shop history,
// operator release dates, events, meta.json, and the slim game data under
// gamedata/) is fetched from. Point this at your own repo's raw JSON if you
// run your own copy (see the README's setup section).
const EXTRA_DATA_REPO_RAW_BASE =
  "https://raw.githubusercontent.com/KaKuna285/akshop-history/main/akgcc-extra-data/json/";

// raw.githubusercontent.com sits behind a CDN that can keep serving an old
// copy of a branch path like the one above for hours after a push. A query
// param that changes every hour makes each hour's URL new to that CDN, so
// data is at most about an hour behind the daily update. Within the hour
// the URL stays the same, so the browser's own cache (max-age=300, then a
// cheap revalidation) still works, instead of every page view
// re-downloading every file.
const DATA_CACHE_BUCKET_MS = 3600 * 1000;
function extraDataUrl(filename) {
  return `${EXTRA_DATA_REPO_RAW_BASE}${filename}?_=${Math.floor(Date.now() / DATA_CACHE_BUCKET_MS)}`;
}

// Base URL of the standalone Cloudflare Worker behind the home page's
// "Sync your Arknights account" feature (js/account-sync.js; the Worker is
// cloudflare/depot-import/index.js, with deploy steps in its header
// comment). No trailing slash. Leave blank to hide the feature entirely:
// the sync form and the other pages' "sync your account" prompts only
// show once this points at a deployed Worker.
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
