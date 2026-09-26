"""Structure-aware chunking for documents, the organization brief and meeting evidence.

Documents are split on headings and paragraphs into passages of roughly
``TARGET_TOKENS`` (bounded by ``MIN_TOKENS``/``MAX_TOKENS``) with ~15% overlap
when a section has to be split. Every chunk keeps its heading path and page
range so retrieval can explain where a passage came from.

Meeting transcripts are grouped into single-speaker turns (consecutive
finalized segments by the same speaker) so a chunk maps back onto exact
transcript segment ids for citations.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from typing import Any

MIN_TOKENS = 500
TARGET_TOKENS = 700
MAX_TOKENS = 900
OVERLAP_RATIO = 0.15
TURN_MAX_TOKENS = 600
PAGE_SEPARATOR = "\f"

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_SENTENCE_END = re.compile(r"(?<=[.!?。！？])\s+")


def estimate_tokens(text: str) -> int:
    """Cheap, provider-neutral token estimate (~4 characters per token)."""
    stripped = text.strip()
    return max(1, math.ceil(len(stripped) / 4)) if stripped else 0


@dataclass(frozen=True)
class ChunkDraft:
    """A chunk before enrichment and embedding. ``hint`` is transient enrichment input."""

    source_type: str
    source_id: str
    title: str
    content: str
    position: int
    details: dict[str, Any] = field(default_factory=dict)
    meeting_id: str | None = None
    document_id: str | None = None
    hint: str = ""

    @property
    def token_count(self) -> int:
        return estimate_tokens(self.content)

    @property
    def heading_path(self) -> list[str]:
        value = self.details.get("heading_path")
        return [str(item) for item in value] if isinstance(value, list) else []

    def fingerprint(self, scope: str, scope_id: str | None) -> str:
        payload = json.dumps({
            "scope": scope, "scope_id": scope_id, "source_type": self.source_type,
            "source_id": self.source_id, "title": self.title, "heading_path": self.heading_path,
            "content": self.content,
        }, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()


@dataclass(frozen=True)
class _Block:
    text: str
    heading_path: tuple[str, ...]
    page: int | None
    starts_section: bool


def split_pages(extracted_text: str) -> list[tuple[int | None, str]]:
    """Pages are separated by form feeds in stored extracted text; plain text is one page."""
    if PAGE_SEPARATOR not in extracted_text:
        return [(None, extracted_text)]
    return [(index + 1, page) for index, page in enumerate(extracted_text.split(PAGE_SEPARATOR))]


def _blocks(pages: list[tuple[int | None, str]]) -> list[_Block]:
    blocks: list[_Block] = []
    headings: list[tuple[int, str]] = []
    section_started = False
    for page, text in pages:
        paragraph: list[str] = []
        for line in [*text.splitlines(), ""]:  # the trailing "" flushes the page's last paragraph
            match = _HEADING.match(line.strip())
            if line.strip() and not match:
                paragraph.append(line.rstrip())
                continue
            body = "\n".join(paragraph).strip()
            paragraph = []
            if body:
                blocks.append(_Block(body, tuple(title for _, title in headings), page, section_started))
                section_started = False
            if match:
                level, title = len(match.group(1)), match.group(2).strip()[:200]
                headings = [item for item in headings if item[0] < level] + [(level, title)]
                section_started = True
    return blocks


def _split_long(text: str, limit: int) -> list[str]:
    """Split an oversized paragraph at sentence (then word) boundaries."""
    pieces: list[str] = []
    current = ""
    for sentence in _SENTENCE_END.split(text):
        candidate = f"{current} {sentence}".strip() if current else sentence
        if estimate_tokens(candidate) <= limit:
            current = candidate
            continue
        if current:
            pieces.append(current)
        if estimate_tokens(sentence) <= limit:
            current = sentence
            continue
        words, current = sentence.split(), ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if estimate_tokens(candidate) > limit and current:
                pieces.append(current)
                current = word
            else:
                current = candidate
    if current:
        pieces.append(current)
    return pieces


def _tail(text: str, tokens: int) -> str:
    """The trailing ~``tokens`` of ``text``, cut at a sentence or word boundary."""
    if tokens <= 0:
        return ""
    sentences = _SENTENCE_END.split(text)
    kept: list[str] = []
    for sentence in reversed(sentences):
        if estimate_tokens(" ".join([sentence, *kept])) > tokens:
            break
        kept.insert(0, sentence)
    if kept:
        return " ".join(kept)
    words = text.split()
    return " ".join(words[-max(1, tokens * 3 // 4):])


def chunk_document(
    extracted_text: str, *, title: str, source_type: str, source_id: str,
    document_id: str | None = None,
    min_tokens: int = MIN_TOKENS, max_tokens: int = MAX_TOKENS,
) -> list[ChunkDraft]:
    """Heading/paragraph-aware packing with overlap when a section is split."""
    blocks: list[_Block] = []
    for block in _blocks(split_pages(extracted_text)):
        if estimate_tokens(block.text) <= max_tokens:
            blocks.append(block)
            continue
        for index, piece in enumerate(_split_long(block.text, int(max_tokens * 0.8))):
            blocks.append(_Block(piece, block.heading_path, block.page, block.starts_section and index == 0))
    chunks: list[ChunkDraft] = []
    current: list[_Block] = []
    overlap = ""

    def emit() -> None:
        nonlocal overlap
        if not current:
            return
        body = "\n\n".join(block.text for block in current)
        content = f"{overlap}\n\n{body}".strip() if overlap else body
        pages = [block.page for block in current if block.page is not None]
        paths = list(dict.fromkeys(block.heading_path for block in current))
        chunks.append(ChunkDraft(
            source_type=source_type, source_id=source_id, title=title[:300], content=content,
            position=len(chunks), document_id=document_id,
            details={
                "heading_path": list(current[0].heading_path),
                "sections": [list(path) for path in paths[:8]],
                "page_start": min(pages) if pages else None,
                "page_end": max(pages) if pages else None,
                "overlap_tokens": estimate_tokens(overlap) if overlap else 0,
            },
        ))
        overlap = ""
        current.clear()

    for block in blocks:
        size = sum(estimate_tokens(item.text) for item in current) + estimate_tokens(overlap)
        if current and block.starts_section and size >= min_tokens:
            emit()  # clean section boundary: no overlap needed
        elif current and size + estimate_tokens(block.text) > max_tokens:
            carried = _tail("\n\n".join(item.text for item in current), int(max_tokens * OVERLAP_RATIO))
            emit()
            overlap = carried
        current.append(block)
    emit()
    return chunks


def brief_markdown(brief: dict[str, Any]) -> str:
    """Render the organization brief fields as headed Markdown for chunking."""
    sections = [
        ("Overview", brief.get("overview") or ""),
        ("Services", "\n".join(f"- {item}" for item in brief.get("services") or [])),
        ("Products", "\n".join(f"- {item}" for item in brief.get("products") or [])),
        ("Differentiators", brief.get("differentiators") or ""),
        ("Positioning", brief.get("positioning") or ""),
    ]
    parts = [f"# Organization profile\n\nWebsite: {brief['website']}" if brief.get("website") else "# Organization profile"]
    parts += [f"## {heading}\n\n{body.strip()}" for heading, body in sections if body and body.strip()]
    return "\n\n".join(parts) if len(parts) > 1 else ""


@dataclass(frozen=True)
class TurnSegment:
    """The subset of a canonical transcript source needed to build a turn."""

    source_id: str
    segment_id: str
    speaker: str | None
    start_seconds: float
    end_seconds: float
    text: str


def group_turns(segments: list[TurnSegment], max_tokens: int = TURN_MAX_TOKENS) -> list[list[TurnSegment]]:
    """Consecutive segments by the same speaker form a turn, split when too long."""
    turns: list[list[TurnSegment]] = []
    for segment in segments:
        last = turns[-1] if turns else None
        if (last is not None and last[-1].speaker == segment.speaker
                and estimate_tokens(" ".join(item.text for item in [*last, segment])) <= max_tokens):
            last.append(segment)
        else:
            turns.append([segment])
    return turns


def turn_source_id(meeting_id: str, turn: list[TurnSegment]) -> str:
    """Single-segment turns reuse the canonical source id so fusion deduplicates them."""
    if len(turn) == 1:
        return turn[0].source_id
    identity = f"{meeting_id}:turn:{'|'.join(item.segment_id for item in turn)}:{' '.join(item.text for item in turn)}"
    return hashlib.sha256(identity.encode()).hexdigest()[:20]
