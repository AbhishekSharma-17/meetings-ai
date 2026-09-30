# ADR 0002: Scaling meeting assistants beyond three concurrent calls

- Status: proposed
- Date: 2026-09-30

## Context

### What runs today

- One Railway service, `meetings-ai-vexa`, runs Vexa Lite v0.12.27 (`deploy/railway/vexa.Dockerfile`).
  Everything is in one container under supervisord: the gateway, the admin API, the meeting API,
  the bot runtime, an internal Redis (Valkey), a virtual display (Xvfb) and one audio server
  (PulseAudio) (`vendor/vexa/deploy/lite/README.md`, `deploy/lite/supervisord.conf`).
- **Each assistant is its own headful Chromium**, started as a child process of the runtime
  (`RUNTIME_BACKEND=process`). All of them share one display, one audio server and one
  `/dev/shm`. Vexa's docs describe Lite as "best for one browser session at a time"
  (`deploy/lite/README.md`, `docs/docs/deployment-lite.mdx`).
- **One platform account.** Our API uses one Vexa API key, and every workspace and user shares it
  (`services/api/app/adapters/vexa.py`). That Vexa user has `max_concurrent_bots = 3`. This value
  was read from the production Vexa database on 2026-09-30.

### What limits us, in order

1. **The account cap (3).** Vexa enforces it when a bot is created, inside one transaction with
   a per-user Postgres lock (`meeting_api/bot_spawn/adapters.py`). Over the cap, Vexa returns
   **429** immediately and doesn't queue. Our API then marks the meeting *failed*, and the owner
   gets "Assistant could not join" (`services/api/app/meeting_service.py`). A 4th overlapping
   meeting is lost.
2. **The container's CPU and memory** (measured on 2026-09-30; see Load test results). Before the test, the only per-bot figures were:
   - about **1.15 vCPU** per bot (one measurement, Zoom web client, `browser-args.ts`);
   - **1–2 GiB RAM** per bot (the Helm defaults, which Vexa says to raise for real meetings);
   - about **2 GiB `/dev/shm`**, used most heavily by Teams.

   Meet and Teams on Lite have **not been measured**.
3. **Lite's shared display and audio.** How many browsers one Xvfb and PulseAudio handle
   reliably is unknown. This is also the "one microphone" problem: every bot shares one audio
   output, so only one bot per Vexa server could *speak* (relevant to the future voice agent,
   not to today's listen-only assistants).
4. **Railway replicas can't be used for Vexa.** Private networking sends each request to a random
   replica. A bot lives only in the replica that started it, so stop, status and transcript calls
   would often reach the wrong replica, and Railway also doesn't allow replicas on services with
   volumes.
5. **Deploys and crashes end calls.** On the process backend "the bot dies with the runtime"
   (`meeting_api/lifecycle/reconcile.py`), so redeploying `meetings-ai-vexa` drops every
   assistant that is in a call.

### Other hard limits that don't change with scale

- **One assistant per meeting link.** Vexa returns 409 for a second bot; call coordination turns
  that into "share a teammate's assistant".
- **4 hours per call** (`BOT_MAX_ACTIVE_MS`).
- **Gateway rate limit:** 120 requests burst, 40 per second.
- **Teams is starting to block unverified bots** (a rollout from Aug–Sep 2026). This applies at
  any scale.

### How much concurrency we need

Concurrency is the number of **meetings that overlap at the busiest moment**, not the number of
users:

```
peak concurrent ≈ users × meetings per user per day × average hours per meeting ÷ working hours × peak factor (≈2)
```

| Workspace | Meetings / user / day | Avg length | Average concurrent | Peak (×2) |
|---|---|---|---|---|
| 10 users | 3 | 45 min | 2.8 | ~6 |
| 50 users | 3 | 45 min | 14 | ~28 |
| 200 users | 4 | 45 min | 75 | ~150 |

Meetings cluster on the hour (10:00, 11:00, 14:00…), so the peak factor can be higher than 2.
Call coordination lowers demand, because teammates in the same call share one assistant.
**Three is already too few for about ten active users.**

## Options

### A. Scale up the one Vexa server

Raise the account's `max_concurrent_bots` and give `meetings-ai-vexa` more CPU and memory.

- **Capacity (estimate):** 8 vCPU / 16 GB fits about 5–6 bots; 24 vCPU / 24 GB (Railway Pro's
  per-service maximum) fits about 10–11, limited by memory. The shared display and `/dev/shm`
  may cap it lower. **Unmeasured.**
- **Cost:** Railway bills actual use at $20 per vCPU-month and $10 per GB-month, which is about
  **$0.06 per assistant-hour** (1.15 vCPU + 2 GB), plus the idle Vexa services.
- **Effort:** hours: a load test, one API call to raise the cap, one Railway setting.
- **Downsides:** a hard ceiling of about 10; one server is a single point of failure; every
  Vexa deploy drops every live call.

### B. A pool of Vexa servers behind our API (horizontal, still on Railway)

Run N **separate** Railway services (`meetings-ai-vexa`, `meetings-ai-vexa-2`, …). Each has
**its own database** (`meetings_ai_vexa_2`, …) and its own API key. Our API decides where each
meeting goes.

Servers must not share a database. Each server's reconcile sweep checks every active meeting
in its database against its *own* runtime. It would see the other server's bots as untracked
and mark them failed after 10 minutes (`reconcile.py`, `MEETING_UNTRACKED_GRACE_SEC`).

```
                        ┌──────────────── meetings-ai-api ────────────────┐
  join / schedule ───▶  │  Placement: least-loaded instance with room     │
                        │  (capacity from each instance's /bots/status)   │
                        │  on 429 → next instance → else queue            │
                        │  meetings.vexa_instance = chosen id             │
                        └───────┬──────────────────┬───────────────┬──────┘
        every later call for    │                  │               │
        a meeting goes to the   ▼                  ▼               ▼
        instance that holds it  vexa-1             vexa-2    …     vexa-N
                                (own DB, key,      (own DB, key,
                                 ~8–10 bots)        ~8–10 bots)
```

What we change (no change to Vexa itself):

1. **Data model:** add `meetings.vexa_instance` (backfill `primary`). `vexa_meeting_id` is
   only unique within one instance.
2. **Adapter pool:** replace the single `VexaCaptureAdapter` (`main.py`, `VEXA_BASE_URL` /
   `VEXA_API_KEY`) with a registry: instance id → base URL, API key and capacity. Configure it
   with one environment variable holding a JSON list.
3. **Routing:** every call for an existing meeting goes to its instance:
   - `get_meeting`, `stop`, `get_transcript`, `get_participants`, `list_recordings`,
     `delete_meeting` in `meeting_service.py`;
   - the leave watchdog;
   - storage accounting.
4. **Placement:** pick the instance with the most free slots. On 429, try the next one.
5. **A queue instead of failure:** when every instance is full, keep the meeting "waiting for a
   free assistant". Retry every 30 s for up to 10 minutes, tell the owner, and only then mark it
   missed. This is worth doing even with one instance.
6. **One assistant per call across instances:** today we rely on Vexa's 409, which only works
   within one instance. Our API must also refuse a second active bot for the same
   (platform, native meeting id).
7. **Health and capacity:** the Vexa health endpoint and Observability show each instance's
   bots in use and free slots.
8. **Draining for deploys:** mark an instance "draining" so it gets no new meetings, wait until
   it's empty, then redeploy it. Deploy instances one at a time.

- **Capacity:** about 8–10 per instance, linear in N. Railway Pro allows many services.
- **Cost:** the same $0.06 per assistant-hour, plus about $15–25 a month of idle services per
  instance, plus one database per instance on the shared Postgres server.
- **Effort:** about 1–2 weeks, including tests and a load test.
- **Downsides:** each instance is another thing to deploy and monitor. Bots are still processes
  in a shared container, not isolated.

### C. Full Vexa on Kubernetes (one pod per assistant)

Vexa's full deployment (Helm, `RUNTIME_BACKEND=k8s`) runs **every bot as its own pod** with its
own `/dev/shm`. The API services run 2 replicas with leader election, and the cluster autoscaler
adds nodes as calls start. Vexa describes it as scaling to thousands of users
(`docs/docs/deployment-kubernetes.mdx`).

- **This can't run on Railway**: there is no Docker socket or Kubernetes API. It needs a managed
  cluster (GKE, EKS, DigitalOcean Kubernetes) or k3s on rented servers.
- **Capacity:** effectively unlimited. Bots are isolated, so one misbehaving call can't take
  down the others.
- **Cost:** node pricing depends on the provider, usually cheaper per vCPU than Railway at
  scale, plus a control plane of about $70 a month on GKE or EKS (DigitalOcean's is free).
- **Effort:** 2–4 weeks the first time, plus ongoing cluster operations: upgrades, monitoring,
  node pools and secrets. Our API only needs the adapter change from option B, pointed at one
  instance.
- **Downsides:** a second platform to operate next to Railway.

### D. Buy: a hosted meeting-bot API (Recall.ai)

- **Price:** $0.50 per recording hour, plus $0.15 per hour if we use their transcription (we
  could keep our own). No platform fee.
- **Coverage:** Meet, Teams, Zoom, **Webex**, Slack Huddles and GoTo. Calendar integration is
  included.
- **Concurrency:** Recall runs the fleet, and we found no published limit (confirm with them).
- **Effort:** about 1–2 weeks to write a Recall adapter next to the Vexa one, since our
  `MeetingService` already sits behind an adapter.
- **Downsides:** about 8–10× the self-hosted cost per hour (see the table), audio leaves our
  infrastructure, and we depend on a vendor.

### Cost at a glance (compute only; estimates)

| Monthly assistant-hours | A/B: self-hosted on Railway | D: Recall ($0.50–0.65/h) |
|---|---|---|
| 200 | ~$12 + ~$20 idle | $100–130 |
| 1,000 | ~$60 + ~$20–60 idle | $500–650 |
| 5,000 | ~$300 + ~$60–120 idle | $2,500–3,250 |

These figures leave out engineering time, which is the real cost of B and C, and Recall's
included calendar, Webex and bot-image features.

## Decision (proposed)

Scale in phases, and let measurements decide the next step:

1. **Phase 0 (this week):**
   - Load-test the current Vexa service with 3, 5 and 8 simultaneous test calls on Meet and
     Teams, recording CPU, RAM, `/dev/shm` and transcript quality.
   - Raise `max_concurrent_bots` to what the test supports, and size the Railway service to
     match.
   - Add the **queue instead of failure** (option B, step 5) and show free assistant slots in
     Observability.
2. **Phase 1 (when peak need exceeds one server, ~8–10):** build the Vexa pool (option B).
3. **Phase 2 (beyond ~30 concurrent, or if Webex becomes a requirement):**
   - Decide between Kubernetes (C) and Recall (D), or a hybrid: Recall only for platforms Vexa
     lacks (Webex), and Vexa for the rest.
   - The adapter pool from Phase 1 makes a hybrid a configuration choice, because each
     instance can be a Vexa server or a Recall account.

## Related decisions

### Webex

- **Vexa can't join Webex.** It has no Webex module; upstream request #1155 is accepted but not
  scheduled.
- **Building one** means a join module and an audio capture module for the Webex web client,
  plus platform plumbing: weeks of work, and ongoing drift from upstream.
- **Recall supports Webex today.**
- **Calendar sync:** Composio's Webex toolkit has no meetings actions. Syncing Webex's own
  calendar would need our own Webex OAuth integration (`GET /v1/meetings`, scope
  `meeting:schedules_read`).
- **Meanwhile:** Webex meetings booked in Outlook or Google calendars carry a webex.com link, but
  our link parser (`meeting_links.py`) drops them. A pasted Webex link now gets a clear "not
  supported yet" message.
- **Next step, if wanted:** list Webex meetings in the calendar and say the assistant can't join
  them yet.

### The assistant's picture in the call (logo instead of the "M" tile)

- **Vexa v0.12.27 can't show one.** The bot's camera is fed from `/dev/null` and switched off on
  join. Upstream is removing the old avatar feature (issue #151).
- **Option 1, patch our fork:** feed Chromium's fake camera a small looping image of our logo
  and leave the camera on. This works in principle on Meet, Teams and Zoom web but is untested,
  and every bot then encodes video continuously, costing roughly 0.1–0.3 of a core each
  (unmeasured). That reduces bots per server, which works against scaling.
- **Option 2, a signed-in Google account for the bot** (Vexa "authenticated bots"): Meet shows
  that account's profile photo at no CPU cost. It works on Meet only, and one signed-in account
  runs one bot at a time.
- **Recall.ai supports a bot image natively.** Confirm the details if option D is chosen.
- **Recommendation:** decide together with the scaling path. On Recall it's a setting; on Vexa,
  option 1 should be load-tested alongside Phase 0.

## Load test results (2026-09-30, first run)

Measured on the production assistant server, using a separate Vexa test user (limit 10) so
production's limit of 3 was untouched. Each call was a public Jitsi room (meet.ffmuc.net) with a
headless speaker playing recorded speech.

| Measure | Result |
|---|---|
| Server allowance | 32 vCPU, 32 GB RAM (cgroup `cpu.max`, `memory.max`) |
| Idle | 1.1 GB RAM, 0.02 cores |
| Memory per assistant | +0.45 GB |
| `/dev/shm` (62 MB) | 0 KB used; Playwright launches Chromium with `--disable-dev-shm-usage` |
| CPU, one Jitsi assistant with speech | 16–32 cores, throttled at the 32-core cap |
| CPU, real Meet/Teams assistants | about 0.5–1 core each (the server's total CPU over 5 days ÷ assistant time; estimate) |
| Transcription | 21 segments, 276 words in 2 minutes |

- **Memory and shared memory are not the constraints; CPU is**, and it depends on the platform.
  Jitsi's web client renders video in software, so it is a worst case and is not representative.
- **Scaling to 3, 5 and 8 assistants was not run on Jitsi,** because it would only have pinned the
  production server at its cap. It needs Meet and Teams test calls that anyone can join without
  waiting in a lobby.
- **Vexa's runtime leaves finished assistant processes as zombies.** This is harmless for now and
  should be reported upstream.

## Consequences

- Phase 0 removes the silent failure of the 4th meeting and gives us real capacity numbers
  within days.
- Phase 1 changes our data model (`meetings.vexa_instance`) and how every Vexa call is routed.
  Existing meetings are backfilled to the current instance.
- Running each Vexa instance on its own database keeps the instances independent. The cost is
  one more database and API key per instance, managed through Railway variables.
