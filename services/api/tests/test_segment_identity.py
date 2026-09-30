"""Vexa re-keys a segment after publishing it (`<key>:<start ms>` becomes `<key>:<sequence>`).

Speaker corrections and minutes evidence are stored by segment ID, so each sentence must keep one ID
across transcript refreshes or both silently break.
"""

from app.meeting_service import _segment


def _vexa(segment_id: str, start: float, **extra) -> dict:
    return {"segment_id": segment_id, "start": start, "end": start + 2, "text": "Hello there", "speaker": "Abdulrahiman Kunnummal",
            "speaker_key": segment_id.rsplit(":", 1)[0], "completed": True, **extra}


def test_a_re_keyed_segment_keeps_its_original_time_based_id() -> None:
    # Same sentence, as first published and after Vexa re-keyed it (real IDs from a Teams meeting).
    first = _segment(_vexa("csrc-2970:11:1790752587221", 1790752587.221))
    later = _segment(_vexa("csrc-2970:11:0", 1790752587.221))
    assert first.segment_id == "csrc-2970:11:1790752587221"
    assert later.segment_id == first.segment_id


def test_other_sequence_numbers_map_to_their_own_start_time() -> None:
    assert _segment(_vexa("csrc-2757:15:3", 1790751215.829)).segment_id == "csrc-2757:15:1790751215829"


def test_ids_that_are_not_re_keyed_are_left_alone() -> None:
    # Relative (non-epoch) starts, non-numeric suffixes and IDs without a stream key stay as sent.
    assert _segment(_vexa("spk-1:4", 12.5)).segment_id == "spk-1:4"
    assert _segment(_vexa("csrc-9:2:abc", 1790752587.221)).segment_id == "csrc-9:2:abc"
    assert _segment(_vexa("plain-id", 1790752587.221)).segment_id == "plain-id"
    assert _segment({"segment_id": "turn:7:2", "start": 1790752587.2, "text": "x"}).segment_id == "turn:7:2"  # no speaker_key


def test_a_key_that_does_not_prefix_the_id_is_left_alone() -> None:
    assert _segment(_vexa("csrc-1:2:0", 1790752587.221, speaker_key="other")).segment_id == "csrc-1:2:0"
