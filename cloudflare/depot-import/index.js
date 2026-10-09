// Cloudflare Worker: one-shot Arknights (EN/Yostar) account sync, used by
// the home page's "Sync your Arknights account" section (js/account-sync.js).
// The synced data feeds the Operator Planner (/planner/), the owned/not-owned
// filter and "Your stats" toggle on the operator browser (/operator/), and
// the medal progress section on the account overview page (/account/).
// Given an account email and the one-time code Yostar emails to it, this
// logs in the way the mobile client does, reads the account's item
// inventory, operator roster (with each operator's progress), skins and
// medals once, and returns them. Nothing about the account is kept.
//
// This is an independent JavaScript implementation of the login/session
// protocol documented by the ArkPRTS project
// (https://github.com/thesadru/arkprts, GPLv3). Endpoints, field names and
// the request-signing schemes below come from reading that project's
// source, but the code is written for the Workers runtime, not translated
// from its Python, so this file carries this repo's MIT license. If Yostar
// changes the protocol, arkprts is the first place to check.
//
// Scope:
//   - EN (Yostar) accounts only. No CN/JP/KR support.
//   - Fetch-and-discard: the account's session token/secret and the fetched
//     inventory/roster exist only in memory for the lifetime of a single
//     request. This Worker has no KV/D1/Durable Object bindings at all, so
//     there is nowhere for any of it to persist even by accident -- writing
//     it down anywhere would take a deploy, not just a bug. Cloudflare's own
//     request logs (visible on the dashboard, if enabled) can still show
//     metadata like the caller's IP and timestamp; nothing below logs the
//     email, code, session secret, inventory, or roster contents themselves.
//   - Unofficial API. This talks to Yostar/Hypergryph's real game backend
//     the same way the app does, which isn't a documented or sanctioned
//     integration -- the sync form (js/account-sync.js) tells the user so.
//
// Deployed automatically: this folder's wrangler.jsonc plus Cloudflare's
// Workers Builds, connected to this repo with root directory
// cloudflare/depot-import -- a push that changes this folder redeploys
// the Worker; nothing to paste into the dashboard. See the README's
// "Deploying the Cloudflare Workers" section. (Same setup as this repo's
// other standalone Worker, cloudflare/dispatch-cron/.)
//
// One-time setup (Cloudflare dashboard):
//   1. The Worker itself ("akshop-depot-import") and its Git connection --
//      see the README section above.
//   2. Settings -> Variables and Secrets -> add (wrangler.jsonc has
//      keep_vars: true, so deploys never touch these):
//        ALLOWED_ORIGIN - the origin the site is served from, e.g.
//                         "https://ak.athansson.com". Requests from any
//                         other Origin header are rejected. Origins on
//                         http://localhost or http://127.0.0.1 (any port)
//                         are always allowed too, for local testing.
//        ACCESS_KEY_HASH - OPTIONAL. If set, requests must include a
//                         "X-Access-Key" header whose SHA-256 hex digest
//                         matches this value, or they're rejected before
//                         anything else happens. Leave unset to disable
//                         this check entirely (fine for a private tool
//                         behind an unlisted *.workers.dev URL; add it if
//                         you want a second gate). Generate one with:
//                           echo -n 'your-chosen-key' | sha256sum
//     The Origin check only stops other websites from calling this from a
//     visitor's browser -- a script can send any Origin it likes. Abuse
//     (mailing codes to arbitrary addresses, guessing codes) is limited by
//     the per-IP/per-email rate limits (rateLimited() below, bindings in
//     wrangler.jsonc), plus ACCESS_KEY_HASH if set.
//     The site's own code is public, so it holds no access key: the sync
//     form asks for one at use time and sends it as the "X-Access-Key"
//     header (js/account-sync.js). Only its hash is stored here.
//   3. Point DEPOT_IMPORT_ENDPOINT in js/config.js at this Worker's URL
//      (its default *.workers.dev URL is fine, or a Custom Domain under
//      Settings -> Triggers if you set one up).

const NETWORK_CONFIG_URL =
  "https://ak-conf.arknights.global/config/prod/official/network_config";
const VERSION_CONFIG_URL =
  "https://ark-us-static-online.yo-star.com/assetbundle/official/Android/version";
const YOSTARPLAT_HOST = "https://en-sdk-api.yostarplat.com";
const U8_SIGN_KEY = "91240f70c09a08a6bc72af1a5c8d4670";
const YOSTARPLAT_SIGN_SUFFIX = "886c085e4a8d30a703367b120dd8353948405ec2";
const CLIENT_VERSION_FALLBACK = "4.10.0";

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const corsOk = isAllowedOrigin(origin, env);
    const cors = corsOk ? corsHeaders(origin) : null;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors || {} });
    }
    if (!corsOk) {
      return new Response("Forbidden origin", { status: 403 });
    }
    if (env.ACCESS_KEY_HASH) {
      const key = request.headers.get("X-Access-Key") || "";
      const gotHash = key ? await sha256Hex(key) : "";
      if (gotHash !== env.ACCESS_KEY_HASH) {
        return json({ error: "Forbidden" }, 403, cors);
      }
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, cors);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/request-code") {
        const { email } = await safeJson(request);
        requireEmail(email);
        const limited = await rateLimited(env.CODE_LIMITER, request, email);
        if (limited) return json({ error: limited }, 429, cors);
        await sendEmailCode(email);
        return json({ ok: true }, 200, cors);
      }
      if (url.pathname === "/fetch-depot") {
        const { email, code } = await safeJson(request);
        requireEmail(email);
        if (!code || typeof code !== "string") {
          throw new StepError("validate code", "Enter the code Yostar emailed you.");
        }
        const limited = await rateLimited(env.FETCH_LIMITER, request, email);
        if (limited) return json({ error: limited }, 429, cors);
        const result = await fetchDepot(email, code);
        return json(result, 200, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      const step = err instanceof StepError ? err.step : "unknown";
      const message = err instanceof Error ? err.message : String(err);
      // Deliberately no email/code/token/secret/inventory in this log line.
      console.log(`depot-import failed at step "${step}": ${message}`);
      // Bad input from the caller is a 400; anything else failed upstream.
      const status = INPUT_STEPS.has(step) ? 400 : 502;
      return json({ error: message, step }, status, cors);
    }
  },
};

// --- request/response plumbing --------------------------------------------

class StepError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

const INPUT_STEPS = new Set(["parse request", "validate email", "validate code"]);

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) return true;
  // Local testing: exactly localhost / 127.0.0.1 on any port. Compared as
  // a parsed hostname, so "http://localhost.example.com" doesn't count.
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

// Workers Rate Limiting (bindings CODE_LIMITER and FETCH_LIMITER in
// wrangler.jsonc): each call is counted twice, once per caller IP and once
// per email address, so neither one IP cycling through addresses nor many
// IPs hammering one address gets past the limit. Returns an error message
// when over the limit, else null. Without the binding (e.g. local dev) it
// never limits; if the limiter itself errors, the request is let through
// rather than locking real users out.
async function rateLimited(limiter, request, email) {
  if (!limiter) return null;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  try {
    const results = await Promise.all([
      limiter.limit({ key: `ip:${ip}` }),
      limiter.limit({ key: `email:${email.trim().toLowerCase()}` }),
    ]);
    if (results.every((r) => r.success)) return null;
  } catch (err) {
    console.log(`rate limiter unavailable: ${err && err.message}`);
    return null;
  }
  return "Too many attempts. Wait a minute and try again.";
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...(cors || {}) },
  });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    throw new StepError("parse request", "Malformed request body.");
  }
}

function requireEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) {
    throw new StepError("validate email", "Enter a valid account email.");
  }
}

// --- crypto primitives ------------------------------------------------------

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return toHex(new Uint8Array(digest));
}

async function hmacSha1Hex(keyStr, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyStr),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig));
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Python's urllib.parse.quote_plus (space -> "+", everything but
// [A-Za-z0-9_.-~] percent-encoded) -- encodeURIComponent alone differs on
// space and on "!*'()", which it leaves unescaped.
function quotePlus(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, "+");
}

// RFC 1321 MD5, for the Yostar request signature. Matches Python's
// hashlib.md5 on padding-boundary inputs (empty, 55/56/63/64/65 bytes,
// 1000 bytes) -- re-check those if this is ever touched.
function md5Hex(bytes) {
  function rotl(x, c) {
    return (x << c) | (x >>> (32 - c));
  }
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  }

  const origLen = bytes.length;
  const withOne = origLen + 1;
  const padLen = withOne % 64 <= 56 ? 56 - (withOne % 64) : 120 - (withOne % 64);
  const totalLen = withOne + padLen + 8;
  const msg = new Uint8Array(totalLen);
  msg.set(bytes, 0);
  msg[origLen] = 0x80;
  const bitLenLow = (origLen * 8) >>> 0;
  const bitLenHigh = Math.floor((origLen * 8) / 4294967296) >>> 0;
  const dv = new DataView(msg.buffer);
  dv.setUint32(totalLen - 8, bitLenLow, true);
  dv.setUint32(totalLen - 4, bitLenHigh, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let chunkStart = 0; chunkStart < totalLen; chunkStart += 64) {
    for (let j = 0; j < 16; j++) M[j] = dv.getInt32(chunkStart + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const outDv = new DataView(out.buffer);
  outDv.setInt32(0, a0, true);
  outDv.setInt32(4, b0, true);
  outDv.setInt32(8, c0, true);
  outDv.setInt32(12, d0, true);
  return toHex(out);
}

function md5HexOfString(str) {
  return md5Hex(new TextEncoder().encode(str));
}

function randomDeviceId() {
  return crypto.randomUUID();
}

// Mimics the mobile client's Android-style device id triplet closely enough
// for the login flow. A real phone presents the same device id on every
// login for a given account, so this derives a stable one from the account
// email (nothing persisted -- just a deterministic hash) instead of a fresh
// random id per request, which would make every request look like a
// never-before-seen device.
async function stableAndroidDeviceIds(email) {
  const digest = await sha256Hex(`akshop-depot-import-device-id-v1:${email}`);
  const id1 = digest.slice(0, 32);
  const id3 = digest.slice(32, 64);
  let id2 = "86";
  for (let i = 0; i < 13; i++) id2 += (parseInt(digest[i], 16) % 10).toString();
  return [id1, id2, id3];
}

// --- Yostar EN auth chain ---------------------------------------------------

async function generateYostarplatHeaders(bodyStr, { uid = "", token = "", deviceId } = {}) {
  const head = {
    PID: "US-ARKNIGHTS",
    Channel: "googleplay",
    Platform: "android",
    Version: CLIENT_VERSION_FALLBACK,
    GVersionNo: "2000112",
    GBuildNo: "",
    Lang: "en",
    DeviceID: deviceId || randomDeviceId(),
    DeviceModel: "F9",
    UID: uid,
    Token: token,
    Time: Math.floor(Date.now() / 1000),
  };
  const headStr = JSON.stringify(head);
  const sign = md5HexOfString(headStr + bodyStr + YOSTARPLAT_SIGN_SUFFIX).toUpperCase();
  return {
    Authorization: JSON.stringify({ Head: head, Sign: sign }),
    "Content-Type": "application/json",
  };
}

async function yostarplatPost(path, bodyObj, authState) {
  const bodyStr = JSON.stringify(bodyObj);
  const headers = await generateYostarplatHeaders(bodyStr, authState);
  const resp = await fetch(`${YOSTARPLAT_HOST}/${path}`, {
    method: "POST",
    headers,
    body: bodyStr,
  });
  const data = await parseJsonOrThrow(resp, path);
  return data;
}

async function parseJsonOrThrow(resp, step) {
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StepError(step, `Unexpected response from ${step} (status ${resp.status}).`);
  }
  return data;
}

async function sendEmailCode(email) {
  const data = await yostarplatPost("yostar/send-code", {
    Account: email,
    Randstr: "",
    Ticket: "",
  });
  // Yostar signals failure via a non-zero/absent status inside the JSON
  // body rather than an HTTP error status; the exact shape isn't fully
  // pinned down, so surface whatever message field is present on anything
  // that doesn't look like success.
  if (data && data.Data == null && (data.Message || data.message)) {
    throw new StepError("send code", data.Message || data.message);
  }
}

async function submitEmailCode(email, code) {
  const data = await yostarplatPost("yostar/get-auth", { Account: email, Code: code });
  const token = data?.Data?.Token;
  if (!token) {
    throw new StepError(
      "submit code",
      data?.Message || data?.message || "That code wasn't accepted -- check it and try again.",
    );
  }
  return token;
}

async function getYostarToken(email, emailToken) {
  const data = await yostarplatPost("user/login", {
    CheckAccount: 0,
    Geetest: {},
    OpenID: email,
    Secret: "",
    Token: emailToken,
    Type: "yostar",
    UserName: email,
  });
  const userInfo = data?.Data?.UserInfo;
  const channelUid = userInfo?.ID;
  const accessToken = userInfo?.Token ?? data?.Data?.Token;
  if (!channelUid || !accessToken) {
    throw new StepError(
      "yostar login",
      data?.Message || data?.message || "Yostar login didn't return a usable session.",
    );
  }
  return { channelUid, accessToken };
}

async function loadNetworkConfig() {
  const resp = await fetch(NETWORK_CONFIG_URL);
  const raw = await parseJsonOrThrow(resp, "network config");
  // The config may arrive as a JSON string under "content" (the shape
  // arkprts reads) or already unwrapped, so handle either shape.
  const cfg = raw.configs ? raw : JSON.parse(raw.content);
  const network = cfg?.configs?.[cfg.funcVer]?.network;
  if (!network || !network.gs || !network.u8) {
    throw new StepError("network config", "Couldn't read Arknights' server routing config.");
  }
  return network;
}

async function loadVersionConfig() {
  const resp = await fetch(VERSION_CONFIG_URL);
  const data = await parseJsonOrThrow(resp, "version config");
  return {
    resVersion: data.resVersion || data.res || "1",
    clientVersion: data.clientVersion || CLIENT_VERSION_FALLBACK,
  };
}

async function getU8Token(u8Host, channelUid, accessToken, deviceIds) {
  const [deviceId, deviceId2, deviceId3] = deviceIds;
  const body = {
    appId: "1",
    platform: 1,
    channelId: "3",
    subChannel: "3",
    extension: JSON.stringify({ type: 1, uid: channelUid, token: accessToken }),
    deviceId,
    deviceId2,
    deviceId3,
  };
  const sign = await generateU8Sign(body);
  const resp = await fetch(`${u8Host}/user/v1/getToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, sign }),
  });
  const data = await parseJsonOrThrow(resp, "u8 token");
  const uid = data?.uid;
  const token = data?.token;
  if (!uid || !token) {
    throw new StepError("u8 token", data?.message || "Couldn't obtain a game session token.");
  }
  return { uid, token };
}

async function generateU8Sign(data) {
  const entries = Object.entries(data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = entries.map(([k, v]) => `${quotePlus(k)}=${quotePlus(String(v))}`).join("&");
  return hmacSha1Hex(U8_SIGN_KEY, query);
}

async function getGameSecret(gsHost, uid, u8Token, versions, deviceIds) {
  const [deviceId, deviceId2, deviceId3] = deviceIds;
  const body = {
    platform: 1,
    networkVersion: "1",
    assetsVersion: versions.resVersion,
    clientVersion: versions.clientVersion,
    token: u8Token,
    uid,
    deviceId,
    deviceId2,
    deviceId3,
  };
  const resp = await fetch(`${gsHost}/account/login`, {
    method: "POST",
    headers: { secret: "", seqnum: "1", uid, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await parseJsonOrThrow(resp, "game session");
  const secret = data?.secret;
  if (!secret) {
    throw new StepError("game session", data?.message || "Couldn't start a game session.");
  }
  return secret;
}

// The four "Battle Record" items operators consume for EXP, with their
// EXP per unit (item ids from Penguin Stats, values from the wiki).
// fetchDepot() sums them into the single "EXP owned" total the planner
// reads under EXP_ITEM_ID ("5001"); the items also stay in the depot
// under their own ids.
const BATTLE_RECORD_EXP_VALUES = {
  "2001": 200, // Drill Battle Record
  "2002": 400, // Frontline Battle Record
  "2003": 1000, // Tactical Battle Record
  "2004": 2000, // Strategic Battle Record
};

async function getInventory(gsHost, uid, secret) {
  const resp = await fetch(`${gsHost}/account/syncData`, {
    method: "POST",
    headers: { secret, seqnum: "2", uid, "Content-Type": "application/json" },
    body: JSON.stringify({ platform: 1 }),
  });
  const data = await parseJsonOrThrow(resp, "sync data");
  // The full account state sits under "user" (alongside "result"/"ts"/
  // "playerDataDelta" at the top level), and "inventory" is a flat
  // itemId -> count map directly on it.
  const user = data?.user ?? data;
  if (!user || typeof user.inventory !== "object" || user.inventory == null) {
    throw new StepError("sync data", "Account data didn't include an inventory.");
  }
  return user;
}

// The owned-operator list, from the same /account/syncData response as
// the depot (getInventory() above): `user.troop.chars` is an
// { [instanceId]: { charId, ... } } map with one entry per owned
// operator -- the field arkprts and the box/depot viewers built on it
// read. `charId` is already in this site's "char_002_amiya" format, so
// this just collects and dedupes.
//
// The shape comes from other open-source implementations of this login
// flow, so it's read defensively. If it doesn't match, this returns null
// rather than an empty array, so the frontend can tell "couldn't read
// your roster" from an empty roster (impossible -- every account starts
// with several operators) and disable the owned/not-owned filter instead
// of greying out every operator.
function extractOwnedOperators(user) {
  const chars = user?.troop?.chars;
  if (!chars || typeof chars !== "object") return null;
  const ids = new Set();
  for (const entry of Object.values(chars)) {
    if (entry && typeof entry.charId === "string" && entry.charId) {
      ids.add(entry.charId);
    }
    forEachAmiyaTmpl(entry, (tmplCharId) => ids.add(tmplCharId));
  }
  return ids.size ? Array.from(ids) : null;
}

// Amiya is the one operator with swappable classes (base Caster, plus the
// Guard and Medic forms unlocked later in the story), and her forms don't
// get separate troop.chars entries. Her one entry's `charId` is whichever
// form is currently equipped; every form she has is in its `tmpl` field,
// a { [charId]: <that form's character data, same shape as the entry> }
// map (ArkPRTS: "Alternative operator class data. Only for Amiya.").
// Reading only entry.charId would leave the unequipped forms out of both
// the owned-operator list and the progress map, so both walk `tmpl` with
// this as well. A no-op for every other operator (no `tmpl` field).
function forEachAmiyaTmpl(entry, fn) {
  const tmpl = entry && entry.tmpl;
  if (!tmpl || typeof tmpl !== "object") return;
  for (const [key, data] of Object.entries(tmpl)) {
    const charId = (data && typeof data.charId === "string" && data.charId) || key;
    if (typeof charId === "string" && charId) fn(charId, data);
  }
}

// Per-operator progress (Elite phase, level, potential rank, skill levels
// and masteries, module stages, and which module is equipped) for the
// operator page's "Your stats" toggle, from one troop.chars entry or one
// of its Amiya tmpl sub-entries (same shape).
// The field names (evolvePhase, level, potentialRank, mainSkillLvl,
// skills[].specializeLevel, equip[uniEquipId].level, currentEquip) come
// from arkprts and haven't been checked against a real account's
// response; `skills` and `equip` are the likeliest to differ. Every field
// is type-checked and comes back null/omitted when it isn't the expected
// type, so a wrong guess makes that operator's "Your stats" view fall
// back to "Maxed" (js/operator-page.js) instead of showing a wrong number.
function buildOperatorProgress(entry) {
  return {
    evolvePhase: typeof entry.evolvePhase === "number" ? entry.evolvePhase : null,
    level: typeof entry.level === "number" ? entry.level : null,
    potentialRank: typeof entry.potentialRank === "number" ? entry.potentialRank : null,
    mainSkillLvl: typeof entry.mainSkillLvl === "number" ? entry.mainSkillLvl : null,
    skills: extractSkillProgress(entry.skills),
    modules: extractModuleProgress(entry.equip),
    currentEquip: typeof entry.currentEquip === "string" && entry.currentEquip ? entry.currentEquip : null,
  };
}

function extractOwnedOperatorProgress(user) {
  const chars = user?.troop?.chars;
  if (!chars || typeof chars !== "object") return null;
  const byChar = {};
  // Some community tools' notes mention accounts with more than one troop
  // entry for the same charId (unconfirmed). If that happens, keep the
  // highest-level one rather than the last one seen. Amiya's tmpl entries
  // go through the same rule.
  const consider = (charId, data) => {
    if (typeof charId !== "string" || !charId) return;
    const progress = buildOperatorProgress(data);
    const prev = byChar[charId];
    if (!prev || (progress.level || 0) > (prev.level || 0)) {
      byChar[charId] = progress;
    }
  };
  for (const entry of Object.values(chars)) {
    if (!entry || typeof entry.charId !== "string" || !entry.charId) continue;
    consider(entry.charId, entry);
    forEachAmiyaTmpl(entry, (tmplCharId, tmplData) => consider(tmplCharId, tmplData));
  }
  return Object.keys(byChar).length ? byChar : null;
}

function extractSkillProgress(skills) {
  if (!Array.isArray(skills)) return null;
  const out = skills.map((s) => ({
    skillId: s && typeof s.skillId === "string" ? s.skillId : null,
    specializeLevel: s && typeof s.specializeLevel === "number" ? s.specializeLevel : 0,
  }));
  return out.length ? out : null;
}

// Stage reached per module, keyed by uniEquipId -- a module with no
// progress at all (never unlocked) just doesn't get an entry, rather
// than an explicit 0, so the frontend's `progress.modules[id] || 0`
// lookup stays simple either way.
function extractModuleProgress(equip) {
  if (!equip || typeof equip !== "object") return null;
  const out = {};
  for (const [uniEquipId, info] of Object.entries(equip)) {
    if (info && typeof info.level === "number" && info.level > 0) {
      out[uniEquipId] = info.level;
    }
  }
  return Object.keys(out).length ? out : null;
}

// Obtained medals (achievements), for the /account overview page's medal
// progress section -- keyed by medalId against the full catalog it loads
// itself from medal_table.json.
//
// `user.medal.medals` (checked against a real synced account) is an
// object keyed by medalId, one entry per medal the game tracks for the
// account -- including ones not earned yet (e.g. progress toward a
// counter-based medal), so "present" doesn't mean "obtained":
//   { id: "medal_player_lv_01", fts: 1601399226, rts: -1, ... }
// `fts` is when the medal was first obtained (Unix seconds); an entry that
// hasn't been earned has no positive fts. (`rts` is a separate timestamp,
// -1 on most entries, and isn't needed here.) If no entry carries a
// numeric fts at all, the format isn't the expected one: return null,
// which the account page shows as "this sync didn't include medal data",
// rather than guess.
function extractObtainedMedals(user) {
  const medals = user?.medal?.medals;
  if (!medals || typeof medals !== "object") return null;

  const entries = Object.entries(medals);
  if (!entries.some(([, raw]) => raw && typeof raw.fts === "number")) return null;

  const out = {};
  for (const [key, raw] of entries) {
    if (!raw || typeof raw.fts !== "number" || raw.fts <= 0) continue;
    const id = typeof raw.id === "string" && raw.id ? raw.id : key;
    out[id] = { ts: raw.fts };
  }
  return Object.keys(out).length ? out : null;
}

// Owned skins (and when each was obtained), for the operator page's skin
// gallery "grey out owned" toggle, keyed by skinId -- the same ids as
// skin_table.json (e.g. "char_002_amiya#1"). In a real synced response,
// `user.skin.characterSkins` is a { [skinId]: owned } map and
// `user.skin.skinTs` a parallel { [skinId]: timestamp } map. ArkPRTS
// types the owned flag as a bool, but real responses use the number 1
// (the game encodes booleans that way elsewhere too), so this checks
// truthiness rather than `=== true`.
function extractOwnedSkins(user) {
  const owned = user?.skin?.characterSkins;
  if (!owned || typeof owned !== "object") return null;
  const ts = user?.skin?.skinTs;
  const out = {};
  for (const [skinId, isOwned] of Object.entries(owned)) {
    if (!isOwned) continue;
    if (typeof skinId !== "string" || !skinId) continue;
    out[skinId] = { ts: ts && typeof ts[skinId] === "number" ? ts[skinId] : null };
  }
  return Object.keys(out).length ? out : null;
}

// The depot the planner stores: itemId -> count, from the account's
// inventory plus the currencies and the EXP total described below.
export function buildDepot(user) {
  // LMD, Orundum and Originite Prime aren't part of "inventory": they're
  // currency fields on status, merged in under their item ids. Originite
  // Prime is tracked per platform; this logs in as an Android device, so
  // androidDiamond is what that client shows (iosDiamond as a fallback).
  const depot = { ...(user?.inventory || {}) };
  const status = user?.status || {};
  const currencies = {
    4001: status.gold, // LMD
    4003: status.diamondShard, // Orundum
    4002: typeof status.androidDiamond === "number" ? status.androidDiamond : status.iosDiamond, // Originite Prime
  };
  for (const [itemId, count] of Object.entries(currencies)) {
    if (typeof count === "number" && count > 0) depot[itemId] = count;
  }

  // Combine the four Battle Record card counts into the single "EXP
  // owned" total under EXP_ITEM_ID ("5001"), same convention as LMD
  // above. The individual cards are left in the depot too (under their
  // own real ids), so they still show up as their own rows.
  let expTotal = 0;
  for (const [itemId, expPerUnit] of Object.entries(BATTLE_RECORD_EXP_VALUES)) {
    const count = depot[itemId];
    if (typeof count === "number" && count > 0) expTotal += count * expPerUnit;
  }
  if (expTotal > 0) depot["5001"] = expTotal;
  return depot;
}

async function fetchDepot(email, code) {
  const emailToken = await submitEmailCode(email, code);
  const { channelUid, accessToken } = await getYostarToken(email, emailToken);

  const [network, versions] = await Promise.all([loadNetworkConfig(), loadVersionConfig()]);
  const deviceIds = await stableAndroidDeviceIds(email);

  const { uid, token: u8Token } = await getU8Token(network.u8, channelUid, accessToken, deviceIds);
  const secret = await getGameSecret(network.gs, uid, u8Token, versions, deviceIds);
  const user = await getInventory(network.gs, uid, secret);

  const depot = buildDepot(user);

  return {
    depot,
    nickname: user?.status?.nickName ?? user?.status?.nickname ?? null,
    level: user?.status?.level ?? null,
    ownedOperators: extractOwnedOperators(user),
    ownedOperatorProgress: extractOwnedOperatorProgress(user),
    obtainedMedals: extractObtainedMedals(user),
    ownedSkins: extractOwnedSkins(user),
  };
}
