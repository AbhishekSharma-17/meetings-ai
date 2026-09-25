# The pinned upstream Lite image contains the complete browser/audio runtime.
# Overlay only the reviewed Meetings AI signed-STT patch from our Vexa fork.
# Keep this digest aligned with the pinned v0.12.27 submodule base release.
FROM vexaai/vexa-lite@sha256:945628e54d843cf6286a823ca8e226f2b3c48eb948ad2f895e64eb867b7a0d55

COPY vendor/vexa/core/gateway/services/gateway/src/gateway/app.py /app/gateway/src/gateway/app.py
COPY vendor/vexa/core/meetings/services/meeting-api/src/meeting_api/bot_spawn/router.py /app/meeting-api/src/meeting_api/bot_spawn/router.py
COPY vendor/vexa/core/meetings/services/meeting-api/src/meeting_api/bot_spawn/service.py /app/meeting-api/src/meeting_api/bot_spawn/service.py
COPY vendor/vexa/core/meetings/services/meeting-api/src/meeting_api/bot_spawn/signed_stt.py /app/meeting-api/src/meeting_api/bot_spawn/signed_stt.py

RUN /opt/venvs/gateway/bin/python -m py_compile /app/gateway/src/gateway/app.py \
 && /opt/venvs/meeting/bin/python -m py_compile \
      /app/meeting-api/src/meeting_api/bot_spawn/router.py \
      /app/meeting-api/src/meeting_api/bot_spawn/service.py \
      /app/meeting-api/src/meeting_api/bot_spawn/signed_stt.py
