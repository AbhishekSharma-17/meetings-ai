.PHONY: check api-test api-dev web-check web-dev compose-up compose-down vexa-up vexa-down vexa-test

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
	$(MAKE) -C vendor/vexa/deploy/lite up LOCAL_STT=1 AUTO_MOUNT_CLAUDE=0

vexa-down:
	$(MAKE) -C vendor/vexa/deploy/lite down

vexa-test:
	$(MAKE) -C vendor/vexa/deploy/lite test
	$(MAKE) -C vendor/vexa/deploy/lite stt-smoke
