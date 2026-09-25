"""Compare reviewed transcript turns with a human-labeled reference.

Usage: python3 scripts/speaker_eval.py transcript.json reference.json

reference.json is an object of {"segment_id": "actual speaker name"}; use null for
an honestly unidentifiable turn. A value may also be
{"speaker": "Alice", "language": "es", "overlap": true}. This measures
turn-level attribution, not audio DER.
"""

import argparse
import json
from pathlib import Path


def _truth(value: object) -> tuple[str | None, str | None, bool | None]:
    if isinstance(value, dict):
        speaker = value.get("speaker")
        language = value.get("language")
        overlap = value.get("overlap")
        return (str(speaker) if speaker is not None else None,
                str(language) if language else None,
                overlap if isinstance(overlap, bool) else None)
    return (str(value) if value is not None else None, None, None)


def _overlaps(segment: dict, others: list[dict]) -> bool:
    start = segment.get("start_seconds", segment.get("start"))
    end = segment.get("end_seconds", segment.get("end"))
    if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
        return False
    return any(
        other is not segment
        and isinstance(other.get("start_seconds", other.get("start")), (int, float))
        and isinstance(other.get("end_seconds", other.get("end")), (int, float))
        and start < other.get("end_seconds", other.get("end"))
        and other.get("start_seconds", other.get("start")) < end
        for other in others
    )


def evaluate(transcript: dict, reference: dict[str, object]) -> dict[str, object]:
    segments = [item for item in transcript.get("segments", []) if item.get("completed", True)]
    by_id = {str(item.get("segment_id")): item for item in segments if item.get("segment_id")}
    missing = sorted(set(reference) - set(by_id))
    named = sum(bool(item.get("speaker")) for item in segments)
    evaluated = 0
    correct = 0
    false_attributions = 0
    unresolved = 0
    named_correct = 0
    named_predictions = 0
    named_truth = 0
    truth_speakers: set[str] = set()
    languages: dict[str, dict[str, int]] = {}
    overlap_turns = 0
    overlap_correct = 0
    for segment_id, expected_value in reference.items():
        if segment_id not in by_id:
            continue
        segment = by_id[segment_id]
        expected, language, overlap = _truth(expected_value)
        actual = (segment.get("speaker") or "").strip().casefold()
        truth = (expected or "").strip().casefold()
        language = language or segment.get("language") or "undetermined"
        language_bucket = languages.setdefault(language, {"turns": 0, "correct": 0, "false_attributions": 0})
        language_bucket["turns"] += 1
        evaluated += 1
        if truth:
            truth_speakers.add(truth)
            named_truth += 1
        if actual:
            named_predictions += 1
        if actual and actual == truth:
            named_correct += 1
        is_overlap = overlap if overlap is not None else _overlaps(segment, segments)
        if is_overlap:
            overlap_turns += 1
        if actual == truth:
            correct += 1
            language_bucket["correct"] += 1
            if is_overlap:
                overlap_correct += 1
        elif actual and actual != truth:
            false_attributions += 1
            language_bucket["false_attributions"] += 1
        else:
            unresolved += 1
    return {
        "finalized_turns": len(segments),
        "named_coverage": round(named / len(segments), 3) if segments else None,
        "reference_turns_evaluated": evaluated,
        "turn_attribution_accuracy": round(correct / evaluated, 3) if evaluated else None,
        "named_precision": round(named_correct / named_predictions, 3) if named_predictions else None,
        "named_recall": round(named_correct / named_truth, 3) if named_truth else None,
        "reference_speaker_count": len(truth_speakers),
        "overlap_turns": overlap_turns,
        "overlap_accuracy": round(overlap_correct / overlap_turns, 3) if overlap_turns else None,
        "per_language": {
            language: {**bucket, "accuracy": round(bucket["correct"] / bucket["turns"], 3)}
            for language, bucket in sorted(languages.items())
        },
        "false_attributions": false_attributions,
        "unresolved_labeled_turns": unresolved,
        "reference_ids_missing_from_transcript": missing,
        "note": "Turn-level label comparison, not diarization error rate from audio.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcript", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("--require-speakers", type=int, default=0)
    parser.add_argument("--require-languages", type=int, default=0)
    parser.add_argument("--require-overlap", action="store_true")
    parser.add_argument("--min-named-precision", type=float)
    args = parser.parse_args()
    transcript = json.loads(args.transcript.read_text())
    reference = json.loads(args.reference.read_text())
    if not isinstance(transcript, dict) or not isinstance(reference, dict):
        parser.error("transcript and reference must be JSON objects")
    report = evaluate(transcript, reference)
    print(json.dumps(report, indent=2))
    if report["reference_ids_missing_from_transcript"]:
        parser.exit(2, "reference contains missing transcript segment IDs\n")
    if report["reference_speaker_count"] < args.require_speakers:
        parser.exit(2, "reference has too few distinct speakers\n")
    if len(report["per_language"]) < args.require_languages:
        parser.exit(2, "reference has too few languages\n")
    if args.require_overlap and not report["overlap_turns"]:
        parser.exit(2, "reference has no overlapping turns\n")
    if args.min_named_precision is not None and (
        report["named_precision"] is None
        or report["named_precision"] < args.min_named_precision
    ):
        parser.exit(2, "named-speaker precision is below the required threshold\n")


if __name__ == "__main__":
    main()
