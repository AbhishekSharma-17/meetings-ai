"""Container-level helpers for browser-recorded audio: no decoding, only byte framing.

A MediaRecorder started with a timeslice produces one continuous file cut into pieces: the first
piece carries the container header (WebM EBML + Tracks, MP4 ``ftyp`` + ``moov``, Ogg Opus header
pages) and later pieces are continuation data (WebM Clusters, MP4 ``moof``/``mdat`` fragments,
Ogg pages). The pieces of one stream concatenated in order are the original file. A range that
starts mid-stream becomes decodable when the stream header is put in front of it and the range is
trimmed to its first frame boundary (Cluster / ``moof`` / ``OggS``); that is how live captions and
long-recording parts are built.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

from .in_person_store import ChunkMeta

_WEBM_CLUSTER = b"\x1f\x43\xb6\x75"
_OGG_PAGE = b"OggS"
_HEADER_SCAN_LIMIT = 256 * 1024  # stream headers are a few hundred bytes to a few KB


def stream_header(mime_type: str, first_chunk: bytes) -> bytes | None:
    """The container header at the start of a stream's first chunk, or None when it can't be found."""
    if mime_type == "audio/webm":
        index = first_chunk.find(_WEBM_CLUSTER, 0, _HEADER_SCAN_LIMIT)
        return first_chunk[:index] if index > 0 else None
    if mime_type == "audio/mp4":
        return _mp4_init_segment(first_chunk)
    if mime_type == "audio/ogg":
        return _ogg_header_pages(first_chunk)
    return None


def aligned(mime_type: str, data: bytes) -> bytes | None:
    """``data`` trimmed to its first frame boundary; None when it holds none (too little audio)."""
    if mime_type == "audio/webm":
        index = data.find(_WEBM_CLUSTER)
    elif mime_type == "audio/mp4":
        index = _mp4_box_offset(data, b"moof")
    elif mime_type == "audio/ogg":
        index = data.find(_OGG_PAGE)
    else:
        return None
    return data[index:] if index >= 0 else None


def standalone(mime_type: str, header: bytes | None, chunks: list[bytes], *, starts_stream: bool) -> bytes | None:
    """One decodable file from consecutive chunks of a stream (header prepended when mid-stream)."""
    if not chunks:
        return None
    if starts_stream:
        return b"".join(chunks)
    if header is None:
        return None
    head = aligned(mime_type, chunks[0])
    if head is None:
        return None
    return header + head + b"".join(chunks[1:])


# ----- part planning --------------------------------------------------------------------------------
@dataclass(frozen=True)
class Part:
    """A range of consecutive chunks of one stream, transcribed in one provider request."""

    index: int
    stream_first_seq: int
    seqs: tuple[int, ...]
    start_ms: int          # offset of the part's first chunk in the whole recording
    duration_ms: int
    overlap_ms: int        # audio shared with the previous part of the same stream (0 for a stream's first part)


def streams(chunks: list[ChunkMeta]) -> list[list[ChunkMeta]]:
    """Chunks grouped by recorder stream (a new stream starts after a page reload)."""
    groups: list[list[ChunkMeta]] = []
    for chunk in chunks:
        if chunk.stream_start or not groups:
            groups.append([])
        groups[-1].append(chunk)
    return groups


def plan_parts(chunks: list[ChunkMeta], *, max_bytes: int, max_ms: int, overlap_chunks: int = 1,
               header_bytes: int = 64 * 1024) -> list[Part]:
    """The fewest parts within the provider limits; adjacent parts of a stream share ``overlap_chunks``."""
    parts: list[Part] = []
    for stream in streams(chunks):
        start = 0
        while start < len(stream):
            end = start
            size, duration = header_bytes, 0
            while end < len(stream) and (end == start or (
                    size + stream[end].byte_size <= max_bytes and duration + stream[end].duration_ms <= max_ms)):
                size += stream[end].byte_size
                duration += stream[end].duration_ms
                end += 1
            members = stream[start:end]
            previous_end = parts[-1].seqs[-1] if parts and parts[-1].stream_first_seq == stream[0].seq else None
            overlap = sum(item.duration_ms for item in members if previous_end is not None and item.seq <= previous_end)
            parts.append(Part(index=len(parts), stream_first_seq=stream[0].seq, seqs=tuple(item.seq for item in members),
                              start_ms=members[0].start_ms, duration_ms=duration, overlap_ms=overlap))
            if end >= len(stream):
                break
            # Step back so the next part repeats the last chunk(s): speakers are matched across that overlap.
            start = max(end - overlap_chunks, start + 1)
    return parts


# ----- MP4 / Ogg framing -----------------------------------------------------------------------------
def _mp4_boxes(data: bytes):
    offset = 0
    while offset + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[offset:offset + 8])
        if size == 1 and offset + 16 <= len(data):
            size = struct.unpack(">Q", data[offset + 8:offset + 16])[0]
        if size < 8:
            return
        yield offset, kind, size
        offset += size


def _mp4_init_segment(data: bytes) -> bytes | None:
    """``ftyp`` + ``moov`` (everything before the first ``moof``)."""
    for offset, kind, _ in _mp4_boxes(data):
        if kind == b"moof":
            return data[:offset] if offset > 0 else None
    return None


def _mp4_box_offset(data: bytes, kind: bytes) -> int:
    """Offset of the first real ``moof`` box (its first child is ``mfhd``); a piece may start mid-box."""
    search = 0
    while True:
        index = data.find(kind, search)
        if index == -1:
            return -1
        size = struct.unpack(">I", data[index - 4:index])[0] if index >= 4 else 0
        if size >= 16 and data[index + 8:index + 12] == b"mfhd":
            return index - 4
        search = index + 1


def _ogg_header_pages(data: bytes) -> bytes | None:
    """The Ogg pages before the first audio page (Opus: OpusHead and OpusTags, granule position 0)."""
    offset = 0
    while offset + 27 <= len(data) and data[offset:offset + 4] == _OGG_PAGE:
        granule = struct.unpack("<q", data[offset + 6:offset + 14])[0]
        segments = data[offset + 26]
        table_end = offset + 27 + segments
        if table_end > len(data):
            return None
        body = sum(data[offset + 27:table_end])
        if granule > 0:
            return data[:offset] if offset else None
        offset = table_end + body
    return data[:offset] if offset else None
