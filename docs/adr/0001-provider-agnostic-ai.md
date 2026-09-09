# ADR 0001: Provider-agnostic AI routing

- Status: accepted
- Date: 2026-09-09

## Context

Meetings AI must support managed providers and self-hosted/open-source models. Vexa already exposes native/local transcription and OpenAI-compatible LLM configuration, while the product requires consistent transcripts, MOMs, evidence, knowledge and audit regardless of provider.

## Decision

The product owns three independent capability contracts:

1. `TranscriptionProvider`: batch/streaming audio to normalized transcript segments and speaker information.
2. `TextGenerationProvider`: prompts/messages plus an optional output schema and tools to normalized structured results.
3. `EmbeddingProvider`: text batches to versioned vectors with explicit dimensions.

A named provider profile stores provider kind, deployment locality, endpoint, model ID, declared/verified capabilities, credential reference, connection state and version. Raw credentials are not part of application response schemas.

Initial provider kinds:

- Vexa-native/local transcription;
- OpenAI transcription and Responses API;
- generic OpenAI-compatible transcription and text generation for self-hosted gateways;
- later native providers where compatibility or feature coverage requires them.

The backend validates capabilities before a route can be selected. Structured MOM and evidence validation is provider-independent. If a provider lacks native structured output, bounded JSON extraction/repair may be used, but the result is not publishable until it passes the same schema and evidence checks.

Every AI run snapshots profile ID/version, provider kind, endpoint identity (not credentials), model, prompt/schema version, routing/fallback policy, latency, usage and result state.

## Fallback and locality

Fallback is opt-in and ordered. Local/self-hosted profiles never fall back to a cloud profile unless an administrator explicitly configures that data-boundary change. Retries remain on the selected run snapshot and are idempotent.

## Secrets

For initial local development, profiles refer to secrets held in `.env.local`. Persistent credentials entered through the UI will be encrypted with a key outside the database. APIs return only `credential_configured: true|false`; edit forms never rehydrate a stored secret.

Connection tests must use server-side adapters, restrict self-hosted endpoints to configured network destinations, reject redirects to unexpected hosts and block metadata/link-local destinations.

## Consequences

- The frontend and backend need provider-profile configuration in the first MVP slice.
- Application records never store vendor-specific response objects as their canonical form.
- Changing an embedding provider requires rebuilding the affected index.
- Supporting “OpenAI-compatible” endpoints requires contract tests; URL shape alone does not establish compatibility.
- Vexa's open-source model paths remain available and testable.
