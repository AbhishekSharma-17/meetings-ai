# Meetings AI

Meetings AI is a provider-agnostic meeting agent built around a pinned Vexa capture subsystem. The product will join Google Meet, Zoom and Microsoft Teams, produce a versioned transcript and evidence-backed MOM, deliver approved recaps, and compile governed organizational knowledge.

## Current implementation slice

The current local capture slice establishes:

- the product web application and manual meeting journey;
- a FastAPI product API with PostgreSQL persistence;
- product meeting creation, Vexa bot dispatch, lifecycle refresh and idempotent stop;
- exact-meeting transcript reads with a durable cached fallback;
- structured MOM generation through the selected text-generation provider;
- persisted human review, explicit approval, and sent-version locking;
- manual-recipient recap delivery through Resend, with optional transcript inclusion;
- provider profiles for transcription, text generation and embeddings;
- Vexa-native, OpenAI and OpenAI-compatible provider boundaries;
- write-only credential handling and capability validation;
- a pinned local Vexa `v0.12.27` checkout for the ARM64 Lite witness path.

The Vexa capture and OpenAI MOM paths are active locally. Resend delivery is wired,
but a custom sender must be verified in Resend before using the product domain.
All provider credentials belong in the ignored local secret file and must be rotated
if they have appeared in a chat or task transcript.

See the [local capture MVP verification record](docs/status/2026-09-09-capture-mvp.md)
for the exact checks already passed and the next incomplete slices.

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
`make compose-up` automatically loads `.env.local` when it exists.

## Source layout

```text
apps/web/                 Next.js product UI
services/api/             FastAPI product API
services/worker/          durable/background workflows (production slice)
services/stt-bridge/      provider-normalized audio boundary (next slice)
packages/contracts/       application-owned provider and meeting schemas
packages/email-templates/ reusable branded templates (later slice)
integrations/             Vexa, provider and email adapters
vendor/vexa/              pinned organization fork/submodule
```

## Vexa pin

- Tag: `v0.12.27`
- Commit: `cbaf88c6530d5e41368fc2df80e33c53240bd49e`
- Upstream: <https://github.com/Vexa-ai/vexa>

Organization fork: <https://github.com/Genaiprotos/vexa>. The product pins its tested fork commit as a submodule and retains the public Vexa repository as `upstream` inside that checkout.
