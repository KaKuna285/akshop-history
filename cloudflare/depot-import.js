// Cloudflare Worker: one-shot Arknights (EN/Yostar) account sync, used by
// the home page's "Sync your Arknights account" section (js/account-sync.js)
// and, downstream, the Operator Planner (/planner/), the owned/not-owned
// filter and "Your stats" toggle on the operator browser (/operator/), and
// the medal progress section on the account overview page (/account/).
// Given an account email and the one-time code Yostar emails to it, this
// logs in exactly the way the mobile client does, reads the account's
// current item inventory, operator roster (including each owned
// operator's own progress), and obtained medals once, and returns them.
// Nothing about the account is kept anywhere afterwards.
//
// This is an independent JavaScript implementation of the login/session
// protocol documented by the ArkPRTS project
// (https://github.com/thesadru/arkprts, GPLv3) -- endpoints, field names,
// and the request-signing schemes below were worked out by reading that
// project's source, but every line here was written fresh for the Workers
// runtime rather than translated from its Python, so this file carries
// this repo's own MIT license rather than arkprts's GPLv3. If Yostar ever
// changes this protocol, arkprts is the first place to check for an
// updated version of it.
//
// What this Worker does, and deliberately doesn't, do:
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
//     integration -- see the Operator Planner's import UI for the
//     disclosure shown to whoever uses it.
//
// Setup (Cloudflare dashboard, no Wrangler/npm needed -- same pattern as
// this repo's other standalone Worker, cloudflare/dispatch-cron.js):
//   1. Workers & Pages -> Create -> Create Worker -> name it (e.g.
//      "akshop-depot-import") -> Deploy -> Edit code -> paste this file's
//      contents in over the default template -> Save and deploy.
//   2. Settings -> Variables and Secrets -> add:
//        ALLOWED_ORIGIN - the origin the planner is served from, e.g.
//                         "https://ak.athansson.com". Requests from any
//                         other Origin header are rejected. A request
//                         whose Origin starts with "http://localhost" or
//                         "http://127.0.0.1" is always allowed too, for
//                         local testing.
//     There's no access-key secret here on purpose: this file is served
//     to anyone who views the planner's page source, so anything baked in
//     there isn't actually secret. Instead, the planner's import UI asks
//     for an access key at use time (see js/planner.js) and sends it as
//     the "X-Access-Key" header -- set ACCESS_KEY_HASH below to gate on
//     that instead, if you want this endpoint to require one.
//        ACCESS_KEY_HASH - OPTIONAL. If set, requests must include a
//                         "X-Access-Key" header whose SHA-256 hex digest
//                         matches this value, or they're rejected before
//                         anything else happens. Leave unset to disable
//                         this check entirely (fine for a private tool
//                         behind an unlisted *.workers.dev URL; add it if
//                         you want a second gate). Generate one with:
//                           echo -n 'your-chosen-key' | sha256sum
//   3. Point js/planner.js's DEPOT_IMPORT_ENDPOINT (in js/config.js) at
//      this Worker's URL (its default *.workers.dev URL is fine, or a
//      Custom Domain under Settings -> Triggers if you set one up).

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
        await sendEmailCode(email);
        return json({ ok: true }, 200, cors);
      }
      if (url.pathname === "/fetch-depot") {
        const { email, code } = await safeJson(request);
        requireEmail(email);
        if (!code || typeof code !== "string") {
          throw new StepError("validate code", "Enter the code Yostar emailed you.");
        }
        const result = await fetchDepot(email, code);
        return json(result, 200, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      const step = err instanceof StepError ? err.step : "unknown";
      const message = err instanceof Error ? err.message : String(err);
      // Deliberately no email/code/token/secret/inventory in this log line.
      console.log(`depot-import failed at step "${step}": ${message}`);
      return json({ error: message, step }, 502, cors);
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

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
    return true;
  }
  return !!env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN;
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

// RFC 1321 MD5, verified against Python's hashlib.md5 across boundary-length
// inputs (55/56/63/64/65 bytes, 1000 bytes, empty string) before being
// wired into the signing logic below -- see the project's dev notes if
// this ever needs re-checking.
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
  // arkprts's own generic HTTP wrapper nests the real payload as a string
  // under "content"; the endpoint's own JSON may or may not already be
  // unwrapped depending on how it's fronted, so handle either shape.
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

// The four "Battle Record" cards operators consume for EXP -- confirmed
// against Penguin Stats' item list (real itemIds) and the wiki's stated
// per-unit EXP values. These are genuine, separately-tracked inventory
// items in their own right (they'll also appear under their own ids in
// the returned depot), used here only to compute the single combined
// "EXP owned" total the planner already expects under EXP_ITEM_ID "5001"
// -- the same aggregate a user would otherwise work out by hand and type
// in themselves.
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

// The same /account/syncData response already fetched for the depot
// (see getInventory() above) carries the player's actual operator
// roster too, under `user.troop.chars` -- an { [instanceId]: { charId,
// ... }, ... } map, one entry per operator the account owns. This is
// the same field essentially every other community Arknights tool
// (arkprts and the various box/depot viewers built on it) reads for
// "what operators does this account have", and `charId` there is
// already in the exact "char_002_amiya"-style format this site uses
// everywhere else -- no name mapping needed, just collect and dedupe.
//
// Defensive, more so than the inventory/status fields above: this
// field's shape has only been confirmed by reading other open-source
// implementations of this same login flow, not by a live response
// captured specifically for this Worker. If a real response doesn't
// have `troop.chars` in this shape, this returns null -- not an empty
// array -- so the frontend can tell "couldn't read your roster" apart
// from "this account genuinely owns zero operators" (which shouldn't
// be possible; every account starts with several) and skip greying out
// every single operator on a bad guess instead of just disabling the
// owned/not-owned filter until this gets sorted out.
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

// Amiya is the one operator in the game with swappable alternate classes
// (base Caster, plus the Guard and Medic forms unlocked later in the
// story) -- confirmed live (see the account overview's own "Amiya's
// alternate forms aren't tracked" report) this does NOT show up as three
// separate troop.chars entries the way every other operator's roster
// data does. Confirmed instead, by reading the ArkPRTS reference
// implementation's own data model (this file's own header comment above
// explains why that's the reference here): a troop.chars entry has a
// `tmpl` field, a map of { [charId]: <that form's own full character
// data -- charId/level/evolvePhase/skills/equip/etc, same shape as the
// entry itself> }, documented there as "Alternative operator class data.
// Only for Amiya." The outer entry's own `charId` is whichever form is
// CURRENTLY ACTIVE/equipped (base Caster, for most accounts, since
// that's the default) -- so reading only entry.charId, as both functions
// below used to, silently drops whichever form(s) aren't currently
// equipped: not undercounted, not miscategorized, just entirely absent
// from both the owned-operator list and the per-operator progress map,
// no matter how much real progress that account has on them. This walks
// `tmpl` alongside the entry itself so every owned form is counted, not
// just the active one. Harmless/a no-op for every other operator, whose
// entries have no `tmpl` field at all.
function forEachAmiyaTmpl(entry, fn) {
  const tmpl = entry && entry.tmpl;
  if (!tmpl || typeof tmpl !== "object") return;
  for (const [key, data] of Object.entries(tmpl)) {
    const charId = (data && typeof data.charId === "string" && data.charId) || key;
    if (typeof charId === "string" && charId) fn(charId, data);
  }
}

// Per-operator progress (Elite phase, level, potential rank, skill levels
// and masteries, module stages, and which module is currently equipped),
// for the operator page's "Your stats" toggle -- a further read of the
// exact same `troop.chars` entries extractOwnedOperators() above already
// walks for the owned/not-owned filter. Field names here (evolvePhase,
// level, potentialRank, mainSkillLvl, skills[].specializeLevel,
// equip[uniEquipId].level, currentEquip) come from the same arkprts-
// derived reading of this protocol as the rest of this file (see the
// header comment), but -- even more so than extractOwnedOperators()'s own
// charId-only read -- this has NOT been checked against a real account's
// actual response: a real `troop.chars` entry carries a lot more fields
// than either function reads, and the shapes of `skills`/`equip`
// specifically are the ones most likely to have shifted since arkprts'
// own notes on them were written. Every field below is read
// defensively and just comes back null/omitted if it's not the type
// expected, so a wrong guess here means a particular operator's "Your
// stats" view falls back to "Maxed" (see js/operator-page.js) rather
// than showing a wrong number -- never throws, and never guesses a
// plausible-looking value for a field that isn't actually there.
// Shared by extractOwnedOperatorProgress() below for both a top-level
// troop.chars entry and one of its Amiya tmpl sub-entries (see
// forEachAmiyaTmpl()'s comment above) -- both are the same shape.
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
  // A handful of community tools' own notes mention accounts that can end
  // up with more than one troop entry for the same charId (e.g. a
  // recruited-then-recalled slot); not confirmed to actually happen, but
  // guarded for anyway -- keep whichever looks the most invested-in
  // rather than just whichever was last in iteration order. Shared here
  // so a tmpl-derived entry (see forEachAmiyaTmpl()) is deduped against a
  // same-charId entry found any other way by the exact same rule.
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
// Shape of `user.medal.medals`, confirmed against a real synced account's
// raw response: an object keyed by medalId, one entry per medal the game
// tracks for the account -- including ones not earned yet (e.g. progress
// toward a counter-based medal), which is why "present" doesn't mean
// "obtained":
//   { id: "medal_player_lv_01", fts: 1601399226, rts: -1, ... }
// `fts` is when the medal was first obtained (Unix seconds); an entry that
// hasn't been earned has no positive fts. (`rts` is a separate timestamp,
// -1 on most entries, and isn't needed here.) If no entry carries a
// numeric fts at all, the format has changed: return null, which the
// account page shows as "this sync didn't include medal data", rather
// than guess.
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
// gallery "grey out owned" toggle -- keyed by skinId against the per-
// operator skins listed in skin_table.json (the frontend side of that
// match is already solid: skin_table.json's own skinId values, e.g.
// "char_002_amiya#1", are exactly what a real account's ownership map
// uses too). The top-level shape here was right on the first guess
// (ArkPRTS's reference model: `user.skin.characterSkins` as a
// `{ [skinId]: ... }` ownership map, `user.skin.skinTs` as a parallel
// `{ [skinId]: timestamp }` obtained-time map) -- confirmed via a real
// account's own synced response. What was wrong was the *value* type:
// ArkPRTS's own `Mapping[str, bool]` typing implied a literal `true`,
// but a real response's characterSkins entries are the *number* 1 (this
// game's own JSON encoding for booleans elsewhere too) -- a strict
// `=== true` check silently treated every single owned skin as
// unowned. Plain truthiness below covers both that real shape and a
// literal `true`, while still correctly skipping a falsy (0/false)
// entry if one ever does show up.
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

async function fetchDepot(email, code) {
  const emailToken = await submitEmailCode(email, code);
  const { channelUid, accessToken } = await getYostarToken(email, emailToken);

  const [network, versions] = await Promise.all([loadNetworkConfig(), loadVersionConfig()]);
  const deviceIds = await stableAndroidDeviceIds(email);

  const { uid, token: u8Token } = await getU8Token(network.u8, channelUid, accessToken, deviceIds);
  const secret = await getGameSecret(network.gs, uid, u8Token, versions, deviceIds);
  const user = await getInventory(network.gs, uid, secret);

  // LMD isn't part of "inventory" at all -- it's tracked as its own
  // currency field, status.gold -- so it's merged in here under the same
  // itemId ("4001") the planner already uses for LMD everywhere else,
  // rather than silently always coming back missing from an import.
  const depot = { ...user.inventory };
  if (typeof user?.status?.gold === "number" && user.status.gold > 0) {
    depot["4001"] = user.status.gold;
  }

  // Combine the four Battle Record card counts into the single "EXP
  // owned" total under EXP_ITEM_ID ("5001"), same convention as LMD
  // above. The individual cards are left in the depot too (under their
  // own real ids), so they still show up as their own rows.
  let expTotal = 0;
  for (const [itemId, expPerUnit] of Object.entries(BATTLE_RECORD_EXP_VALUES)) {
    const count = user.inventory[itemId];
    if (typeof count === "number" && count > 0) expTotal += count * expPerUnit;
  }
  if (expTotal > 0) depot["5001"] = expTotal;

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
