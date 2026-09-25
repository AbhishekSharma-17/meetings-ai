import importlib.util
from pathlib import Path


def test_turn_attribution_report_distinguishes_unknown_from_wrong_name():
    path = Path(__file__).resolve().parents[3] / "scripts" / "speaker_eval.py"
    spec = importlib.util.spec_from_file_location("speaker_eval", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    report = module.evaluate({"segments": [
        {"segment_id": "s1", "speaker": "Alice", "completed": True},
        {"segment_id": "s2", "speaker": None, "completed": True},
        {"segment_id": "s3", "speaker": "Bob", "completed": True},
    ]}, {"s1": "Alice", "s2": "Carol", "s3": "Eve"})
    assert report["named_coverage"] == 0.667
    assert report["turn_attribution_accuracy"] == 0.333
    assert report["false_attributions"] == 1
    assert report["unresolved_labeled_turns"] == 1


def test_multilingual_overlapping_three_speaker_breakdown():
    path = Path(__file__).resolve().parents[3] / "scripts" / "speaker_eval.py"
    spec = importlib.util.spec_from_file_location("speaker_eval", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    report = module.evaluate({"segments": [
        {"segment_id": "s1", "speaker": "Alice", "start": 0, "end": 3, "language": "en"},
        {"segment_id": "s2", "speaker": "Bob", "start": 2, "end": 4, "language": "es"},
        {"segment_id": "s3", "speaker": None, "start": 5, "end": 7, "language": "hi"},
    ]}, {
        "s1": {"speaker": "Alice", "language": "en"},
        "s2": {"speaker": "Bob", "language": "es"},
        "s3": {"speaker": "Carol", "language": "hi", "overlap": False},
    })
    assert report["reference_speaker_count"] == 3
    assert report["overlap_turns"] == 2
    assert report["overlap_accuracy"] == 1.0
    assert report["named_precision"] == 1.0
    assert report["named_recall"] == 0.667
    assert set(report["per_language"]) == {"en", "es", "hi"}
