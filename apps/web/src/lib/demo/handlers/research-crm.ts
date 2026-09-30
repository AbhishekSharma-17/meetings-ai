import type { ApolloCrmMatch, ApolloSavePreview, ResearchProfile } from "../../research-types";
import { companyHits, DAILY_LIMIT, peopleHits } from "../fixtures/research";
import { OWNER_ID } from "../fixtures/people";
import { json, notify, problem, str, wait } from "../http";
import type { DemoRouter } from "../router";
import type { DemoStore } from "../store";

/*
 * "Save to Apollo" in the demo: the same dialog, a simulated duplicate check (sample companies and people marked
 * as already in Apollo come back as likely matches) and a simulated save. Nothing leaves the browser.
 */

const PROFILE = "/v1/research/profiles/:id/apollo";
const APOLLO = "https://app.apollo.io/#";
const CONTACT_STAGES = [{ id: "demo-cs-new", name: "New" }, { id: "demo-cs-working", name: "Working" }, { id: "demo-cs-meeting", name: "Meeting set" }];
const ACCOUNT_STAGES = [{ id: "demo-as-target", name: "Target" }, { id: "demo-as-prospect", name: "Prospect" }, { id: "demo-as-customer", name: "Customer" }];
const OWNERS = [{ id: "demo-user-alex", name: "Alex Morgan" }, { id: "demo-user-priya", name: "Priya Shah" }];
const usage = (store: DemoStore) => ({ used_today: store.research.usedToday, daily_limit: DAILY_LIMIT });
const spend = (store: DemoStore, calls: number) => { store.research.usedToday = Math.min(DAILY_LIMIT, store.research.usedToday + calls); };
const find = (store: DemoStore, id: string) => store.research.profiles.find((item) => item.id === id);

function matches(profile: ResearchProfile): ApolloCrmMatch[] {
  if (profile.kind === "company") {
    const hit = companyHits.find((item) => item.apollo_id === profile.apollo_id && item.in_apollo_account);
    return hit ? [{ id: `demo-acc-${hit.apollo_id}`, name: hit.name, detail: hit.domain, url: `${APOLLO}/accounts/demo-acc-${hit.apollo_id}` }] : [];
  }
  const hit = peopleHits.find((item) => item.apollo_id === profile.apollo_id && item.in_apollo_contacts);
  return hit ? [{ id: `demo-con-${hit.apollo_id}`, name: profile.name, detail: [profile.title, profile.company].filter(Boolean).join(" at ") || null, url: `${APOLLO}/contacts/demo-con-${hit.apollo_id}` }] : [];
}

function preview(store: DemoStore, profile: ResearchProfile): ApolloSavePreview {
  const person = profile.kind === "person";
  const [first, ...rest] = profile.name.split(" ");
  const fields = person
    ? [["First name", rest.length ? profile.name.slice(0, profile.name.lastIndexOf(" ")) : first], ["Last name", rest.at(-1) ?? ""], ["Title", profile.title], ["Company", profile.company], ["Company website", profile.domain ? `https://${profile.domain}` : null]]
    : [["Account name", profile.name], ["Domain", profile.domain]];
  const linkedin = person ? profile.person?.linkedin_url : profile.company_facts?.linkedin_url;
  return {
    record_type: person ? "contact" : "account",
    fields: fields.filter((item): item is [string, string] => Boolean(item[1])).map(([label, value]) => ({ label, value })),
    not_sent: [
      ...(linkedin ? [person ? "LinkedIn profile: Apollo's create-contact tool has no field for it." : "Company LinkedIn page: Apollo's create-account tool has no field for it."] : []),
      person ? "Emails and phone numbers: never stored in Research, so never sent." : "Phone numbers: never stored in Research, so never sent.",
    ],
    matches: matches(profile), stages: person ? CONTACT_STAGES : ACCOUNT_STAGES, stages_note: null,
    owners: person ? [] : OWNERS, owners_note: null, usage: usage(store),
  };
}

export function registerResearchCrm(router: DemoRouter): void {
  router
    .on("GET", PROFILE, async ({ store, params }) => {
      const profile = find(store, params.id);
      if (!profile) return problem(404, "Not found. It may have been deleted.");
      if (profile.apollo_crm) return problem(409, "This profile is already in Apollo.");
      await wait(600);
      spend(store, 2);
      return json(preview(store, profile));
    })
    .on("POST", PROFILE, async ({ store, params, body }) => {
      const profile = find(store, params.id);
      if (!profile) return problem(404, "Not found. It may have been deleted.");
      if (profile.apollo_crm) return problem(409, "This profile is already in Apollo.");
      const linking = str(body.action) === "link";
      const match = matches(profile).find((item) => item.id === str(body.record_id));
      if (linking && !match) return problem(422, "That record wasn't among the matches Apollo returned. Check Apollo again.");
      if (!linking && matches(profile).length && body.create_anyway !== true) return problem(409, `Apollo already has a likely match for ${profile.name}. Link to it, or choose Create anyway.`);
      await wait(700);
      const recordType = profile.kind === "person" ? "contact" : "account";
      const recordId = match?.id ?? `demo-${recordType}-${crypto.randomUUID().slice(0, 8)}`;
      if (!linking) spend(store, 1);
      const saved: ResearchProfile = { ...profile, apollo_crm: {
        record_type: recordType, record_id: recordId, record_name: match?.name ?? profile.name, action: linking ? "linked" : "created",
        url: `${APOLLO}/${recordType}s/${recordId}`, by: { id: OWNER_ID, name: "Alex Morgan" }, at: new Date().toISOString(),
      } };
      store.research.profiles = store.research.profiles.map((item) => item.id === profile.id ? saved : item);
      notify(`Demo: nothing was written to Apollo. A real workspace would ${linking ? "link this profile to" : "create"} the ${recordType}.`);
      return json({ profile: saved, created: !linking, usage: usage(store) });
    });
}
