// Cloudflare Worker: fires the "Update banner history" GitHub Actions
// workflow once a day via the GitHub API, so the daily schedule lives on
// Cloudflare instead of depending on GitHub's own `schedule:` trigger
// (which GitHub auto-disables after 60 days of no repo activity).
//
// Deployed automatically: this folder's wrangler.jsonc (name, schedule)
// plus Cloudflare's Workers Builds, connected to this repo with root
// directory cloudflare/dispatch-cron -- a push that changes this folder
// redeploys the Worker; nothing to paste into the dashboard. See the
// README's "Deploying the Cloudflare Workers" section.
//
// One-time setup (Cloudflare dashboard):
//   1. The Worker itself ("akshop-history-cron") and its Git connection --
//      see the README section above.
//   2. Settings -> Variables and Secrets -> add two secrets:
//        GITHUB_PAT   - a GitHub fine-grained personal access token,
//                       scoped ONLY to the akshop-history repo, with
//                       "Actions: Read and write" repository permission
//                       (nothing else). Create it at
//                       github.com/settings/tokens?type=beta
//        TRIGGER_KEY  - any long random string (e.g. `openssl rand -hex
//                       24`), used only to gate the manual test route
//                       below. Never commit it.
//   3. The daily schedule ("0 7 * * *", 07:00 UTC) is in wrangler.jsonc's
//      triggers.crons -- edit it there, not in the dashboard (a deploy
//      replaces the dashboard's cron triggers with the config's).
//   4. Test it once: visit
//        https://<your-worker>.<your-subdomain>.workers.dev/trigger?key=<TRIGGER_KEY>
//      in a browser. It should show "OK: dispatched", and a new run
//      should appear in the repo's Actions tab within a few seconds.

const OWNER = "KaKuna285";
const REPO = "akshop-history";
const WORKFLOW_FILE = "banner_history_update.yml";
// A failed dispatch is retried after these waits (GitHub's API has brief
// hiccups); after the last one the scheduled run fails.
const RETRY_DELAYS_MS = [30_000, 120_000];

export default {
  // Fires on the cron schedule in wrangler.jsonc. A dispatch that still
  // fails after the retries throws, so the run shows as failed under the
  // Worker's Cron Events / logs in the dashboard instead of looking fine
  // while the daily update quietly stops. (The site's footer also warns
  // once the data is over a day and a half old -- js/data-health.js.)
  async scheduled(event, env, ctx) {
    let result = await dispatchWorkflow(env);
    for (const delay of RETRY_DELAYS_MS) {
      if (result.ok || !result.retryable) break;
      await new Promise((r) => setTimeout(r, delay));
      result = await dispatchWorkflow(env);
    }
    if (!result.ok) throw new Error(`Daily workflow dispatch failed: ${result.body}`);
  },

  // A manual "/trigger?key=..." route for testing without waiting for
  // the next scheduled fire. Gated by TRIGGER_KEY so this Worker's public
  // URL can't be used by a stranger to spam the GitHub Action.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      if (!(await keyMatches(url.searchParams.get("key"), env.TRIGGER_KEY))) {
        return new Response("Forbidden", { status: 403 });
      }
      const result = await dispatchWorkflow(env);
      return new Response(result.body, { status: result.ok ? 200 : 502 });
    }
    return new Response("akshop-history cron worker is running", {
      status: 200,
    });
  },
};

// Constant-time comparison, so response timing doesn't leak how much of a
// guessed key was right.
async function keyMatches(given, expected) {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function dispatchWorkflow(env) {
  if (!env.GITHUB_PAT) return { ok: false, retryable: false, body: "GITHUB_PAT secret is not set" };
  let resp;
  try {
    resp = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_PAT}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "akshop-history-cron-worker",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );
  } catch (err) {
    console.log(`dispatch failed: ${err.message}`);
    return { ok: false, retryable: true, body: `ERROR: ${err.message}` };
  }
  if (resp.status === 204) {
    return { ok: true, body: "OK: dispatched" };
  }
  const text = await resp.text();
  console.log(`dispatch failed: ${resp.status} ${text}`);
  // 401/403/404 mean a bad, expired or under-scoped token (or a renamed
  // workflow) -- retrying won't help. Rate limits and 5xx might.
  const retryable = resp.status === 429 || resp.status >= 500;
  return { ok: false, retryable, body: `ERROR ${resp.status}: ${text}` };
}
