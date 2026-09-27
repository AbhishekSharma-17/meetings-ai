import type { KnowledgeBase, KnowledgeChatResponse, KnowledgeConversation, KnowledgeIndexStatus, KnowledgeSource, TextModelCatalog } from "../../types";
import { newId } from "../fixtures/ids";
import { cannedAnswers } from "../fixtures/knowledge";
import { OWNER_ID } from "../fixtures/people";
import { catalogModels, PROFILE_EMBED, textProfiles } from "../fixtures/providers";
import { json, noContent, problem, sse, type SseFrame, str, strList, wait } from "../http";
import { composeAnswer, findSource, mapFor, outOfScopeTerms, overviewFor, search, searchableSeeds, terms } from "../knowledge-engine";
import type { DemoRequest, DemoRouter } from "../router";
import type { DemoStore } from "../store";

const REINDEX_MS = 5_000;
const NOTE = "Answers use only the cited meeting evidence. Check the sources before acting on them.";

function withBase(handler: (base: KnowledgeBase, request: DemoRequest) => Response | Promise<Response>) {
  return (request: DemoRequest) => {
    const base = request.store.bases.find((item) => item.id === request.params.id);
    return base ? handler(base, request) : problem(404, "knowledge base not found");
  };
}

function indexStatus(store: DemoStore, base: KnowledgeBase): KnowledgeIndexStatus {
  const requested = store.reindexedAt[base.id];
  const running = requested && Date.now() - requested < REINDEX_MS;
  const sources = searchableSeeds(store.seeds, base.id).reduce((sum, seed) => sum + seed.segments.length, 0);
  return {
    knowledge_base_id: base.id, indexed_sources: sources, profile_id: PROFILE_EMBED, model: "text-embedding-3-small",
    last_indexed_at: requested && !running ? new Date(requested + REINDEX_MS).toISOString() : new Date(store.clock.start - 22 * 60_000).toISOString(),
    job_status: running ? "running" : "succeeded", requested_at: requested ? new Date(requested).toISOString() : null, next_retry_at: null, last_error: null,
  };
}

/** The word as the visitor typed it, e.g. "Globex" rather than the normalised "globex". */
function asWritten(question: string, term: string): string {
  return question.split(/[^A-Za-z0-9-]+/).find((word) => word.toLowerCase() === term) ?? term;
}

/** A cited answer: a curated reply when the question is close to one, otherwise quotes from the best-matching turns. */
function answer(store: DemoStore, question: string, tags: string[], baseId: string | null): { text: string; citations: KnowledgeSource[] } {
  const asked = terms(question);
  const canned = cannedAnswers().filter((item) => !baseId || item.base === baseId).map((item) => {
    const known = terms(item.question);
    return { item, score: asked.filter((term) => known.includes(term)).length / Math.max(known.length, 1) };
  }).sort((a, b) => b.score - a.score)[0];
  if (canned && canned.score >= 0.6) {
    return { text: canned.item.answer, citations: canned.item.evidence.map((id) => findSource(store.seeds, id)).filter((item): item is KnowledgeSource => Boolean(item)) };
  }
  const scope = store.bases.find((item) => item.id === baseId)?.name ?? "your opted-in meetings";
  const elsewhere = outOfScopeTerms(store.seeds, question, baseId);
  if (elsewhere.length) {
    const other = store.bases.find((base) => base.id !== baseId && searchableSeeds(store.seeds, base.id).some((seed) => elsewhere.some((term) => terms(`${seed.meeting.title} ${seed.meeting.tags.join(" ")}`).includes(term))));
    return { text: `None of the meetings in ${scope} mention ${elsewhere.map((term) => `“${asWritten(question, term)}”`).join(" or ")}.${other ? ` Those conversations are in the ${other.name} knowledge base — switch to it and ask again.` : ""}`, citations: [] };
  }
  const sources = search(store.seeds, question, tags, baseId, 4);
  return { text: composeAnswer(question, sources, scope), citations: sources };
}

function saveExchange(store: DemoStore, baseId: string, conversationId: string | null, question: string, reply: { text: string; citations: KnowledgeSource[] }): string {
  const now = new Date().toISOString();
  const messages = [
    { id: newId(14), role: "user" as const, content: question, citations: [], provider: null, model: null, created_at: now },
    { id: newId(14), role: "assistant" as const, content: reply.text, citations: reply.citations, provider: "openrouter", model: "openai/gpt-6-luna", created_at: now },
  ];
  const existing = conversationId ? store.conversations.find((item) => item.id === conversationId) : undefined;
  if (existing) {
    store.conversations = store.conversations.map((item) => item.id === existing.id ? { ...item, updated_at: now, messages: [...item.messages, ...messages] } : item);
    return existing.id;
  }
  const created: KnowledgeConversation = { id: newId(5), knowledge_base_id: baseId, title: question.length > 70 ? `${question.slice(0, 67)}…` : question, created_at: now, updated_at: now, messages };
  store.conversations = [created, ...store.conversations];
  return created.id;
}

function chatResponse(store: DemoStore, body: Record<string, unknown>): { response: KnowledgeChatResponse; raw: string } | Response {
  const question = str(body.query)?.trim();
  if (!question || question.length < 2) return problem(422, "Ask a question of at least two characters.");
  const baseId = str(body.knowledge_base_id);
  const reply = answer(store, question, strList(body.tags), baseId);
  const conversation = baseId ? saveExchange(store, baseId, str(body.conversation_id), question, reply) : null;
  const response: KnowledgeChatResponse = { answer: reply.text, citations: reply.citations, conversation_id: conversation, provider: "openrouter", model: "openai/gpt-6-luna", retrieval_mode: "hybrid", note: NOTE };
  return { response, raw: JSON.stringify({ answer: reply.text, citations: reply.citations.map((_, index) => `K${index + 1}`) }) };
}

function chunks(text: string, size: number): string[] {
  return Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
}

export function registerKnowledge(router: DemoRouter): void {
  router
    .on("GET", "/v1/knowledge-bases", ({ store }) => json(store.bases))
    .on("POST", "/v1/knowledge-bases", ({ store, body }) => {
      const name = str(body.name)?.trim();
      if (!name || name.length < 2) return problem(422, "Enter a name of at least two characters.");
      const now = new Date().toISOString();
      const base: KnowledgeBase = { id: newId(4), organization_id: store.orgId, name, description: str(body.description), created_by: OWNER_ID, visibility: "private", text_profile_id: null, meeting_count: 0, shared_user_ids: [], created_at: now, updated_at: now };
      store.bases = [...store.bases, base];
      return json(base, 201);
    })
    .on("GET", "/v1/knowledge-bases/:id", withBase((base) => json(base)))
    .on("PATCH", "/v1/knowledge-bases/:id", withBase((base, { store, body }) => {
      const next = { ...base, ...("name" in body && str(body.name) ? { name: str(body.name) as string } : {}), ...("description" in body ? { description: str(body.description) } : {}), ...("text_profile_id" in body ? { text_profile_id: str(body.text_profile_id) } : {}), updated_at: new Date().toISOString() };
      store.bases = store.bases.map((item) => item.id === base.id ? next : item);
      return json(next);
    }))
    .on("DELETE", "/v1/knowledge-bases/:id", withBase((base, { store }) => {
      store.bases = store.bases.filter((item) => item.id !== base.id);
      store.conversations = store.conversations.filter((item) => item.knowledge_base_id !== base.id);
      store.seeds = store.seeds.map((seed) => seed.meeting.knowledge_base_id === base.id ? { ...seed, meeting: { ...seed.meeting, knowledge_base_id: null, knowledge_enabled: false } } : seed);
      return noContent();
    }))
    .on("PUT", "/v1/knowledge-bases/:id/sharing", withBase((base, { store, body }) => {
      const visibility = (["private", "organization", "specific"] as const).find((item) => item === str(body.visibility)) ?? base.visibility;
      const next = { ...base, visibility, shared_user_ids: visibility === "specific" ? strList(body.user_ids) : [], updated_at: new Date().toISOString() };
      store.bases = store.bases.map((item) => item.id === base.id ? next : item);
      return json(next);
    }))
    .on("GET", "/v1/knowledge-bases/:id/overview", withBase((base, { store }) => json(overviewFor(base.id, base.name, store.seeds, store.minutes))))
    .on("GET", "/v1/knowledge-bases/:id/map", withBase((base, { store }) => json(mapFor(base.id, store.seeds, Object.fromEntries(Object.values(store.identities).flat().map((item) => [item.speaker, item.email]))))))
    .on("GET", "/v1/knowledge-bases/:id/index", withBase((base, { store }) => json(indexStatus(store, base))))
    .on("POST", "/v1/knowledge-bases/:id/reindex", withBase((base, { store }) => { store.reindexedAt = { ...store.reindexedAt, [base.id]: Date.now() }; return json(indexStatus(store, base)); }))
    .on("GET", "/v1/knowledge-bases/:id/conversations", withBase((base, { store }) => json(store.conversations.filter((item) => item.knowledge_base_id === base.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at)))))
    .on("GET", "/v1/knowledge-bases/:id/conversations/:conversationId", withBase((base, { store, params }) => {
      const conversation = store.conversations.find((item) => item.id === params.conversationId && item.knowledge_base_id === base.id);
      return conversation ? json(conversation) : problem(404, "conversation not found");
    }))
    .on("DELETE", "/v1/knowledge-bases/:id/conversations/:conversationId", withBase((_base, { store, params }) => { store.conversations = store.conversations.filter((item) => item.id !== params.conversationId); return noContent(); }))
    .on("POST", "/v1/knowledge/search", async ({ store, body }) => {
      await wait(350);
      const sources = search(store.seeds, str(body.query) ?? "", strList(body.tags), str(body.knowledge_base_id), 12);
      return json({ sources, count: sources.length, retrieval_mode: "hybrid", truncated_meeting_scope: false });
    })
    .on("POST", "/v1/knowledge/chat", async ({ store, body }) => {
      await wait(900);
      const result = chatResponse(store, body);
      return result instanceof Response ? result : json(result.response);
    })
    .on("POST", "/v1/knowledge/chat/stream", ({ store, body }) => {
      const result = chatResponse(store, body);
      if (result instanceof Response) return result;
      return sse(async function* (): AsyncGenerator<SseFrame> {
        let first = true;
        for (const piece of chunks(result.raw, 14)) { yield { event: "delta", data: piece, delayMs: first ? 700 : 28 }; first = false; }
        yield { event: "final", data: result.response, delayMs: 120 };
      });
    })
    .on("GET", "/v1/knowledge/text-profiles", ({ store }) => json(textProfiles(store.profiles)))
    .on("GET", "/v1/knowledge/text-profiles/:id/models", ({ store, params }) => {
      const profile = store.profiles.find((item) => item.id === params.id);
      if (!profile) return problem(404, "text provider not found");
      const provider = profile.provider_type === "openai" ? "openai" : "openrouter";
      const catalog: TextModelCatalog = { profile_id: profile.id, provider, configured_model: profile.capabilities[0]?.model ?? "", live_catalog: true, models: catalogModels(provider, "text_generation").map((model) => ({ id: model.id, name: model.name, input_per_million_usd: model.input_per_million_usd, output_per_million_usd: model.output_per_million_usd })) };
      return json(catalog);
    });
}
