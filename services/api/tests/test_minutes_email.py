"""The recap email: clearly separated, scannable sections in HTML and plain text."""

import re
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from meetings_contracts import MeetingPlatform

from app.minutes_email import render_minutes_email

JOINED = datetime(2026, 9, 30, 6, 38, tzinfo=UTC)


def _segments():
    return [
        SimpleNamespace(segment_id="s1", start_seconds=1000.0, completed=True, speaker="Priya Nair", text="Let's lock the plan."),
        SimpleNamespace(segment_id="s4", start_seconds=1052.0, completed=True, speaker="Dana Ortiz", text="I'll share the doc by Friday."),
    ]


def _minutes(**overrides):
    values = {
        "title": "Acme — Q4 roadmap",
        "executive_summary": "The team agreed to ship SSO in October and move audit logs to November.",
        "discussion_points": ["Release sequencing for October and November."],
        "decisions": ["Ship SSO in the October release.", "Move audit logs to November."],
        "action_items": [
            SimpleNamespace(description="Share the SSO design doc", owner="Dana Ortiz", due_date="Friday", evidence_segment_ids=["s4"]),
            SimpleNamespace(description="Book the legal review", owner=None, due_date=None, evidence_segment_ids=[]),
        ],
        "open_questions": ["When will data residency be decided?"],
        "speaker_contributions": [SimpleNamespace(speaker="Priya Nair", summary="Set the goal and the release split.")],
        "questions_asked": [SimpleNamespace(speaker=None, question="Who signs off on the DPA?")],
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _meeting():
    return SimpleNamespace(platform=MeetingPlatform.TEAMS, created_at=JOINED, joined_at=JOINED,
                           stopped_at=JOINED + timedelta(minutes=50))


def _render(**overrides):
    return render_minutes_email(_minutes(**overrides), _segments(), include_transcript=True, meeting=_meeting())


def test_sections_are_labelled_in_order_of_importance() -> None:
    html, _ = _render()
    labels = ["Summary", "At a glance", "Decisions", "Action items", "Open questions",
              "Discussion points", "Who said what", "Questions asked"]
    positions = [html.index(label) for label in labels]
    assert positions == sorted(positions)


def test_action_items_show_owner_due_date_and_the_moment_it_was_said() -> None:
    html, text = _render()
    assert "Share the SSO design doc" in html and "Dana Ortiz" in html and "Friday" in html
    assert "At 00:52" in html
    assert "Unassigned" in html and "No date" in html
    assert "1. Share the SSO design doc — Dana Ortiz · due Friday · at 00:52" in text
    assert "2. Book the legal review — Unassigned · no date" in text


def test_at_a_glance_counts_what_needs_attention() -> None:
    _, text = _render()
    assert "2 decisions · 2 action items · 1 open question" in text


def test_meeting_details_line() -> None:
    html, text = _render()
    for part in ("30 Sep 2026", "50 min", "Microsoft Teams", "2 people"):
        assert part in html and part in text


def test_empty_sections_are_left_out() -> None:
    html, text = _render(open_questions=[], questions_asked=[], discussion_points=[])
    for label in ("Open questions", "Questions asked", "Discussion points"):
        assert not re.search(rf"<h2[^>]*>{label}", html)  # no section heading for an empty section
    assert "0 open questions" in text


def test_meeting_content_is_escaped_everywhere() -> None:
    html, _ = _render(
        title="Client <script>alert(1)</script>",
        action_items=[SimpleNamespace(description="Fix <b>bold</b>", owner="<i>Eve</i>", due_date="<u>soon</u>", evidence_segment_ids=[])],
        speaker_contributions=[SimpleNamespace(speaker="<img src=x>", summary="<svg onload=1>")],
    )
    for raw in ("<script>", "<b>bold", "<i>Eve", "<u>soon", "<img src=x>", "<svg onload"):
        assert raw not in html
    assert "&lt;script&gt;" in html and "&lt;i&gt;Eve&lt;/i&gt;" in html


def test_inbox_preview_uses_the_summary_and_transcript_note_is_shown() -> None:
    html, text = _render()
    assert 'class="preheader"' in html and "The team agreed to ship SSO" in html.split('class="preheader"', 1)[1][:400]
    assert "transcript is attached" in html.lower() and "transcript is attached" in text.lower()


def test_works_without_meeting_details() -> None:
    html, text = render_minutes_email(_minutes(), _segments(), include_transcript=False)
    assert "Decisions" in html and "transcript is attached" not in text.lower()
