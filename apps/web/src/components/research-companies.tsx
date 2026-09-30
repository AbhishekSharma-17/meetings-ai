"use client";

import { FormEvent, useState } from "react";
import { Building2, MapPin, Search, SlidersHorizontal, Users } from "lucide-react";
import { researchService } from "@/lib/research-service";
import { EMPLOYEE_RANGES, type ApolloUsage, type CompanyHit, type CompanySearchInput, type CompanySearchResponse, type EmployeeRange } from "@/lib/research-types";
import { ChipInput } from "./ui/chip-input";
import { Alert, Badge, EmptyState, LoadingRow } from "./ui/feedback";
import { cleanDomain, CompanyMark, employeesLabel, Pager, websiteProblem } from "./research-shared";

const EMPTY: CompanySearchInput = { name: "", domains: [], industry_keywords: [], locations: [], employee_ranges: [], page: 1 };

/** Companies tab: Apollo organization search with filters (collapsed on phones) and saved/account markers. */
export function CompanySearch({ onUsage, onOpen }: { onUsage(usage: ApolloUsage): void; onOpen(profileId: string): void }) {
  const [form, setForm] = useState<CompanySearchInput>(EMPTY);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [result, setResult] = useState<CompanySearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filterCount = form.domains.length + form.industry_keywords.length + form.locations.length + form.employee_ranges.length;
  const invalid = form.domains.some((item) => websiteProblem(item));
  const empty = !form.name?.trim() && filterCount === 0;

  async function run(page: number) {
    setBusy(true); setError(null);
    try {
      const next = await researchService.searchCompanies({ ...form, name: form.name?.trim() || null, domains: form.domains.map(cleanDomain), page });
      setResult(next); onUsage(next.usage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The search didn't work. Try again.");
    } finally { setBusy(false); }
  }

  async function save(hit: CompanyHit) {
    if (hit.saved_profile_id) { onOpen(hit.saved_profile_id); return; }
    setSavingId(hit.apollo_id ?? hit.name); setError(null);
    try {
      const saved = await researchService.saveProfile({ kind: "company", apollo_id: hit.apollo_id, domain: hit.domain, name: hit.name });
      onUsage(saved.usage); onOpen(saved.profile.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The company couldn't be saved. Try again.");
    } finally { setSavingId(null); }
  }

  const toggleRange = (range: EmployeeRange) => setForm((current) => ({ ...current, employee_ranges: current.employee_ranges.includes(range)
    ? current.employee_ranges.filter((item) => item !== range) : [...current.employee_ranges, range] }));

  return <div className="rx-search">
    <form className="card rx-filters" data-open={filtersOpen || undefined} onSubmit={(event: FormEvent) => { event.preventDefault(); void run(1); }} aria-label="Search companies">
      <div className="rx-filter-main">
        <div className="field rx-grow">
          <label htmlFor="rx-company-name">Company name</label>
          <input id="rx-company-name" value={form.name ?? ""} maxLength={120} placeholder="e.g. Acme Robotics" autoComplete="off"
            onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </div>
        <button type="button" className="button ghost rx-filter-toggle" aria-expanded={filtersOpen} aria-controls="rx-company-filters" onClick={() => setFiltersOpen((open) => !open)}>
          <SlidersHorizontal aria-hidden="true" />Filters{filterCount ? <span className="count">{filterCount}</span> : null}
        </button>
        <button className="button primary" disabled={busy || empty || invalid}>{busy ? <span className="spinner on-brand" aria-hidden="true" /> : <Search aria-hidden="true" />}Search</button>
      </div>
      <div className="rx-filter-fields" id="rx-company-filters">
        <ChipInput id="rx-company-domains" label="Websites" kind="text" value={form.domains} onChange={(domains) => setForm({ ...form, domains })}
          maxItems={10} maxItemLength={200} validate={websiteProblem} placeholder="acme.com" />
        <ChipInput id="rx-company-industry" label="Industry keywords" kind="text" value={form.industry_keywords} onChange={(industry_keywords) => setForm({ ...form, industry_keywords })}
          maxItems={10} maxItemLength={80} placeholder="e.g. robotics, logistics" />
        <ChipInput id="rx-company-location" label="Headquarters location" kind="text" value={form.locations} onChange={(locations) => setForm({ ...form, locations })}
          maxItems={10} maxItemLength={80} placeholder="e.g. Texas, Germany" />
        <fieldset className="rx-ranges">
          <legend className="field-label">Employees</legend>
          <div className="rx-chip-toggles">{EMPLOYEE_RANGES.map((range) => <button key={range} type="button" className="rx-chip-toggle" aria-pressed={form.employee_ranges.includes(range)} onClick={() => toggleRange(range)}>{range}</button>)}</div>
        </fieldset>
      </div>
    </form>
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {busy && !result ? <LoadingRow>Searching Apollo…</LoadingRow> : null}
    {result ? <section className="card rx-results" aria-label="Company results" aria-busy={busy}>
      <div className="card-header"><div><h2>Companies</h2><p>{result.total !== null ? `${result.total.toLocaleString()} found in Apollo` : `${result.items.length} shown`}{result.cached ? " · recent results" : ""}</p></div></div>
      {result.items.length ? <ul className="rx-result-list">{result.items.map((hit) => <li key={hit.apollo_id ?? hit.name} className="rx-result">
        <CompanyMark name={hit.name} logoUrl={hit.logo_url} />
        <div className="rx-result-copy">
          <b className="rx-result-name">{hit.name}{hit.in_apollo_account ? <Badge tone="info">Apollo account</Badge> : null}{hit.saved_profile_id ? <Badge tone="success">Saved</Badge> : null}</b>
          <span className="rx-result-meta">
            {hit.domain ? <span>{hit.domain}</span> : null}
            {hit.industry ? <span className="rx-capitalize">{hit.industry}</span> : null}
            {employeesLabel(hit.employee_count) ? <span><Users aria-hidden="true" />{employeesLabel(hit.employee_count)}</span> : null}
            {hit.headquarters ? <span><MapPin aria-hidden="true" />{hit.headquarters}</span> : null}
          </span>
        </div>
        <button type="button" className={hit.saved_profile_id ? "button ghost sm" : "button secondary sm"} disabled={savingId !== null}
          aria-label={hit.saved_profile_id ? `Open ${hit.name}` : `Save ${hit.name}`} onClick={() => void save(hit)}>
          {savingId === (hit.apollo_id ?? hit.name) ? "Saving…" : hit.saved_profile_id ? "Open" : "Save"}
        </button>
      </li>)}</ul> : <EmptyState plain icon={<Building2 />} title="No companies match">Try fewer filters or a shorter name.</EmptyState>}
      <div className="card-footer"><Pager page={result.page} totalPages={result.total_pages} busy={busy} onPage={(page) => void run(page)} /><span className="field-hint">Saving a company adds its profile, news and open roles for the whole workspace.</span></div>
    </section> : !busy && !error ? <EmptyState icon={<Building2 />} title="Find a company">Search by name, website or filters. Results come from Apollo.</EmptyState> : null}
  </div>;
}
