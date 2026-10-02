/** Sample personal MOMs stay in this tab; no provider calls, email or real persistence. */
import type { MinutesVersion, MinutesVersionSummary } from "../../minutes-versions";
import type { MomGuidance } from "../../types";
import { newId } from "../fixtures/ids";
import { OWNER_ID } from "../fixtures/people";
import { json, noContent, notify, problem, str, strList } from "../http";
import { draftMinutes } from "../minutes-generator";
import type { DemoRouter } from "../router";
import type { DemoStore } from "../store";
import { findSeed } from "./meetings";

const states = new WeakMap<DemoStore, MinutesVersion[]>();
const state = (store: DemoStore) => {
  let rows = states.get(store);
  if (!rows) { rows = []; states.set(store, rows); }
  return rows;
};
const summary = (row: MinutesVersion): MinutesVersionSummary => {
  const { guidance, content, user_ids, source_is_current, provider, model, ...result } = row;
  void guidance; void content; void user_ids; void source_is_current; void provider; void model;
  return result;
};

export function registerMinutesVersions(router: DemoRouter): void {
  router.on("GET", "/v1/me/minutes-versions", ({ store }) => json(state(store).filter((row) => findSeed(store, row.meeting_id)).map(summary)));
  router.on("GET", "/v1/meetings/:id/minutes-versions", ({ store, params }) => json(state(store).filter((row) => row.meeting_id === params.id).map(summary)));
  router.on("POST", "/v1/meetings/:id/minutes-versions", ({ store, params, body }) => {
    if (!findSeed(store, params.id)) return problem(404, "meeting not found");
    const label = str(body.label)?.trim();
    if (!label) return problem(422, "Name your MOM version.");
    const stamp = new Date().toISOString();
    const row: MinutesVersion = { id: newId(35), meeting_id: params.id, label, creator_id: OWNER_ID,
      creator_name: store.displayName, template: str(body.perspective) ?? "standard", status: "empty", visibility: "private",
      revision: 1, is_mine: true, can_read: true, created_at: stamp, updated_at: stamp,
      guidance: body.guidance as MomGuidance, content: null, user_ids: [], source_is_current: false, provider: null, model: null };
    state(store).push(row); return json(row, 201);
  });
  router.on("GET", "/v1/minutes-versions/:id", ({ store, params }) => {
    const row = state(store).find((item) => item.id === params.id);
    return row && findSeed(store, row.meeting_id) ? json(row) : problem(404, "MOM version not found");
  });
  for (const action of ["edit", "approve", "sharing", "jobs", "delete"] as const) {
    const method = action === "edit" ? "PATCH" : action === "delete" ? "DELETE" : "POST";
    const suffix = action === "edit" || action === "delete" ? "" : `/${action}`;
    router.on(method, `/v1/minutes-versions/:id${suffix}`, ({ store, params, body, query }) => {
      const row = state(store).find((item) => item.id === params.id);
      if (!row || !findSeed(store, row.meeting_id)) return problem(404, "MOM version not found");
      if (row.revision !== Number(action === "delete" ? query.get("revision") : body.revision)) return problem(409, "Refresh this version before changing it.");
      if (action === "delete") { states.set(store, state(store).filter((item) => item.id !== row.id)); return noContent(); }
      if (action === "approve" && !row.content) return problem(409, "Generate a draft first.");
      if (action === "jobs") {
        const seed = findSeed(store, row.meeting_id)!;
        if (seed.live || !seed.segments.length) return problem(409, "Finish the capture before generating your MOM.");
        row.content = draftMinutes(seed, seed.segments); row.source_is_current = true; row.status = "draft";
        row.provider = "demo"; row.model = "sample-data";
        notify("Demo: personal MOMs are sample drafts. No AI call or second transcription is made.");
      }
      if (action === "edit") {
        row.label = str(body.label) ?? row.label; row.guidance = body.guidance as MomGuidance;
        row.template = str(body.perspective) ?? row.template;
        if (body.content) row.content = body.content as MinutesVersion["content"];
        row.status = row.content ? "draft" : "empty";
      }
      if (action === "approve") row.status = "approved";
      if (action === "sharing") { row.visibility = body.visibility as MinutesVersion["visibility"]; row.user_ids = strList(body.user_ids); }
      row.revision += 1; row.updated_at = new Date().toISOString();
      return action === "jobs" ? json({ id: newId(14), kind: "personal_mom", subject_id: row.id, status: "succeeded",
        result: { version_id: row.id }, attempts: 1, user_id: OWNER_ID, created_at: row.updated_at,
        started_at: row.updated_at, updated_at: row.updated_at, finished_at: row.updated_at }, 202) : json(row);
    });
  }
}
