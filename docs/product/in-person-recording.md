# In-person recording

Face-to-face meetings recorded from a phone or laptop browser become normal meetings with platform
`in_person`. The flow is: transcript with speakers, then names you approve, then minutes, knowledge, recap
and notifications. No assistant joins anything, and Vexa is never called for these meetings.

## Flow

1. **Consent.** All-party consent is required. The recorder must confirm "Everyone present has agreed to be
   recorded". They can also show or read aloud an on-screen notice. The server refuses to create a recording
   without that confirmation (HTTP 422). The session keeps the confirmation time, who recorded, and whether
   the notice was shown.
2. **Recording.** The browser uses MediaRecorder with `audio/webm;codecs=opus`, or `audio/mp4` on iOS Safari.
   It cuts the audio into 15 s timeslices and uploads numbered chunks in strict order. Chunks are buffered in
   IndexedDB so they survive network drops.
   - The server accepts only the next sequence number. A resent chunk is a harmless duplicate, and a gap
     returns 409 with the `expected_seq`.
   - It also checks the recorder, the audio type, and size and time limits (see below).
3. **Live captions.** Each new chunk is transcribed with the workspace's **Speech to text** profile, text only.
   A later chunk is only decodable with the stream header, so the header from chunk 0 is put in front of it.
   - At most one caption request per meeting runs at a time, and at most 8 per person per minute. A backlog
     after going offline is captioned only at its newest chunk.
   - Captions are a preview. They are deleted with the audio.
4. **Stop and final pass.** A background job (`in_person_finalize`) does the final pass:
   1. Assembles the chunks in order.
   2. Transcribes them with diarization.
   3. Reconciles speakers across parts.
   4. Saves `Speaker A/B/…` transcript segments.
   5. Suggests speaker names.
   6. Marks the meeting completed.
   7. Deletes the audio.

   Completing the meeting starts the normal post-meeting pipeline (minutes draft, knowledge indexing,
   notifications). Moments marked while recording are added to the meeting's minutes guidance.
5. **Names.** The workspace text model proposes a name for each speaker label. It uses names said aloud, self
   introductions, and calendar invitees or people the recorder listed, under a strict JSON schema.
   - Each proposal carries verified evidence: a quote that really occurs in the transcript, with its time.
   - Nothing is applied until someone approves it. Approving renames every line with that label, using the
     same speaker correction a person can make by hand.
   - After that, the usual speaker-contact (email) suggestions apply.

## Speech-to-text requests

These shapes are implemented in `services/api/app/in_person_stt.py` and were checked against the provider docs
on 2026-09-29.

| Profile | Request | Diarization |
| --- | --- | --- |
| OpenRouter (`https://openrouter.ai/api/v1`) | `POST /audio/transcriptions`, JSON `{model, input_audio: {data: base64, format: webm\|m4a\|ogg}, response_format, timestamp_granularities: ["segment","word"], diarize: true, language?}` | `response_format=verbose_json` + `diarize=true`. Speakers come in `segments[].speaker` or `speaker_label`, or in `words[]`. `usage.cost` is recorded as provider-reported cost. |
| OpenAI `gpt-4o-transcribe-diarize` | multipart `POST /v1/audio/transcriptions` with `file`, `model`, `response_format=diarized_json`, `chunking_strategy=auto` | Speakers `A`, `B`, … on `segments[]` |
| Other OpenAI / OpenAI-compatible | multipart with `verbose_json` (Whisper-style segments), else `json` | none: single "Speaker" |

A 400 for an optional feature steps down to a simpler request: diarize, then verbose_json, then json. If the
model returns no speaker labels, everything is saved under one "Speaker". The UI then explains that lines can
be renamed or reassigned by hand.

Sources:
- https://openrouter.ai/docs/guides/overview/multimodal/stt.md
- https://openrouter.ai/docs/api/api-reference/stt/create-transcription.md
- https://openrouter.ai/google/gemini-3.5-transcribe
- https://developers.openai.com/api/docs/guides/speech-to-text.md
- https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize.md

## Limits

| Limit | Value | Why |
| --- | --- | --- |
| Chunk size | 2 MB | A 15 s opus chunk is about 60 KB |
| Chunk duration | 20 s | 15 s timeslice plus slack |
| Recording length | 4 hours | Same cap as an online capture. The chunk that crosses 4 h is kept and later ones are refused. |
| Recording size | 400 MB | |
| Part per request (OpenRouter) | 10 min (`IN_PERSON_STT_PART_SECONDS`, 60–3600) | Gemini 3.5 Transcribe allows 30 min with diarization, but OpenRouter's upstream timeout is 60 s per request |
| Part per request (OpenAI diarize) | 7 min (`IN_PERSON_STT_DIARIZE_PART_SECONDS`) | 2,000 output tokens per request |
| Part size | 20 MB (OpenRouter), 24 MB (OpenAI) | OpenAI files are limited to 25 MB |

Recordings longer than one part are split at chunk boundaries into the largest allowed parts. Adjacent parts
share one 15 s chunk of overlap.
- A part's speaker labels are matched to the running labels by how long they speak at the same time in the
  overlap.
- Labels the overlap cannot settle go to a continuity check by the workspace text model. That covers a person
  silent in the overlap, or a new stream after a page reload.
- The model may only map a label to an existing speaker or leave it new.
- The overlap is cut at its midpoint so nothing appears twice.

## Retention

Raw audio is stored in PostgreSQL (`in_person_chunks`, schema v30) only until the final transcript is saved,
then deleted. There is no option to keep it.

A cleanup loop runs only in the background leader process:
- It deletes the audio of a session with no activity for 24 hours and marks the session failed.
- It marks a final pass that has been interrupted for 2 hours as failed. The recorder can retry while audio
  remains.
- It removes audio left behind by a crash after a successful pass.

## Access

- Owners, admins and members may record. Viewers may not.
- Only the recorder may upload, pause, mark moments, stop or discard.
- The recorder and workspace admins may view a recording and name its speakers.
- The recorder owns the meeting, so a member can open it like any meeting they own.
- Audio is sent only to the configured speech-to-text provider. Audio and transcript text are never logged.

## Needs real-device and real-model verification

- iPhone Safari: `audio/mp4` fragment framing, stopping when the screen locks or the app is switched, and
  Wake Lock support.
- Android Chrome background behaviour.
- The Gemini 3.5 Transcribe diarization route. OpenRouter documents a top-level `diarize`; a 400 falls back to
  undiarized.
- Timestamps of mid-stream parts: they are assumed to be relative to the start of the part audio.
- Diarization quality with overlapping speech and more than 8 speakers.
