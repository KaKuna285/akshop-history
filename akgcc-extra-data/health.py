"""Write json/meta.json: whether the daily update actually worked.

The three update steps (shop_operators.py, operator_online.py, events.py)
are each allowed to fail without stopping the others -- but a scraper
that breaks quietly (the wiki changes a template, an API starts erroring)
otherwise just leaves the site showing yesterday's data with nothing to
say so. This runs last, with `if: always()`, and records what happened:

    python health.py shop=success operators=failure events=success

Each argument is a workflow step's `outcome` (success / failure /
cancelled / skipped). The result, json/meta.json:

    generatedAt   when this check ran (the site's "Updated X ago")
    ok            true only if every step succeeded and nothing is degraded
    problemRuns   how many runs in a row have had any warning (0 = healthy).
                  The workflow only opens a GitHub issue at 2+, so one
                  transient wiki hiccup doesn't open and close an issue
                  by itself; a hard step failure still turns the run red
                  at once.
    steps         per step: label, outcome, lastSuccess (carried over from
                  the previous meta.json when this run's step failed, so
                  "last good data from ..." survives a bad run)
    counts        how much data each step produced
    warnings      [{step, message}] -- failed steps, degraded sub-steps
                  events.py reported (events.json `warnings`), and any
                  count that shrank suspiciously since the last run

The shrink check is the part that catches *silent* breakage: a scraper
that still exits 0 but now parses nothing (events 320 -> 12) is exactly
what a plain success/failure outcome can't see.

The workflow reads the same arguments again afterwards to fail the run
and open a GitHub issue (see .github/workflows/banner_history_update.yml);
this script itself never fails, so meta.json is always written.
"""

import json
import sys
from datetime import datetime, timezone

JSON_DIR = "./json"
META_PATH = f"{JSON_DIR}/meta.json"

# argument name -> (label shown in warnings, file the step writes)
STEPS = {
    "shop": ("Shop history", "banner_history.json"),
    "operators": ("Operator release dates", "operator_release_dates.json"),
    "events": ("Event calendar", "events.json"),
}

# A count that falls below this fraction of its previous value is flagged.
# Only for counts that were big enough for a drop to mean something.
SHRINK_FRACTION = 0.8
SHRINK_MIN_PREVIOUS = 20


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def gather_counts():
    counts = {}
    banners = read_json(f"{JSON_DIR}/banner_history.json")
    if isinstance(banners, dict):
        for key, name in (("NA", "shopOperatorsEN"), ("CN", "shopOperatorsCN")):
            if hasattr(banners.get(key), "__len__"):
                counts[name] = len(banners[key])
    dates = read_json(f"{JSON_DIR}/operator_release_dates.json")
    if hasattr(dates, "__len__"):
        counts["operatorDates"] = len(dates)
    events = read_json(f"{JSON_DIR}/events.json")
    if isinstance(events, dict) and isinstance(events.get("events"), list):
        counts["events"] = len(events["events"])
        counts["eventsWithSkins"] = sum(1 for e in events["events"] if e.get("skins"))
    return counts


def build_meta(outcomes, previous, now):
    """outcomes: {"shop": "success", ...}. previous: the last meta.json
    (or None). Pure apart from reading the data files via gather_counts()
    / read_json(), so tests can point JSON_DIR somewhere else."""
    previous = previous if isinstance(previous, dict) else {}
    prev_steps = previous.get("steps") if isinstance(previous.get("steps"), dict) else {}
    prev_counts = previous.get("counts") if isinstance(previous.get("counts"), dict) else {}
    now_iso = now.isoformat()

    steps = {}
    warnings = []
    for key, (label, filename) in STEPS.items():
        outcome = outcomes.get(key, "skipped")
        last_success = (prev_steps.get(key) or {}).get("lastSuccess")
        if outcome == "success":
            last_success = now_iso
        else:
            when = f" -- showing data from {last_success[:10]}" if last_success else ""
            warnings.append({"step": key, "message": f"{label} update {outcome}{when}"})
        steps[key] = {"label": label, "outcome": outcome, "lastSuccess": last_success}

    # events.py's own degraded sub-steps (themes, skins, images, ...).
    events = read_json(f"{JSON_DIR}/events.json")
    if outcomes.get("events") == "success" and isinstance(events, dict):
        for w in events.get("warnings") or []:
            if isinstance(w, dict) and w.get("message"):
                warnings.append({"step": w.get("step") or "events", "message": w["message"]})

    counts = gather_counts()
    for name, value in counts.items():
        before = prev_counts.get(name)
        if isinstance(before, int) and before >= SHRINK_MIN_PREVIOUS and value < before * SHRINK_FRACTION:
            warnings.append({"step": "counts", "message": f"{name} dropped from {before} to {value}"})

    problem_runs = (previous.get("problemRuns") if isinstance(previous.get("problemRuns"), int) else 0) + 1
    return {
        "generatedAt": now_iso,
        "ok": not warnings,
        "problemRuns": problem_runs if warnings else 0,
        "steps": steps,
        "counts": counts,
        "warnings": warnings,
    }


def parse_args(argv):
    outcomes = {}
    for arg in argv:
        key, sep, value = arg.partition("=")
        if sep and key in STEPS:
            outcomes[key] = value.strip().lower() or "skipped"
    return outcomes


if __name__ == "__main__":
    outcomes = parse_args(sys.argv[1:])
    meta = build_meta(outcomes, read_json(META_PATH), datetime.now(timezone.utc))
    with open(META_PATH, "w") as f:
        json.dump(meta, f, indent=1)
    print(f"meta.json: ok={meta['ok']}, counts={meta['counts']}")
    for w in meta["warnings"]:
        print(f"  warning [{w['step']}]: {w['message']}")
