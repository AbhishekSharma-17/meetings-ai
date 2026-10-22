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

## Production rollout: blocked by Railway build outage, not deployed

### Access restored on 22 October 2026

The user reauthenticated Railway as GenAi Protos (`developer@genaiprotos.com`).
CLI variable reads and SSH now work. The previous access blocker is resolved.
Checks were read-only except for the explicitly authorized Vexa deployment
attempts below; no credential values were printed or added to Git.

- Checked both product and Vexa databases across **all workspaces**, using
  separate database roles and read-only transactions. Vexa had zero nonterminal
  meetings; product records had no active captures or running background jobs.
- No scheduled joins overlapped the next 30 minutes at the preflight check.
- Inspected runtime worker processes: zero bot workers. Authenticated Vexa
  `/bots/status` also returned zero running bots, using the product's existing
  capture key passed over SSH stdin rather than command-line arguments.
- Gateway health returned `status=ok` and `signed_stt_override=true`.
- Production's configured bootstrap admin password did not authenticate to the
  product UI. No account was reset or bypassed; infrastructure access supplied
  the required checks instead.

### Deployment attempts

| Deployment | Result |
| --- | --- |
| `e736582b-7ea5-4753-96b7-ed434f4f30ee` | Failed during source snapshot, before any application build |
| `80331dee-5961-4ff7-b2b6-893727bd43f4` | Same failure using a minimal deployment-only bundle |

Both report `Failed to snapshot repository. Please try again in a few minutes.`
Neither has an associated application build. The minimal bundle contains only
the allowlisted Dockerfile, branding assets/helper, signed-STT overlay and
licenses (about 388 KB). It builds locally to the same tested image,
`sha256:537761e725bf4fe1ad6dffa3f223f47aa41ad1168f8de8adcef853105010cc99`.

The last successful Vexa deployment remains
`0af0b839-a2f6-4c31-9254-b806db6a9210`, without the new branding. The web and API
were not redeployed; no service variables, builder settings, database schema or
stored product data were changed. Both attempted releases are terminal failures,
so no queued release remains to replace Vexa unexpectedly during a later call.

A separate API deployment, `de2c9d56-7e8d-40d4-a686-698a94661f6a`, was observed
initializing at the final check. Its message identifies the independent
`46dffde` calendar-automation release. It was not submitted, canceled, or modified
by this logo rollout. Do not cancel another workflow's release as a side effect
of investigating this one.

### External blocker and security advisory

Railway's [status page](https://status.railway.com/) on 22 October, updated at
14:58 IST (09:28 UTC), reports an ongoing platform outage, elevated build failures
and deployment delays. It asks customers not to submit duplicate deployments.
No further retries were queued after confirming that advisory.

Railway also published a [security disclosure](https://blog.railway.com/p/security-disclosure-wednesday-october-21st)
concerning possible access to customer environment-variable secrets. Railway
recommends rotating secrets stored there and reviewing service activity. This
does **not** establish that this particular account was compromised.

The user has been informed. Credential rotation requires a coordinated security
change, not an automatic logo-rollout step: the PostgreSQL server is shared,
API/Vexa signing keys must remain compatible, and changing the provider encryption
key without migrating stored ciphertext would make credentials unreadable. No
credentials, database roles, sessions or integrations were changed in response
to the disclosure without user direction.

After addressing the advisory and Railway recovery, repeat the complete idle
and imminent-schedule checks immediately before deploying **only Vexa**. Then
verify startup, authenticated runtime health, signed STT and the consented live
Teams/Meet acceptance checks. Update this record with the successful deployment
ID and observed results; do not mark those checks passed prematurely.
