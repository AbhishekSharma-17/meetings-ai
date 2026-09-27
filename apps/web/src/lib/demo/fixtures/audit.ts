import type { AuditEvent } from "../../types";
import { auditId, baseId, type Clock, meetingId, minutesFrom, userId } from "./ids";

/** [minutes ago, actor (1-based team index, 0 = automatic), action "METHOD /path" or event name, resource id, status] */
type Row = [number, number, string, string | null, number?];

const H = 60, D = 24 * 60;

const ROWS: Row[] = [
  [3, 1, "POST /v1/knowledge/chat/stream", null],
  [14, 1, "POST /v1/meetings/{m1}/join", "m1"],
  [21, 2, "auth.login.succeeded", null],
  [58, 1, "POST /v1/calendar/sync", null],
  [2 * H, 4, "POST /v1/knowledge/search", null],
  [3 * H, 2, "PUT /v1/meetings/{m3}/delivery-settings", "m3"],
  [5 * H, 1, "POST /v1/calendar/events/{e}/prep", null],
  [20 * H, 1, "POST /v1/meetings/{m3}/minutes/generate", "m3"],
  [22 * H, 1, "PUT /v1/meetings/{m3}/transcript/segments/{s}/speaker", "m3"],
  [23 * H, 3, "auth.login.succeeded", null],
  [D + 2 * H, 1, "PUT /v1/knowledge-bases/{k2}/sharing", "k2"],
  [D + 5 * H, 0, "auth.login.denied", null, 401],
  [2 * D, 1, "POST /v1/meetings/{m4}/minutes/generate", "m4"],
  [2 * D + H, 4, "PUT /v1/meetings/{m4}/speaker-identities", "m4"],
  [2 * D + 3 * H, 2, "POST /v1/calendar/schedules", null],
  [2 * D + 6 * H, 1, "PUT /v1/workspace/brief", null],
  [3 * D, 2, "POST /v1/meetings/{m5}/minutes/generate", "m5"],
  [3 * D + 2 * H, 1, "POST /v1/workspace/invite", null],
  [3 * D + 4 * H, 1, "POST /v1/provider-profiles", null],
  [4 * D, 1, "POST /v1/meetings/{m6}/minutes/approve", "m6"],
  [4 * D + H, 5, "auth.login.succeeded", null],
  [4 * D + 3 * H, 1, "PUT /v1/ai/settings", null],
  [5 * D, 3, "POST /v1/meetings/{m8}/join", "m8"],
  [5 * D + H, 0, "POST /v1/meetings/{m8}/post-meeting-job/retry", "m8", 502],
  [5 * D + 4 * H, 1, "POST /v1/workspace/brief/documents", null],
  [6 * D, 3, "POST /v1/meetings/{m7}/minutes/approve", "m7"],
  [6 * D + 1, 3, "POST /v1/meetings/{m7}/minutes/send-configured", "m7"],
  [6 * D + 5 * H, 1, "POST /v1/calendar/connect/{c}", null],
  [7 * D, 2, "PATCH /v1/workspace/members/{u6}/role", "u6"],
  [8 * D, 3, "POST /v1/meetings/{m9}/join", "m9"],
  [8 * D + H, 1, "POST /v1/knowledge-bases/{k3}/reindex", "k3"],
  [9 * D, 1, "PUT /v1/workspace/retention", null],
  [10 * D, 0, "retention.chats.deleted", null],
  [11 * D, 1, "POST /v1/knowledge-bases", null],
  [12 * D, 2, "PATCH /v1/calendar/connections/{c}", null],
  [14 * D, 1, "POST /v1/workspaces", null],
  [16 * D, 1, "POST /v1/auth/change-password", null],
  [18 * D, 4, "POST /v1/provider-profiles/{p}/test", null],
  [21 * D, 2, "DELETE /v1/workspace/brief/documents/{d}", null],
  [25 * D, 1, "PUT /v1/provider-defaults/{cap}", null],
];

const TARGETS: Record<string, () => string> = {
  m1: () => meetingId(1), m3: () => meetingId(3), m4: () => meetingId(4), m5: () => meetingId(5), m6: () => meetingId(6),
  m7: () => meetingId(7), m8: () => meetingId(8), m9: () => meetingId(9), k2: () => baseId(2), k3: () => baseId(3), u6: () => userId(6),
};

export function auditEvents(clock: Clock): AuditEvent[] {
  return ROWS.map(([ago, actor, action, target, status], index) => {
    const resourceId = target ? TARGETS[target]() : null;
    const path = action.includes(" ") ? action.split(" ")[1].replace(/\{(m\d|k\d|u\d)\}/g, (_, key: string) => TARGETS[key]()) : "/v1/auth/login";
    return {
      id: auditId(index + 1), actor_user_id: actor ? userId(actor) : null,
      action: action.includes(" ") ? `${action.split(" ")[0]} ${path}` : action,
      resource_path: path, resource_id: resourceId, status_code: status ?? 200, created_at: minutesFrom(clock, -ago),
    };
  });
}
