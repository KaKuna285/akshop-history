// The "Updated X ago" line in a page's footer, plus a warning when the
// daily data update isn't healthy. Load after config.js (extraDataUrl()).
//
// Two things can go wrong with a scraper-fed site, and both look the same
// from the outside -- the page just quietly shows old or incomplete data:
//   - the update stopped running (the Cloudflare cron or GitHub is down), or
//   - it ran but part of it failed or came back suspiciously small.
// akgcc-extra-data/health.py writes json/meta.json after every run to say
// which; this turns that into one muted line. `fallback` is for the page's
// own data file (events.json / banner_history.json): if meta.json hasn't
// been generated yet, the page still shows when its data was produced.
const DataHealth = (function () {
  // The update runs once a day; a day and a half of silence is a miss,
  // with some slack for a late run.
  const STALE_HOURS = 36;

  function relativeTime(date, now) {
    const minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60000));
    if (minutes < 10) return "just now";
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(hours / 24);
    return `${days} days ago`;
  }

  // meta: {generatedAt, warnings: [{step, message}]} (either may be absent).
  // Returns null when there's nothing to say, else {text, level, title}.
  function summarize(meta, now) {
    if (!meta || !meta.generatedAt) return null;
    const at = new Date(meta.generatedAt);
    if (isNaN(at)) return null;
    const warnings = Array.isArray(meta.warnings) ? meta.warnings.filter((w) => w && w.message) : [];
    const stale = now.getTime() - at.getTime() > STALE_HOURS * 3600 * 1000;
    const exact = at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const lines = [`Last data update: ${exact}`];
    warnings.forEach((w) => lines.push(`- ${w.message}`));
    let text;
    let level = "ok";
    if (stale) {
      text = ` · Last updated ${relativeTime(at, now)} – automatic updates may be delayed`;
      level = "warn";
    } else {
      text = ` · Updated ${relativeTime(at, now)}`;
      if (warnings.length) {
        text += " – some details may be incomplete";
        level = "warn";
      }
    }
    return { text, level, title: lines.join("\n") };
  }

  async function loadMeta() {
    try {
      const res = await fetch(extraDataUrl("meta.json"));
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data === "object" ? data : null;
    } catch (err) {
      return null;
    }
  }

  // Fills `el` (the page's #dataFreshness span). Never throws -- this line
  // is a nicety and must not be able to break the page it sits on.
  async function mount(el, fallback) {
    if (!el) return;
    try {
      const meta = await loadMeta();
      // meta.json is the pipeline's own account of the last run; the page
      // data's timestamp is only used if meta is missing.
      const summary = summarize(meta && meta.generatedAt ? meta : fallback, new Date());
      if (!summary) return;
      el.textContent = summary.text;
      el.title = summary.title;
      el.classList.toggle("warn", summary.level === "warn");
    } catch (err) {
      console.warn("Couldn't show data freshness:", err);
    }
  }

  return { mount, summarize, relativeTime, STALE_HOURS };
})();
