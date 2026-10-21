"""Helpers shared by the pipeline scripts (shop_operators.py,
operator_online.py, events.py, game_data.py)."""

import time
from datetime import datetime

import requests

# Plain requests.get() has no timeout, so a slow or rate-limited host could
# hang a run indefinitely. http_get() always sets a timeout and retries a
# couple of times with backoff before raising, so a down host fails fast
# with a clear error in the Action log.
REQUEST_TIMEOUT = 30  # seconds, per attempt
REQUEST_RETRIES = 3
REQUEST_BACKOFF = 5  # seconds, multiplied by attempt number

# wiki.gg sometimes answers with a bot-check page ("Just a second...",
# HTTP 403) or a rate limit (429) for a while; waiting usually gets a
# normal answer. Such responses are retried after each of these waits.
# Once one request has still been blocked after all of them, later blocked
# responses in the same run are returned straight away, so a site that
# stays blocked can't stretch a run past the workflow's time limit.
BLOCKED_RETRY_WAITS = [30, 90]
_blocked_gave_up = False


def is_blocked(r):
    """Whether a response is a bot check or rate limit rather than an answer."""
    if r.status_code == 429:
        return True
    return r.status_code == 403 and "Just a second" in (r.text or "")[:2000]


def http_get(url, **kwargs):
    global _blocked_gave_up
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)
    waits = [] if _blocked_gave_up else list(BLOCKED_RETRY_WAITS)
    while True:
        r = _get_with_retries(url, **kwargs)
        if not is_blocked(r):
            return r
        if not waits:
            _blocked_gave_up = True
            return r
        wait = waits.pop(0)
        print(f"{url}: blocked (HTTP {r.status_code}), retrying in {wait}s")
        time.sleep(wait)


def _get_with_retries(url, **kwargs):
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


def response_json(r, what):
    """r.json(), or a RuntimeError that says what came back instead (a
    bot-check page, an error page, an empty body) -- clearer in the Action
    log than a bare JSONDecodeError."""
    try:
        return r.json()
    except ValueError:
        snippet = " ".join((r.text or "")[:200].split())
        raise RuntimeError(f"{what}: HTTP {r.status_code}, not JSON: {snippet!r}") from None


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
