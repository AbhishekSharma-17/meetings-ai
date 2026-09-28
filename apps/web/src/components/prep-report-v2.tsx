import type { ReactNode } from "react";
import { formatDateTime } from "@/lib/time-preferences";
import { BrainCircuit, Building2, CircleHelp, Compass, ExternalLink, Handshake, MessageSquareText, Newspaper, Scale, TriangleAlert, Users } from "lucide-react";
import type { PrepCitedClaim, PrepDevelopmentType, PrepReportV2, PrepSourceV2 } from "@/lib/types";
import { Alert, Badge } from "./ui/feedback";
import { briefingTime, Citations, formatTokens, formatUsd, ListSection, safeHref, SectionHeading } from "./prep-shared";
import { PrepAttendees, personaLabels } from "./prep-attendees";
import { PrepSources } from "./prep-sources";
import { WhosWhoView } from "./prep-whos-who-view";
import { ProviderName, UsageProviderName } from "./provider-brand-icons";

const developmentLabels: Record<PrepDevelopmentType, string> = {
  deal: "Deal", mou: "MOU", partnership: "Partnership", funding: "Funding", product: "Product", hiring: "Hiring", news: "News",
};
const developmentTone: Record<PrepDevelopmentType, "brand" | "success" | "info" | "neutral" | "warning"> = {
  deal: "brand", mou: "brand", partnership: "info", funding: "success", product: "info", hiring: "neutral", news: "neutral",
};

type SourceMap = Map<string, PrepSourceV2>;

/** A v2 briefing: who they are, what changed, how we fit, who is in the room and how to run the meeting. */
export function PrepReportV2View({ report }: { report: PrepReportV2 }) {
  const sources: SourceMap = new Map(report.sources.map((source) => [source.id, source]));
  const title = report.company.name || report.target_company;
  const { usage } = report;
  return <article className="card prep-report prep-report-v2" aria-labelledby="prep-report-title">
    <div className="card-header">
      <div>
        <div className="prep-report-meta">
          <Badge tone="success" dot>Saved briefing</Badge>
          <small className="provider-route">{formatDateTime(report.generated_at, briefingTime)} · <UsageProviderName provider={report.provider} /> / {report.model}</small>
          <small className="prep-report-usage">{formatTokens(usage.input_tokens, usage.output_tokens)} · {usage.exa_calls ? <ProviderName brand="exa" label={`${usage.exa_calls} Exa ${usage.exa_calls === 1 ? "search" : "searches"}`} /> : "0 searches"} · est. {formatUsd(usage.estimated_usd)}{usage.unpriced_calls ? " + unpriced" : ""}</small>
        </div>
        <h2 id="prep-report-title">{title ? `Briefing: ${title}` : "Meeting briefing"}</h2>
      </div>
    </div>
    <div className="card-body prep-report-body">
      <p className="prep-report-lead">{report.executive_brief}</p>
      {!report.public_research_performed ? <Alert tone="neutral" role="note">Context only. No public web research was run.</Alert> : null}
      {report.whos_who ? <section className="prep-report-section" aria-labelledby="prep-whos-who-report-title">
        <h3 id="prep-whos-who-report-title"><span className="prep-section-icon" aria-hidden="true"><Scale /></span>Who’s who</h3>
        <WhosWhoView value={report.whos_who} />
      </section> : null}
      <CompanySnapshot report={report} sources={sources} />
      <Developments report={report} sources={sources} />
      <AiLandscape report={report} sources={sources} />
      <Alignment report={report} sources={sources} />
      {report.attendees.length ? <section className="prep-report-section">
        <SectionHeading icon={<Users />} count={report.attendees.length}>Who you are meeting</SectionHeading>
        <PrepAttendees attendees={report.attendees} sources={sources} />
      </section> : null}
      <Narrative report={report} />
      <div className="prep-report-grid">
        <ListSection title="Talking points" icon={<MessageSquareText />} items={report.talking_points} />
        <ListSection title="Questions to ask" icon={<CircleHelp />} items={report.questions_to_ask} />
        <ListSection title="Watch-outs" icon={<TriangleAlert />} items={report.watchouts} tone="warning" />
      </div>
      <PrepSources sources={report.sources} />
    </div>
  </article>;
}

function CompanySnapshot({ report, sources }: { report: PrepReportV2; sources: SourceMap }) {
  const { company } = report;
  const website = company.website || report.company_website;
  const href = safeHref(website);
  const facts: [string, string][] = ([["Industry", company.industry], ["Size", company.size_signals], ["Headquarters", company.headquarters]] as [string, string][])
    .filter(([, value]) => value);
  if (!company.what_they_do && !facts.length && !href) return null;
  return <section className="prep-report-section" aria-labelledby="prep-company-title">
    <h3 id="prep-company-title"><span className="prep-section-icon" aria-hidden="true"><Building2 /></span>Company snapshot</h3>
    <div className="inset-panel prep-snapshot">
      {company.what_they_do ? <p className="prep-snapshot-summary">{company.what_they_do} <Citations ids={company.source_ids} sources={sources} /></p> : null}
      {facts.length || href ? <dl className="prep-snapshot-facts">
        {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        {href ? <div><dt>Website</dt><dd><a href={href} target="_blank" rel="noreferrer noopener">{website?.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")} <ExternalLink aria-hidden="true" /></a></dd></div> : null}
      </dl> : null}
    </div>
  </section>;
}

function Developments({ report, sources }: { report: PrepReportV2; sources: SourceMap }) {
  if (!report.recent_developments.length) return null;
  return <section className="prep-report-section">
    <SectionHeading icon={<Newspaper />} count={report.recent_developments.length}>Recent developments</SectionHeading>
    <ol className="prep-timeline">
      {report.recent_developments.map((item, index) => <li key={index}>
        <div className="prep-timeline-meta">
          <Badge tone={developmentTone[item.type] ?? "neutral"}>{developmentLabels[item.type] ?? item.type}</Badge>
          {item.date ? <time dateTime={item.date}>{formatDate(item.date)}</time> : null}
        </div>
        <p className="prep-timeline-title">{item.title}</p>
        {item.summary ? <p className="prep-timeline-summary">{item.summary} <Citations ids={item.source_ids} sources={sources} /></p> : <Citations ids={item.source_ids} sources={sources} />}
      </li>)}
    </ol>
  </section>;
}

function ClaimList({ title, items, sources }: { title: string; items: PrepCitedClaim[]; sources: SourceMap }) {
  if (!items.length) return null;
  return <div className="prep-claims">
    <h4>{title}</h4>
    <ul>{items.map((item, index) => <li key={index}>{item.statement} <Citations ids={item.source_ids} sources={sources} /></li>)}</ul>
  </div>;
}

function AiLandscape({ report, sources }: { report: PrepReportV2; sources: SourceMap }) {
  const landscape = report.ai_landscape;
  if (!landscape.summary && !landscape.initiatives.length && !landscape.vendors.length && !landscape.end_clients.length) return null;
  return <section className="prep-report-section">
    <SectionHeading icon={<BrainCircuit />}>AI landscape</SectionHeading>
    {landscape.summary ? <p className="prep-paragraph">{landscape.summary} <Citations ids={landscape.source_ids} sources={sources} /></p> : null}
    <div className="prep-claims-grid">
      <ClaimList title="Initiatives" items={landscape.initiatives} sources={sources} />
      <ClaimList title="Vendors and partners" items={landscape.vendors} sources={sources} />
      <ClaimList title="End clients" items={landscape.end_clients} sources={sources} />
    </div>
  </section>;
}

function Alignment({ report, sources }: { report: PrepReportV2; sources: SourceMap }) {
  const { alignment } = report;
  if (!alignment.fit_summary && !alignment.relevant_services.length) return null;
  return <section className="prep-report-section">
    <SectionHeading icon={<Handshake />}>How we fit</SectionHeading>
    {alignment.fit_summary ? <p className="prep-paragraph">{alignment.fit_summary}</p> : null}
    {alignment.relevant_services.length ? <ul className="prep-service-list">
      {alignment.relevant_services.map((item, index) => <li key={index} className="prep-service">
        <p className="prep-service-name">{item.service} <Citations ids={item.source_ids} sources={sources} /></p>
        {item.why ? <p>{item.why}</p> : null}
        {item.talking_point ? <p className="prep-service-say"><MessageSquareText aria-hidden="true" /><span>{item.talking_point}</span></p> : null}
      </li>)}
    </ul> : null}
  </section>;
}

function Narrative({ report }: { report: PrepReportV2 }) {
  const narrative = report.meeting_narrative;
  const hasContent = narrative.recommended_focus || narrative.opening || narrative.by_persona.length || narrative.agenda_suggestions.length;
  if (!hasContent) return null;
  return <section className="prep-report-section">
    <SectionHeading icon={<Compass />}>Meeting narrative</SectionHeading>
    <div className="inset-panel prep-narrative">
      {narrative.recommended_focus ? <NarrativeBlock label="Recommended focus">{narrative.recommended_focus}</NarrativeBlock> : null}
      {narrative.opening ? <NarrativeBlock label="Opening">{narrative.opening}</NarrativeBlock> : null}
      {narrative.by_persona.length ? <div className="prep-narrative-block">
        <h4>Focus by audience</h4>
        <ul className="prep-persona-focus">{narrative.by_persona.map((item, index) => <li key={index}>
          <Badge tone="neutral">{personaLabels[item.persona] ?? item.persona}</Badge><span>{item.focus}</span>
        </li>)}</ul>
      </div> : null}
      {narrative.agenda_suggestions.length ? <div className="prep-narrative-block">
        <h4>Suggested agenda</h4>
        <ol className="prep-ordered">{narrative.agenda_suggestions.map((item, index) => <li key={index}>{item}</li>)}</ol>
      </div> : null}
    </div>
  </section>;
}

function NarrativeBlock({ label, children }: { label: string; children: ReactNode }) {
  return <div className="prep-narrative-block"><h4>{label}</h4><p>{children}</p></div>;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
