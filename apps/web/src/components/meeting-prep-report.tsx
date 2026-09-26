import type { ReactNode } from "react";
import { BriefcaseBusiness, CircleHelp, ExternalLink, Lightbulb, MessageSquareText, TriangleAlert, UserRoundSearch } from "lucide-react";
import type { PrepReport, PrepSource } from "@/lib/types";
import { Alert, Badge } from "./ui/feedback";

/** Only follow web links; anything else renders as plain text. */
function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch { return undefined; }
}

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function Citation({ id, source }: { id: string; source: PrepSource }) {
  const href = safeHref(source.url);
  if (!href) return <span className="prep-citation" title={source.title}>{id}</span>;
  return <a className="prep-citation" href={href} target="_blank" rel="noreferrer noopener" aria-label={`Source ${id}`} title={source.title}>{id}</a>;
}

function ListSection({ title, icon, items, tone }: { title: string; icon: ReactNode; items: string[]; tone?: "warning" }) {
  if (!items.length) return null;
  return <section className={tone ? `prep-report-section ${tone}` : "prep-report-section"}>
    <h3><span className="prep-section-icon" aria-hidden="true">{icon}</span>{title}</h3>
    <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
  </section>;
}

/** A saved briefing, laid out as a short document: summary, cited findings, then what to do with it. */
export function PrepReportView({ report }: { report: PrepReport }) {
  const sourceMap = new Map(report.sources.map((source) => [source.id, source]));
  return <article className="card prep-report" aria-labelledby="prep-report-title">
    <div className="card-header">
      <div>
        <div className="prep-report-meta"><Badge tone="success" dot>Saved briefing</Badge><small>{new Date(report.generated_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {report.provider} / {report.model}</small></div>
        <h2 id="prep-report-title">{report.target_company ? `Briefing: ${report.target_company}` : "Meeting briefing"}</h2>
      </div>
    </div>
    <div className="card-body prep-report-body">
      <p className="prep-report-lead">{report.executive_brief}</p>
      {!report.public_research_performed ? <Alert tone="neutral" role="note">Context only. No public web research was run.</Alert> : null}
      {report.findings.length ? <section className="prep-report-section">
        <h3><span className="prep-section-icon" aria-hidden="true"><Lightbulb /></span>Public findings</h3>
        <ul className="prep-findings">{report.findings.map((finding, index) => <li key={index}>
          <span>{finding.statement}</span>
          <span className="prep-citations">{finding.source_ids.map((id) => { const source = sourceMap.get(id); return source ? <Citation key={id} id={id} source={source} /> : null; })}</span>
        </li>)}</ul>
      </section> : null}
      <div className="prep-report-grid">
        <ListSection title="Talking points" icon={<MessageSquareText />} items={report.talking_points} />
        <ListSection title="Questions to ask" icon={<CircleHelp />} items={report.questions_to_ask} />
        <ListSection title="Relevant offerings" icon={<BriefcaseBusiness />} items={report.relevant_offerings} />
        <ListSection title="People and roles to verify" icon={<UserRoundSearch />} items={report.people_notes} />
        <ListSection title="Watch-outs" icon={<TriangleAlert />} items={report.watchouts} tone="warning" />
      </div>
      {report.sources.length ? <section className="prep-report-section prep-sources">
        <h3>Sources <span className="section-count">{report.sources.length}</span></h3>
        <ol>{report.sources.map((source) => {
          const href = safeHref(source.url);
          return <li key={source.id}>
            <span className="prep-source-id">{source.id}</span>
            <span className="prep-source-copy">
              {href ? <a href={href} target="_blank" rel="noreferrer noopener">{source.title} <ExternalLink aria-hidden="true" /></a> : <b>{source.title}</b>}
              <small>{hostname(source.url)}</small>
            </span>
          </li>;
        })}</ol>
      </section> : null}
    </div>
  </article>;
}
