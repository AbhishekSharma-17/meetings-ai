"""Chunk boundaries, heading paths, page ranges, overlap and transcript turns."""

from app.chunking import (
    MAX_TOKENS, ChunkDraft, TurnSegment, brief_markdown, chunk_document, estimate_tokens, group_turns,
    turn_source_id,
)


def _paragraph(word: str, sentences: int = 12) -> str:
    return " ".join(f"The {word} programme sentence number {index} explains a detail." for index in range(sentences))


def test_small_sections_share_a_chunk_and_keep_heading_path_and_pages() -> None:
    text = "\f".join([
        "# Handbook\n\n## Pricing\n\nPilots start at a fixed fee.\n\n## Support\n\nEmail us any time.",
        "## Security\n\nWe encrypt data at rest.",
    ])
    chunks = chunk_document(text, title="handbook.pdf", source_type="document", source_id="d1", document_id="d1")
    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk.details["heading_path"] == ["Handbook", "Pricing"]
    assert ["Handbook", "Security"] in chunk.details["sections"]
    assert chunk.details["page_start"] == 1 and chunk.details["page_end"] == 2
    assert chunk.document_id == "d1" and chunk.position == 0


def test_large_sections_split_at_paragraphs_within_bounds_with_overlap() -> None:
    body = "\n\n".join(_paragraph(f"alpha{index}") for index in range(12))
    text = f"# Guide\n\n## Rollout\n\n{body}\n\n## Appendix\n\n{_paragraph('beta', 60)}"
    chunks = chunk_document(text, title="guide.md", source_type="document", source_id="g")
    assert len(chunks) >= 3
    assert all(chunk.token_count <= MAX_TOKENS * 1.2 for chunk in chunks)
    assert all(chunk.token_count >= 100 for chunk in chunks[:-1])
    split = [chunk for chunk in chunks if chunk.details["overlap_tokens"]]
    assert split, "a section that had to be split carries overlap"
    first, second = chunks[0], chunks[1]
    if second.details["overlap_tokens"]:
        assert second.content.split("\n\n")[0][-40:] in first.content
    # A new top-level section starts a clean chunk (no overlap) once the current one is big enough.
    appendix = [chunk for chunk in chunks if chunk.details["heading_path"] == ["Guide", "Appendix"]]
    assert appendix and appendix[0].details["overlap_tokens"] == 0
    assert [chunk.position for chunk in chunks] == list(range(len(chunks)))


def test_oversized_paragraph_is_split_by_sentences() -> None:
    text = _paragraph("gamma", 200)
    chunks = chunk_document(text, title="t", source_type="document", source_id="x")
    assert len(chunks) > 1 and all(chunk.token_count <= MAX_TOKENS * 1.2 for chunk in chunks)
    assert estimate_tokens("abcd" * 10) == 10 and estimate_tokens("   ") == 0


def test_fingerprint_changes_only_with_content_or_location() -> None:
    draft = ChunkDraft("document", "d1", "t", "same text", 0, {"heading_path": ["A"]})
    moved = ChunkDraft("document", "d1", "t", "same text", 5, {"heading_path": ["A"], "page_start": 3})
    assert draft.fingerprint("organization", None) == moved.fingerprint("organization", None)
    assert draft.fingerprint("organization", None) != draft.fingerprint("prep", "e1")
    edited = ChunkDraft("document", "d1", "t", "other text", 0, {"heading_path": ["A"]})
    assert draft.fingerprint("organization", None) != edited.fingerprint("organization", None)


def test_turns_group_consecutive_same_speaker_segments() -> None:
    segments = [
        TurnSegment("s1", "seg-1", "Alice", 0, 2, "Hello."),
        TurnSegment("s2", "seg-2", "Alice", 2, 4, "Welcome all."),
        TurnSegment("s3", "seg-3", "Bob", 4, 6, "Thanks."),
        TurnSegment("s4", "seg-4", "Alice", 6, 8, "Next topic."),
    ]
    turns = group_turns(segments)
    assert [[item.segment_id for item in turn] for turn in turns] == [["seg-1", "seg-2"], ["seg-3"], ["seg-4"]]
    assert turn_source_id("m1", turns[1]) == "s3"  # single-segment turns keep the canonical id
    assert turn_source_id("m1", turns[0]) not in {"s1", "s2"}
    long = [TurnSegment(f"s{i}", f"seg-{i}", "Alice", i, i + 1, "word " * 300) for i in range(5)]
    assert len(group_turns(long)) > 1


def test_brief_markdown_renders_only_filled_sections() -> None:
    markdown = brief_markdown({"website": "https://ourco.example", "overview": "We build AI.",
                               "services": ["RAG"], "products": [], "differentiators": "", "positioning": ""})
    assert "## Overview" in markdown and "- RAG" in markdown and "## Products" not in markdown
    assert brief_markdown({"overview": "", "services": [], "products": []}) == ""
