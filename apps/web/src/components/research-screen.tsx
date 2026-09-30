"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, KeyRound, ScanSearch, UserRound } from "lucide-react";
import { researchService } from "@/lib/research-service";
import type { ApolloUsage, ProfileKind, ResearchProfile, ResearchStatus } from "@/lib/research-types";
import { formatDate } from "@/lib/time-preferences";
import { PageHeader } from "./ui/page-header";
import { Alert, EmptyState, LoadingRow } from "./ui/feedback";
import { Avatar } from "./ui/avatar";
import { FilterInput, NoMatches } from "./scroll-panel";
import { useListSearch } from "./use-list-search";
import { CompanySearch } from "./research-companies";
import { PeopleSearch } from "./research-people";
import { ResearchProfileView, type ProfileLinks } from "./research-profile";
import { CompanyMark, dataAge, UsageMeter } from "./research-shared";
import { ProviderName } from "./provider-brand-icons";

type Tab = "companies" | "people";

/** Research (Apollo Explorer): search Apollo, keep profiles for the workspace, and ask AI about them. */
export function ResearchScreen({ userId, links, onOpenProviders }: {
  userId: string;
  links: ProfileLinks;
  /** Owners and admins only: opens AI providers to connect Apollo. */
  onOpenProviders?(): void;
}) {
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ApolloUsage | null>(null);
  const [tab, setTab] = useState<Tab>("companies");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [saved, setSaved] = useState<ResearchProfile[] | null>(null);
  const [savedKind, setSavedKind] = useState<ProfileKind | "all">("all");

  const loadSaved = useCallback(() => {
    void researchService.listProfiles().then(setSaved).catch(() => setSaved([]));
  }, []);

  useEffect(() => {
    void researchService.status().then((next) => { setStatus(next); setUsage(next.usage); if (next.can_use) loadSaved(); })
      .catch((cause) => setStatusError(cause instanceof Error ? cause.message : "Research couldn't be loaded."));
  }, [loadSaved]);

  const open = (id: string) => { setProfileId(id); loadSaved(); window.scrollTo?.({ top: 0 }); };

  if (statusError) return <section className="page wide"><PageHeader title="Research" /><Alert tone="danger">{statusError}</Alert></section>;
  if (!status) return <section className="page wide"><PageHeader title="Research" /><LoadingRow>Loading Research…</LoadingRow></section>;
  if (!status.can_use) return <section className="page narrow rx-page" aria-labelledby="rx-title">
    <PageHeader titleId="rx-title" title="Research" description="Look up companies and people, keep what you find, and ask AI about them." />
    <div className="card"><EmptyState icon={<ScanSearch />} title={status.status === "invalid" ? "Apollo needs to be reconnected" : "Apollo isn't connected"}
      action={status.can_manage && onOpenProviders ? <button type="button" className="button primary" onClick={onOpenProviders}><KeyRound aria-hidden="true" />Connect Apollo in AI providers</button> : undefined}>
      {status.can_manage ? "Research uses the workspace's Apollo account. Connect Apollo in AI providers to start." : "Research uses the workspace's Apollo account. Ask an admin to connect Apollo."}
    </EmptyState></div>
  </section>;

  if (profileId) return <ResearchProfileView key={profileId} profileId={profileId} userId={userId} isAdmin={status.can_manage} links={links}
    onBack={() => { setProfileId(null); loadSaved(); }} onOpenProfile={open} onUsage={setUsage} onDeleted={() => { setProfileId(null); loadSaved(); }} />;

  const visibleSaved = (saved ?? []).filter((item) => savedKind === "all" || item.kind === savedKind);
  return <section className="page wide rx-page" aria-labelledby="rx-title">
    <PageHeader titleId="rx-title" title="Research" description="Look up companies and people, keep what you find, and ask AI about them."
      actions={<UsageMeter usage={usage} />} />
    {status.status === "out_of_credit" ? <Alert tone="warning">Apollo reports the workspace is out of credits. Saved profiles still work; new look-ups may fail until credits renew.</Alert> : null}
    <div className="rx-layout">
      <div className="rx-search-column">
        <div className="segmented rx-tabs" role="tablist" aria-label="What to search">
          <button type="button" role="tab" aria-selected={tab === "companies"} onClick={() => setTab("companies")}><Building2 aria-hidden="true" />Companies</button>
          <button type="button" role="tab" aria-selected={tab === "people"} onClick={() => setTab("people")}><UserRound aria-hidden="true" />People</button>
        </div>
        <div hidden={tab !== "companies"}><CompanySearch onUsage={setUsage} onOpen={open} /></div>
        <div hidden={tab !== "people"}><PeopleSearch usage={usage} bulkConfirmOver={status.bulk_confirm_over} onUsage={setUsage} onOpen={open} /></div>
      </div>
      <SavedProfiles items={visibleSaved} total={saved?.length ?? null} kind={savedKind} onKind={setSavedKind} onOpen={open} />
    </div>
  </section>;
}

function SavedProfiles({ items, total, kind, onKind, onOpen }: { items: ResearchProfile[]; total: number | null; kind: ProfileKind | "all"; onKind(kind: ProfileKind | "all"): void; onOpen(id: string): void }) {
  const search = useListSearch(items, (item) => [item.name, item.domain, item.title, item.company, item.company_facts?.industry]);
  return <aside className="card rx-saved" aria-labelledby="rx-saved-title">
    <div className="card-header"><div><h2 id="rx-saved-title">Saved research</h2><p>{total === null ? "Loading…" : `${total} saved for the workspace`}</p></div></div>
    <div className="rx-saved-tools">
      <div className="segmented" role="group" aria-label="Show saved">
        {(["all", "company", "person"] as const).map((value) => <button key={value} type="button" aria-pressed={kind === value} onClick={() => onKind(value)}>{value === "all" ? "All" : value === "company" ? "Companies" : "People"}</button>)}
      </div>
      {search.offered ? <FilterInput id="rx-saved-search" label="Search saved research" value={search.query} onChange={search.setQuery} placeholder="Search saved research" /> : null}
    </div>
    {total === null ? <LoadingRow>Loading saved research…</LoadingRow> : search.noMatches ? <NoMatches query={search.query} noun="saved profiles" onClear={search.clear} />
      : search.visible.length ? <ul className="rx-saved-list">{search.visible.map((item) => <li key={item.id}>
        <button type="button" className="rx-saved-row" onClick={() => onOpen(item.id)}>
          {item.kind === "company" ? <CompanyMark name={item.name} logoUrl={item.logo_url} /> : <Avatar name={item.name} />}
          <span><b>{item.name}</b><small>{item.kind === "company" ? item.domain ?? "Company" : [item.title, item.company].filter(Boolean).join(" · ") || "Person"}</small>
            <small className="rx-saved-age"><ProviderName brand="apollo" label={`Fetched ${dataAge(item.fetched_at)}`} /> · saved {formatDate(item.created_at)}</small></span>
        </button>
      </li>)}</ul> : <EmptyState plain icon={<ScanSearch />} title="Nothing saved yet">Save a company or person from your search results to keep it here.</EmptyState>}
  </aside>;
}
