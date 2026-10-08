"""Shared HTTP helper for the pipeline scripts.

Plain requests.get() has no timeout by default, so a slow or rate-limited
host can hang a run indefinitely instead of failing loudly. http_get()
always sets a timeout and retries a couple of times with backoff before
raising, so a genuinely-down host still fails fast with a clear error in
the Action log. (shop_operators.py, operator_online.py and events.py each
still carry their own copy of this; they can move to this module.)
"""

import time

import requests

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
