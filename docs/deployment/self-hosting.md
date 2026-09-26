# Self-hosting and production operations

This guide describes deploying the current repository. It is an operator runbook, not a claim that every integration, security control or scaling path is production-validated. Complete the release checklist before relying on a deployment for sensitive meetings.

## Service layout

| Service | Build source | Port | Readiness |
| --- | --- | --- | --- |
| Web | `apps/web/Dockerfile` | 3000 | `/` |
| API | `services/api/Dockerfile` | 8000 | `/ready` |
| Capture | `deploy/railway/vexa.Dockerfile` | 8056 | `/health` |
| PostgreSQL | Operator-managed PostgreSQL/pgvector image | 5432 | PostgreSQL connection check |

Use separate product and Vexa databases and login roles. The database and capture/API services should be private; only web needs a public HTTPS domain. Keep services in the same Railway environment so private DNS resolves at runtime. Vercel and Supabase are optional architectural alternatives, not prerequisites.

The Vexa overlay uses a pinned image digest and a reviewed fork. Do not substitute stock Vexa: Meetings AI relies on signed per-bot STT capability/attestation. Clone with submodules and verify the pinned revision before building.

## Railway setup

### 1. Create services and storage

1. Authenticate Railway and select the intended workspace/project/environment.
2. Provision PostgreSQL with a persistent volume and backups. For a shared server, create separate `meetings_ai` and `meetings_ai_vexa` databases/roles; do not grant access to unrelated databases. A new self-host should use its own project, not the maintainer's database.
3. Create web, API and Vexa services from this repository. Use the **repository root** as Docker build context and set each service's Dockerfile path from the table above (for example through `RAILWAY_DOCKERFILE_PATH`). Subdirectory build contexts omit shared contracts or the submodule.
4. Use private endpoints for service-to-service traffic. Configure target ports explicitly: these Dockerfiles use fixed ports; setting a different `PORT` alone does not rewrite their start commands.
5. Allocate sufficient CPU/RAM for browser capture and constrain bot concurrency. Measure your actual workloads; no fixed capacity is promised.

Railway references: [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [private networking](https://docs.railway.com/networking/private-networking), [public networking](https://docs.railway.com/networking/public-networking).

### 2. Configure Vexa

Follow the pinned [Vexa Lite documentation](../../vendor/vexa/deploy/lite/README.md) for database/runtime setup and admin/API-user initialization. Its database environment is separate from the product API. Obtain a Vexa API key with the bot/transcript permissions required by the application, and keep bootstrap/admin access private.

Set a randomly generated `VEXA_STT_OVERRIDE_SECRET` on Vexa and the identical value on the product API. Configure local or remote STT according to the selected deployment path. Model/runtime licenses and resource requirements must be reviewed independently.

Test Vexa `/health` privately and verify the signed STT feature is advertised before dispatching a bot. The product's authenticated `/v1/integrations/vexa/health` endpoint provides the integration check; do not expose Vexa publicly merely for diagnostics.

### 3. Configure the product API

Set values in Railway's protected service variables, not Git. Use `.env.example` as a reference rather than uploading a local secrets file.

| Variable | Production requirement |
| --- | --- |
| `APP_ENV` | `production` |
| `DATABASE_URL` | `postgresql+psycopg://...` using the product's private database/role |
| `WEB_ORIGIN`, `APP_BASE_URL` | Canonical public HTTPS web origin, without a page path |
| `MEETINGS_AI_ADMIN_EMAIL` | Initial owner email |
| `MEETINGS_AI_ADMIN_PASSWORD` | Unique bootstrap password, at least 16 characters |
| `MEETINGS_AI_SESSION_SECRET` | Independent random secret, at least 32 characters |
| `PROVIDER_CREDENTIAL_KEY` | Independent stable random secret, at least 32 characters |
| `VEXA_BASE_URL` | Private Vexa origin on port 8056 |
| `VEXA_API_KEY` | Application capture/transcript credential |
| `VEXA_STT_OVERRIDE_SECRET` | Same random secret as Vexa, at least 32 characters |

Enable the intended `AUTO_*` workers after checking their runtime behavior. Keep **one API process/replica**: scheduling, MOM, indexing and retention workers are currently in-process. Distributed execution requires coordination and idempotent job ownership, not simply adding replicas.

For optional integrations:

- Configure model credentials/profiles through **AI providers**. Do not assume setting an `OPENAI_API_KEY` variable automatically creates/defaults all profiles.
- Set `COMPOSIO_API_KEY` and each intended `COMPOSIO_*_AUTH_CONFIG_ID`. Use the correct project-scoped key/config. A fresh app-user connection is required after changing OAuth scopes. Default managed Google scopes may grant broader permissions than the read-only tools used by Meetings AI; disclose the consent scope to users.
- Set `RESEND_API_KEY` and an explicit `RESEND_FROM_EMAIL` on a verified domain. Arrange a reply mailbox separately. Complete real delivery tests; configuration presence is not domain verification.

### 4. Configure and build web

Set `API_INTERNAL_BASE_URL` to the API's private HTTP origin/port. The web Dockerfile uses this value during `next build` through a build argument, and the Next.js proxy configuration is built from it. Railway exposes referenced variables as Docker build arguments only when declared appropriately in the Dockerfile; verify the resulting `/v1` proxy after deployment. Private services do not need to be reached during the build merely to compile the proxy destination.

Build/rebuild web if that destination changes; a runtime variable change alone may not update baked rewrite rules.

Expose web on port 3000 and add your desired domain. Add the exact DNS/ownership records Railway provides at your domain registrar and wait for verification/TLS. Do not copy someone else's Railway CNAME target. Once the domain works, align `WEB_ORIGIN` and `APP_BASE_URL` with it so OAuth and invitation links return to the correct site.

### 5. Release in dependency order

After initializing databases/Vexa and setting all variables, deploy capture, API and web. Example for services named as in the existing deployment:

```sh
railway whoami
railway status
railway up --service meetings-ai-vexa --detach
railway up --service meetings-ai-api --detach
railway up --service meetings-ai-web --detach
```

Wait for each dependency's readiness before validating downstream behavior. Avoid publishing full `railway variables --json` output: it contains secrets. Use the CLI only after confirming project/environment/service targets.

## Data, upgrades and rollback

- Pin application/submodule revisions and image digests. Record what was built and retain third-party licenses in release artifacts.
- Back up both databases before schema upgrades. Product startup performs numbered forward migrations and rejects incompatible schemas. Inspect `services/api/app/database.py` for the exact version; do not rely on historical status documents.
- Test upgrades on a restored staging database with synthetic/authorized data. Confirm row preservation, permission checks and worker recovery.
- Application rollback is not database rollback. After an incompatible migration, redeploying an older image can fail. Use a tested restore/forward-fix plan rather than silently downgrading a schema.
- Preserve the credential-encryption key in a secure recovery mechanism; database restore without it cannot recover encrypted provider credentials.
- Retention/deletion does not erase sent emails, exports or backups. Define independent backup/object-storage retention and access policies.

## Monitoring and capacity

Monitor readiness, deployment restarts, queue/job failures, admission failures, scheduler latency, database storage and backup success. Add alerting appropriate to your hosting setup. Product token/cost views are partial accounting, not provider invoices; unknown model rates and STT/tool charges need explicit treatment.

Do not enable horizontal API scaling, unsupported bot concurrency or broad customer access without corresponding testing. Review outbound content/privacy requirements for every selected model and research provider.

## Release checklist

- [ ] Independent production secrets; no leaked/default credentials; encrypted provider keys readable after restart
- [ ] HTTPS domain, correct canonical callback/invitation origin, working web-to-API proxy
- [ ] Private API, Vexa and database; scoped DB roles; readiness checks pass
- [ ] Backups configured and restore tested; migration/recovery plan documented
- [ ] Vexa signed-STT feature verified and consented live capture completed per supported platform
- [ ] Scheduled join, cancellation, leave behavior and automatic MOM witnessed, including failure recovery
- [ ] Multi-speaker/multilingual accuracy measured; identities reviewed rather than assumed
- [ ] Fresh OAuth flow and actual event sync witnessed for each advertised integration
- [ ] Invitation delivery, first-login password change, workspace roles and deny-path isolation tested
- [ ] Recap review/approval/recipient opt-in and actual sender/inbox delivery tested
- [ ] Knowledge sharing/revocation, indexing, streaming and source citations evaluated against real authorized records
- [ ] Resource caps, monitoring, retention/privacy terms and incident response arranged
- [ ] Final images audited for licenses/vulnerabilities and required notices packaged

Use the [acceptance guide](../validation/mvp-acceptance.md) for more detailed product testing. Passing build checks alone does not satisfy this checklist.
