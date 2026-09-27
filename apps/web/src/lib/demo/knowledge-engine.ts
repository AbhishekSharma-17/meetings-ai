import type { KnowledgeMap, KnowledgeMapEntry, KnowledgeSource, KnowledgeWikiOverview, MeetingMinutes } from "../types";
import type { MeetingSeed } from "./fixtures/meetings";
import { team } from "./fixtures/people";

/** Keyword retrieval over the sample transcripts: enough to make search and Ask AI feel real. */
const STOPWORDS = new Set("a an and are as at be by can did do does for from had has have how i in is it its of on or our said say says the their them they this to was we were what when where which who why will with you your about any there".split(" "));

export function terms(text: string): string[] {
  return Array.from(new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((word) => word.length > 2 && !STOPWORDS.has(word))));
}

export function searchableSeeds(seeds: MeetingSeed[], baseId: string | null): MeetingSeed[] {
  return seeds.filter((seed) => seed.meeting.status === "completed" && seed.meeting.knowledge_enabled && (!baseId || seed.meeting.knowledge_base_id === baseId));
}

export function sourceFor(seed: MeetingSeed, segmentId: string, kind: KnowledgeSource["kind"] = "transcript"): KnowledgeSource | null {
  const segment = seed.segments.find((item) => item.segment_id === segmentId);
  if (!segment) return null;
  return {
    source_id: `${kind}:${segment.segment_id}`, kind, meeting_id: seed.meeting.id, knowledge_base_id: seed.meeting.knowledge_base_id,
    meeting_title: seed.meeting.title, meeting_created_at: seed.meeting.created_at, meeting_joined_at: seed.meeting.joined_at,
    segment_id: segment.segment_id, start_seconds: segment.start_seconds, end_seconds: segment.end_seconds, speaker: segment.speaker,
    text: segment.text, tags: seed.meeting.tags, evidence_segment_ids: [segment.segment_id],
  };
}

export function findSource(seeds: MeetingSeed[], segmentId: string): KnowledgeSource | null {
  const seed = seeds.find((item) => item.segments.some((segment) => segment.segment_id === segmentId));
  return seed ? sourceFor(seed, segmentId) : null;
}

const matches = (words: string[], term: string) => words.some((word) => word.startsWith(term) || (term.startsWith(word) && word.length > 3));

/** Keyword search weighted by rarity, so common words ("agree", "team") don't outrank names and topics. */
export function search(seeds: MeetingSeed[], query: string, tags: string[], baseId: string | null, limit = 8): KnowledgeSource[] {
  const wanted = terms(query);
  if (!wanted.length) return [];
  const candidates = searchableSeeds(seeds, baseId)
    .filter((seed) => !tags.length || tags.every((tag) => seed.meeting.tags.includes(tag.toLowerCase())))
    .flatMap((seed) => seed.segments.filter((segment) => segment.speaker !== "Meetings AI").map((segment) => ({ seed, segment, words: terms(`${segment.text} ${segment.speaker ?? ""}`), title: terms(`${seed.meeting.title} ${seed.meeting.tags.join(" ")}`) })));
  if (!candidates.length) return [];
  const weight = new Map(wanted.map((term) => {
    const frequency = candidates.filter((item) => matches(item.words, term)).length;
    return [term, frequency ? Math.log(1 + candidates.length / frequency) : 0];
  }));
  const scored = candidates.map((item) => {
    const text = wanted.reduce((sum, term) => sum + (matches(item.words, term) ? weight.get(term) ?? 0 : 0), 0);
    const title = wanted.filter((term) => item.title.includes(term)).length * 0.4;
    return { item, score: text ? text + title : 0 };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  return scored.filter((entry) => entry.score >= Math.max(1.2, best * 0.45)).slice(0, limit)
    .map((entry) => sourceFor(entry.item.seed, entry.item.segment.segment_id)).filter((item): item is KnowledgeSource => Boolean(item));
}

/** Names or topics the question mentions that only appear in meetings outside this scope. */
export function outOfScopeTerms(seeds: MeetingSeed[], question: string, baseId: string | null): string[] {
  if (!baseId) return [];
  const label = (seed: MeetingSeed) => terms(`${seed.meeting.title} ${seed.meeting.tags.join(" ")}`);
  const inside = new Set(searchableSeeds(seeds, baseId).flatMap(label));
  const everywhere = new Set(searchableSeeds(seeds, null).flatMap(label));
  return terms(question).filter((term) => everywhere.has(term) && !inside.has(term));
}

/** A cited answer composed from the best-matching transcript turns. */
export function composeAnswer(question: string, sources: KnowledgeSource[], scopeName: string): string {
  if (!sources.length) {
    return `I couldn't find that in the meetings in ${scopeName}. Try naming a client, person or topic — for example “Acme pilot timeline”, “Globex SLA” or “Initech Spanish support”.`;
  }
  const lead = sources[0];
  const lines = sources.slice(0, 4).map((source, index) => `- ${source.speaker ?? "An unidentified speaker"} (${source.meeting_title}): “${source.text.length > 180 ? `${source.text.slice(0, 177)}…` : source.text}” [K${index + 1}]`);
  const opener = /\b(who|owner|owns)\b/i.test(question)
    ? `The clearest owner in the evidence is ${lead.speaker ?? "an unidentified speaker"}, from “${lead.meeting_title}” [K1].`
    : /\b(when|date|timeline|start|deadline)\b/i.test(question)
      ? `The meetings give this timeline, starting with “${lead.meeting_title}” [K1].`
      : `Here is what the meetings in ${scopeName} say about this.`;
  return `${opener}\n\n${lines.join("\n")}\n\nThese are direct quotes from the transcripts; open a source to check the surrounding discussion.`;
}

export function overviewFor(baseIdValue: string, name: string, seeds: MeetingSeed[], minutes: Record<string, MeetingMinutes | null>): KnowledgeWikiOverview {
  const inBase = searchableSeeds(seeds, baseIdValue);
  return {
    knowledge_base_id: baseIdValue, name,
    meetings: inBase.map((seed) => {
      const record = minutes[seed.meeting.id];
      const related = inBase.filter((other) => other !== seed && other.meeting.tags.some((tag) => seed.meeting.tags.includes(tag)));
      return {
        id: seed.meeting.id, title: seed.meeting.title, created_at: seed.meeting.created_at, tags: seed.meeting.tags,
        summary: record?.executive_summary ?? null, decisions: record?.decisions ?? [],
        action_items: (record?.action_items ?? []).map((item) => `${item.owner ?? "Unassigned"}: ${item.description}`),
        related_meeting_ids: related.map((other) => other.meeting.id),
        related_meetings: related.slice(0, 3).map((other) => ({ meeting_id: other.meeting.id, title: other.meeting.title, reasons: other.meeting.tags.filter((tag) => seed.meeting.tags.includes(tag)).map((tag) => `shared tag #${tag}`) })),
      };
    }),
  };
}

export function mapFor(baseIdValue: string, seeds: MeetingSeed[], confirmedEmails: Record<string, string>): KnowledgeMap {
  const inBase = searchableSeeds(seeds, baseIdValue);
  const topics = new Map<string, MeetingSeed[]>();
  for (const seed of inBase) for (const tag of seed.meeting.tags) topics.set(tag, [...(topics.get(tag) ?? []), seed]);
  const topicEntries: KnowledgeMapEntry[] = [...topics.entries()].map(([tag, list]) => {
    const sources = list.flatMap((seed) => seed.segments.filter((segment) => segment.speaker && segment.speaker !== "Meetings AI").slice(1, 3).map((segment) => sourceFor(seed, segment.segment_id)).filter((item): item is KnowledgeSource => Boolean(item)));
    return { key: tag, label: tag, meeting_count: list.length, source_count: list.reduce((sum, seed) => sum + seed.segments.length, 0), verified_identity: false, email: null, sources: sources.slice(0, 4) };
  }).sort((a, b) => b.meeting_count - a.meeting_count || b.source_count - a.source_count);
  const speakers = new Map<string, Array<{ seed: MeetingSeed; segmentId: string }>>();
  for (const seed of inBase) for (const segment of seed.segments) {
    const label = segment.speaker ?? "Unidentified speaker";
    if (label === "Meetings AI") continue;
    speakers.set(label, [...(speakers.get(label) ?? []), { seed, segmentId: segment.segment_id }]);
  }
  const speakerEntries: KnowledgeMapEntry[] = [...speakers.entries()].map(([label, turns]) => {
    const member = team.find((person) => person.name === label);
    const email = member?.email ?? confirmedEmails[label] ?? null;
    return {
      key: label.toLowerCase().replace(/\s+/g, "-"), label, meeting_count: new Set(turns.map((turn) => turn.seed.meeting.id)).size, source_count: turns.length,
      verified_identity: Boolean(email), email,
      sources: turns.slice(0, 3).map((turn) => sourceFor(turn.seed, turn.segmentId)).filter((item): item is KnowledgeSource => Boolean(item)),
    };
  }).sort((a, b) => b.source_count - a.source_count);
  return { knowledge_base_id: baseIdValue, topics: topicEntries, speaker_labels: speakerEntries, truncated_meeting_scope: false };
}
