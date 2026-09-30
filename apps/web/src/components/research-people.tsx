"use client";

import { FormEvent, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ExternalLink, MapPin, Search, SlidersHorizontal, UserRound, UserSearch, X } from "lucide-react";
import { researchService } from "@/lib/research-service";
import { SENIORITIES, type ApolloUsage, type LookupResponse, type PeopleSearchInput, type PeopleSearchResponse, type PersonHit, type Seniority } from "@/lib/research-types";
import { ChipInput } from "./ui/chip-input";
import { Alert, Badge, EmptyState, LoadingRow } from "./ui/feedback";
import { Avatar } from "./ui/avatar";
import { cleanDomain, Pager, safeLink, seniorityLabel, websiteProblem } from "./research-shared";

const EMPTY: PeopleSearchInput = { domains: [], titles: [], seniorities: [], locations: [], keywords: "", page: 1 };
type Looked = LookupResponse["items"][number];

/** People tab: search results are shown as Apollo returns them; "Look up" enriches one person (or a confirmed batch). */
export function PeopleSearch({ usage, bulkConfirmOver, onUsage, onOpen }: {
  usage: ApolloUsage | null; bulkConfirmOver: number; onUsage(usage: ApolloUsage): void; onOpen(profileId: string): void;
}) {
  const [form, setForm] = useState<PeopleSearchInput>(EMPTY);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [result, setResult] = useState<PeopleSearchResponse | null>(null);
  const [looked, setLooked] = useState<Record<string, Looked>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filterCount = form.titles.length + form.seniorities.length + form.locations.length + (form.keywords?.trim() ? 1 : 0);
  const empty = !form.domains.length && filterCount === 0;
  const invalid = form.domains.some((item) => websiteProblem(item));

  async function run(page: number) {
    setBusy("search"); setError(null); setSelected([]);
    try {
      const next = await researchService.searchPeople({ ...form, domains: form.domains.map(cleanDomain), keywords: form.keywords?.trim() || null, page });
      setResult(next); onUsage(next.usage);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The search didn't work. Try again."); }
    finally { setBusy(null); }
  }

  async function lookUp(ids: string[], confirm = false) {
    setBusy(ids.length === 1 ? ids[0] : "bulk"); setError(null); setConfirming(false);
    try {
      const response = await researchService.lookUp(ids, confirm);
      setLooked((current) => ({ ...current, ...Object.fromEntries(response.items.map((item) => [item.apollo_id, item])) }));
      setSelected([]); onUsage(response.usage);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The look-up didn't work. Try again."); }
    finally { setBusy(null); }
  }

  async function save(hit: PersonHit) {
    if (hit.saved_profile_id) { onOpen(hit.saved_profile_id); return; }
    setBusy(`save:${hit.apollo_id}`); setError(null);
    try {
      const saved = await researchService.saveProfile({ kind: "person", apollo_id: hit.apollo_id });
      onUsage(saved.usage); onOpen(saved.profile.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This person couldn't be saved. Try again."); }
    finally { setBusy(null); }
  }

  const bulk = () => selected.length > bulkConfirmOver ? setConfirming(true) : void lookUp(selected, selected.length > bulkConfirmOver);
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleSeniority = (value: Seniority) => setForm((current) => ({ ...current, seniorities: current.seniorities.includes(value)
    ? current.seniorities.filter((item) => item !== value) : [...current.seniorities, value] }));
  const left = usage ? Math.max(usage.daily_limit - usage.used_today, 0) : null;

  return <div className="rx-search">
    <form className="card rx-filters" data-open={filtersOpen || undefined} onSubmit={(event: FormEvent) => { event.preventDefault(); void run(1); }} aria-label="Search people">
      <div className="rx-filter-main">
        <ChipInput id="rx-people-domains" label="Company websites" kind="text" value={form.domains} onChange={(domains) => setForm({ ...form, domains })}
          maxItems={10} maxItemLength={200} validate={websiteProblem} placeholder="acme.com" />
        <button type="button" className="button ghost rx-filter-toggle" aria-expanded={filtersOpen} aria-controls="rx-people-filters" onClick={() => setFiltersOpen((open) => !open)}>
          <SlidersHorizontal aria-hidden="true" />Filters{filterCount ? <span className="count">{filterCount}</span> : null}
        </button>
        <button className="button primary" disabled={busy !== null || empty || invalid}>{busy === "search" ? <span className="spinner on-brand" aria-hidden="true" /> : <Search aria-hidden="true" />}Search</button>
      </div>
      <div className="rx-filter-fields" id="rx-people-filters">
        <ChipInput id="rx-people-titles" label="Job titles" kind="text" value={form.titles} onChange={(titles) => setForm({ ...form, titles })} maxItems={10} maxItemLength={80} placeholder="e.g. CTO, Head of Operations" />
        <ChipInput id="rx-people-locations" label="Locations" kind="text" value={form.locations} onChange={(locations) => setForm({ ...form, locations })} maxItems={10} maxItemLength={80} placeholder="e.g. Austin, Netherlands" />
        <div className="field"><label htmlFor="rx-people-keywords">Keywords</label><input id="rx-people-keywords" value={form.keywords ?? ""} maxLength={120} placeholder="e.g. warehouse automation" onChange={(event) => setForm({ ...form, keywords: event.target.value })} /></div>
        <fieldset className="rx-ranges">
          <legend className="field-label">Seniority</legend>
          <div className="rx-chip-toggles">{SENIORITIES.map((item) => <button key={item.value} type="button" className="rx-chip-toggle" aria-pressed={form.seniorities.includes(item.value)} onClick={() => toggleSeniority(item.value)}>{item.label}</button>)}</div>
        </fieldset>
      </div>
    </form>
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {busy === "search" && !result ? <LoadingRow>Searching Apollo…</LoadingRow> : null}
    {result ? <section className="card rx-results" aria-label="People results" aria-busy={busy === "search"}>
      <div className="card-header">
        <div><h2>People</h2><p>{result.total !== null ? `${result.total.toLocaleString()} found in Apollo` : `${result.items.length} shown`}. Look someone up to see their full profile.</p></div>
        {selected.length ? <button type="button" className="button secondary sm" disabled={busy !== null} onClick={bulk}><UserSearch aria-hidden="true" />Look up {selected.length}</button> : null}
      </div>
      {result.items.length ? <ul className="rx-result-list">{result.items.map((hit) => <PersonRow key={hit.apollo_id} hit={hit} looked={looked[hit.apollo_id]} selected={selected.includes(hit.apollo_id)}
        busy={busy} onToggle={() => toggle(hit.apollo_id)} onLookUp={() => void lookUp([hit.apollo_id])} onSave={() => void save(hit)} />)}</ul>
        : <EmptyState plain icon={<UserRound />} title="No people match">Try a broader title or fewer filters.</EmptyState>}
      <div className="card-footer"><Pager page={result.page} totalPages={result.total_pages} busy={busy !== null} onPage={(page) => void run(page)} /><span className="field-hint">Contact details are never shown or saved.</span></div>
    </section> : busy === null && !error ? <EmptyState icon={<UserRound />} title="Find people">Search by company website, title, seniority or location.</EmptyState> : null}
    <Dialog.Root open={confirming} onOpenChange={setConfirming}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog">
          <Dialog.Close className="close-button" aria-label="Close"><X /></Dialog.Close>
          <Dialog.Title>Look up {selected.length} people?</Dialog.Title>
          <Dialog.Description className="dialog-intro">This uses up to {selected.length} Apollo lookups{left !== null ? ` of the ${left} you have left today` : ""}. People already looked up recently cost nothing.</Dialog.Description>
          <div className="dialog-footer">
            <button type="button" className="button secondary" onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="button primary" onClick={() => void lookUp(selected, true)}>Look up {selected.length}</button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}

function PersonRow({ hit, looked, selected, busy, onToggle, onLookUp, onSave }: {
  hit: PersonHit; looked: Looked | undefined; selected: boolean; busy: string | null; onToggle(): void; onLookUp(): void; onSave(): void;
}) {
  const person = looked?.person;
  const name = person?.name ?? hit.name;
  const linkedin = safeLink(person?.linkedin_url ?? hit.linkedin_url);
  return <li className="rx-result rx-person" data-looked={looked ? true : undefined}>
    <label className="rx-select"><input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${name}`} disabled={Boolean(looked)} /></label>
    <Avatar name={name} />
    <div className="rx-result-copy">
      <b className="rx-result-name">{name}{hit.in_apollo_contacts ? <Badge tone="info">Apollo contact</Badge> : null}{hit.saved_profile_id ? <Badge tone="success">Saved</Badge> : null}</b>
      <span className="rx-result-meta">
        {person?.title ?? hit.title ? <span>{person?.title ?? hit.title}</span> : null}
        {person?.company ?? hit.company ? <span>{person?.company ?? hit.company}</span> : null}
        {person?.location ?? hit.location ? <span><MapPin aria-hidden="true" />{person?.location ?? hit.location}</span> : null}
      </span>
      {hit.name_partial && !looked ? <small className="field-hint">Apollo shows the full name after a look-up.</small> : null}
      {looked && !person ? <small className="field-hint">Apollo has no more details for this person.</small> : null}
      {person ? <span className="rx-result-meta">
        {seniorityLabel(person.seniority) ? <span>{seniorityLabel(person.seniority)}</span> : null}
        {person.departments.length ? <span className="rx-capitalize">{person.departments.join(", ")}</span> : null}
        {person.past_roles[0]?.company ? <span>Previously {person.past_roles.map((role) => role.company).filter(Boolean).slice(0, 2).join(", ")}</span> : null}
        {linkedin ? <a href={linkedin} target="_blank" rel="noopener noreferrer">LinkedIn <ExternalLink aria-hidden="true" /></a> : null}
      </span> : null}
    </div>
    <div className="rx-row-actions">
      {!looked && !hit.saved_profile_id ? <button type="button" className="button ghost sm" disabled={busy !== null} onClick={onLookUp} aria-label={`Look up ${name}`}>{busy === hit.apollo_id ? "Looking up…" : "Look up"}</button> : null}
      <button type="button" className={hit.saved_profile_id ? "button ghost sm" : "button secondary sm"} disabled={busy !== null} onClick={onSave} aria-label={hit.saved_profile_id ? `Open ${name}` : `Save ${name}`}>
        {busy === `save:${hit.apollo_id}` ? "Saving…" : hit.saved_profile_id ? "Open" : "Save"}
      </button>
    </div>
  </li>;
}
