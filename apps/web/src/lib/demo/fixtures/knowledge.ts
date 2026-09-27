import type { KnowledgeBase, KnowledgeConversation, KnowledgeSource } from "../../types";
import { findSource } from "../knowledge-engine";
import { baseId, type Clock, conversationId, minutesFrom, ORG_VENTURES } from "./ids";
import type { MeetingSeed } from "./meetings";
import { OWNER_ID, team } from "./people";

export function knowledgeBases(clock: Clock, orgId: string, seeds: MeetingSeed[]): KnowledgeBase[] {
  const count = (id: string) => seeds.filter((seed) => seed.meeting.knowledge_base_id === id && seed.meeting.knowledge_enabled).length;
  const base = (index: number, name: string, description: string, visibility: KnowledgeBase["visibility"], shared: string[], ageDays: number, touched: number): KnowledgeBase => ({
    id: baseId(index), organization_id: orgId, name, description, created_by: OWNER_ID, visibility, text_profile_id: null,
    meeting_count: count(baseId(index)), shared_user_ids: shared, created_at: minutesFrom(clock, -ageDays * 24 * 60), updated_at: minutesFrom(clock, -touched),
  });
  const all = [
    base(1, "Acme Robotics account", "Pilot scope, security conditions and weekly delivery for Acme Robotics.", "organization", [], 64, 18),
    base(2, "Client delivery", "Globex and Initech engagements: renewals, go-lives and discovery.", "specific", [team[1].id, team[2].id, team[3].id], 120, 60 * 20),
    base(3, "Leadership notes", "Internal leadership syncs. Private to the leadership team.", "private", [], 200, 60 * 24 * 4),
  ];
  return orgId === ORG_VENTURES ? all.filter((item) => item.id === baseId(3)) : all;
}

type Turn = { question: string; answer: string; evidence: string[] };
type Thread = { index: number; base: number; title: string; ageMinutes: number; turns: Turn[] };

const THREADS: Thread[] = [
  { index: 1, base: 1, title: "Who owns the next steps for the Acme pilot?", ageMinutes: 40, turns: [
    { question: "Who owns the next steps for the Acme pilot, and when are they due?", evidence: ["acme-roadmap:21", "acme-roadmap:19", "acme-roadmap:22", "acme-roadmap:26"],
      answer: "Four owners came out of the Q4 roadmap meeting:\n\n- Daniel Kim owns the architecture document and data map, due by Friday [K1].\n- Asha Patel will grant read access to the SharePoint maintenance library this week; the ServiceNow export needs security approval [K2].\n- Chen Li will nominate the five pilot technicians and check their tablets [K3].\n- Priya Shah will send the statement of work with the success criteria written in [K4]." },
    { question: "What is still open?", evidence: ["acme-roadmap:23", "acme-roadmap:25", "acme-roadmap:27", "acme-roadmap:29"],
      answer: "Two questions were left open:\n\n- Whether to include the Dutch-language manuals for the Rotterdam yard trucks [K1]; Alex suggested revisiting once the port confirms the demo date [K2].\n- What production will cost per site after the pilot [K3]. Chen Li asked for a range because budget planning closes in November [K4]." },
  ] },
  { index: 2, base: 1, title: "What security conditions did Acme set?", ageMinutes: 60 * 26, turns: [
    { question: "What security conditions did Acme set for the pilot?", evidence: ["acme-security:3", "acme-security:5", "acme-security:11", "acme-security:15", "acme-security:21"],
      answer: "Grace Liu's conditions were:\n\n- Everything runs in Acme's Azure subscription, with West Europe for Rotterdam [K1].\n- Model calls go to Acme's own Azure OpenAI deployment over a private endpoint [K2].\n- Sign-in through Entra ID, restricted to a security group Acme manages [K3].\n- Query logs kept for 90 days; the pilot index is deleted at the end unless moved to production [K4].\n- A red-team set for prompt injection must be part of the evaluation [K5]." },
  ] },
  { index: 3, base: 1, title: "When does the FieldGuide pilot start and end?", ageMinutes: 60 * 6, turns: [
    { question: "When does the FieldGuide pilot start and end?", evidence: ["acme-roadmap:18", "acme-roadmap:17"],
      answer: "The pilot starts on October 14 and reads out on November 4, provided SharePoint and ServiceNow access arrive by the tenth [K1]. Asha Patel confirmed the October commitment in the same meeting [K2]." },
  ] },
  { index: 4, base: 2, title: "What did Globex agree on price and SLA?", ageMinutes: 60 * 50, turns: [
    { question: "What did Globex agree on price and SLA?", evidence: ["globex-renewal:15", "globex-renewal:9", "globex-renewal:16"],
      answer: "They agreed in principle to a two-year term: 4% in year one, flat in year two, 99.9% availability during month-end close and a one-hour P1 response [K1]. The service credit cap rises to 10% for month-end breaches [K2]. It is subject to Globex legal review [K3]." },
  ] },
  { index: 5, base: 2, title: "Summarise Initech's support pain points", ageMinutes: 60 * 30, turns: [
    { question: "Summarise Initech's support pain points", evidence: ["initech-discovery:3", "initech-discovery:5", "initech-discovery:6", "initech-discovery:8"],
      answer: "- About 18,000 tickets a month in English and Spanish; 40% are billing and password questions [K1].\n- Help center articles are stale, so agents rewrite macros; first response is about nine hours [K2].\n- CSAT fell from 88% to 82% in two quarters [K3].\n- Leadership won't risk a customer-facing bot on billing answers [K4]." },
  ] },
  { index: 6, base: 3, title: "Leadership decisions this week", ageMinutes: 60 * 24 * 3, turns: [
    { question: "What did leadership decide this week?", evidence: ["leadership:20", "leadership:7", "leadership:13"],
      answer: "Three decisions: the Globex renewal floor is 4%, Hannah Lee shadows Daniel on Acme before taking Initech, and the red-team evaluation set becomes standard [K1]. The 4% floor was agreed so nobody improvises on the call [K2], and Hannah's plan was set by Alex [K3]." },
  ] },
];

export function conversations(clock: Clock, seeds: MeetingSeed[]): KnowledgeConversation[] {
  return THREADS.filter((thread) => seeds.some((seed) => seed.meeting.knowledge_base_id === baseId(thread.base))).map((thread) => {
    const created = minutesFrom(clock, -thread.ageMinutes);
    return {
      id: conversationId(thread.index), knowledge_base_id: baseId(thread.base), title: thread.title, created_at: created, updated_at: minutesFrom(clock, -thread.ageMinutes + thread.turns.length * 2),
      messages: thread.turns.flatMap((turn, index) => {
        const citations = turn.evidence.map((id) => findSource(seeds, id)).filter((item): item is KnowledgeSource => Boolean(item));
        const at = minutesFrom(clock, -thread.ageMinutes + index * 2);
        return [
          { id: `${conversationId(thread.index)}:q${index}`, role: "user" as const, content: turn.question, citations: [], provider: null, model: null, created_at: at },
          { id: `${conversationId(thread.index)}:a${index}`, role: "assistant" as const, content: turn.answer, citations, provider: "openrouter", model: "openai/gpt-6-luna", created_at: at },
        ];
      }),
    };
  });
}

export const FEATURED_CONVERSATION = conversationId(1);

/** Curated question/answer pairs, reused when a visitor asks something close to them. */
export function cannedAnswers(): Array<{ base: string; question: string; answer: string; evidence: string[] }> {
  return THREADS.flatMap((thread) => thread.turns.map((turn) => ({ base: baseId(thread.base), question: turn.question, answer: turn.answer, evidence: turn.evidence })));
}
