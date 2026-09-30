"use client";

import { useEffect, useState } from "react";
import { BookmarkPlus, BriefcaseBusiness, CalendarPlus, ExternalLink, Globe, MapPin, Newspaper, RefreshCw, Trash2, Users } from "lucide-react";
import { formatDate } from "@/lib/time-preferences";
import { researchService } from "@/lib/research-service";
import type { ApolloUsage, PrepareResult, ProfileHistory, ResearchProfile } from "@/lib/research-types";
import { ProviderName } from "./provider-brand-icons";
import { Alert, Badge, EmptyState, Skeleton } from "./ui/feedback";
import { Avatar } from "./ui/avatar";
import { PageHeader } from "./ui/page-header";
import { CompanyMark, dataAge, employeesLabel, safeLink, seniorityLabel } from "./research-shared";
import { ResearchHistory, type HistoryLinks } from "./research-history";
import { ResearchChat } from "./research-chat";
import { KnowledgeDialog, PrepareDialog } from "./research-actions";

export type ProfileLinks = HistoryLinks & {
  onPrepared(result: PrepareResult): void;
  onOpenCalendar(): void;
};

/** One saved company or person: Apollo facts, our history, Ask AI and actions. Stacks into one column on phones. */
export function ResearchProfileView({ profileId, userId, isAdmin, links, onBack, onOpenProfile, onUsage, onDeleted }: {
  profileId: string; userId: string; isAdmin: boolean; links: ProfileLinks;
  onBack(): void; onOpenProfile(id: string): void; onUsage(usage: ApolloUsage): void; onDeleted(): void;
}) {
  const [profile, setProfile] = useState<ResearchProfile | null>(null);
  const [history, setHistory] = useState<ProfileHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [people, setPeople] = useState<ResearchProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"refresh" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dialog, setDialog] = useState<"prepare" | "knowledge" | null>(null);

  // Keyed by profile id by the parent, so state starts fresh for each profile.
  useEffect(() => {
    void researchService.getProfile(profileId).then((next) => {
      setProfile(next);
      if (next.kind === "company") void researchService.people(profileId).then(setPeople).catch(() => setPeople([]));
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "This profile couldn't be loaded."));
    void researchService.history(profileId).then(setHistory).catch(() => setHistoryError("Our history couldn't be loaded. Refresh to try again."));
  }, [profileId]);

  async function refresh() {
    setBusy("refresh"); setError(null); setNotice(null);
    try { const saved = await researchService.refreshProfile(profileId); setProfile(saved.profile); onUsage(saved.usage); setNotice("Updated from Apollo."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Apollo couldn't be reached. Try again."); }
    finally { setBusy(null); }
  }

  async function remove() {
    setBusy("delete"); setError(null);
    try { await researchService.deleteProfile(profileId); onDeleted(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "It couldn't be deleted."); setBusy(null); setConfirmDelete(false); }
  }

  if (error && !profile) return <section className="page wide"><PageHeader title="Research" back={{ label: "Research", onClick: onBack }} /><Alert tone="danger">{error}</Alert></section>;
  if (!profile) return <section className="page wide"><PageHeader title="Loading…" back={{ label: "Research", onClick: onBack }} /><div className="card card-body"><Skeleton lines={5} /></div></section>;

  const website = safeLink(profile.company_facts?.website ?? (profile.domain ? `https://${profile.domain}` : null));
  const subtitle = profile.kind === "company"
    ? [profile.domain, profile.company_facts?.industry].filter(Boolean).join(" · ")
    : [profile.title, profile.company].filter(Boolean).join(" at ");
  return <section className="page wide rx-profile" aria-labelledby="rx-profile-title">
    <PageHeader titleId="rx-profile-title" back={{ label: "Research", onClick: onBack }} eyebrow={profile.kind === "company" ? "Company" : "Person"}
      title={<span className="rx-profile-title">{profile.kind === "company" ? <CompanyMark name={profile.name} logoUrl={profile.logo_url} size="lg" /> : <Avatar name={profile.name} size="lg" />}<span>{profile.name}</span></span>}
      description={subtitle || undefined}
      actions={<>
        <button type="button" className="button secondary" onClick={() => setDialog("prepare")}><CalendarPlus aria-hidden="true" />Prepare a meeting</button>
        <button type="button" className="button secondary" onClick={() => setDialog("knowledge")}><BookmarkPlus aria-hidden="true" />Save to knowledge</button>
      </>} />
    <div className="rx-age">
      <ProviderName brand="apollo" label={`From Apollo · fetched ${dataAge(profile.fetched_at)}`} />
      <span className="field-hint">Saved by {profile.created_by?.name ?? "a teammate"} on {formatDate(profile.created_at)}</span>
      <button type="button" className="button ghost sm" disabled={busy !== null} onClick={() => void refresh()}><RefreshCw aria-hidden="true" />{busy === "refresh" ? "Refreshing…" : "Refresh from Apollo"}</button>
      {profile.can_delete ? confirmDelete
        ? <span className="rx-confirm" role="group" aria-label="Confirm delete"><span>Delete for everyone?</span><button type="button" className="button danger sm" disabled={busy !== null} onClick={() => void remove()}>{busy === "delete" ? "Deleting…" : "Delete"}</button><button type="button" className="button ghost sm" onClick={() => setConfirmDelete(false)}>Keep</button></span>
        : <button type="button" className="button ghost sm" onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden="true" />Delete</button> : null}
    </div>
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {notice ? <Alert tone="success">{notice}</Alert> : null}
    <div className="rx-profile-grid">
      <div className="rx-profile-main">
        {profile.kind === "company" ? <CompanyFacts profile={profile} website={website} /> : <PersonFacts profile={profile} />}
        {profile.kind === "company" ? <NewsAndJobs profile={profile} /> : null}
        {profile.kind === "company" ? <section className="card" aria-labelledby="rx-people-title">
          <div className="card-header"><div><h2 id="rx-people-title"><Users aria-hidden="true" /> People saved at {profile.name}</h2><p>Look people up under Research → People and save them to see them here.</p></div></div>
          <div className="card-body">{people.length ? <ul className="rx-people">{people.map((person) => <li key={person.id}>
            <Avatar name={person.name} size="sm" /><span><button type="button" className="text-button" onClick={() => onOpenProfile(person.id)}>{person.name}</button><small>{person.title ?? "Title unknown"}</small></span>
          </li>)}</ul> : <p className="field-hint">No one saved yet.</p>}</div>
        </section> : null}
        <ResearchHistory history={history} error={historyError} links={links} />
      </div>
      <div className="rx-profile-side"><ResearchChat profile={profile} onOpenMeeting={links.onOpenMeeting} /></div>
    </div>
    <PrepareDialog open={dialog === "prepare"} profile={profile} people={people} onClose={() => setDialog(null)} onOpenCalendar={links.onOpenCalendar}
      onPrepared={(result) => { setDialog(null); links.onPrepared(result); }} />
    <KnowledgeDialog open={dialog === "knowledge"} profile={profile} userId={userId} isAdmin={isAdmin} onClose={() => setDialog(null)}
      onSaved={(_, name) => { setDialog(null); setNotice(`Saved to ${name}. It becomes searchable in AI knowledge once indexed.`); }} />
  </section>;
}

function Facts({ items }: { items: [string, string | null | undefined][] }) {
  const shown = items.filter((item): item is [string, string] => Boolean(item[1]));
  return shown.length ? <dl className="rx-facts">{shown.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null;
}

function CompanyFacts({ profile, website }: { profile: ResearchProfile; website: string | undefined }) {
  const company = profile.company_facts;
  const linkedin = safeLink(company?.linkedin_url);
  const round = [company?.latest_funding_stage, company?.latest_funding_amount, company?.latest_funding_date ? formatDate(company.latest_funding_date) : null].filter(Boolean).join(" · ");
  return <section className="card" aria-labelledby="rx-facts-title">
    <div className="card-header"><div><h2 id="rx-facts-title"><ProviderName brand="apollo" label="Company facts" /></h2>{company?.description ? <p>{company.description}</p> : null}</div></div>
    <div className="card-body stack">
      {company ? <Facts items={[
        ["Industry", company.industry], ["Size", employeesLabel(company.employee_count)], ["Revenue", company.revenue_band],
        ["Total funding", company.total_funding], ["Latest round", round || null], ["Headquarters", company.headquarters],
        ["Founded", company.founded_year ? String(company.founded_year) : null],
      ]} /> : <p className="field-hint">Apollo has few details for this company. Refresh later or search by its website.</p>}
      {company?.tech_stack.length ? <div className="rx-tech"><span className="field-label">Tech stack</span><ul className="tag-list">{company.tech_stack.map((item) => <li key={item} className="tag">{item}</li>)}</ul></div> : null}
      <div className="rx-links">
        {website ? <a href={website} target="_blank" rel="noopener noreferrer"><Globe aria-hidden="true" />Website <ExternalLink aria-hidden="true" /></a> : null}
        {linkedin ? <a href={linkedin} target="_blank" rel="noopener noreferrer">LinkedIn <ExternalLink aria-hidden="true" /></a> : null}
      </div>
    </div>
  </section>;
}

function PersonFacts({ profile }: { profile: ResearchProfile }) {
  const person = profile.person;
  const linkedin = safeLink(person?.linkedin_url);
  return <section className="card" aria-labelledby="rx-facts-title">
    <div className="card-header"><div><h2 id="rx-facts-title"><ProviderName brand="apollo" label="Profile" /></h2></div></div>
    <div className="card-body stack">
      <Facts items={[
        ["Title", person?.title], ["Company", person?.company], ["Seniority", seniorityLabel(person?.seniority)],
        ["Departments", person?.departments.join(", ") || null], ["In role since", person?.role_started ? formatDate(person.role_started) : null],
        ["Location", person?.location],
      ]} />
      {person?.past_roles.length ? <div><span className="field-label">Employment history</span><ul className="rx-roles">{person.past_roles.map((role, index) => <li key={index}>
        <BriefcaseBusiness aria-hidden="true" /><span><b>{role.title ?? "Role"}</b> at {role.company ?? "unknown"}<small>{[role.start_date, role.end_date].filter(Boolean).map((value) => formatDate(value as string)).join(" – ")}</small></span>
      </li>)}</ul></div> : null}
      {linkedin ? <div className="rx-links"><a href={linkedin} target="_blank" rel="noopener noreferrer">LinkedIn <ExternalLink aria-hidden="true" /></a></div> : null}
    </div>
  </section>;
}

function NewsAndJobs({ profile }: { profile: ResearchProfile }) {
  return <div className="rx-signal-grid">
    <section className="card" aria-labelledby="rx-news-title">
      <div className="card-header"><div><h2 id="rx-news-title"><Newspaper aria-hidden="true" /> News · last 90 days</h2></div></div>
      <div className="card-body">{profile.news.length ? <ul className="rx-news">{profile.news.map((item, index) => {
        const href = safeLink(item.url);
        return <li key={`${item.title}-${index}`}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{item.title}</a> : <span>{item.title}</span>}{item.published_at ? <small>{formatDate(item.published_at)}</small> : null}</li>;
      })}</ul> : <EmptyState plain title="No recent news">Apollo found no articles in the last 90 days.</EmptyState>}</div>
    </section>
    <section className="card" aria-labelledby="rx-jobs-title">
      <div className="card-header"><div><h2 id="rx-jobs-title"><BriefcaseBusiness aria-hidden="true" /> Open roles</h2>{profile.hiring ? <p>{profile.hiring.open_roles} open role{profile.hiring.open_roles === 1 ? "" : "s"}</p> : null}</div></div>
      <div className="card-body">{profile.job_groups.length ? <div className="rx-job-groups">{profile.job_groups.map((group) => <div key={group.theme}>
        <h3>{group.theme} <Badge tone="neutral">{group.count}</Badge></h3>
        {group.jobs.length ? <ul>{group.jobs.map((job, index) => <li key={`${job.title}-${index}`}>{job.title}{job.location ? <small><MapPin aria-hidden="true" />{job.location}</small> : null}</li>)}</ul> : null}
      </div>)}</div> : <EmptyState plain title="No open roles found">Apollo lists no current job postings.</EmptyState>}</div>
    </section>
  </div>;
}
