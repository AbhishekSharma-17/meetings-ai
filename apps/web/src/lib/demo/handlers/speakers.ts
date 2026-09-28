import type { SpeakerSuggestion, SpeakerSuggestionSource } from "../../types";
import { team } from "../fixtures/people";
import { visibleSegments } from "../fixtures/meetings";
import { json, problem, str } from "../http";
import type { DemoRouter } from "../router";
import { findSeed } from "./meetings";

type Candidate = { email: string; name: string; source: SpeakerSuggestionSource };
type Match = { candidate: Candidate; confidence: "high" | "medium"; reason: string };

const ASSISTANT = "meetings ai";
const words = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const who = (candidate: Candidate) => `${candidate.source === "workspace_member" ? "workspace member" : "invitee"} ${candidate.name}`;

/** A small version of the API's matcher: full name, unique first/last name, or email local part. */
function match(speaker: string[], candidate: Candidate): Match | null {
  const name = words(candidate.name.includes("@") ? "" : candidate.name);
  const local = words(candidate.email.split("@")[0].replace(/[._-]+/g, " "));
  if (name.length && speaker.join(" ") === name.join(" ")) return { candidate, confidence: "high", reason: `Full name matches ${who(candidate)}` };
  if (speaker.length === 1 && name[0] === speaker[0]) return { candidate, confidence: "medium", reason: `First name matches ${who(candidate)}` };
  if (speaker.length === 1 && name.length > 1 && name.at(-1) === speaker[0]) return { candidate, confidence: "medium", reason: `Last name matches ${who(candidate)}` };
  if (local.length && local.join(" ") === speaker.join(" ")) return { candidate, confidence: "medium", reason: `Email ${candidate.email} matches the name` };
  return null;
}

function suggest(speaker: string, candidates: Candidate[]): SpeakerSuggestion | null {
  const found = candidates.map((candidate) => match(words(speaker), candidate)).filter((item): item is Match => Boolean(item));
  const top = found.some((item) => item.confidence === "high") ? found.filter((item) => item.confidence === "high") : found;
  const meeting = top.filter((item) => item.candidate.source !== "workspace_member");
  const level = meeting.length ? meeting : top;
  if (!level.length) return null;
  const alternatives = level.map((item) => ({ email: item.candidate.email, display_name: item.candidate.name, source: item.candidate.source }));
  if (level.length > 1) {
    return { speaker, status: "ambiguous", email: null, display_name: null, source: null, confidence: null, alternatives,
      reason: `“${speaker}” matches ${level.length} people (${level.slice(0, 3).map((item) => item.candidate.name).join(", ")}); choose the right one` };
  }
  const [best] = level;
  return { speaker, status: "suggested", email: best.candidate.email, display_name: best.candidate.name, source: best.candidate.source, confidence: best.confidence, reason: best.reason, alternatives: [] };
}

export function registerSpeakers(router: DemoRouter): void {
  router
    .on("GET", "/v1/meetings/:id/speaker-suggestions", ({ store, params }) => {
      const seed = findSeed(store, params.id);
      if (!seed) return problem(404, "meeting not found");
      const confirmed = store.identities[seed.meeting.id] ?? [];
      const taken = new Set(confirmed.map((item) => item.email));
      const seen = new Set<string>();
      const candidates = [
        ...seed.invitees.flatMap((person): Candidate[] => person.email ? [{ email: person.email, name: person.name, source: "invite" }] : []),
        ...team.filter((person) => person.status !== "disabled").map((person): Candidate => ({ email: person.email, name: person.name, source: "workspace_member" })),
      ].filter((candidate) => !taken.has(candidate.email) && !seen.has(candidate.email) && Boolean(seen.add(candidate.email)));
      const speakers = [...new Set(visibleSegments(seed, Date.now()).map((segment) => segment.speaker).filter((name): name is string => Boolean(name)))]
        .filter((name) => words(name).join(" ") !== ASSISTANT && !confirmed.some((item) => item.speaker === name));
      return json(speakers.map((speaker) => suggest(speaker, candidates)).filter(Boolean));
    })
    .on("POST", "/v1/meetings/:id/speaker-identities/bulk", ({ store, params, body }) => {
      const seed = findSeed(store, params.id);
      if (!seed) return problem(404, "meeting not found");
      const items = Array.isArray(body.identities) ? body.identities as Record<string, unknown>[] : [];
      const approvals = items.map((item) => ({ speaker: str(item.speaker)?.trim() ?? "", email: str(item.email)?.trim().toLowerCase() ?? "" }));
      if (!approvals.length || approvals.some((item) => !item.speaker || !item.email.includes("@"))) return problem(422, "Each approval needs a speaker and an email.");
      const now = new Date().toISOString();
      const kept = (store.identities[seed.meeting.id] ?? []).filter((item) => !approvals.some((approval) => approval.speaker === item.speaker));
      store.identities[seed.meeting.id] = [...kept, ...approvals.map((item) => ({ ...item, confirmed_at: now }))];
      return json(store.identities[seed.meeting.id]);
    });
}
