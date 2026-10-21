# Global in-call image

Every new bot in the custom Railway Vexa image uses the existing Meetings AI
logo from `apps/web/public/brand/meetings-ai-avatar-1024.png`. There is no personal
upload, workspace setting, new account, API endpoint, or database migration.

This is **a still image through a virtual camera**, not a Google/Microsoft
camera-off profile photograph. The camera indicator can therefore be on. A host
may disable video or hide participant tiles; the image cannot override that.
Changing this image requires rebuilding the Vexa image. Running bots are not
updated in place.

## Implementation

`deploy/railway/vexa.Dockerfile` retains the digest-pinned Lite v0.12.27 runtime,
the existing signed-STT overlay, and upstream redistribution notices. During the
build it:

1. Renders the logo onto a dark 640×360 background, five frames/second, in Y4M.
   Chromium loops this local file; no asset URL or storage credential is needed.
2. Adds a silent WAV input. Chromium's fake-device mode otherwise supplies a
   synthetic microphone tone. The existing platform mute controls remain unchanged.
3. Applies `deploy/railway/branding/apply.py` to the image's join module, then
   compiles the TypeScript that the actual bot imports. Pinned source anchors
   fail the build if upstream changes. The vendored Git submodule is not edited.
4. Enables `MEETINGS_AI_STATIC_LOGO_ENABLED=true` in this custom image. The Lite
   process backend inherits it into spawned bots.

Google Meet (anonymous and authenticated), Teams, and Zoom configure the lobby
camera only when the current state is understood. An already-enabled camera
is left on; a disabled, missing, or unrecognized control is not forced. Google
retains its existing click handler. Jitsi sets its initial video-muted default
to false only when no explicit meeting override exists. No post-join loop
re-enables a camera that the host has disabled.

Transcription routes, recording settings, voice-agent flags, microphone mute
logic, assistant names, and product data are not changed. Publishing even a
static video track uses some encoding CPU and outbound bandwidth; this is not
a zero-resource account avatar.

## Verification

From the repository root (Docker is required for browser/media checks):

```sh
git submodule update --init vendor/vexa
python3 deploy/railway/branding/test_overlay.py
docker build -f deploy/railway/vexa.Dockerfile -t meetings-ai-vexa:global-logo-test .
docker run --rm --shm-size=512m --entrypoint sh \
  --mount type=bind,source="$PWD/deploy/railway/branding/test-static-image.cjs",target=/app/branding/test-static-image.cjs,readonly \
  meetings-ai-vexa:global-logo-test -lc '
    pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=file:/tmp/branding-pulse.log
    Xvfb :98 -screen 0 1280x1024x24 -nolisten tcp >/tmp/branding-xvfb.log 2>&1 &
    DISPLAY=:98 node /app/branding/test-static-image.cjs
  '
```

The browser test uses two independent Chromium processes and local WebRTC peers.
It checks the received logo frame, incoming audio samples, no outbound audio
track, silent fake input, camera state transitions, the kill switch, and host
restrictions. It does not call a model, external meeting, or production API.
Docker's bridge network is needed for ICE candidates; `--network none` prevents
the two local peers from connecting. No host directory needs to be mounted
except the read-only test file.

The upstream join regression suite should also pass with branding disabled:

```sh
docker run --rm --network none --entrypoint sh \
  -e MEETINGS_AI_STATIC_LOGO_ENABLED=false meetings-ai-vexa:global-logo-test -lc '
    cd /app/core/meetings/modules/join
    PATH="$PWD/node_modules/.bin:$PATH" npm test
  '
```

These checks do **not** prove visibility in an admitted Teams/Google Meet call.
For acceptance, schedule a consented test meeting, admit the assistant, observe
the tile from a second participant, speak a short sample, confirm the transcript,
and stop the assistant. Repeat for both platforms. Also check that host video
restrictions let capture continue without the logo. Do not use customer meetings
as a test room.

## Safe rollout and rollback

- Deploy only `meetings-ai-vexa`; the API, web, database, and integrations need
  no deployment or migration for this change.
- Check **all workspaces** for active/joining/waiting/stopping bots and imminent
  scheduled joins immediately before rollout. Do not restart Lite during a call:
  its browser workers are child processes, so an instance replacement ends them.
- If active state cannot be verified, leave production untouched. Do not infer
  idleness from a single workspace or from quiet logs.
- Confirm the deployed image build compiled the overlay, Vexa comes up, the
  signed-STT health capability remains present, then run the live acceptance
  checks above. Existing app health alone does not prove the logo works.
- To disable branding, set `MEETINGS_AI_STATIC_LOGO_ENABLED=false` on Vexa and
  roll out only after the same drain check. It restores the original camera
  behavior. Alternatively redeploy the previous known-good Vexa image. Neither
  requires changing product data. A variable change itself may trigger a restart;
  do not use it as a mid-call kill switch.

Release status and evidence are recorded in `docs/status/global-assistant-image.md`.
