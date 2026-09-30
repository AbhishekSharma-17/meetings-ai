"""The approved-minutes recap email: scannable sections in HTML (email-client safe) and plain text.

Order is by what readers act on: summary, counts, decisions, action items, open questions, then the
supporting detail. Tables and inline styles only, so Gmail, Outlook and phones render it the same.
Every piece of meeting content is escaped.
"""

from __future__ import annotations

from datetime import datetime
from html import escape

from .minutes_service import _evidence_times, _human_text

BRAND = "#0e4946"
INK = "#172322"
MUTED = "#5c6b67"
LINE = "#e3ebe8"
PAGE = "#f3f6f5"
FONT = "Arial,Helvetica,sans-serif"
PLATFORM_NAMES = {"google_meet": "Google Meet", "teams": "Microsoft Teams", "zoom": "Zoom", "jitsi": "Jitsi",
                  "in_person": "In person"}


def render_minutes_email(minutes, transcript: list[object], *, include_transcript: bool = False,
                         meeting=None) -> tuple[str, str]:
    times = _evidence_times(transcript)
    human = lambda value: _human_text(value or "", times)
    title = human(minutes.title) or "Meeting recap"
    summary = human(minutes.executive_summary)
    details = _details(meeting, transcript)
    decisions = [human(item) for item in minutes.decisions if item.strip()]
    actions = [_action(item, times, human) for item in minutes.action_items]
    questions = [human(item) for item in minutes.open_questions if item.strip()]
    points = [human(item) for item in minutes.discussion_points if item.strip()]
    said = [(item.speaker, human(item.summary)) for item in minutes.speaker_contributions]
    asked = [(item.speaker or "Unidentified speaker", human(item.question)) for item in minutes.questions_asked]
    counts = _counts(len(decisions), len(actions), len(questions))

    body = [
        _card("Summary", f'<p style="margin:0;font-size:15px;line-height:1.65;color:{INK};">{escape(summary)}</p>',
              background="#f0f7f5", border="#d6e9e4"),
        _glance(len(decisions), len(actions), len(questions)),
        _decisions(decisions),
        _actions(actions),
        _open_questions(questions),
        _bullets("Discussion points", points),
        _people("Who said what", said),
        _people("Questions asked", asked),
    ]
    if include_transcript:
        body.append(_note("The full timestamped transcript is attached as a Markdown file."))
    html = _page(title, details, summary, "".join(part for part in body if part))
    text = _plain(title, details, summary, counts, decisions, actions, questions, points, said, asked, include_transcript)
    return html, text


# ----- data ---------------------------------------------------------------------------------------
def _details(meeting, transcript: list[object]) -> list[str]:
    parts: list[str] = []
    when = getattr(meeting, "joined_at", None) or getattr(meeting, "created_at", None)
    if isinstance(when, datetime):
        parts.append(f"{when.day} {when:%b %Y}")
    stopped = getattr(meeting, "stopped_at", None)
    if isinstance(when, datetime) and isinstance(stopped, datetime) and stopped > when:
        parts.append(f"{max(1, round((stopped - when).total_seconds() / 60))} min")
    platform = getattr(getattr(meeting, "platform", None), "value", getattr(meeting, "platform", None))
    if platform:
        parts.append(PLATFORM_NAMES.get(str(platform), str(platform)))
    people = {getattr(item, "speaker", None) for item in transcript if getattr(item, "speaker", None)}
    if people:
        parts.append(f"{len(people)} {'person' if len(people) == 1 else 'people'}")
    return parts


def _action(item, times: dict[str, str], human) -> dict[str, str]:
    moments = list(dict.fromkeys(times[ref] for ref in item.evidence_segment_ids if ref in times))
    return {"task": human(item.description), "owner": (item.owner or "").strip(),
            "due": (item.due_date or "").strip(), "at": moments[0] if moments else ""}


def _counts(decisions: int, actions: int, questions: int) -> str:
    def plural(count: int, word: str) -> str:
        return f"{count} {word}{'' if count == 1 else 's'}"
    return f"{plural(decisions, 'decision')} · {plural(actions, 'action item')} · {plural(questions, 'open question')}"


# ----- HTML blocks ----------------------------------------------------------------------------------
def _page(title: str, details: list[str], summary: str, body: str) -> str:
    meta = " · ".join(escape(part) for part in details)
    preheader = escape(summary[:180])
    return (
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>'
        f'<body style="margin:0;padding:0;background:{PAGE};font-family:{FONT};color:{INK};">'
        f'<div class="preheader" style="display:none;max-height:0;overflow:hidden;opacity:0;">{preheader}</div>'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{PAGE};"><tr><td style="padding:24px 12px;">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid {LINE};border-radius:16px;">'
        f'<tr><td style="padding:26px 28px 24px;background:{BRAND};border-radius:16px 16px 0 0;">'
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr>'
        '<td style="padding-right:10px;vertical-align:middle;"><img src="cid:meetings-ai-logo" width="36" height="36" alt="" style="display:block;border-radius:9px;"></td>'
        '<td style="vertical-align:middle;font-size:15px;font-weight:700;color:#ffffff;">Meetings AI</td></tr></table>'
        '<p style="margin:22px 0 6px;font-size:11px;font-weight:700;letter-spacing:2px;color:#bfe3dc;">MEETING RECAP</p>'
        f'<h1 style="margin:0;font-size:24px;line-height:1.3;color:#ffffff;">{escape(title)}</h1>'
        + (f'<p style="margin:10px 0 0;font-size:13px;color:#d3ece7;">{meta}</p>' if meta else "")
        + f'</td></tr><tr><td style="padding:24px 28px 8px;">{body}</td></tr>'
        f'<tr><td style="padding:16px 28px 22px;border-top:1px solid {LINE};font-size:12px;line-height:1.5;color:{MUTED};">'
        'Prepared by Meetings AI from the meeting transcript and approved before sending. '
        'Please check important details against the transcript.</td></tr></table></td></tr></table></body></html>'
    )


def _heading(label: str, count: int | None = None, color: str = BRAND) -> str:
    badge = (f' <span style="display:inline-block;margin-left:6px;padding:1px 8px;border-radius:10px;'
             f'background:{PAGE};color:{MUTED};font-size:12px;font-weight:600;">{count}</span>') if count else ""
    return f'<h2 style="margin:0 0 12px;font-size:16px;line-height:1.3;color:{color};">{escape(label)}{badge}</h2>'


def _card(label: str, inner: str, *, background: str = "#ffffff", border: str = LINE, color: str = BRAND,
          count: int | None = None) -> str:
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;'
            f'background:{background};border:1px solid {border};border-radius:12px;"><tr><td style="padding:18px 20px;">'
            f'{_heading(label, count, color)}{inner}</td></tr></table>')


def _glance(decisions: int, actions: int, questions: int) -> str:
    def tile(value: int, label: str, color: str) -> str:
        return (f'<td width="33%" style="padding:12px 8px;text-align:center;border:1px solid {LINE};border-radius:10px;">'
                f'<div style="font-size:22px;font-weight:700;color:{color};">{value}</div>'
                f'<div style="margin-top:2px;font-size:12px;color:{MUTED};">{label}</div></td>')
    gap = '<td width="8" style="font-size:0;">&nbsp;</td>'
    return (f'<p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:{MUTED};">At a glance</p>'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr>'
            f'{tile(decisions, "Decisions", "#1f7a4d")}{gap}{tile(actions, "Action items", BRAND)}{gap}'
            f'{tile(questions, "Open questions", "#9a6700")}</tr></table>')


def _decisions(items: list[str]) -> str:
    if not items:
        return ""
    rows = "".join(
        '<tr><td width="28" style="padding:4px 0;vertical-align:top;">'
        '<span style="display:inline-block;width:20px;height:20px;line-height:20px;border-radius:10px;'
        'background:#e3f4ea;color:#1f7a4d;font-size:12px;font-weight:700;text-align:center;">&#10003;</span></td>'
        f'<td style="padding:4px 0 8px;font-size:14px;line-height:1.55;color:{INK};">{escape(item)}</td></tr>'
        for item in items)
    return _card("Decisions", f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows}</table>',
                 color="#1f7a4d", count=len(items))


def _actions(items: list[dict[str, str]]) -> str:
    if not items:
        return ""
    cards = []
    for number, item in enumerate(items, 1):
        owner = (f'<b style="color:{INK};">{escape(item["owner"])}</b>' if item["owner"]
                 else f'<i style="color:{MUTED};">Unassigned</i>')
        due = f'due <b style="color:{INK};">{escape(item["due"])}</b>' if item["due"] else f'<i style="color:{MUTED};">No date</i>'
        at = f' &nbsp;·&nbsp; <span style="white-space:nowrap;">At {escape(item["at"])}</span>' if item["at"] else ""
        cards.append(
            f'<tr><td style="padding:0 0 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'style="border:1px solid {LINE};border-radius:10px;"><tr>'
            f'<td width="34" style="padding:12px 0 12px 12px;vertical-align:top;"><span style="display:inline-block;width:22px;height:22px;'
            f'line-height:22px;border-radius:11px;background:{BRAND};color:#ffffff;font-size:12px;font-weight:700;text-align:center;">{number}</span></td>'
            f'<td style="padding:12px 14px 12px 6px;"><div style="font-size:14px;font-weight:600;line-height:1.45;color:{INK};">{escape(item["task"])}</div>'
            f'<div style="margin-top:4px;font-size:12px;color:{MUTED};">{owner} &nbsp;·&nbsp; {due}{at}</div></td></tr></table></td></tr>')
    return _card("Action items", f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(cards)}</table>',
                 count=len(items))


def _open_questions(items: list[str]) -> str:
    if not items:
        return ""
    rows = "".join(f'<li style="margin:0 0 6px;">{escape(item)}</li>' for item in items)
    return _card("Open questions", f'<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.55;color:{INK};">{rows}</ul>',
                 background="#fff8e8", border="#f1dfb4", color="#9a6700", count=len(items))


def _bullets(label: str, items: list[str]) -> str:
    if not items:
        return ""
    rows = "".join(f'<li style="margin:0 0 6px;">{escape(item)}</li>' for item in items)
    return _card(label, f'<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.55;color:{INK};">{rows}</ul>')


def _people(label: str, items: list[tuple[str, str]]) -> str:
    if not items:
        return ""
    rows = "".join(
        f'<tr><td width="40" style="padding:0 0 12px;vertical-align:top;"><span style="display:inline-block;width:30px;height:30px;'
        f'line-height:30px;border-radius:15px;background:{PAGE};color:{BRAND};font-size:12px;font-weight:700;text-align:center;">'
        f'{escape(_initials(name))}</span></td><td style="padding:0 0 12px;font-size:14px;line-height:1.5;color:{INK};">'
        f'<b>{escape(name)}</b><br><span style="color:{MUTED};">{escape(text)}</span></td></tr>'
        for name, text in items)
    return _card(label, f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows}</table>')


def _note(text: str) -> str:
    return (f'<p style="margin:0 0 18px;padding:12px 16px;border-radius:10px;background:{PAGE};font-size:13px;'
            f'color:{MUTED};">&#128206; {escape(text)}</p>')


def _initials(name: str) -> str:
    if name == "Unidentified speaker":
        return "?"
    words = [word for word in name.replace("-", " ").split() if word[:1].isalpha()]
    return "".join(word[0] for word in (words[:1] + words[-1:] if len(words) > 1 else words)).upper() or "?"


# ----- plain text -----------------------------------------------------------------------------------
def _plain(title, details, summary, counts, decisions, actions, questions, points, said, asked, include_transcript) -> str:
    lines = ["MEETING RECAP", title]
    if details:
        lines.append(" · ".join(details))
    lines += ["", "SUMMARY", summary, "", f"At a glance: {counts}"]

    def section(label: str, rows: list[str]) -> None:
        if rows:
            lines.extend(["", label.upper(), *rows])

    section("Decisions", [f"✓ {item}" for item in decisions])
    section("Action items", [
        f"{number}. {item['task']} — {item['owner'] or 'Unassigned'} · "
        f"{'due ' + item['due'] if item['due'] else 'no date'}{' · at ' + item['at'] if item['at'] else ''}"
        for number, item in enumerate(actions, 1)])
    section("Open questions", [f"? {item}" for item in questions])
    section("Discussion points", [f"• {item}" for item in points])
    section("Who said what", [f"{name}: {text}" for name, text in said])
    section("Questions asked", [f"{name}: {text}" for name, text in asked])
    if include_transcript:
        lines += ["", "The full timestamped transcript is attached as a Markdown file."]
    lines += ["", "Prepared by Meetings AI from the meeting transcript and approved before sending."]
    return "\n".join(lines)
