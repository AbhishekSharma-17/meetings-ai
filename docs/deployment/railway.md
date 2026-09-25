# Railway deployment

Meetings AI is deployed in the `Meetings Ai` Railway project, production
environment, under the GenAi Protos workspace. The web service is public at
https://meetings-ai-web-production.up.railway.app. The API and Vexa gateway
are private Railway services; Vercel is not required.

The web service also has `meeting.genaiprotos.com` attached. Its CNAME and
ownership-verification TXT records must be added at the domain's DNS provider
before Railway can verify the domain and issue its HTTPS certificate.

| Service | Purpose | Port / check |
| --- | --- | --- |
| `meetings-ai-web` | Next.js UI and same-origin `/v1` proxy | 3000 / `/` |
| `meetings-ai-api` | FastAPI, background jobs, integrations | 8000 / `/ready` |
| `meetings-ai-vexa` | Browser meeting capture, signed per-bot STT | 8056 / `/health` |
| `pgvector` | Existing shared PostgreSQL server | private port 5432 |

The two product databases on that server are `meetings_ai` and
`meetings_ai_vexa`. They use distinct login roles, and each role is denied
access to the other's database. The unrelated `Postgres` service in the same
Railway project is **not** used by Meetings AI. Product connections use
Railway private networking. PostgreSQL's `vector` extension is installed in
`meetings_ai`, but the current knowledge index still stores JSON vectors and
scores them in the API; do not describe it as pgvector-backed search yet.

The Vexa service uses [the thin overlay Dockerfile](../../deploy/railway/vexa.Dockerfile)
over a digest-pinned upstream Vexa Lite v0.12.27 image. It copies only the
signed-STT changes from the pinned `vendor/vexa` submodule. Do not replace it
with the stock Vexa image: the API verifies the signed-STT capability before
sending a per-meeting transcription route. The Vexa image is large; its first
Railway build and cold start can take several minutes.

## Configuration and release

Keep all credentials in Railway service variables, never in Git. The API
requires `APP_ENV=production`, `DATABASE_URL`, `WEB_ORIGIN`,
`APP_BASE_URL`, `PROVIDER_CREDENTIAL_KEY`, `MEETINGS_AI_ADMIN_EMAIL`,
`MEETINGS_AI_ADMIN_PASSWORD`, `MEETINGS_AI_SESSION_SECRET`, `VEXA_BASE_URL`,
`VEXA_API_KEY`, and `VEXA_STT_OVERRIDE_SECRET`. The API and Vexa services
must share the same STT override secret. Resend and Composio credentials are
server-side API variables. The web build uses `API_INTERNAL_BASE_URL` to
proxy browser requests to the private API; the browser never receives the
private service URL or integration keys.

From the repository root, after checking the intended Railway project and
service names:

```sh
railway whoami
railway status
railway up --service meetings-ai-vexa --detach
railway up --service meetings-ai-api --detach
railway up --service meetings-ai-web --detach
```

Deploy Vexa first when changing its image or STT contract. The API should
have one replica while the calendar scheduler, MOM, knowledge-index, and
retention loops are in-process. Multiple API replicas need a separately
coordinated job queue before scaling out. Do not attach a public domain to
the Vexa or API services merely to test them; the web proxy and authenticated
`/v1/integrations/vexa/health` endpoint cover the normal integration check.

## Validation and remaining setup

1. Confirm Railway lists `pgvector`, Vexa, API, and web as online.
2. Open the web URL, sign in with the Railway-seeded admin account, and
   confirm Calendar and AI providers load. The initial password is in the
   API service's protected Railway variables; change it after first login.
3. Confirm the authenticated Vexa integration endpoint returns `ready` with
   `bot` and `tx` scopes. This does **not** prove a live meeting can be joined.
4. Configure at least one transcription, text-generation, and embedding
   profile in **AI providers**. The first deployment uses a fresh product
   database and does not copy local provider profiles or meeting records.
5. Reconnect any expired calendar accounts and sync once. The event cache is
   persisted after that; stale snapshots refresh in the background.
6. Test one consented live meeting end to end: join, speakers/transcript,
   automatic MOM, review/approval, email delivery, and meeting prep/knowledge.
   Confirm the Resend sender domain with a real approved send; configuration
   presence alone is not domain verification.

Before relying on the service for real customer meetings, rotate any API
keys previously shared in chat, verify Railway database backups and restore,
set usage alerts, and complete the live acceptance checklist in
[`docs/validation/mvp-acceptance.md`](../validation/mvp-acceptance.md).
