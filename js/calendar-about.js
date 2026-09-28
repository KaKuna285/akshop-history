// Fills in the "How accurate is this?" section on the about page with the
// live backtest stats from events.json (see akgcc-extra-data/events.py's
// backtest_lag_model() for how these are computed).
(async function () {
  const el = document.getElementById("backtestStats");
  if (!el) return;
  try {
    const res = await fetch(extraDataUrl("events.json"));
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const data = await res.json();
    const bt = data.backtest;
    if (!bt || !bt.n) {
      el.textContent = "Not enough confirmed history yet to report an accuracy figure.";
      return;
    }
    const round = (d) => Math.round(d);
    el.textContent =
      `Across ${bt.n} past events, this method's estimate was off by a median of ` +
      `${round(bt.medianAbsErrDays)} days - within ${round(bt.p75AbsErrDays)} days three ` +
      `quarters of the time, and within ${round(bt.p90AbsErrDays)} days nine times out of ten. ` +
      `Its single worst miss was ${round(bt.maxAbsErrDays)} days off.`;
  } catch (err) {
    console.error("Failed to load backtest stats:", err);
    el.textContent = "Couldn't load accuracy stats (see console for details).";
  }
})();
