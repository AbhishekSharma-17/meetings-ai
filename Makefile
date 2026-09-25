.PHONY: check api-test api-dev web-check web-dev compose-up compose-down vexa-up vexa-down vexa-test

# Stronger English transcription for local multi-speaker evaluation. Override
# VEXA_WHISPER_MODEL when testing another language or provider route.
VEXA_WHISPER_MODEL ?= Systran/faster-whisper-small.en
# Set VEXA_STT_MODE=remote in .env.local to use the endpoint configured in
# vendor/vexa/.env. Keep local as the default for a fresh checkout.
VEXA_STT_MODE ?= $(shell sed -n 's/^VEXA_STT_MODE=//p' .env.local 2>/dev/null | tail -1)
VEXA_STT_OVERRIDE_SECRET ?= $(shell sed -n 's/^VEXA_STT_OVERRIDE_SECRET=//p' .env.local 2>/dev/null | tail -1)
export VEXA_STT_OVERRIDE_SECRET

check: api-test web-check

api-test:
	PYTHONPATH=packages/contracts:services/api python3 -m pytest services/api/tests -q

api-dev:
	PYTHONPATH=packages/contracts:services/api uvicorn app.main:app --reload --port 8320

web-check:
	npm --prefix apps/web run typecheck
	npm --prefix apps/web run lint
	npm --prefix apps/web run build

web-dev:
	npm --prefix apps/web run dev -- --port 3020

compose-up:
	docker network inspect vexa-lite-net >/dev/null 2>&1 || docker network create vexa-lite-net
	@if [ -f .env.local ]; then \
		docker compose --env-file .env.local up --build -d; \
	else \
		docker compose up --build -d; \
	fi

compose-down:
	docker compose down

# Explicitly disables the Vexa helper's personal Claude credential auto-mount.
vexa-up:
	@if [ "$(VEXA_STT_MODE)" = "remote" ]; then \
		$(MAKE) -C vendor/vexa/deploy/lite up AUTO_MOUNT_CLAUDE=0; \
	else \
		$(MAKE) -C vendor/vexa/deploy/lite up LOCAL_STT=1 AUTO_MOUNT_CLAUDE=0 WHISPER_MODEL=$(VEXA_WHISPER_MODEL) WHISPER_CONTAINER=vexa-lite-whisper-quality HOST_STT_PORT=8084; \
	fi

vexa-down:
	$(MAKE) -C vendor/vexa/deploy/lite down WHISPER_CONTAINER=vexa-lite-whisper-quality
	@docker rm -f vexa-lite-whisper >/dev/null 2>&1 || true

vexa-test:
	$(MAKE) -C vendor/vexa/deploy/lite test
	@if [ "$(VEXA_STT_MODE)" = "remote" ]; then \
		echo "External STT selected; use a separate provider audio witness."; \
	else \
		$(MAKE) -C vendor/vexa/deploy/lite stt-smoke HOST_STT_PORT=8084; \
	fi
