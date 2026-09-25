# Connected meeting sources

The Calendar page supports four per-user Composio connections: Google Calendar, Outlook Calendar, Calendly, and Zoom. Multiple accounts of each type can be connected. Scan a chosen account for today, tomorrow, this week, or next week; only upcoming entries with a supported Meet, Zoom, Teams, or Jitsi join URL are shown. The chosen event is re-read from that same connected account on the server before a bot is scheduled or joined. A matching link and start time in the same workspace cannot be imported twice. No scan automatically joins a meeting.

Source records preserve event title, time, join URL, organizer, agenda/description, and available invitees. Google and Outlook can expose RSVP states; Calendly invitees are fetched from its event-invitee tool. Zoom's scheduled-meeting listing exposes the host and agenda but generally does **not** provide a list of invitees, so the app does not invent one. Meeting detail shows the saved source metadata and merges listed invitees into People & capture. Invitees are not an attendance roster; heard transcript speakers can be new people. An exact-name invitee email appears only as a suggestion and must be explicitly confirmed before being linked to a speaker.

The recap recipient field can be prefilled from source invitee emails in the review dialog. Sending to those addresses remains off until the organizer explicitly enables participant delivery and later approves the MOM. No connected-source email is automatically used for delivery or identity verification.

The dedicated Meetings page filters all records, scheduled, in-progress, ready-to-review, needs-attention, and stopped meetings and has a text search. The Calendar page handles connection and event discovery. The Overview keeps recent activity.

## Configuration

Set `COMPOSIO_API_KEY` and the four `COMPOSIO_*_AUTH_CONFIG_ID` variables on the API service; model/toolkit versions are pinned in `.env.example`. Calendly and Zoom use Composio-managed OAuth auth configs in the local environment. Each individual user still needs to click Connect account and complete OAuth. No Calendly or Zoom account has been connected or live-scanned by this implementation. The managed auth config IDs in local `.env.local` are intentionally not committed.

Current limits: scans are user-initiated rather than background synchronized; there is no cross-source merge of metadata for the same invitation beyond duplicate-import prevention. Calendly enriches the first 40 visible events with invitee detail and caps stored invitees at 100 per event. Repeating Zoom meetings without a specific start time are omitted. Provider data availability and scopes determine what appears.
