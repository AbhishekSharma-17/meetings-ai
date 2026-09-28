"""Who's who for meeting prep: our company is never the target; attendees land on the right side."""

from types import SimpleNamespace

import pytest

from app.prep_parties import (
    TARGET_IS_US_MESSAGE, OurIdentity, PartyInputs, attendee_key, company_key, counterpart_from_title,
    is_system_address, resolve_parties,
)

US = OurIdentity(name="GenAI Protos", aliases=("GAP",), domains=frozenset({"genaiprotos.com"}), configured=True)


def person(name, email=None):
    return SimpleNamespace(name=name, email=email)


def sides(result):
    return {item.name: item.side for item in result.attendees}


def test_our_domain_is_never_the_target_even_when_it_is_the_most_common():
    invitees = [person("Me", "me@genaiprotos.com"), person("Ann", "ann@genaiprotos.com"),
                person("Bo", "bo@sales.genaiprotos.com"), person("Asha Patel", "asha@acme.io")]
    result = resolve_parties(US, PartyInputs(), invitees, title="Weekly sync")
    assert result.target.domains == ["acme.io"] and result.target.source == "email_domain"
    assert result.target.reason == "From email domain acme.io"
    assert sides(result) == {"Me": "ours", "Ann": "ours", "Bo": "ours", "Asha Patel": "theirs"}


def test_resource_group_and_noreply_addresses_are_ignored():
    invitees = [
        person("Room 4", "c_1889@resource.calendar.google.com"),
        person("Team calendar", "abc123@group.calendar.google.com"),
        person("Zoom", "no-reply@zoom.us"), person("Calendly", "notifications@calendly.com"),
        person("Board room", "boardroom@acme.io"), person("Me", "me@genaiprotos.com"),
    ]
    result = resolve_parties(US, PartyInputs(), invitees, title="GenAI Protos <> Globex weekly")
    assert [item.name for item in result.attendees] == ["Me"]
    assert len(result.ignored) == 5
    # Nothing external in the invite: the counterpart comes from the title.
    assert result.target.name == "Globex" and result.target.source == "event_title"
    assert is_system_address(None, "donotreply@acme.io") and not is_system_address("Asha", "asha@acme.io")


@pytest.mark.parametrize(("title", "expected"), [
    ("GenAI Protos <> Acme weekly", "Acme"),
    ("Acme x GenAI Protos", "Acme"),
    ("Acme | GenAI Protos | QBR", "Acme"),
    ("GenAI Protos / Acme Robotics", "Acme Robotics"),
    ("Acme Robotics - Weekly sync", "Acme Robotics"),
    ("Weekly sync with Acme", "Acme"),
    ("GenAI Protos and Acme", "Acme"),
    ("GAP vs Initech: pricing", "Initech"),
    ("Invitation: GenAI Protos <> Acme @ Mon Oct 6, 2026 2pm", "Acme"),
    ("Budget and planning", None),
    ("Design review", None),
    ("Lunch with Asha", None),  # a person in the invite is not a company
    ("GenAI Protos <> GAP", None),
])
def test_counterpart_from_title(title, expected):
    assert counterpart_from_title(title, US, ["Asha Patel"]) == expected


def test_explicit_target_equal_to_us_is_dropped_with_a_warning():
    invitees = [person("Me", "me@genaiprotos.com"), person("Asha Patel", "asha@acme.io")]
    for inputs in (PartyInputs(target_company="GenAI-Protos, Inc."), PartyInputs(target_company="gap"),
                   PartyInputs(company_website="https://www.genaiprotos.com/about")):
        result = resolve_parties(US, inputs, invitees, title="Kickoff")
        assert [warning.code for warning in result.warnings] == ["target_is_us"]
        assert result.warnings[0].message == TARGET_IS_US_MESSAGE
        # Research continues with the remaining signals instead of researching ourselves.
        assert result.target.domains == ["acme.io"] and result.target.source == "email_domain"
        assert sides(result)["Asha Patel"] == "theirs"


def test_explicit_target_keeps_the_side_that_is_not_us():
    result = resolve_parties(US, PartyInputs(target_company="GenAI Protos", company_website="https://acme.io"),
                             [person("Asha Patel", "asha@acme.io")])
    assert result.target.name is None and result.target.domains == ["acme.io"] and result.target.source == "inputs"
    assert [warning.code for warning in result.warnings] == ["target_is_us"]


def test_attendee_classification_with_third_parties_free_mail_and_overrides():
    invitees = [person("Me", "me@genaiprotos.com"), person("Asha Patel", "asha@acme.io"),
                person("Ben Ortiz", "ben@acme.io"), person("Vendor Val", "val@globex.com"),
                person("Gee Mail", "gee@gmail.com"), person("No Email"), person("Contractor", "c@gmail.com")]
    overrides = {"c@gmail.com": "ours", attendee_key("No Email", None): "theirs"}
    result = resolve_parties(US, PartyInputs(target_company="Acme", overrides=overrides), invitees)
    assert result.target.name == "Acme" and result.target.domains == ["acme.io"]
    assert sides(result) == {
        "Me": "ours", "Asha Patel": "theirs", "Ben Ortiz": "theirs", "Vendor Val": "other_external",
        "Gee Mail": "unknown", "No Email": "theirs", "Contractor": "ours",
    }
    reasons = {item.name: item.reason for item in result.attendees}
    assert reasons["Me"] == "Email domain genaiprotos.com is yours"
    assert reasons["Vendor Val"] == "Another company (globex.com)"
    assert reasons["Gee Mail"].startswith("Personal email")
    assert {item.name for item in result.attendees if item.overridden} == {"No Email", "Contractor"}


def test_override_to_ours_removes_a_domain_from_target_inference():
    invitees = [person("Partner", "p@partnerco.com"), person("Partner 2", "q@partnerco.com"),
                person("Asha Patel", "asha@acme.io")]
    result = resolve_parties(US, PartyInputs(overrides={"p@partnerco.com": "ours", "q@partnerco.com": "ours"}),
                             invitees)
    assert result.target.domains == ["acme.io"]


def test_title_name_is_attached_to_the_inferred_domain_only_when_it_matches():
    invitees = [person("Asha Patel", "asha@acmerobotics.com")]
    named = resolve_parties(US, PartyInputs(), invitees, title="GenAI Protos <> Acme Robotics")
    assert named.target.name == "Acme Robotics" and named.target.domains == ["acmerobotics.com"]
    other = resolve_parties(US, PartyInputs(), invitees, title="GenAI Protos <> Initech")
    assert other.target.name is None and other.target.domains == ["acmerobotics.com"]


def test_no_target_and_missing_identity_warnings():
    result = resolve_parties(OurIdentity(), PartyInputs(), [person("Gee", "gee@gmail.com")], title="Catch up")
    assert {warning.code for warning in result.warnings} == {"no_target", "identity_missing"}
    assert result.target.source == "none"


def test_company_key_ignores_case_punctuation_and_legal_suffixes():
    assert company_key("GenAI Protos Pvt. Ltd.") == company_key("genai-protos") == "genaiprotos"
    assert US.is_us("GENAIPROTOS") and US.is_us("genaiprotos.com") and US.is_us("mail.genaiprotos.com")
    assert not US.is_us("Acme") and not US.is_us("protos.io")


def test_dropped_target_name_is_replaced_by_the_matching_title_counterpart():
    result = resolve_parties(US, PartyInputs(target_company="GenAI Protos", company_website="https://www.acme.io"),
                             [person("Asha Patel", "asha@acme.io")], title="GenAI Protos <> Acme weekly")
    assert result.target.name == "Acme" and result.target.domains == ["acme.io"]
    assert [warning.code for warning in result.warnings] == ["target_is_us"]
