import type { EmailDelivery, MeetingDeliverySettings, Team, TeamMember } from "../../types";
import { demoId, minutesFrom, newId, ORG_VENTURES, userId } from "../fixtures/ids";
import { DOMAIN, team as people } from "../fixtures/people";
import { json, noContent, notify, problem, str, strList } from "../http";
import type { DemoRequest, DemoRouter } from "../router";
import type { DemoStore } from "../store";
import { findSeed } from "./meetings";

/**
 * Internal teams (recipient groups) in the sample workspace, plus the delivery-settings and
 * send-configured routes that understand `internal_group_ids`. Registered before the minutes
 * handlers so these routes win; teams expand to their current members when a recap is "sent".
 */
const TEAM_GROUP = 20;
const LEADERSHIP = demoId(TEAM_GROUP, 1);
const ACME_TEAM = demoId(TEAM_GROUP, 2);
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/;

type StoredTeam = Omit<Team, "members" | "member_count" | "meeting_count"> & { entries: Array<{ user_id: string | null; email: string }> };

const state = new WeakMap<DemoStore, StoredTeam[]>();

function seedTeams(store: DemoStore): StoredTeam[] {
  const created = minutesFrom(store.clock, -60 * 24 * 40);
  const member = (index: number) => ({ user_id: userId(index), email: people[index - 1].email });
  const leadership: StoredTeam = {
    id: LEADERSHIP, name: "Leadership", description: "Partners and delivery leads who get every internal recap.",
    created_by: userId(1), created_at: created, updated_at: minutesFrom(store.clock, -60 * 24 * 6),
    entries: store.orgId === ORG_VENTURES ? [member(1), member(2), member(5)] : [member(1), member(2), member(5), { user_id: null, email: `board@${DOMAIN}` }],
  };
  const acme: StoredTeam = {
    id: ACME_TEAM, name: "Acme account team", description: "Everyone working on the Acme Robotics rollout.",
    created_by: userId(2), created_at: created, updated_at: minutesFrom(store.clock, -60 * 24 * 2),
    entries: [member(2), member(3), member(4), { user_id: null, email: "pm@acme-robotics.example" }],
  };
  // The sample meetings already point their recaps at these teams.
  const targets: Record<string, string[]> = store.orgId === ORG_VENTURES ? { leadership: [LEADERSHIP] } : { leadership: [LEADERSHIP], "acme-roadmap": [ACME_TEAM], "acme-security": [ACME_TEAM, LEADERSHIP] };
  for (const seed of store.seeds) {
    const ids = targets[seed.key];
    const current = store.delivery[seed.meeting.id];
    if (!ids || !current) continue;
    // Addresses a targeted team already covers are dropped, so the chips read "team + extras".
    const covered = new Set([leadership, acme].filter((team) => ids.includes(team.id)).flatMap((team) => team.entries.map((entry) => entry.email)));
    store.delivery = { ...store.delivery, [seed.meeting.id]: { ...current, internal_group_ids: ids, internal_recipients: current.internal_recipients.filter((email) => !covered.has(email)) } };
  }
  return store.orgId === ORG_VENTURES ? [leadership] : [acme, leadership];
}

function teamsOf(store: DemoStore): StoredTeam[] {
  let teams = state.get(store);
  if (!teams) { teams = seedTeams(store); state.set(store, teams); }
  return teams;
}

function publicTeam(store: DemoStore, stored: StoredTeam): Team {
  const members: TeamMember[] = stored.entries.map((entry) => {
    const account = entry.user_id ? store.members.find((item) => item.user_id === entry.user_id) : undefined;
    const active = !entry.user_id || Boolean(account);
    return { email: account?.email ?? entry.email, user_id: entry.user_id, display_name: account?.display_name ?? null, photo_url: account?.photo_url ?? null, active };
  });
  return {
    id: stored.id, name: stored.name, description: stored.description, created_by: stored.created_by,
    created_at: stored.created_at, updated_at: stored.updated_at, members, member_count: members.filter((item) => item.active).length,
    meeting_count: Object.values(store.delivery).filter((settings) => settings.internal_group_ids?.includes(stored.id)).length,
  };
}

function parseInput(store: DemoStore, body: Record<string, unknown>, partial: boolean): { name?: string; description?: string | null; entries?: StoredTeam["entries"] } | string {
  const out: { name?: string; description?: string | null; entries?: StoredTeam["entries"] } = {};
  if (!partial || "name" in body) {
    const name = str(body.name)?.trim().replace(/\s+/g, " ");
    if (!name || name.length > 80) return "Enter a team name of up to 80 characters.";
    out.name = name;
  }
  if ("description" in body) out.description = str(body.description)?.trim() || null;
  if (!partial || "members" in body) {
    const raw = Array.isArray(body.members) ? body.members as Array<Record<string, unknown>> : [];
    const entries: StoredTeam["entries"] = [];
    for (const item of raw) {
      const id = str(item.user_id);
      const account = id ? store.members.find((member) => member.user_id === id) : undefined;
      const email = (account?.email ?? str(item.email) ?? "").trim().toLowerCase();
      if (id && !account) return "That workspace member was not found.";
      if (!EMAIL.test(email)) return `invalid email address: ${email || "(empty)"}`;
      if (!entries.some((entry) => entry.email === email)) entries.push({ user_id: account ? id : null, email });
    }
    out.entries = entries;
  }
  return out;
}

function nameTaken(teams: StoredTeam[], name: string, except?: string): boolean {
  return teams.some((team) => team.id !== except && team.name.toLocaleLowerCase() === name.toLocaleLowerCase());
}

function deliveryOf(store: DemoStore, id: string): MeetingDeliverySettings {
  const teamIds = new Set(teamsOf(store).map((team) => team.id));
  const current = store.delivery[id];
  return { ...current, internal_group_ids: (current.internal_group_ids ?? []).filter((groupId) => teamIds.has(groupId)) };
}

function withMeeting(handler: (id: string, request: DemoRequest) => Response) {
  return (request: DemoRequest) => findSeed(request.store, request.params.id) ? handler(request.params.id, request) : problem(404, "meeting not found");
}

function sendConfigured(store: DemoStore, id: string): Response {
  const minutes = store.minutes[id];
  if (!minutes) return problem(404, "No minutes to send.");
  if (minutes.status !== "approved" && minutes.status !== "sent") return problem(409, "approve the MOM before sending it");
  const settings = deliveryOf(store, id);
  const used = teamsOf(store).filter((team) => settings.internal_group_ids?.includes(team.id)).map((team) => publicTeam(store, team));
  const internal = [...new Set([...settings.internal_recipients, ...used.flatMap((team) => team.members.filter((member) => member.active).map((member) => member.email))])];
  const to = [...new Set([...internal, ...(settings.send_to_participants ? settings.participant_recipients : [])])];
  if (!to.length) return problem(409, "choose at least one recipient — a teammate, a team or the meeting participants");
  const now = new Date().toISOString();
  store.minutes = { ...store.minutes, [id]: { ...minutes, status: "sent", sent_at: now, updated_at: now } };
  notify(`Demo: no email was sent. In a real workspace the approved recap would go to ${to.length} recipient${to.length === 1 ? "" : "s"}${used.length ? `, including ${used.map((team) => team.name).join(" and ")}` : ""}.`);
  const delivery: EmailDelivery = {
    id: newId(13), meeting_id: id, recipients: to, status: "sent", provider_message_id: "demo-not-sent", error: null, created_at: now,
    groups: used.map((team) => ({ id: team.id, name: team.name, member_count: team.member_count })),
  };
  return json(delivery);
}

export function registerTeams(router: DemoRouter): void {
  router
    .on("GET", "/v1/workspace/teams", ({ store }) => json(teamsOf(store).map((team) => publicTeam(store, team)).sort((a, b) => a.name.localeCompare(b.name))))
    .on("GET", "/v1/workspace/teams/:id", ({ store, params }) => {
      const found = teamsOf(store).find((team) => team.id === params.id);
      return found ? json(publicTeam(store, found)) : problem(404, "team not found");
    })
    .on("POST", "/v1/workspace/teams", ({ store, body }) => {
      const input = parseInput(store, body, false);
      if (typeof input === "string") return problem(422, input);
      const teams = teamsOf(store);
      if (nameTaken(teams, input.name ?? "")) return problem(409, "a team with this name already exists");
      const now = new Date().toISOString();
      const created: StoredTeam = { id: newId(TEAM_GROUP), name: input.name ?? "", description: input.description ?? null, created_by: userId(1), created_at: now, updated_at: now, entries: input.entries ?? [] };
      state.set(store, [...teams, created]);
      return json(publicTeam(store, created), 201);
    })
    .on("PATCH", "/v1/workspace/teams/:id", ({ store, params, body }) => {
      const teams = teamsOf(store);
      const current = teams.find((team) => team.id === params.id);
      if (!current) return problem(404, "team not found");
      const input = parseInput(store, body, true);
      if (typeof input === "string") return problem(422, input);
      if (input.name && nameTaken(teams, input.name, current.id)) return problem(409, "a team with this name already exists");
      const next: StoredTeam = { ...current, ...(input.name ? { name: input.name } : {}), ...("description" in input ? { description: input.description ?? null } : {}), ...(input.entries ? { entries: input.entries } : {}), updated_at: new Date().toISOString() };
      state.set(store, teams.map((team) => team.id === current.id ? next : team));
      return json(publicTeam(store, next));
    })
    .on("DELETE", "/v1/workspace/teams/:id", ({ store, params }) => {
      const teams = teamsOf(store);
      if (!teams.some((team) => team.id === params.id)) return problem(404, "team not found");
      state.set(store, teams.filter((team) => team.id !== params.id));
      store.delivery = Object.fromEntries(Object.entries(store.delivery).map(([id, settings]) => [id, { ...settings, internal_group_ids: (settings.internal_group_ids ?? []).filter((groupId) => groupId !== params.id) }]));
      return noContent();
    })
    .on("GET", "/v1/meetings/:id/delivery-settings", withMeeting((id, { store }) => json(deliveryOf(store, id))))
    .on("PUT", "/v1/meetings/:id/delivery-settings", withMeeting((id, { store, body }) => {
      const known = new Set(teamsOf(store).map((team) => team.id));
      const groupIds = [...new Set(strList(body.internal_group_ids))];
      if (groupIds.some((groupId) => !known.has(groupId))) return problem(422, "one of the selected teams no longer exists");
      const next: MeetingDeliverySettings = {
        internal_recipients: strList(body.internal_recipients), participant_recipients: strList(body.participant_recipients),
        send_to_participants: Boolean(body.send_to_participants), include_transcript: Boolean(body.include_transcript), internal_group_ids: groupIds,
      };
      store.delivery = { ...store.delivery, [id]: next };
      return json(next);
    }))
    .on("POST", "/v1/meetings/:id/minutes/send-configured", withMeeting((id, { store }) => sendConfigured(store, id)));
}
