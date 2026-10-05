"""In-memory cache for the read-only /api/results and /api/analytics payloads.

Both payloads only change when the database does (an upload, a product
edit/delete, a rule remine), but rebuilding the dashboard one means loading
every RawTransaction row - so they're cached and reused until the next write.

Invalidation is by "generation": every committed database session bumps a
counter (see _bump_generation), and an entry is only served if it was built
under the current generation. That covers every write path - routes, the
background remine thread, startup migrations - without each one having to
remember to clear the cache. An entry built while a commit lands mid-build is
stored under the old generation and so is never served.

Process-local by design: this app runs as a single Flask process. Under a
multi-worker server each worker would only see its own commits.
"""

from collections import OrderedDict
import threading

from sqlalchemy import event
from sqlalchemy.orm import Session

# Distinct dashboard filter combinations kept per generation.
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
    """Returns the cached value for `key`, or calls build() and caches it.

    The returned value is shared between requests - callers must not mutate it.
    """
    with _lock:
        generation = _generation
        cache_key = (generation, key)
        if cache_key in _entries:
            _entries.move_to_end(cache_key)
            return _entries[cache_key]

    # Built outside the lock so a slow build doesn't block other requests.
    value = build()

    with _lock:
        if generation == _generation:
            _entries[cache_key] = value
            while len(_entries) > _MAX_ENTRIES:
                _entries.popitem(last=False)
    return value
