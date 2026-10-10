// The site Worker's own code. Everything except /mirror/* is served
// straight from the static assets without running this (see
// wrangler.jsonc's assets.run_worker_first), so this only handles the
// mirror below.
//
// /mirror/<source>/<path> -- a permanent copy of game assets kept in the R2
// bucket "akshop-mirror" (binding MIRROR), from one of SOURCES below:
//   myrtle -- myrtle.moe's asset API: EN skin art and animated chibis
//   aa2    -- the ArknightsAssets2 dump on GitHub (CN client, updated
//             daily): art for CN-only operators and skins myrtle.moe
//             doesn't have
// The operator page's skin previews load their full illustrations and
// chibis through here, so each file is downloaded from its source once,
// ever, instead of once per visitor:
//
//   1. Cloudflare's edge cache, if this data centre has it.
//   2. R2. Kept indefinitely. Sources with recheckDays (the CN dump, which
//      gets corrected after patches) are asked "has this changed?" when a
//      stored copy is that old, in the background, and the copy is
//      replaced if it has (see recheck()).
//   3. The source. A 200 that really is the file type asked for (see
//      looksValid()) is copied into R2 and served. A 404 is only
//      remembered in the edge cache, for a day -- not in R2, so requests
//      for made-up file names can't fill the bucket. Asking a source is
//      also rate limited per visitor IP (UPSTREAM_LIMITER), so made-up
//      names can't be used to hammer it through this Worker either.
//
// Only the folders and file types the operator page uses are allowed, so
// this can't be used as a general-purpose proxy.

const SOURCES = {
  myrtle: {
    upstream: "https://api.myrtle.moe/api/assets/",
    allowed: [
      { prefix: "textures/chararts/", ext: ["png"] },
      { prefix: "textures/skinpack/", ext: ["png"] },
      { prefix: "spine/BattleFront/", ext: ["skel", "atlas", "png"] },
      { prefix: "spine/BattleBack/", ext: ["skel", "atlas", "png"] },
      { prefix: "spine/Building/", ext: ["skel", "atlas", "png"] },
    ],
  },
  aa2: {
    // characters/<charId>/<portraitId>[b].png -- default and skin art alike
    upstream: "https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/cn/assets/dyn/arts/",
    allowed: [{ prefix: "characters/", ext: ["png"] }],
    // The dump's files can be corrected later, so stored copies are
    // re-checked weekly and cached for a day instead of a year.
    recheckDays: 7,
    cacheControl: "public, max-age=86400",
  },
};
const CONTENT_TYPES = {
  png: "image/png",
  atlas: "text/plain; charset=utf-8",
  skel: "application/octet-stream",
};
const FOUND_CACHE = "public, max-age=31536000, immutable";
const MISSING_CACHE = "public, max-age=86400";
// Asset names are ids like "char_250_phatom_sale#4" -- letters, digits,
// "_", "#", "-", "." and "/" between folders, nothing else.
const SAFE_PATH = /^[A-Za-z0-9_#.\-/]+$/;

// "/mirror/<source>/<path>" -> { source, path } (path decoded), or null for
// an unknown source or a path outside that source's allowed folders/types.
export function mirrorKey(pathname) {
  const m = /^\/mirror\/([a-z0-9]+)\/(.+)$/.exec(pathname);
  const source = m && Object.prototype.hasOwnProperty.call(SOURCES, m[1]) ? m[1] : null;
  if (!source) return null;
  let path;
  try {
    path = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  if (!SAFE_PATH.test(path) || path.includes("..") || path.includes("//")) return null;
  const ext = path.slice(path.lastIndexOf(".") + 1);
  if (!SOURCES[source].allowed.some((a) => path.startsWith(a.prefix) && a.ext.includes(ext))) return null;
  return { source, path };
}

// Whether an upstream 200 is plausibly the real file, so an error page or a
// truncated response served with a 200 never gets stored forever.
export function looksValid(ext, bytes) {
  if (!bytes || bytes.byteLength < 16) return false;
  const b = new Uint8Array(bytes);
  if (ext === "png") {
    // PNG signature, and the IEND chunk at the end (a cut-off file lacks it).
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const iend = [0x49, 0x45, 0x4e, 0x44];
    return sig.every((v, i) => b[i] === v) && iend.every((v, i) => b[b.length - 8 + i] === v);
  }
  const head = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 512));
  if (/^\s*[<{]/.test(head)) return false; // an HTML or JSON error body
  if (ext === "atlas") return /\.png\s*\r?\n/.test(head) && /size:\s*\d+\s*,\s*\d+/.test(head);
  return true; // skel: binary, nothing simple to check beyond the above
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
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
  const target = mirrorKey(new URL(request.url).pathname);
  if (!target) return respond(404, "Not found", null, MISSING_CACHE);
  const { source, path } = target;

  // Same cache key for GET and HEAD, ignoring any query string.
  const cacheKey = new Request(new URL(`/mirror/${source}/${encodePath(path)}`, request.url).toString());
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return request.method === "HEAD" ? new Response(null, hit) : hit;

  const finish = (res) => {
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return request.method === "HEAD" ? new Response(null, res) : res;
  };

  const key = `${source}/${path}`;
  const src = SOURCES[source];
  const foundCache = src.cacheControl || FOUND_CACHE;
  const stored = await env.MIRROR.get(key);
  // Objects with missingSince metadata are leftover 404 markers: treat them
  // as missing (they get overwritten if the file turns up).
  if (stored && !(stored.customMetadata && stored.customMetadata.missingSince)) {
    if (src.recheckDays && recheckDue(stored, src.recheckDays)) {
      ctx.waitUntil(recheck(env, request, source, path, key, stored));
    }
    return finish(respond(200, stored.body, path, foundCache, { "x-mirror": "r2" }));
  }

  if (env.UPSTREAM_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    let ok = true;
    try {
      ok = (await env.UPSTREAM_LIMITER.limit({ key: ip })).success;
    } catch {
      // limiter unavailable: don't block real visitors
    }
    if (!ok) return respond(429, "Too many uncached files requested; try again in a minute", null, "no-store");
  }

  let upstream;
  try {
    upstream = await fetch(src.upstream + encodePath(path), { headers: { "user-agent": USER_AGENT } });
  } catch (err) {
    return respond(502, "Upstream fetch failed", null, "no-store");
  }
  if (upstream.status === 404) {
    return finish(respond(404, "Not found upstream", path, MISSING_CACHE, { "x-mirror": "upstream-missing" }));
  }
  if (!upstream.ok) {
    // An outage or rate limit upstream: don't remember anything, just pass
    // the failure on.
    return respond(502, `Upstream returned ${upstream.status}`, null, "no-store");
  }
  const body = await upstream.arrayBuffer();
  const ext = path.slice(path.lastIndexOf(".") + 1);
  if (!looksValid(ext, body)) {
    console.log(`not storing ${path}: upstream 200 doesn't look like a .${ext} (${body.byteLength} bytes)`);
    return respond(502, "Upstream returned an invalid file", null, "no-store");
  }
  ctx.waitUntil(env.MIRROR.put(key, body, storeOptions(path, upstream)));
  return finish(respond(200, body, path, foundCache, { "x-mirror": "upstream" }));
}

const USER_AGENT = "ak.athansson.com mirror (one fetch per file)";

// R2 put options: the content type, plus when the source was last checked
// and its ETag, for recheck().
function storeOptions(path, upstream) {
  const customMetadata = { checkedAt: String(Date.now()) };
  const etag = upstream && upstream.headers.get("etag");
  if (etag) customMetadata.etag = etag;
  return { httpMetadata: { contentType: CONTENT_TYPES[path.slice(path.lastIndexOf(".") + 1)] }, customMetadata };
}

// Whether a stored copy was last checked against its source more than
// `days` ago (copies stored before checks existed count from upload).
export function recheckDue(stored, days, now = Date.now()) {
  const meta = stored.customMetadata || {};
  const last = Number(meta.checkedAt) || (stored.uploaded ? new Date(stored.uploaded).getTime() : 0);
  return now - last > days * 86400000;
}

// Asks the source whether a stored file changed (If-None-Match with the
// ETag saved when it was stored) and replaces the R2 copy if it did.
// Runs after the stored copy has been served; anything that goes wrong
// just leaves the copy as it is, to be checked again on a later request.
// The edge cache keeps serving the old copy until it expires (a day), then
// picks up the new one from R2.
async function recheck(env, request, source, path, key, stored) {
  try {
    if (env.UPSTREAM_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.UPSTREAM_LIMITER.limit({ key: ip });
      if (!success) return;
    }
    const headers = { "user-agent": USER_AGENT };
    const etag = stored.customMetadata && stored.customMetadata.etag;
    if (etag) headers["if-none-match"] = etag;
    const upstream = await fetch(SOURCES[source].upstream + encodePath(path), { headers });
    let body;
    if (upstream.status === 304) {
      // Unchanged. R2 metadata can only be changed by writing the object
      // again, so rewrite the same bytes with a new checkedAt.
      const current = await env.MIRROR.get(key);
      if (!current) return;
      body = await current.arrayBuffer();
    } else if (upstream.ok) {
      body = await upstream.arrayBuffer();
      const ext = path.slice(path.lastIndexOf(".") + 1);
      if (!looksValid(ext, body)) return;
      console.log(`mirror: refreshed ${key} from the source`);
    } else {
      return; // gone or failing upstream: keep serving the stored copy
    }
    const options = storeOptions(path, upstream.status === 304 ? null : upstream);
    if (upstream.status === 304 && etag) options.customMetadata.etag = etag;
    await env.MIRROR.put(key, body, options);
  } catch (err) {
    console.log(`mirror: recheck of ${key} failed: ${err}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/mirror/")) return handleMirror(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
