# Meetings AI

Meetings AI is a provider-agnostic meeting agent built around a pinned Vexa capture subsystem. The product will join Google Meet, Zoom and Microsoft Teams, produce a versioned transcript and evidence-backed MOM, deliver approved recaps, and compile governed organizational knowledge.

## Current implementation slice

The first slice establishes:

- the product web application and manual meeting journey;
- a FastAPI product API;
- provider profiles for transcription, text generation and embeddings;
- Vexa-native, OpenAI and OpenAI-compatible provider boundaries;
- write-only credential handling and capability validation;
- a pinned local Vexa `v0.12.27` checkout for the ARM64 Lite witness path.

Meeting capture, OpenAI calls and Resend delivery are intentionally not activated until rotated credentials are supplied through the ignored local secret file.

See the [foundation verification record](docs/status/2026-09-09-foundation.md) for the exact checks already passed and the next incomplete slices.

## Provider model

Provider selection is part of the product—not a deployment-only environment switch.

- Transcription, text generation and embeddings have separate provider profiles.
- Profiles declare capabilities such as streaming, timestamps, diarization, structured output and tool calling.
- Runs snapshot the effective profile/model configuration.
- Credentials are resolved only on the server and are never returned by the settings API.
- Cross-provider fallback is explicit and disabled by default. A local route never silently forwards meeting content to a cloud provider.

See [ADR 0001](docs/adr/0001-provider-agnostic-ai.md).

## Local prerequisites

- Docker 28+
- Node.js 22+
- Python 3.12+
- A host capable of reaching the selected meeting and AI providers

This development host is ARM64. The standard Vexa bot image is AMD64-only; the initial witness uses Vexa Lite, which supports ARM64 and is best limited to one browser bot at a time.

## Secrets

Copy `.env.example` to `.env.local` and insert newly rotated credentials there. Do not paste credentials into source files, commits, issues or task transcripts. See [the secrets runbook](docs/security/secrets.md).

## Source layout

```text
apps/web/                 Next.js product UI
services/api/             FastAPI product API
services/worker/          durable meeting workflows (next slice)
services/stt-bridge/      provider-normalized audio boundary (next slice)
packages/contracts/       application-owned provider and meeting schemas
packages/email-templates/ recap templates (email slice)
integrations/             Vexa, provider and email adapters
vendor/vexa/              pinned organization fork/submodule
```

## Vexa pin

- Tag: `v0.12.27`
- Commit: `f64a7653acdd845224f6d7de16b58c081ff7234c`
- Upstream: <https://github.com/Vexa-ai/vexa>

Organization fork: <https://github.com/Genaiprotos/vexa>. The product pins its tested fork commit as a submodule and retains the public Vexa repository as `upstream` inside that checkout.
