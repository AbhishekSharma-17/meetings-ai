# The pinned upstream Lite image contains the complete browser/audio runtime.
# Overlay the reviewed signed-STT patch and the global still-image camera branding.
# Keep this digest aligned with the pinned v0.12.27 submodule base release.
FROM vexaai/vexa-lite@sha256:945628e54d843cf6286a823ca8e226f2b3c48eb948ad2f895e64eb867b7a0d55

COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /app/licenses/meetings-ai/
COPY vendor/vexa/LICENSE vendor/vexa/THIRD_PARTY_LICENSES.md /app/licenses/vexa/
COPY vendor/vexa/licenses/ /app/licenses/vexa/components/

COPY vendor/vexa/core/gateway/services/gateway/src/gateway/app.py /app/gateway/src/gateway/app.py
COPY vendor/vexa/core/meetings/services/meeting-api/src/meeting_api/bot_spawn/router.py /app/meeting-api/src/meeting_api/bot_spawn/router.py
COPY vendor/vexa/core/meetings/services/meeting-api/src/meeting_api/bot_spawn/service.py /app/meeting-api/src/meeting_api/bot_spawn/service.py
COPY vendor/vexa/core/meetings/services/meeting-api/src/meeting_api/bot_spawn/signed_stt.py /app/meeting-api/src/meeting_api/bot_spawn/signed_stt.py

# One application-owned image for every bot. This is a silent virtual camera,
# NOT a camera-off account profile photo or a voice-agent feature. No user uploads.
COPY apps/web/public/brand/meetings-ai-avatar-1024.png /app/branding/meetings-ai.png
COPY deploy/railway/branding/apply.py /app/branding/apply.py
COPY deploy/railway/branding/static-image.ts /app/core/meetings/modules/join/src/shared/meetings-ai-static-image.ts
RUN ffmpeg -hide_banner -loglevel error \
      -f lavfi -i color=c=0x111827:s=640x360:r=5 \
      -i /app/branding/meetings-ai.png \
      -filter_complex '[1:v]scale=240:240[logo];[0:v][logo]overlay=(W-w)/2:(H-h)/2,format=yuv420p' \
      -t 1 -an -f yuv4mpegpipe /app/branding/meetings-ai.y4m \
 && ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=48000:cl=mono \
      -t 1 -c:a pcm_s16le /app/branding/silence.wav \
 && /opt/venvs/meeting/bin/python /app/branding/apply.py /app/core/meetings/modules/join/src \
 && cd /app/core/meetings/modules/join && ./node_modules/.bin/tsc \
 && test -s dist/shared/meetings-ai-static-image.js
ENV MEETINGS_AI_STATIC_LOGO_ENABLED=true

RUN /opt/venvs/gateway/bin/python -m py_compile /app/gateway/src/gateway/app.py \
 && /opt/venvs/meeting/bin/python -m py_compile \
      /app/meeting-api/src/meeting_api/bot_spawn/router.py \
      /app/meeting-api/src/meeting_api/bot_spawn/service.py \
      /app/meeting-api/src/meeting_api/bot_spawn/signed_stt.py
