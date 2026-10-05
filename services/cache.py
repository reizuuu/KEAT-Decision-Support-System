"""In-memory cache for the /api/results and /api/analytics payloads.

Every db commit bumps a generation counter and clears the cache, so no write path has to
invalidate it by hand. Process-local, which is fine for a single Flask process.
"""

import threading
from collections import OrderedDict

from sqlalchemy import event
from sqlalchemy.orm import Session

_MAX_ENTRIES = 32

_lock = threading.Lock()
_generation = 0
_entries = OrderedDict()


@event.listens_for(Session, "after_commit")
def _bump_generation(session):
    global _generation
    with _lock:
        _generation += 1
        _entries.clear()


def get_or_build(key, build):
    """Cached value for key, or build() it. The value is shared, don't mutate it."""
    with _lock:
        generation = _generation
        cache_key = (generation, key)
        if cache_key in _entries:
            _entries.move_to_end(cache_key)
            return _entries[cache_key]

    value = build()

    with _lock:
        if generation == _generation:
            _entries[cache_key] = value
            while len(_entries) > _MAX_ENTRIES:
                _entries.popitem(last=False)
    return value
