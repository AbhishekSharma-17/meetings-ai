import { BriefcaseBusiness, ExternalLink, Handshake, Newspaper, TrendingUp } from "lucide-react";
import type { ApolloCompany, ApolloPerson, ApolloSnapshot, PrepSourceV2 } from "@/lib/types";
import { Alert, Badge } from "./ui/feedback";
import { Citations, safeHref } from "./prep-shared";
import { ProviderName } from "./provider-brand-icons";

type SourceMap = Map<string, PrepSourceV2>;

const ids = (id: string | null | undefined) => (id ? [id] : []);

function shortDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** "2 yrs 4 mos" since an ISO date (null when unknown or in the future). */
export function tenure(since: string | null | undefined, now = new Date()): string | null {
  if (!since) return null;
  const start = new Date(since);
  if (Number.isNaN(start.getTime()) || start > now) return null;
  const months = (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth();
  const years = Math.floor(months / 12), rest = months % 12;
  const parts = [years ? `${years} yr${years === 1 ? "" : "s"}` : "", rest ? `${rest} mo${rest === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.join(" ") || "under a month";
}

function fundingText(company: ApolloCompany): string | null {
  const latest = [company.latest_funding_stage, company.latest_funding_amount, shortDate(company.latest_funding_date)].filter(Boolean).join(", ");
  if (company.total_funding && latest) return `${company.total_funding} total · latest ${latest}`;
  return company.total_funding ?? (latest || null);
}

/** Apollo firmographics inside the Company snapshot, each fact with its source chip. */
export function ApolloCompanyFacts({ company, sources }: { company: ApolloCompany; sources: SourceMap }) {
  const facts: [string, string | null][] = [
    ["Employees", company.employee_count ? `~${company.employee_count.toLocaleString()}` : null],
    ["Revenue", company.revenue_band],
    ["Funding", fundingText(company)],
    ["Industry", company.industry],
    ["Headquarters", company.headquarters],
    ["Founded", company.founded_year ? String(company.founded_year) : null],
  ];
  const shown = facts.filter((fact): fact is [string, string] => Boolean(fact[1]));
  const linkedin = safeHref(company.linkedin_url);
  if (!shown.length && !company.tech_stack.length && !linkedin) return null;
  return <div className="prep-apollo-company" aria-label="Verified company data from Apollo">
    <p className="prep-apollo-origin"><ProviderName brand="apollo" label="Verified by Apollo" /> <Citations ids={ids(company.source_id)} sources={sources} /></p>
    {shown.length ? <dl className="prep-snapshot-facts prep-apollo-facts">
      {shown.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl> : null}
    {company.tech_stack.length ? <div className="prep-apollo-tech">
      <span className="prep-apollo-label">Tech stack</span>
      <ul className="tag-list" aria-label="Technologies they use">{company.tech_stack.map((item) => <li key={item} className="tag">{item}</li>)}</ul>
    </div> : null}
    {linkedin ? <a className="prep-apollo-link" href={linkedin} target="_blank" rel="noreferrer noopener">Company LinkedIn <ExternalLink aria-hidden="true" /></a> : null}
  </div>;
}

/** Hiring and news signals from Apollo, summarised as one "Why now" line with the detail below. */
export function ApolloWhyNow({ snapshot, sources }: { snapshot: ApolloSnapshot; sources: SourceMap }) {
  const { hiring, news, relationship } = snapshot;
  if (!hiring && !news.length && !relationship) return null;
  const hiringText = hiring ? `Hiring ${hiring.open_roles} role${hiring.open_roles === 1 ? "" : "s"}${hiring.themes.length ? ` (${hiring.themes.slice(0, 3).map((theme) => `${theme.theme} ${theme.count}`).join(", ")})` : ""}` : null;
  const newsText = news.length ? `${news.length} news item${news.length === 1 ? "" : "s"} in the last 90 days` : null;
  return <section className="prep-report-section prep-apollo-signals" aria-labelledby="prep-why-now-title">
    <h3 id="prep-why-now-title"><span className="prep-section-icon" aria-hidden="true"><TrendingUp /></span>Why now</h3>
    {hiringText || newsText ? <p className="prep-why-now">
      {[hiringText, newsText].filter(Boolean).join(" · ")} <Citations ids={[...ids(hiring?.source_id), ...news.map((item) => item.source_id ?? "")].filter(Boolean)} sources={sources} />
    </p> : null}
    <div className="prep-apollo-signal-grid">
      {hiring?.examples.length ? <div className="prep-apollo-signal">
        <h4><BriefcaseBusiness aria-hidden="true" />Open roles</h4>
        <ul>{hiring.examples.slice(0, 5).map((job, index) => <li key={`${job.title}-${index}`}>{job.title}{job.location ? <small> · {job.location}</small> : null}</li>)}</ul>
      </div> : null}
      {news.length ? <div className="prep-apollo-signal">
        <h4><Newspaper aria-hidden="true" />In the news</h4>
        <ul>{news.map((item, index) => {
          const href = safeHref(item.url);
          return <li key={`${item.title}-${index}`}>
            {href ? <a href={href} target="_blank" rel="noreferrer noopener">{item.title}</a> : item.title}
            {item.published_at ? <small> · {shortDate(item.published_at)}</small> : null} <Citations ids={ids(item.source_id)} sources={sources} />
          </li>;
        })}</ul>
      </div> : null}
    </div>
    {relationship ? <p className="prep-apollo-relationship">
      <Handshake aria-hidden="true" />
      <span>In your Apollo CRM{relationship.stage ? <>: <Badge tone="info">{relationship.stage}</Badge></> : null}
        {relationship.owner ? ` · owner ${relationship.owner}` : ""}{relationship.last_activity_at ? ` · last activity ${shortDate(relationship.last_activity_at)}` : ""}
        {relationship.contacts.length ? ` · ${relationship.contacts.length} contact${relationship.contacts.length === 1 ? "" : "s"}: ${relationship.contacts.map((contact) => contact.title ? `${contact.name} (${contact.title})` : contact.name).join(", ")}` : ""}
        {" "}<Citations ids={ids(relationship.source_id)} sources={sources} /></span>
    </p> : null}
  </section>;
}

export function ApolloNotice({ snapshot }: { snapshot: ApolloSnapshot | null | undefined }) {
  if (!snapshot?.notice) return null;
  return <Alert tone="neutral" role="note" className="prep-apollo-notice">{snapshot.notice}. This briefing used web research only.</Alert>;
}

/** Apollo facts on an attendee card: seniority, tenure, previous companies and location. */
export function ApolloPersonFacts({ person, sources }: { person: ApolloPerson; sources: SourceMap }) {
  const inRole = tenure(person.role_started);
  const past = person.past_roles.map((role) => role.company).filter((company): company is string => Boolean(company));
  const facts = [
    person.seniority ? person.seniority.replaceAll("_", " ") : null,
    inRole ? `${inRole} in role` : null,
    person.location,
  ].filter(Boolean);
  if (!facts.length && !past.length) return null;
  return <div className="prep-person-apollo">
    {facts.length ? <p className="prep-person-facts">{facts.join(" · ")} <Citations ids={ids(person.source_id)} sources={sources} /></p> : null}
    {past.length ? <p className="prep-person-past"><span>Previously</span> {[...new Set(past)].join(", ")}</p> : null}
  </div>;
}
