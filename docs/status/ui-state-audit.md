# UI state audit (September 2026)

The web app unmounts most screens on navigation. Server records remain the source of truth; browser storage only holds scoped UI choices so returning to a page does not reset it. Keys include both organization ID and user ID. Selections backed by a fetched option list fall back when the saved option is missing, inactive, or inaccessible.

| Area | Restored choice | Storage |
| --- | --- | --- |
| Navigation | Current page and open meeting ID | Session |
| Calendar | Tab, date range, month, day, connected account, open event | Local |
| AI providers | Selected configuration | Local |
| AI providers | Unsaved non-secret configuration fields | Session |
| Meetings | Status filter | Local |
| Meetings | Search text | Session |
| AI knowledge | Base, mode, chat provider, model, saved conversation | Local |
| Meeting prep | Selected saved event | Local |

Session storage is limited to the current browser tab. Local storage survives a refresh or browser restart on that device. Neither is shared across devices. Actual meetings, accounts, provider credentials, knowledge bases, chats, and prep reports remain server-side.

API keys and passwords are never written to browser storage. An unsubmitted key or password is intentionally cleared when its form is left. Draft meeting content, invitation details, and unsaved organization context are not persisted to browser storage; users must save or submit them. Provider draft endpoints containing URL credentials or query strings are not retained in session storage.

Regression coverage: `apps/web/tests/e2e/state-persistence.spec.ts` and `apps/web/tests/e2e/calendar-workspace.spec.ts` cover navigation, reload, OAuth callback selection, saved conversation, selected calendar event, prep event, and cross-user isolation.
