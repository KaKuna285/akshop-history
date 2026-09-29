// Cloudflare Worker: one-shot Arknights (EN/Yostar) account -> depot import
// for the Operator Planner (/planner/). Given an account email and the
// one-time code Yostar emails to it, this logs in exactly the way the
// mobile client does, pulls the account's current item inventory once, and
// returns it. Nothing about the account is kept anywhere afterwards.
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
//     inventory exist only in memory for the lifetime of a single request.
//     This Worker has no KV/D1/Durable Object bindings at all, so there is
//     nowhere for any of it to persist even by accident -- writing it down
//     anywhere would take a deploy, not just a bug. Cloudflare's own
//     request logs (visible on the dashboard, if enabled) can still show
//     metadata like the caller's IP and timestamp; nothing below logs the
//     email, code, session secret, or inventory contents themselves.
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
// for the login flow -- these only need to look plausible and be internally
// consistent within one request, not match a real device.
function randomAndroidDeviceIds() {
  const digits = "0123456789";
  let id2 = "86";
  for (let i = 0; i < 13; i++) id2 += digits[Math.floor(Math.random() * 10)];
  return [crypto.randomUUID().replace(/-/g, ""), id2, crypto.randomUUID().replace(/-/g, "")];
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

async function getInventory(gsHost, uid, secret) {
  const resp = await fetch(`${gsHost}/account/syncData`, {
    method: "POST",
    headers: { secret, seqnum: "2", uid, "Content-Type": "application/json" },
    body: JSON.stringify({ platform: 1 }),
  });
  const data = await parseJsonOrThrow(resp, "sync data");
  const user = data?.user ?? data;
  if (!user || typeof user.inventory !== "object" || user.inventory == null) {
    throw new StepError("sync data", "Account data didn't include an inventory.");
  }
  return user;
}

async function fetchDepot(email, code) {
  const emailToken = await submitEmailCode(email, code);
  const { channelUid, accessToken } = await getYostarToken(email, emailToken);

  const [network, versions] = await Promise.all([loadNetworkConfig(), loadVersionConfig()]);
  const deviceIds = randomAndroidDeviceIds();

  const { uid, token: u8Token } = await getU8Token(network.u8, channelUid, accessToken, deviceIds);
  const secret = await getGameSecret(network.gs, uid, u8Token, versions, deviceIds);
  const user = await getInventory(network.gs, uid, secret);

  return {
    depot: user.inventory,
    nickname: user?.status?.nickName ?? user?.status?.nickname ?? null,
    level: user?.status?.level ?? null,
  };
}
