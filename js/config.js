// Shared config for every page in this fork. Load this before util.js,
// shoplist.js, or calendar.js -- they all reference EXTRA_DATA_REPO_RAW_BASE.

// Where banner_history.json / operator_release_dates.json / events.json
// are fetched from. Point this at YOUR OWN fork's raw JSON (set up with
// its own scraper schedule -- see .github/workflows/) instead of
// depending on akgcc/akgcc-extra-data's own (twice-weekly) refresh
// cadence.
const EXTRA_DATA_REPO_RAW_BASE =
  "https://raw.githubusercontent.com/KaKuna285/akshop-history/main/akgcc-extra-data/json/";
