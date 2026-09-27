// =======================
// Yostar email login
// =======================

const YOSTAR_DOMAINS = {
  en_US: "https://en-sdk-api.yostarplat.com",
  ja_JP: "https://jp-sdk-api.yostarplat.com",
  ko_KR: "https://jp-sdk-api.yostarplat.com",
};

const SERVER_MAP = {
  en_US: "https://account.yo-star.com",
  ja_JP: "https://account.yostar.co.jp",
  ko_KR: "https://account.yostar.kr",
};

const U8_CHANNEL_ID = {
  en: "3",
  jp: "3",
  kr: "3",
};

// -----------------------
// crypto helpers
// -----------------------

const te = new TextEncoder();
function md5cycle(x, k) {
  var a = x[0],
    b = x[1],
    c = x[2],
    d = x[3];

  a = ff(a, b, c, d, k[0], 7, -680876936);
  d = ff(d, a, b, c, k[1], 12, -389564586);
  c = ff(c, d, a, b, k[2], 17, 606105819);
  b = ff(b, c, d, a, k[3], 22, -1044525330);
  a = ff(a, b, c, d, k[4], 7, -176418897);
  d = ff(d, a, b, c, k[5], 12, 1200080426);
  c = ff(c, d, a, b, k[6], 17, -1473231341);
  b = ff(b, c, d, a, k[7], 22, -45705983);
  a = ff(a, b, c, d, k[8], 7, 1770035416);
  d = ff(d, a, b, c, k[9], 12, -1958414417);
  c = ff(c, d, a, b, k[10], 17, -42063);
  b = ff(b, c, d, a, k[11], 22, -1990404162);
  a = ff(a, b, c, d, k[12], 7, 1804603682);
  d = ff(d, a, b, c, k[13], 12, -40341101);
  c = ff(c, d, a, b, k[14], 17, -1502002290);
  b = ff(b, c, d, a, k[15], 22, 1236535329);

  a = gg(a, b, c, d, k[1], 5, -165796510);
  d = gg(d, a, b, c, k[6], 9, -1069501632);
  c = gg(c, d, a, b, k[11], 14, 643717713);
  b = gg(b, c, d, a, k[0], 20, -373897302);
  a = gg(a, b, c, d, k[5], 5, -701558691);
  d = gg(d, a, b, c, k[10], 9, 38016083);
  c = gg(c, d, a, b, k[15], 14, -660478335);
  b = gg(b, c, d, a, k[4], 20, -405537848);
  a = gg(a, b, c, d, k[9], 5, 568446438);
  d = gg(d, a, b, c, k[14], 9, -1019803690);
  c = gg(c, d, a, b, k[3], 14, -187363961);
  b = gg(b, c, d, a, k[8], 20, 1163531501);
  a = gg(a, b, c, d, k[13], 5, -1444681467);
  d = gg(d, a, b, c, k[2], 9, -51403784);
  c = gg(c, d, a, b, k[7], 14, 1735328473);
  b = gg(b, c, d, a, k[12], 20, -1926607734);

  a = hh(a, b, c, d, k[5], 4, -378558);
  d = hh(d, a, b, c, k[8], 11, -2022574463);
  c = hh(c, d, a, b, k[11], 16, 1839030562);
  b = hh(b, c, d, a, k[14], 23, -35309556);
  a = hh(a, b, c, d, k[1], 4, -1530992060);
  d = hh(d, a, b, c, k[4], 11, 1272893353);
  c = hh(c, d, a, b, k[7], 16, -155497632);
  b = hh(b, c, d, a, k[10], 23, -1094730640);
  a = hh(a, b, c, d, k[13], 4, 681279174);
  d = hh(d, a, b, c, k[0], 11, -358537222);
  c = hh(c, d, a, b, k[3], 16, -722521979);
  b = hh(b, c, d, a, k[6], 23, 76029189);
  a = hh(a, b, c, d, k[9], 4, -640364487);
  d = hh(d, a, b, c, k[12], 11, -421815835);
  c = hh(c, d, a, b, k[15], 16, 530742520);
  b = hh(b, c, d, a, k[2], 23, -995338651);

  a = ii(a, b, c, d, k[0], 6, -198630844);
  d = ii(d, a, b, c, k[7], 10, 1126891415);
  c = ii(c, d, a, b, k[14], 15, -1416354905);
  b = ii(b, c, d, a, k[5], 21, -57434055);
  a = ii(a, b, c, d, k[12], 6, 1700485571);
  d = ii(d, a, b, c, k[3], 10, -1894986606);
  c = ii(c, d, a, b, k[10], 15, -1051523);
  b = ii(b, c, d, a, k[1], 21, -2054922799);
  a = ii(a, b, c, d, k[8], 6, 1873313359);
  d = ii(d, a, b, c, k[15], 10, -30611744);
  c = ii(c, d, a, b, k[6], 15, -1560198380);
  b = ii(b, c, d, a, k[13], 21, 1309151649);
  a = ii(a, b, c, d, k[4], 6, -145523070);
  d = ii(d, a, b, c, k[11], 10, -1120210379);
  c = ii(c, d, a, b, k[2], 15, 718787259);
  b = ii(b, c, d, a, k[9], 21, -343485551);

  x[0] = add32(a, x[0]);
  x[1] = add32(b, x[1]);
  x[2] = add32(c, x[2]);
  x[3] = add32(d, x[3]);
}

function cmn(q, a, b, x, s, t) {
  a = add32(add32(a, q), add32(x, t));
  return add32((a << s) | (a >>> (32 - s)), b);
}

function ff(a, b, c, d, x, s, t) {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}

function gg(a, b, c, d, x, s, t) {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}

function md51(s) {
  var n = s.length,
    state = [1732584193, -271733879, -1732584194, 271733878],
    i;
  for (i = 64; i <= s.length; i += 64) {
    md5cycle(state, md5blk(s.substring(i - 64, i)));
  }
  s = s.substring(i - 64);
  var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (i = 0; i < s.length; i++)
    tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) {
    md5cycle(state, tail);
    for (i = 0; i < 16; i++) tail[i] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return state;
}

/* there needs to be support for Unicode here,
 * unless we pretend that we can redefine the MD-5
 * algorithm for multi-byte characters (perhaps
 * by adding every four 16-bit characters and
 * shortening the sum to 32 bits). Otherwise
 * I suggest performing MD-5 as if every character
 * was two bytes--e.g., 0040 0025 = @%--but then
 * how will an ordinary MD-5 sum be matched?
 * There is no way to standardize text to something
 * like UTF-8 before transformation; speed cost is
 * utterly prohibitive. The JavaScript standard
 * itself needs to look at this: it should start
 * providing access to strings as preformed UTF-8
 * 8-bit unsigned value arrays.
 */
function md5blk(s) {
  /* I figured global was faster.   */
  var md5blks = [],
    i; /* Andy King said do it this way. */
  for (i = 0; i < 64; i += 4) {
    md5blks[i >> 2] =
      s.charCodeAt(i) +
      (s.charCodeAt(i + 1) << 8) +
      (s.charCodeAt(i + 2) << 16) +
      (s.charCodeAt(i + 3) << 24);
  }
  return md5blks;
}

var hex_chr = "0123456789abcdef".split("");

function rhex(n) {
  var s = "",
    j = 0;
  for (; j < 4; j++)
    s += hex_chr[(n >> (j * 8 + 4)) & 0x0f] + hex_chr[(n >> (j * 8)) & 0x0f];
  return s;
}

function hex(x) {
  for (var i = 0; i < x.length; i++) x[i] = rhex(x[i]);
  return x.join("");
}

function md5Hex(s) {
  return hex(md51(s));
}

/* this function is much faster,
so if possible we use it. Some IEs
are the only ones I know of that
need the idiotic second function,
generated by an if clause.  */

function add32(a, b) {
  return (a + b) & 0xffffffff;
}

if (md5Hex("hello") != "5d41402abc4b2a76b9719d911017c592") {
  function add32(x, y) {
    var lsw = (x & 0xffff) + (y & 0xffff),
      msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
}

async function hmacSha1Hex(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    te.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, te.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// -----------------------
// yostar headers
// -----------------------
async function generateYostarHeaders(
  body,
  {
    server = "en_US",
    uid = "",
    token = "",
    deviceId = crypto.randomUUID(),
  } = {},
) {
  const head = {
    PID:
      server === "en_US"
        ? "US-ARKNIGHTS"
        : server === "ja_JP"
          ? "JP-AK"
          : "KR-ARKNIGHTS",
    Channel: "googleplay",
    Platform: "android",
    Version: "4.10.0",
    GVersionNo: "2000112",
    GBuildNo: "",
    Lang: server === "en_US" ? "en_US" : server === "ja_JP" ? "ja_JP" : "ko_KR",
    DeviceID: deviceId,
    DeviceModel: "F9",
    UID: uid || "",
    Token: token || "",
    Time: Math.floor(Date.now() / 1000),
  };

  // No sorting, just stringify as-is
  const sign = (
    await md5Hex(
      JSON.stringify(head) + body + "886c085e4a8d30a703367b120dd8353948405ec2",
    )
  ).toUpperCase();

  return {
    "Content-Type": "application/json",
    "X-Unity-Version": "2017.4.39f1",
    "User-Agent":
      "Dalvik/2.1.0 (Linux; U; Android 11; KB2000 Build/RP1A.201005.001)",
    Connection: "Keep-Alive",
    Authorization: JSON.stringify({ Head: head, Sign: sign }),
  };

  // return {
  //   "Content-Type": "application/json",
  //   Authorization: JSON.stringify({ Head: head, Sign: sign }),
  // };
}

// -----------------------
// request wrapper
// -----------------------

async function yostarRequest(server, endpoint, body, deviceId) {
  const bodyStr = JSON.stringify(body, null, 0);
  const headers = await generateYostarHeaders(bodyStr, { server, deviceId });
  console.log("ys req for", `${SERVER_MAP[server]}/${endpoint}`);
  console.log("content:", bodyStr);
  const res = await fetch(`${YOSTAR_DOMAINS[server]}/${endpoint}`, {
    method: "POST",
    headers,
    body: bodyStr,
  });

  const data = await res.json();
  if (data.Code !== 200) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

// -----------------------
// email auth flow
// -----------------------

export async function sendEmailCode(server, email, deviceIds) {
  await yostarRequest(
    server,
    "yostar/send-code",
    { Account: email, Randstr: "", Ticket: "" },
    deviceIds[0], // DeviceID must match the first deviceId
  );
}

async function submitEmailCode(server, email, code, deviceIds) {
  const data = await yostarRequest(
    server,
    "yostar/get-auth",
    {
      Account: email,
      Code: code,
    },
    deviceIds[0], // same DeviceID as sendEmailCode
  );
  return data.Data.Token;
}

async function getYostarCookies(server, email, emailToken) {
  const body = {
    channel: "yostar",
    token: emailToken,
    openId: email,
    account: email,
    checkAccount: false,
  };
  const bodyStr = JSON.stringify(body, null, 0);

  const headers = await generateYostarHeaders(bodyStr, { server });

  const res = await fetch(`${SERVER_MAP[server]}/api/user/login`, {
    method: "POST",
    headers,
    body: bodyStr,
  });

  // Get all Set-Cookie headers
  const rawHeaders = [...res.headers.entries()];
  const setCookie = rawHeaders
    .filter(([key]) => key.toLowerCase() === "set-cookie")
    .map(([_, val]) => val);

  const cookies = {};
  for (const c of setCookie) {
    const [kv] = c.split(";", 1);
    const [k, ...rest] = kv.split("=");
    cookies[k] = rest.join("=");
  }

  const data = await res.json();

  return { data, cookies };
}
async function fetchWithYostarCookies(server, url, cookies, usePOST = false) {
  // Build cookie header
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  const headers = {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.7",
    "Cache-Control": "max-age=0",
    Connection: "keep-alive",
    Cookie: cookieHeader,
    Host: new URL(url).host,
    Referer: `${SERVER_MAP[server]}/`,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-GPC": "1",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Brave";v="144"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };

  const res = await fetch(url, {
    method: usePOST ? "POST" : "GET", // change to POST if needed
    headers,
  });

  const contentType = res.headers.get("content-type");
  let data;
  if (contentType && contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return data;
}

// -----------------------
// u8 + game login
// -----------------------

function createDeviceIds() {
  // Generate a random 32-character hex string (UUID without hyphens)
  function uuidHex() {
    return crypto.randomUUID().replace(/-/g, "");
  }

  // Generate deviceid2: "86" + 13 random digits
  const deviceid2 =
    "86" +
    Math.floor(Math.random() * 1e13)
      .toString()
      .padStart(13, "0");

  return [uuidHex(), deviceid2, uuidHex()];
}

export default {
  async fetch(request, env, ctx) {
    // ---------- Handle CORS preflight ----------
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("POST only", { status: 405 });
    }

    try {
      const body = await request.json();
      const server = body.server;
      const email = body.email;
      const code = body.code;
      const YSSID = body.YSSID; // optional cookie
      const YSSID_sig = body.YSSID_sig; // optional cookie

      console.log("=== WORKER DEBUG START ===");
      console.log("Request body:", { email, code, YSSID, YSSID_sig });

      let cookies = {};

      // --------- Workflow 3: Use provided cookies directly ---------
      if (YSSID && YSSID_sig) {
        console.log("Using provided YSSID and YSSID.sig, skipping login...");
        cookies["YSSID"] = decodeURIComponent(YSSID);
        cookies["YSSID.sig"] = decodeURIComponent(YSSID_sig);

        if (body.logout) {
          console.log("Processing logout request...");

          const logoutUrl = `${SERVER_MAP[server]}/api/user/logout`;
          console.log("logging out via", logoutUrl);
          const logoutResult = await fetchWithYostarCookies(
            server,
            logoutUrl,
            cookies,
            true, // POST
          );

          console.log("Logout response:", logoutResult);
          if (logoutResult.message === "ok" && logoutResult.code === 0) {
            return new Response(
              JSON.stringify({
                status: 200,
                result: logoutResult,
              }),
              {
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          } else {
            return new Response(
              JSON.stringify({
                status: 500,
                result: logoutResult,
              }),
              {
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }
        }
      } else {
        // --------- Workflows 1 & 2: Email/code login ---------
        if (!email) {
          console.log("Missing email parameter");
          return new Response(
            JSON.stringify({ error: "Missing email parameter" }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }

        const deviceIds = createDeviceIds();
        console.log("Generated deviceIds:", deviceIds);

        // Workflow 1: send email code
        if (!code) {
          console.log("No code provided, sending email code...");
          await sendEmailCode(server, email, deviceIds);
          console.log("Email code sent successfully");
          return new Response(JSON.stringify({ status: "CODE_SENT" }), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // Workflow 2: email + code => fetch Yostar cookies
        console.log("Code provided, submitting email code...");
        const emailToken = await submitEmailCode(
          server,
          email,
          code,
          deviceIds,
        );
        console.log("Received emailToken:", emailToken);

        console.log("Fetching Yostar cookies...");
        const loginResult = await getYostarCookies(server, email, emailToken);
        cookies = loginResult.cookies;
        console.log("Yostar login data:", loginResult.data);
        console.log("Yostar cookies:", cookies);

        // Return cookies directly for workflow 2
        return new Response(
          JSON.stringify({ cookies, data: loginResult.data }),
          {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      // --------- Workflow 3 (or future fetch using cookies) ---------
      const fetchUrl = `${SERVER_MAP[server]}/api/game/gachas?key=ark&index=1&size=9999`;
      console.log("Fetching game history from:", fetchUrl);
      const pulls = await fetchWithYostarCookies(server, fetchUrl, cookies);

      console.log("Game pulls response:", pulls);
      console.log("=== WORKER DEBUG END ===");

      return new Response(JSON.stringify({ pulls, cookies }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (e) {
      console.error("=== WORKER ERROR ===");
      console.error(e);
      return new Response(
        JSON.stringify({ error: e.message || String(e), stack: e.stack }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
  },
};
