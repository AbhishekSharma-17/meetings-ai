# Secrets runbook

## Current action required

Any credential pasted into a task transcript must be treated as exposed. Revoke it in the provider console and generate a replacement before use.

## Local development

1. Copy `.env.example` to `.env.local`.
2. Generate local application and Vexa secrets; do not reuse examples outside local development.
3. Insert rotated provider credentials directly into `.env.local` on the controlled machine.
4. Confirm `.env.local` is ignored with `git check-ignore .env.local`.
5. Run the credential preflight before enabling a provider profile.

Never place keys in frontend environment variables prefixed for browser exposure. The web application sends a new credential only once over the protected settings request; the backend stores or resolves it and returns only whether a credential is configured.

## Production direction

Use a managed secret store and per-service identities. Encrypt any database-held credential envelope with a key kept outside the database. Record credential creation/rotation/deletion as audit events without recording secret values.
