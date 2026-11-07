"""Deterministic ATS keyword coverage, formatting audit, and numerical grounding checks."""

import re

from pydantic import BaseModel

from agent.schemas import CandidateProfile

_ALIASES: dict[str, str] = {
    "js": "javascript",
    "ts": "typescript",
    "py": "python",
    "golang": "go",
    "k8s": "kubernetes",
    "postgres": "postgresql",
    "pg": "postgresql",
    "reactjs": "react",
    "react.js": "react",
    "nodejs": "node",
    "node.js": "node",
    "nextjs": "next.js",
    "vuejs": "vue",
    "vue.js": "vue",
    "ci/cd": "cicd",
    "ci-cd": "cicd",
    "ml": "machine learning",
    "ai": "artificial intelligence",
    "llm": "large language model",
    "llms": "large language model",
    "gcp": "google cloud platform",
    "aws": "amazon web services",
    "rest api": "rest",
    "restful": "rest",
}

_KEEP_PLURAL = frozenset(
    {
        "kubernetes",
        "postgres",
        "serverless",
        "devops",
        "aws",
        "css",
        "redis",
        "pandas",
        "jenkins",
        "fastapi",
        "nextjs",
        "nodejs",
        "reactjs",
        "express",
        "prometheus",
        "glass",
        "pass",
        "less",
        "status",
        "series",
        "analysis",
        "basis",
        "thesis",
        "crisis",
        "hypothesis",
        "diagnosis",
        "synthesis",
    }
)

_ACTION_VERBS = frozenset(
    {
        "achieved",
        "architected",
        "automated",
        "built",
        "collaborated",
        "conducted",
        "consolidated",
        "created",
        "cut",
        "decreased",
        "delivered",
        "deployed",
        "designed",
        "developed",
        "directed",
        "drove",
        "eliminated",
        "engineered",
        "established",
        "executed",
        "expanded",
        "generated",
        "grew",
        "headed",
        "implemented",
        "improved",
        "increased",
        "initiated",
        "integrated",
        "launched",
        "led",
        "maintained",
        "managed",
        "mentored",
        "migrated",
        "modernized",
        "negotiated",
        "operated",
        "optimized",
        "orchestrated",
        "owned",
        "partnered",
        "pioneered",
        "planned",
        "produced",
        "published",
        "raised",
        "redesigned",
        "reduced",
        "refactored",
        "resolved",
        "revamped",
        "scaled",
        "secured",
        "shipped",
        "simplified",
        "spearheaded",
        "standardized",
        "streamlined",
        "strengthened",
        "supervised",
        "supported",
        "transformed",
        "translated",
        "upgraded",
        "wrote",
    }
)

_PLACEHOLDER_RE = re.compile(r"\$?\[[A-Za-z0-9_]+\](?:%|[xX]|[kKmMbB]\b)?")
_NUMBER_RE = re.compile(
    r"(?<![A-Za-z0-9_])(\$?\d[\d,]*(?:\.\d+)?(?:%|[xX]|[kKmMbB]\b)?)(?![A-Za-z0-9_])"
)
_WORD_SPLIT_RE = re.compile(r"[^a-z0-9+#./-]+")


class Coverage(BaseModel):
    """ATS keyword match score (0.0 to 1.0) and lists of matched and missing terms."""

    score: float
    matched: list[str]
    missing: list[str]


def _singularize_word(word: str) -> str:
    """Strip simple English plural suffixes from a single lowercase token."""
    if word in _KEEP_PLURAL or len(word) <= 3:
        return word
    if word.endswith("ies") and len(word) > 4:
        return f"{word[:-3]}y"
    if word.endswith("s") and not word.endswith(("ss", "us")):
        return word[:-1]
    return word


def normalize(term: str) -> str:
    """Normalize case, punctuation, simple plurals, and common tech aliases."""
    cleaned = term.strip().lower()
    cleaned = cleaned.strip(".,;:!?()[]{}\"'`")
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        return ""
    if cleaned in _ALIASES:
        return _ALIASES[cleaned]

    words = [w.strip(".,;:!?()[]{}\"'`") for w in _WORD_SPLIT_RE.split(cleaned) if w]
    norm_words: list[str] = []
    for word in words:
        mapped = _ALIASES.get(word, word)
        for sub in mapped.split():
            norm_words.append(_singularize_word(sub))
    joined = " ".join(norm_words)
    return _ALIASES.get(joined, joined)


def _text_ngrams(text: str, max_n: int = 4) -> set[str]:
    """Build a set of normalized 1..max_n word phrases from free text."""
    raw_tokens = [t.strip(".,;:!?()[]{}\"'`") for t in _WORD_SPLIT_RE.split(text.lower())]
    tokens = [t for t in raw_tokens if t]
    phrases: set[str] = set()
    n_tokens = len(tokens)
    for i in range(n_tokens):
        for width in range(1, min(max_n, n_tokens - i) + 1):
            phrase = normalize(" ".join(tokens[i : i + width]))
            if phrase:
                phrases.add(phrase)
    return phrases


def keyword_coverage(text: str, keywords: list[str]) -> Coverage:
    """Compute deterministic keyword coverage of keywords against candidate text."""
    clean_keywords = [kw.strip() for kw in keywords if kw.strip()]
    if not clean_keywords:
        return Coverage(score=1.0, matched=[], missing=[])

    norm_text = normalize(text)
    phrases = _text_ngrams(text, max_n=5)
    matched: list[str] = []
    missing: list[str] = []

    for kw in clean_keywords:
        norm_kw = normalize(kw)
        if not norm_kw:
            continue
        pattern = rf"(?:^|\s){re.escape(norm_kw)}(?:\s|$)"
        if norm_kw in phrases or re.search(pattern, norm_text):
            matched.append(kw)
        else:
            missing.append(kw)

    total = len(matched) + len(missing)
    score = round(len(matched) / total, 4) if total else 1.0
    return Coverage(score=score, matched=matched, missing=missing)


def _check_bullet_issues(bullet_id: str, text: str) -> list[str]:
    """Check a single bullet for length, action verb, and metric/number presence."""
    issues: list[str] = []
    clean = text.strip()
    if len(clean) > 220:
        issues.append(f"Bullet {bullet_id} is too long ({len(clean)} chars; max 220).")
    words = re.findall(r"[A-Za-z]+", clean)
    first_word = words[0].lower() if words else ""
    has_verb = first_word in _ACTION_VERBS or first_word.endswith("ed")
    has_num = bool(numbers_in(clean)) or bool(placeholders_in(clean))
    if not has_verb and not has_num:
        issues.append(f"Bullet {bullet_id} lacks both a strong action verb and a metric.")
    return issues


def _total_words(profile: CandidateProfile) -> int:
    """Count total words across a candidate profile."""
    parts = [profile.name, profile.headline, profile.summary, *profile.contact, *profile.skills]
    for exp in profile.experience:
        parts.extend([exp.title, exp.organization, exp.location])
        parts.extend(b.text for b in exp.bullets)
    for edu in profile.education:
        parts.extend([edu.degree, edu.institution, edu.details])
    return len(re.findall(r"\S+", " ".join(parts)))


def format_issues(profile: CandidateProfile) -> list[str]:
    """Audit a CandidateProfile for deterministic ATS formatting and structure issues."""
    issues: list[str] = []
    contact_joined = " ".join(profile.contact)
    if not profile.contact or "@" not in contact_joined:
        issues.append("Missing email address in contact information.")
    if not profile.summary.strip():
        issues.append("Missing professional summary.")
    if not profile.skills:
        issues.append("Missing skills list.")

    for exp in profile.experience:
        if not exp.start.strip() or not exp.end.strip():
            issues.append(f"Role {exp.id} ({exp.title}) is missing start or end dates.")
        for bullet in exp.bullets:
            issues.extend(_check_bullet_issues(bullet.id, bullet.text))

    word_count = _total_words(profile)
    if word_count > 900:
        issues.append(f"Resume is too long ({word_count} words; recommended <= 900).")
    return issues


def placeholders_in(text: str) -> list[str]:
    """Return all bracketed metric placeholders (such as '[X]%', '$[Y]', '[N]') in order."""
    seen: list[str] = []
    for match in _PLACEHOLDER_RE.finditer(text):
        token = match.group(0)
        if token not in seen:
            seen.append(token)
    return seen


def _normalize_number_token(raw: str) -> str:
    """Normalize a numeric token for comparison (strip commas, lowercase unit suffixes)."""
    return raw.replace(",", "").lower()


def numbers_in(text: str) -> set[str]:
    """Extract normalized numbers, percentages, currencies, and multipliers from text."""
    stripped = _PLACEHOLDER_RE.sub(" ", text)
    results: set[str] = set()
    for match in _NUMBER_RE.finditer(stripped):
        results.add(_normalize_number_token(match.group(1)))
    return results


def unsupported_numbers(proposed: str, source: str) -> list[str]:
    """Return sorted numbers present in proposed text that do not appear in source text."""
    prop_nums = numbers_in(proposed)
    src_nums = numbers_in(source)
    return sorted(prop_nums - src_nums)


def _overlaps_spans(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    """Return True if [start, end) overlaps any (s, e) interval in spans."""
    return any(start < e and end > s for s, e in spans)


def replace_unsupported_numbers(
    proposed: str, source: str, placeholder: str = "[X]"
) -> tuple[str, list[str]]:
    """Replace whole numeric token spans in proposed not found in source with placeholder."""
    src_nums = numbers_in(source)
    placeholder_spans = [m.span() for m in _PLACEHOLDER_RE.finditer(proposed)]

    out_parts: list[str] = []
    replaced: list[str] = []
    cursor = 0

    for match in _NUMBER_RE.finditer(proposed):
        start, end = match.span(1)
        if _overlaps_spans(start, end, placeholder_spans):
            continue
        raw_token = match.group(1)
        norm = _normalize_number_token(raw_token)
        if norm in src_nums:
            continue
        out_parts.append(proposed[cursor:start])
        out_parts.append(placeholder)
        cursor = end
        if norm not in replaced:
            replaced.append(norm)

    if not replaced:
        return proposed, []

    out_parts.append(proposed[cursor:])
    return "".join(out_parts), replaced
