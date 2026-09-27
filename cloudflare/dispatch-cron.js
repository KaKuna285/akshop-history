// Cloudflare Worker: fires the "Update banner history" GitHub Actions
// workflow once a day via the GitHub API, so the daily schedule lives on
// Cloudflare instead of depending on GitHub's own `schedule:` trigger
// (which GitHub auto-disables after 60 days of no repo activity).
//
// Setup (all in the Cloudflare dashboard, no Wrangler/npm needed):
//   1. Workers & Pages -> Create -> Create Worker -> name it (e.g.
//      "akshop-history-cron") -> Deploy -> Edit code -> paste this file's
//      contents in over the default template -> Save and deploy.
//   2. Settings -> Variables and Secrets -> add two secrets:
//        GITHUB_PAT   - a GitHub fine-grained personal access token,
//                       scoped ONLY to the akshop-history repo, with
//                       "Actions: Read and write" repository permission
//                       (nothing else). Create it at
//                       github.com/settings/tokens?type=beta
//        TRIGGER_KEY  - any random string, used only to gate the manual
//                       test route below (see README's "Hands-off
//                       forever" section for one already generated for
//                       you).
//   3. Settings -> Triggers -> Cron Triggers -> Add Cron Trigger ->
//      "0 7 * * *" (daily, 07:00 UTC -- matches this project's old
//      GitHub schedule; edit to taste, cron here is always UTC too).
//   4. Test it once: visit
//        https://<your-worker>.<your-subdomain>.workers.dev/trigger?key=<TRIGGER_KEY>
//      in a browser. It should show "OK: dispatched", and a new run
//      should appear in the repo's Actions tab within a few seconds.

const OWNER = "KaKuna285";
const REPO = "akshop-history";
const WORKFLOW_FILE = "banner_history_update.yml";

export default {
  // Fires on the Cron Trigger schedule configured in the dashboard.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchWorkflow(env));
  },

  // A manual "/trigger?key=..." route for testing without waiting for
  // the next scheduled fire. Gated by TRIGGER_KEY so this Worker's public
  // URL can't be used by a stranger to spam the GitHub Action.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      if (url.searchParams.get("key") !== env.TRIGGER_KEY) {
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

async function dispatchWorkflow(env) {
  const resp = await fetch(
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
    }
  );
  if (resp.status === 204) {
    return { ok: true, body: "OK: dispatched" };
  }
  const text = await resp.text();
  console.log(`dispatch failed: ${resp.status} ${text}`);
  return { ok: false, body: `ERROR ${resp.status}: ${text}` };
}
