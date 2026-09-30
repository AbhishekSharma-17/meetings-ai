import type { CompanyHistory, PersonHistory, ResearchCitation, ResearchProfile } from "../../research-types";
import { companyHits, companyProfile, DAILY_LIMIT, peopleHits, peopleRecords, personProfile } from "../fixtures/research";
import { OWNER_ID } from "../fixtures/people";
import { json, noContent, notify, problem, str, strList, wait } from "../http";
import type { DemoRouter } from "../router";
import type { DemoStore } from "../store";

/*
 * Research (Apollo Explorer) in the demo: search, look up and save sample companies and people, see "our
 * history" computed from the sample meetings and briefings, and get canned, cited Ask AI answers. No network.
 */

const PROFILE = "/v1/research/profiles/:id";
const usage = (store: DemoStore) => ({ used_today: store.research.usedToday, daily_limit: DAILY_LIMIT });
const spend = (store: DemoStore, calls: number) => { store.research.usedToday = Math.min(DAILY_LIMIT, store.research.usedToday + calls); };
const words = (value: string) => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const matches = (haystack: (string | null)[], needles: string[]) => needles.every((needle) => haystack.join(" ").toLowerCase().includes(needle.toLowerCase()));
const nameMatches = (name: string, candidate: string) => { const wanted = words(name); const got = new Set(words(candidate)); return wanted.length >= 2 && got.has(wanted[0]) && got.has(wanted[wanted.length - 1]); };
const domainOf = (email: string | null | undefined) => (email ?? "").split("@")[1]?.toLowerCase() ?? "";
const domainMatches = (candidate: string, domain: string | null) => Boolean(domain && candidate) && (candidate === domain || candidate.endsWith(`.${domain}`));
const savedId = (store: DemoStore, kind: string, apolloId: string | null) => store.research.profiles.find((item) => item.kind === kind && item.apollo_id === apolloId)?.id ?? null;
const owner = () => ({ id: OWNER_ID, name: "Alex Morgan" });

function companyHistory(store: DemoStore, profile: ResearchProfile): CompanyHistory {
  const phrase = words(profile.name).join(" ");
  const meetings = store.seeds.flatMap((seed) => {
    const reasons = [
      ...(seed.invitees.some((item) => domainMatches(domainOf(item.email), profile.domain)) ? [`Invitee from ${profile.domain}`] : []),
      ...(words(seed.meeting.title).join(" ").includes(phrase) ? ["Title mentions the company"] : []),
    ];
    return reasons.length ? [{ meeting_id: seed.meeting.id, title: seed.meeting.title, date: seed.meeting.joined_at ?? seed.meeting.created_at, status: seed.meeting.status, reasons }] : [];
  });
  const briefings = store.events.flatMap((event) => {
    const report = store.reports[event.id]?.[0];
    const inputs = store.prepInputs[event.id];
    const target = report?.target_company ?? inputs?.target_company;
    if (!target || !words(target).join(" ").includes(phrase)) return [];
    return [{ calendar_event_id: event.id, title: event.title, starts_at: event.starts_at, briefing_at: report?.generated_at ?? null, executive_brief: report?.executive_brief ?? null, reasons: [report ? "Briefing" : "Prep notes"] }];
  });
  return { meetings: meetings.sort((a, b) => b.date.localeCompare(a.date)), briefings, documents: [], our_company: false };
}

function personHistory(store: DemoStore, profile: ResearchProfile): PersonHistory {
  const meetings = store.seeds.flatMap((seed) => {
    const invited = seed.invitees.some((item) => nameMatches(profile.name, item.name) && domainMatches(domainOf(item.email), profile.domain));
    const identity = (store.identities[seed.meeting.id] ?? []).find((item) => nameMatches(profile.name, item.speaker) && domainMatches(domainOf(item.email), profile.domain));
    if (!invited && !identity) return [];
    const quotes = identity ? seed.segments.filter((segment) => segment.speaker === identity.speaker && segment.text.length >= 30).slice(0, 3)
      .map((segment) => ({ segment_id: segment.segment_id, start_seconds: segment.start_seconds, text: segment.text.slice(0, 280) })) : [];
    return [{ meeting_id: seed.meeting.id, title: seed.meeting.title, date: seed.meeting.joined_at ?? seed.meeting.created_at, status: seed.meeting.status,
      reasons: [invited ? "Invited" : null, identity ? "Confirmed speaker" : null].filter((item): item is string => Boolean(item)), speaker: identity?.speaker ?? null, quotes }];
  });
  return { meetings: meetings.sort((a, b) => b.date.localeCompare(a.date)) };
}

function cannedAnswer(store: DemoStore, profile: ResearchProfile, question: string, includeWeb: boolean): { answer: string; citations: ResearchCitation[] } {
  const citations: ResearchCitation[] = [];
  const cite = (item: Omit<ResearchCitation, "id" | "snippet" | "url" | "date" | "meeting_id" | "segment_id" | "calendar_event_id"> & Partial<ResearchCitation>) => {
    const id = `S${citations.length + 1}`;
    citations.push({ snippet: null, url: null, date: null, meeting_id: null, segment_id: null, calendar_event_id: null, ...item, id });
    return `[${id}]`;
  };
  const lines: string[] = [];
  if (profile.kind === "company") {
    const facts = profile.company_facts;
    lines.push(`${profile.name} is ${facts?.industry ? `an ${facts.industry.toLowerCase()} company` : "a company"}${facts?.employee_count ? ` with about ${facts.employee_count.toLocaleString()} employees` : ""}${facts?.headquarters ? `, based in ${facts.headquarters}` : ""} ${cite({ kind: "apollo", title: `${profile.name} company profile`, snippet: facts?.description ?? null, date: profile.fetched_at.slice(0, 10) })}.`);
    if (profile.news[0]) lines.push(`- Recent news: ${profile.news[0].title} ${cite({ kind: "apollo", title: `News: ${profile.news[0].title}`, url: profile.news[0].url, date: profile.news[0].published_at })}`);
    if (profile.hiring) lines.push(`- They're hiring ${profile.hiring.open_roles} roles, mostly ${profile.hiring.themes.slice(0, 2).map((theme) => theme.theme).join(" and ")} ${cite({ kind: "apollo", title: `${profile.name} open roles` })}`);
    const meeting = companyHistory(store, profile).meetings.find((item) => store.minutes[item.meeting_id]?.status !== "draft" && store.minutes[item.meeting_id]);
    if (meeting) lines.push(`- In ${meeting.title}, the team agreed: ${store.minutes[meeting.meeting_id]?.executive_summary.split(". ")[0]} ${cite({ kind: "meeting", title: `${meeting.title} — approved minutes`, meeting_id: meeting.meeting_id, date: meeting.date.slice(0, 10), snippet: store.minutes[meeting.meeting_id]?.executive_summary ?? null })}.`);
  } else {
    lines.push(`${profile.name} is ${profile.title ?? "at"} ${profile.company ? `at ${profile.company}` : ""} ${cite({ kind: "apollo", title: `${profile.name} (${profile.title ?? "profile"})`, date: profile.fetched_at.slice(0, 10) })}.`);
    const said = personHistory(store, profile).meetings.find((item) => item.quotes.length);
    if (said) lines.push(`- In ${said.title} they said: “${said.quotes[0].text}” ${cite({ kind: "meeting", title: `${said.title} — ${said.speaker} said`, meeting_id: said.meeting_id, segment_id: said.quotes[0].segment_id, snippet: said.quotes[0].text, date: said.date.slice(0, 10) })}`);
  }
  if (includeWeb) lines.push(`- Public coverage describes steady expansion in Europe ${cite({ kind: "web", title: `${profile.name} expands European operations`, url: "https://news.example.com/sample-article", snippet: "Sample web result for the demo." })}`);
  const [intro, ...bullets] = lines;
  const answer = [intro, bullets.join("\n"), `This is a sample answer to “${question.slice(0, 80)}” built from the demo data.`].filter(Boolean).join("\n\n");
  return { answer, citations };
}

export function registerResearch(router: DemoRouter): void {
  router
    .on("GET", "/v1/research/status", ({ store }) => json({ connected: store.apollo.connected, status: store.apollo.connected ? "active" : null, can_manage: true, can_use: store.apollo.connected, usage: store.apollo.connected ? usage(store) : null, bulk_confirm_over: 10 }))
    .on("POST", "/v1/research/search/companies", async ({ store, body }) => {
      await wait(450);
      const name = (str(body.name) ?? "").trim();
      const filters = [...strList(body.domains), ...strList(body.industry_keywords), ...strList(body.locations)];
      if (!name && !filters.length && !strList(body.employee_ranges).length) return problem(422, "Add a company name, website or at least one filter to search.");
      spend(store, 1);
      const items = companyHits.filter((hit) => (!name || matches([hit.name, hit.domain], words(name))) && filters.every((term) => matches([hit.name, hit.domain, hit.industry, hit.headquarters], [term.replace(/^https?:\/\/(www\.)?/, "")])))
        .map((hit) => ({ ...hit, saved_profile_id: savedId(store, "company", hit.apollo_id) }));
      return json({ items, page: 1, per_page: 25, total: items.length, total_pages: 1, cached: false, usage: usage(store) });
    })
    .on("POST", "/v1/research/search/people", async ({ store, body }) => {
      await wait(450);
      const domains = strList(body.domains), titles = strList(body.titles), locations = strList(body.locations), seniorities = strList(body.seniorities);
      const keywords = (str(body.keywords) ?? "").trim();
      if (!domains.length && !titles.length && !locations.length && !seniorities.length && !keywords) return problem(422, "Add a company website, title, seniority, location or keyword to search.");
      spend(store, 1);
      const items = peopleHits.filter((hit) => (!domains.length || domains.some((domain) => hit.company_domain?.includes(domain.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])))
        && (!titles.length || titles.some((title) => matches([hit.title], words(title)))) && (!seniorities.length || seniorities.includes(hit.seniority ?? ""))
        && (!locations.length || locations.some((place) => matches([hit.location], [place]))) && (!keywords || matches([hit.title, hit.company], words(keywords))))
        .map((hit) => ({ ...hit, name: store.research.lookups.includes(hit.apollo_id) ? peopleRecords[hit.apollo_id].person.name : hit.name, saved_profile_id: savedId(store, "person", hit.apollo_id) }));
      return json({ items, page: 1, per_page: 25, total: items.length, total_pages: 1, cached: false, usage: usage(store) });
    })
    .on("POST", "/v1/research/people/lookup", async ({ store, body }) => {
      const ids = strList(body.apollo_ids).slice(0, 25);
      if (ids.length > 10 && body.confirm !== true) return problem(409, `Looking up ${ids.length} people uses up to ${ids.length} Apollo lookups. Confirm to continue.`);
      await wait(500);
      const fresh = ids.filter((id) => !store.research.lookups.includes(id));
      spend(store, fresh.length ? Math.ceil(fresh.length / 10) : 0);
      store.research.lookups = [...store.research.lookups, ...fresh];
      return json({ items: ids.map((id) => ({ apollo_id: id, person: peopleRecords[id]?.person ?? null, company_domain: peopleRecords[id]?.domain ?? null })), usage: usage(store) });
    })
    .on("GET", "/v1/research/profiles", ({ store, query }) => json(store.research.profiles.filter((item) => !query.get("kind") || item.kind === query.get("kind"))))
    .on("POST", "/v1/research/profiles", async ({ store, body }) => {
      const kind = str(body.kind), apolloId = str(body.apollo_id);
      const existing = store.research.profiles.find((item) => item.kind === kind && item.apollo_id === apolloId);
      if (existing) return json({ profile: existing, created: false, usage: usage(store) });
      await wait(700);
      const id = crypto.randomUUID(), now = new Date().toISOString();
      const hit = companyHits.find((item) => item.apollo_id === apolloId);
      const profile = kind === "company" && hit ? companyProfile(id, hit, now, owner()) : kind === "person" && apolloId ? personProfile(id, apolloId, now, owner()) : null;
      if (!profile) return problem(404, "Apollo has no details for this sample.");
      spend(store, profile.apollo_calls);
      store.research.profiles = [profile, ...store.research.profiles];
      return json({ profile, created: true, usage: usage(store) }, 201);
    })
    .on("GET", PROFILE, ({ store, params }) => { const found = store.research.profiles.find((item) => item.id === params.id); return found ? json(found) : problem(404, "Not found. It may have been deleted."); })
    .on("POST", `${PROFILE}/refresh`, async ({ store, params }) => {
      const found = store.research.profiles.find((item) => item.id === params.id);
      if (!found) return problem(404, "Not found. It may have been deleted.");
      await wait(700);
      const now = new Date().toISOString();
      const updated = { ...found, fetched_at: now, updated_at: now, apollo_calls: found.apollo_calls + (found.kind === "company" ? 3 : 1) };
      spend(store, found.kind === "company" ? 3 : 1);
      store.research.profiles = store.research.profiles.map((item) => item.id === found.id ? updated : item);
      return json({ profile: updated, created: false, usage: usage(store) });
    })
    .on("DELETE", PROFILE, ({ store, params }) => {
      store.research.profiles = store.research.profiles.filter((item) => item.id !== params.id);
      store.research.conversations = store.research.conversations.filter((item) => item.profile_id !== params.id);
      return noContent();
    })
    .on("GET", `${PROFILE}/history`, ({ store, params }) => {
      const found = store.research.profiles.find((item) => item.id === params.id);
      if (!found) return problem(404, "Not found. It may have been deleted.");
      return json(found.kind === "company" ? companyHistory(store, found) : personHistory(store, found));
    })
    .on("GET", `${PROFILE}/people`, ({ store, params }) => {
      const found = store.research.profiles.find((item) => item.id === params.id);
      return json(found?.kind === "company" ? store.research.profiles.filter((item) => item.kind === "person" && item.domain === found.domain) : []);
    })
    .on("POST", `${PROFILE}/chat`, async ({ store, params, body }) => {
      const found = store.research.profiles.find((item) => item.id === params.id);
      const question = (str(body.question) ?? "").trim();
      if (!found) return problem(404, "Not found. It may have been deleted.");
      if (question.length < 3) return problem(422, "Ask a question of at least three characters.");
      const includeWeb = body.include_web === true;
      await wait(includeWeb ? 1300 : 800);
      const { answer, citations } = cannedAnswer(store, found, question, includeWeb);
      const now = new Date().toISOString();
      let conversation = store.research.conversations.find((item) => item.id === str(body.conversation_id));
      if (!conversation) {
        conversation = { id: crypto.randomUUID(), profile_id: found.id, title: question.slice(0, 200), created_at: now, updated_at: now, messages: [] };
        store.research.conversations = [conversation, ...store.research.conversations];
      }
      conversation.messages.push({ id: crypto.randomUUID(), role: "user", content: question, citations: [], provider: null, model: null, created_at: now },
        { id: crypto.randomUUID(), role: "assistant", content: answer, citations, provider: "openrouter", model: "openai/gpt-6-sol", created_at: now });
      conversation.updated_at = now;
      return json({ answer, citations, conversation_id: conversation.id, provider: "openrouter", model: "openai/gpt-6-sol", web_searches: includeWeb ? 1 : 0, note: null });
    })
    .on("GET", `${PROFILE}/conversations`, ({ store, params }) => json(store.research.conversations.filter((item) => item.profile_id === params.id)
      .map(({ messages: _messages, ...summary }) => summary)))
    .on("GET", `${PROFILE}/conversations/:conversation`, ({ store, params }) => {
      const found = store.research.conversations.find((item) => item.id === params.conversation && item.profile_id === params.id);
      return found ? json(found) : problem(404, "Not found. It may have been deleted.");
    })
    .on("DELETE", `${PROFILE}/conversations/:conversation`, ({ store, params }) => {
      store.research.conversations = store.research.conversations.filter((item) => item.id !== params.conversation);
      return noContent();
    })
    .on("POST", `${PROFILE}/prepare`, ({ store, params, body }) => {
      const found = store.research.profiles.find((item) => item.id === params.id);
      const event = store.events.find((item) => item.id === str(body.calendar_event_id));
      if (!found || !event) return problem(404, "That meeting isn't on your synced calendar.");
      const people = store.research.profiles.filter((item) => item.kind === "person" && (strList(body.person_profile_ids).includes(item.id) || item.id === found.id));
      const target = found.kind === "company" ? found.name : found.company;
      const website = found.company_facts?.website ?? (found.domain ? `https://www.${found.domain}` : null);
      const current = store.prepInputs[event.id] ?? { target_company: null, company_website: null, links: [], notes: "" };
      const line = people.length ? `From Research: ${people.map((item) => item.title ? `${item.name} (${item.title})` : item.name).join(", ")} will be on their side.` : "";
      store.prepInputs[event.id] = { ...current, target_company: target ?? current.target_company, company_website: website ?? current.company_website,
        notes: line && !current.notes.includes(line) ? [current.notes, line].filter(Boolean).join("\n\n") : current.notes, updated_at: new Date().toISOString() };
      const sides: Record<string, "theirs"> = {};
      const matched: string[] = [];
      for (const item of people) {
        const hits = (event.invitees ?? []).filter((invitee) => nameMatches(item.name, invitee.name));
        for (const invitee of hits) sides[invitee.email?.toLowerCase() ?? `name:${words(invitee.name).join(" ")}`] = "theirs";
        if (hits.length) matched.push(item.name);
      }
      return json({ calendar_event_id: event.id, target_company: target, company_website: website, attendee_sides: sides, matched_people: matched, unmatched_people: people.map((item) => item.name).filter((name) => !matched.includes(name)) });
    })
    .on("POST", `${PROFILE}/knowledge`, async ({ store, params, body }) => {
      const found = store.research.profiles.find((item) => item.id === params.id);
      const base = store.bases.find((item) => item.id === str(body.knowledge_base_id));
      if (!found || !base) return problem(404, "That knowledge base wasn't found.");
      await wait(500);
      notify(`Demo: “${found.name}” would be added to ${base.name} and indexed.`);
      return json({ id: crypto.randomUUID(), filename: `${found.name} — Apollo research.md` }, 201);
    });
}
