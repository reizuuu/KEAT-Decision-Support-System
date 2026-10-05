import re


def to_title_case(name: str) -> str:
    """Display name, e.g. "iced-tea 16oz" -> "Iced-Tea 16Oz"."""
    normalized = re.sub(r"\s+", " ", (name or "").strip())
    if not normalized:
        return normalized
    return " ".join(
        "-".join(part.capitalize() for part in word.split("-"))
        for word in normalized.split(" ")
    )


def normalize_alias(name: str) -> str:
    """Matching key for POS names, e.g. " Iced-Tea  16oz" -> "Iced Tea 16oz". Callers lowercase it."""
    normalized = (name or "").replace("-", " ")
    return re.sub(r"\s+", " ", normalized).strip()
