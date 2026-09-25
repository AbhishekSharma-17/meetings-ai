# Meetings AI internal MVP acceptance

Automated tests prove the product and Vexa fork agree on request shapes. They do
not prove that a particular meeting platform admits the bot or produces good
speaker attribution. Run this checklist with consenting internal participants.

## Before the live witness

1. Rotate the OpenAI, OpenRouter, Resend, and Vexa credentials previously pasted
   into chat. Put replacements only in ignored local environment files.
2. Confirm the product API, Vexa Lite, PostgreSQL, and web app are healthy.
   `make check` and the Vexa bot-spawn tests must pass.
3. Confirm Vexa `/health` advertises `features.signed_stt_override=true`.
   A product transcription default without this capability must refuse the
   join; it must not silently use Vexa's deployment STT route.
4. In **AI providers**, choose a transcription profile and a MOM profile.
   Validate their configuration. Profile validation checks fields, not a live
   provider call. The per-bot route is confirmed by the bot response and the
   meeting's **Transcription runtime** record after join.
5. Use a verified Resend sending domain. Participant email sharing must remain
   off unless the organizer explicitly opts in and supplies exact addresses.

## One platform at a time

Repeat for Google Meet, Zoom, and Teams. Record platform, join URL, date,
profile/model, bot outcome, transcript export, and delivery ID in an internal
test log; do not put secrets or private transcript text in a Git commit.

1. Start a meeting with at least three consenting speakers. Say the disclosure
   aloud: “Meetings AI has joined and will record and transcribe this
   conversation.” Confirm platform recording/notice requirements separately.
2. Send the assistant from Meetings AI. Check lobby admission, displayed bot
   name, runtime route, live transcript, and that an already-running bot keeps
   its original route when the default profile is changed for the next bot.
3. Include a short overlap, at least two languages, an explicit question, a
   decision, and an action with a named owner. Keep a human reference of which
   speaker produced each transcript segment. Unknown turns should remain
   unidentified; do not map invitee emails to voices by inference.
4. Stop the bot. Confirm final transcript persistence, automatic draft creation,
   and that a failed draft can be retried. Correct speaker labels as needed;
   confirm a correction invalidates approval until the MOM is regenerated.
5. Inspect every named contribution, question, and action against its cited
   transcript segment. Approve only after human review. Send to internal test
   addresses first. Verify Resend delivery and message contents. Repeat with
   participant opt-in in a separate test. A sent recap must remain locked.

## Speaker score

Export the transcript JSON from the meeting screen. Prepare a reference JSON
object keyed by `segment_id`, for example:

```json
{
  "segment-a": {"speaker": "Alice", "language": "en", "overlap": false},
  "segment-b": {"speaker": "Bob", "language": "es", "overlap": true},
  "segment-c": {"speaker": "Carol", "language": "en", "overlap": true}
}
```

Run `python3 scripts/speaker_eval.py transcript.json reference.json
--require-speakers 3 --require-languages 2 --require-overlap`. The report gives
turn accuracy, named precision/recall, overlap accuracy, and per-language
breakdowns. Set an explicit `--min-named-precision` threshold for a release
decision after reviewing representative internal recordings. This is not a
diarization-error-rate measurement from raw audio.

Do not mark a platform accepted from synthetic audio, API mocks, or a single
speaker meeting. Keep the three platform results separate.
