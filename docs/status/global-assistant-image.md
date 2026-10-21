# Global assistant image — 2026-10-21

## Scope

One existing Meetings AI logo for every assistant, displayed through a silent
still-image virtual camera. No personal uploads or profile-photo accounts. No
web/API/database change. Implementation and commands:
[assistant image runbook](../deployment/assistant-image.md).

## Verified locally

- Custom digest-pinned Vexa Docker image builds; the modified join TypeScript
  compiles and the existing signed-STT Python overlay compiles.
- Three Python overlay checks pass: only five expected join source files change;
  original audio/microphone/voice-agent lines remain unchanged; upstream drift
  and accidentally applying the overlay twice fail the build.
- 27 browser/media checks pass, including the actual merged bot launch args,
  already-on/off/disabled/unknown/missing camera controls, Meet's delegated click
  handler, kill-switch behavior, and no camera retry loop.
- Two independent Chromium processes exchange real local WebRTC media. The
  observer receives the Meetings AI logo; the bot publishes no audio track,
  receives non-silent remote participant audio, and has a silent fake microphone
  rather than Chromium's generated test tone. The observer adapts the 640×360
  source to 320×180 in this local test; aspect ratio and logo pixels are checked.
- The upstream join regression suite passes with branding disabled. These
  are fixture/unit checks, not evidence of admission to an external meeting.
- The Vexa Git submodule is unchanged; no new dependencies or upstream upgrade.

## Not yet validated

- Visibility from another participant in an admitted **Google Meet** call.
- Visibility from another participant in an admitted **Microsoft Teams** call.
- End-to-end transcription/MOM/email with the newly branded bot in those calls.
- Zoom and Jitsi live-call acceptance.

## Production rollout: pending, not deployed

The production web page still responds HTTP 200. The last observed successful
Vexa deployment remains `0af0b839-a2f6-4c31-9254-b806db6a9210` (the previous image).
No production service or variable was changed for this feature.

Railway CLI identifies GenAi Protos and the correct Meetings Ai project, but
service-variable reads fail with `Problem processing request` (both current and
previous CLI). Railway SSH port 22 is refused. Existing local app credentials
did not authenticate to production; no password was reset or bypassed. Thus an
all-workspace active-call and imminent-schedule check could not be completed.
Quiet logs and a healthy web page are not sufficient evidence of idleness.

Do not replace the Vexa instance until working access is restored and no calls
would be interrupted. The user has been asked to refresh Railway authentication.
After that, check all active calls and imminent schedules, deploy **only Vexa**,
verify startup and signed-STT health, then perform the consented Teams/Meet
acceptance checks in the runbook. Update this release record with the deployment
ID and observed results; do not mark those acceptance checks passed prematurely.
