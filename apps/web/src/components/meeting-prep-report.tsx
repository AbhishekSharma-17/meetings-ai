import { BriefcaseBusiness, CircleHelp, ExternalLink, Lightbulb, MessageSquareText, TriangleAlert, UserRoundSearch } from "lucide-react";
import { formatDateTime } from "@/lib/time-preferences";
import type { AnyPrepReport, PrepReport, PrepReportV2 } from "@/lib/types";
import { Alert, Badge } from "./ui/feedback";
import { briefingTime, Citations, hostname, ListSection, safeHref, SectionHeading } from "./prep-shared";
import { PrepReportV2View } from "./prep-report-v2";

export function isReportV2(report: AnyPrepReport): report is PrepReportV2 {
  return "report_version" in report && report.report_version === 2;
}

/** Renders a saved briefing in whichever schema it was stored with (v1 legacy or v2). */
export function PrepReportView({ report }: { report: AnyPrepReport }) {
  return isReportV2(report) ? <PrepReportV2View report={report} /> : <LegacyPrepReport report={report} />;
}

/** A v1 briefing, laid out as a short document: summary, cited findings, then what to do with it. */
function LegacyPrepReport({ report }: { report: PrepReport }) {
  const sourceMap = new Map(report.sources.map((source) => [source.id, source]));
  return <article className="card prep-report" aria-labelledby="prep-report-title">
    <div className="card-header">
      <div>
        <div className="prep-report-meta"><Badge tone="success" dot>Saved briefing</Badge><small>{formatDateTime(report.generated_at, briefingTime)} · {report.provider} / {report.model}</small></div>
        <h2 id="prep-report-title">{report.target_company ? `Briefing: ${report.target_company}` : "Meeting briefing"}</h2>
      </div>
    </div>
    <div className="card-body prep-report-body">
      <p className="prep-report-lead">{report.executive_brief}</p>
      {!report.public_research_performed ? <Alert tone="neutral" role="note">Context only. No public web research was run.</Alert> : null}
      {report.findings.length ? <section className="prep-report-section">
        <SectionHeading icon={<Lightbulb />}>Public findings</SectionHeading>
        <ul className="prep-findings">{report.findings.map((finding, index) => <li key={index}>
          <span>{finding.statement}</span>
          <Citations ids={finding.source_ids} sources={sourceMap} />
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
          return <li key={source.id} id={`prep-source-${source.id}`}>
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
