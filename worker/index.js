// The site Worker's own code. Everything except /mirror/* is served
// straight from the static assets without running this (see
// wrangler.jsonc's assets.run_worker_first), so this only handles the
// mirror below.
//
// /mirror/myrtle/<path> -- a permanent copy of myrtle.moe's game assets
// (https://api.myrtle.moe/api/assets/<path>) kept in the R2 bucket
// "akshop-mirror" (binding MIRROR). The operator page's skin previews load
// their full illustrations and animated chibis through here, so each file
// is downloaded from myrtle.moe once, ever, instead of once per visitor:
//
//   1. Cloudflare's edge cache, if this data centre has it.
//   2. R2. Kept indefinitely: these files don't change after release.
//   3. myrtle.moe. A 200 is copied into R2 and served. A 404 is
//      remembered in R2 for MISSING_RECHECK_MS (the file may appear later,
//      e.g. a CN-only operator once it's extracted), so a missing file
//      doesn't send every visitor's request on to myrtle.moe either.
//
// Only the folders and file types the operator page uses are allowed, so
// this can't be used as a general-purpose proxy.

const UPSTREAM = "https://api.myrtle.moe/api/assets/";
const ALLOWED = [
  { prefix: "textures/chararts/", ext: ["png"] },
  { prefix: "textures/skinpack/", ext: ["png"] },
  { prefix: "spine/BattleFront/", ext: ["skel", "atlas", "png"] },
  { prefix: "spine/BattleBack/", ext: ["skel", "atlas", "png"] },
  { prefix: "spine/Building/", ext: ["skel", "atlas", "png"] },
];
const CONTENT_TYPES = {
  png: "image/png",
  atlas: "text/plain; charset=utf-8",
  skel: "application/octet-stream",
};
const MISSING_RECHECK_MS = 7 * 24 * 3600 * 1000;
const FOUND_CACHE = "public, max-age=31536000, immutable";
const MISSING_CACHE = "public, max-age=86400";
// Asset names are ids like "char_250_phatom_sale#4" -- letters, digits,
// "_", "#", "-", "." and "/" between folders, nothing else.
const SAFE_PATH = /^[A-Za-z0-9_#.\-/]+$/;

export function mirrorKey(pathname) {
  if (!pathname.startsWith("/mirror/myrtle/")) return null;
  let path;
  try {
    path = decodeURIComponent(pathname.slice("/mirror/myrtle/".length));
  } catch {
    return null;
  }
  if (!SAFE_PATH.test(path) || path.includes("..") || path.includes("//")) return null;
  const ext = path.slice(path.lastIndexOf(".") + 1);
  if (!ALLOWED.some((a) => path.startsWith(a.prefix) && a.ext.includes(ext))) return null;
  return path;
}

function upstreamUrl(path) {
  return UPSTREAM + path.split("/").map(encodeURIComponent).join("/");
}

function respond(status, body, path, cacheControl, extra = {}) {
  const ext = path ? path.slice(path.lastIndexOf(".") + 1) : "";
  return new Response(body, {
    status,
    headers: {
      "content-type": status === 200 ? CONTENT_TYPES[ext] || "application/octet-stream" : "text/plain; charset=utf-8",
      "cache-control": cacheControl,
      // The chibi player fetches .skel/.atlas with XHR, and local copies of
      // the site (other origins) use this mirror too.
      "access-control-allow-origin": "*",
      ...extra,
    },
  });
}

async function handleMirror(request, env, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return respond(405, "Method not allowed", null, "no-store", { allow: "GET, HEAD" });
  }
  const path = mirrorKey(new URL(request.url).pathname);
  if (!path) return respond(404, "Not found", null, MISSING_CACHE);

  // Same cache key for GET and HEAD, ignoring any query string.
  const cacheKey = new Request(new URL("/mirror/myrtle/" + path.split("/").map(encodeURIComponent).join("/"), request.url).toString());
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return request.method === "HEAD" ? new Response(null, hit) : hit;

  const finish = (res) => {
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return request.method === "HEAD" ? new Response(null, res) : res;
  };

  const key = "myrtle/" + path;
  const stored = await env.MIRROR.get(key);
  if (stored) {
    const missingSince = stored.customMetadata && stored.customMetadata.missingSince;
    if (!missingSince) return finish(respond(200, stored.body, path, FOUND_CACHE, { "x-mirror": "r2" }));
    if (Date.now() - Number(missingSince) < MISSING_RECHECK_MS) {
      return finish(respond(404, "Not found upstream", path, MISSING_CACHE, { "x-mirror": "r2-missing" }));
    }
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl(path), { headers: { "user-agent": "ak.athansson.com mirror (one fetch per file)" } });
  } catch (err) {
    return respond(502, "Upstream fetch failed", null, "no-store");
  }
  if (upstream.status === 404) {
    ctx.waitUntil(env.MIRROR.put(key, "", { customMetadata: { missingSince: String(Date.now()) } }));
    return finish(respond(404, "Not found upstream", path, MISSING_CACHE, { "x-mirror": "upstream-missing" }));
  }
  if (!upstream.ok) {
    // A myrtle.moe outage: don't remember anything, just pass the failure on.
    return respond(502, `Upstream returned ${upstream.status}`, null, "no-store");
  }
  const body = await upstream.arrayBuffer();
  ctx.waitUntil(env.MIRROR.put(key, body, { httpMetadata: { contentType: CONTENT_TYPES[path.slice(path.lastIndexOf(".") + 1)] } }));
  return finish(respond(200, body, path, FOUND_CACHE, { "x-mirror": "upstream" }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/mirror/")) return handleMirror(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
