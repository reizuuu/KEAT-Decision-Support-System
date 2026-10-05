import re


def to_title_case(name: str) -> str:
    """Title-cases a product name for display: normalizes whitespace and
    capitalizes each word, without mangling existing hyphens/numerals
    (e.g. "iced-tea 16oz" -> "Iced-Tea 16Oz", "bbq rice bowl" -> "Bbq Rice Bowl").
    """
    normalized = re.sub(r"\s+", " ", (name or "").strip())
    if not normalized:
        return normalized
    return " ".join(
        "-".join(part.capitalize() for part in word.split("-"))
        for word in normalized.split(" ")
    )


def normalize_alias(name: str) -> str:
    """Normalizes a raw POS product name into a stable matching/storage key:
    strips leading/trailing whitespace, replaces hyphens with spaces, and
    collapses repeated internal whitespace - so "Iced-Tea", "iced tea", and
    " Iced   Tea " all resolve to the same key instead of drifting into
    separate near-duplicate products across uploads.
    """
    normalized = (name or "").replace("-", " ")
    return re.sub(r"\s+", " ", normalized).strip()
