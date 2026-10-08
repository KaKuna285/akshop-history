"""Helpers shared by the pipeline scripts (shop_operators.py,
operator_online.py, events.py, game_data.py)."""

import time
from datetime import datetime

import requests

# Plain requests.get() has no timeout by default, so a slow or rate-limited
# host can hang a run indefinitely instead of failing loudly. http_get()
# always sets a timeout and retries a couple of times with backoff before
# raising, so a genuinely-down host still fails fast with a clear error in
# the Action log.
REQUEST_TIMEOUT = 30  # seconds, per attempt
REQUEST_RETRIES = 3
REQUEST_BACKOFF = 5  # seconds, multiplied by attempt number


def http_get(url, **kwargs):
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)
    last_exc = None
    for attempt in range(1, REQUEST_RETRIES + 1):
        try:
            return requests.get(url, **kwargs)
        except requests.exceptions.RequestException as exc:
            last_exc = exc
            print(f"Request to {url} failed (attempt {attempt}/{REQUEST_RETRIES}): {exc}")
            if attempt < REQUEST_RETRIES:
                time.sleep(REQUEST_BACKOFF * attempt)
    raise last_exc


def parse_date(s):
    """Lenient date parsing: 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' (with
    either - or / separators) -- the wiki's Cargo date fields come back in
    either form, occasionally empty, and hand-entered override dates are
    usually just a day. Returns None (and logs) rather than raising, so one
    bad row can't take down a whole run."""
    if not s:
        return None
    s = str(s).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    print(f"Could not parse date: {s!r}")
    return None
