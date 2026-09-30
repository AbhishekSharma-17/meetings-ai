"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "@/lib/time-preferences";
import { Tabs } from "@base-ui/react/tabs";
import { FileSearch, History, KeyRound, NotebookPen, SlidersHorizontal } from "lucide-react";
import { apolloService, jobService, meetingsService, prepService, serviceErrorStatus } from "@/lib/meetings-service";
import type { AnyPrepReport, AttendeeSides, BackgroundJob, CachedCalendarEvent, KnowledgeTextProfile, PrepGenerateInput, PrepHistory, PrepStage } from "@/lib/types";
import { isReportV2, PrepReportView } from "./meeting-prep-report";
import { PrepDocuments } from "./prep-documents";
import { PrepHistoryList } from "./prep-history";
import { isHttpsLink, PrepLinkChips } from "./prep-link-chips";
import { PrepProgress } from "./prep-progress";
import { PrepWhosWho, sidesFromReport } from "./prep-whos-who";
import { Alert, EmptyState, Skeleton } from "./ui/feedback";
import { SwitchField } from "./ui/switch";
import { UiSelect } from "./ui-select";
import { ProviderName, providerOptionIcon } from "./provider-brand-icons";
import { providerBrand } from "./provider-brand";
import { useBackgroundJob } from "./use-background-job";

type Tab = "briefing" | "inputs" | "history";
type PrepFailure = { message: string; status: number | null };

/** A 404/405 from the stream means an older API: fall back to the synchronous endpoint. */
const STREAM_FALLBACK = new Set([0, 404, 405]);
/** A 404/405 from the job endpoint means an API without background jobs: use the stream instead. */
const JOB_FALLBACK = new Set([404, 405]);
const PREP_STAGES = new Set<string>(["queued", "planning", "searching", "reading", "writing", "done"]);

/** Job stages map onto the prep steps; the runner's "starting" is still the queued step. */
function jobStage(job: BackgroundJob | null): PrepStage | null {
  if (!job) return null;
  return job.stage && PREP_STAGES.has(job.stage) ? job.stage as PrepStage : "queued";
}

function websiteError(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname.includes(".") ? null : "Enter a full website address, e.g. https://company.com";
  } catch { return "Enter a full website address, e.g. https://company.com"; }
}

export function MeetingPrepPanel({ event, canEdit = true, initialSides, onOpenProviders, onOpenOrganization }: {
  event: CachedCalendarEvent;
  /** Sides to start from (e.g. people marked as theirs in Research) when no saved briefing has corrections. */
  initialSides?: AttendeeSides;
  canEdit?: boolean;
  /** Shown on setup errors (e.g. no Exa key). Pass only for owners/admins. */
  onOpenProviders?(): void;
  /** Opens the company profile when our own identity is missing. */
  onOpenOrganization?(): void;
}) {
  const [report, setReport] = useState<AnyPrepReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(true);
  const [tab, setTab] = useState<Tab>("inputs");
  const [targetCompany, setTargetCompany] = useState("");
  const [website, setWebsite] = useState("");
  const [links, setLinks] = useState<string[]>([]);
  const [context, setContext] = useState("");
  const [researchEnabled, setResearchEnabled] = useState(true);
  const [apolloRefresh, setApolloRefresh] = useState(false);
  // Owners/admins only (onOpenProviders is passed for them): is Apollo connected for this workspace?
  const [apolloConnected, setApolloConnected] = useState<boolean | null>(null);
  const [textProfiles, setTextProfiles] = useState<KnowledgeTextProfile[]>([]);
  const [textProfileId, setTextProfileId] = useState("");
  // Who's-who corrections (attendee key → ours/theirs); sent with the briefing and kept in it.
  const [sides, setSides] = useState<AttendeeSides>(() => initialSides ?? {});
  const [history, setHistory] = useState<PrepHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<PrepStage | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [failure, setFailure] = useState<PrepFailure | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Briefings run as server-side jobs: leaving this page does not stop one, and coming back resumes its progress.
  const prepJob = useBackgroundJob("prep_briefing", event.id, {
    onResume: () => { setBusy(true); setFailure(null); setTab("briefing"); },
    onFinish: (job) => finishJob(job),
  });

  const loadHistory = useCallback(() => {
    void prepService.getHistory(event.id).then(setHistory).catch(() => setHistory(null));
  }, [event.id]);

  useEffect(() => {
    void prepService.getLatest(event.id)
      .then((saved) => {
        setReport(saved);
        if (saved) setTab("briefing");
        if (saved && isReportV2(saved)) setSides((current) => ({ ...sidesFromReport(saved.whos_who), ...current }));
      })
      .catch(() => setLoadError("A previous briefing could not be loaded. You can generate a new one."))
      .finally(() => setLoadingReport(false));
    void prepService.getInputs(event.id).then((inputs) => {
      setTargetCompany(inputs.target_company ?? "");
      setWebsite(inputs.company_website ?? "");
      setLinks(inputs.links ?? []);
      setContext(inputs.notes ?? "");
      setSavedAt(inputs.updated_at ?? null);
    }).catch(() => undefined);
    void meetingsService.listKnowledgeTextProfiles().then(setTextProfiles).catch(() => undefined);
    loadHistory();
  }, [event.id, loadHistory]);

  const canManageSources = Boolean(onOpenProviders);
  useEffect(() => {
    if (!canManageSources) return;
    let active = true;
    apolloService.status().then((view) => { if (active) setApolloConnected(view.connected && view.status !== "invalid" ? true : view.available ? false : null); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [canManageSources]);

  const websiteProblem = websiteError(website);

  async function saveInputs(): Promise<boolean> {
    try {
      const saved = await prepService.saveInputs(event.id, {
        target_company: targetCompany.trim() || null, company_website: website.trim() || null,
        links: links.filter(isHttpsLink), notes: context,
      });
      setSavedAt(saved.updated_at ?? new Date().toISOString());
      return true;
    } catch (cause) {
      // An API without saved inputs (404) still accepts the same fields inline on generate.
      if (serviceErrorStatus(cause) === 404) return true;
      setFailure({ message: cause instanceof Error ? cause.message : "Your inputs could not be saved.", status: serviceErrorStatus(cause) });
      return false;
    }
  }

  function finishJob(job: BackgroundJob) {
    setBusy(false); setStage(null);
    if (job.status === "succeeded") {
      void prepService.getLatest(event.id).then((saved) => { if (saved) { setReport(saved); setTab("briefing"); } }).catch(() => setLoadError("The new briefing could not be loaded. Refresh to see it."));
      loadHistory();
    } else if (job.status === "failed") {
      const status = job.result?.error_status;
      setFailure({ message: job.error ?? "Meeting prep failed.", status: typeof status === "number" ? status : null });
      setTab("inputs");
    }
  }

  /** Starts the background job; false means this API has no job endpoint and the caller should stream instead. */
  async function startJob(input: PrepGenerateInput): Promise<boolean> {
    try {
      prepJob.track(await jobService.startPrep(event.id, input));
      return true;
    } catch (cause) {
      const status = serviceErrorStatus(cause);
      if (status !== null && JOB_FALLBACK.has(status)) return false;
      throw cause;
    }
  }

  async function generate() {
    if (websiteProblem) return;
    setBusy(true); setFailure(null); setStage("queued"); setTab("briefing");
    const input: PrepGenerateInput = {
      context, target_company: targetCompany.trim() || null, company_website: website.trim() || null,
      profile_urls: links.filter(isHttpsLink), text_profile_id: textProfileId || null, research_enabled: researchEnabled,
      attendee_sides: sides, apollo_refresh: apolloRefresh,
    };
    let background = false;
    try {
      if (canEdit && !(await saveInputs())) { setTab("inputs"); return; }
      background = await startJob(input);
      if (background) return;
      let next: AnyPrepReport;
      try {
        next = await prepService.generateStream(event.id, input, (value) => setStage(value));
      } catch (cause) {
        const status = serviceErrorStatus(cause);
        if (status === null || !STREAM_FALLBACK.has(status)) throw cause;
        setStage(null);
        next = await prepService.generate(event.id, input);
      }
      setReport(next);
      loadHistory();
    } catch (cause) {
      setFailure({ message: cause instanceof Error ? cause.message : "Meeting prep failed.", status: serviceErrorStatus(cause) });
      setTab("inputs");
    } finally { if (!background) { setBusy(false); setStage(null); } }
  }

  const needsSetup = failure?.status === 409 && /exa key|provider/i.test(failure.message);
  const primaryLabel = busy ? "Researching and preparing…" : report ? "Refresh briefing" : "Generate briefing";

  return <Tabs.Root className="prep-panel" value={tab} onValueChange={(value) => setTab(value as Tab)}>
    <Tabs.List className="tabs-list prep-tabs" aria-label="Meeting prep sections">
      <Tabs.Tab value="briefing"><NotebookPen aria-hidden="true" />Briefing</Tabs.Tab>
      <Tabs.Tab value="inputs"><SlidersHorizontal aria-hidden="true" />Inputs</Tabs.Tab>
      <Tabs.Tab value="history"><History aria-hidden="true" />History {history?.items.length ? <span className="count">{history.items.length}</span> : null}</Tabs.Tab>
    </Tabs.List>

    <Tabs.Panel value="briefing" className="prep-tab-panel">
      {busy ? <PrepProgress stage={prepJob.running ? jobStage(prepJob.job) : stage} research={researchEnabled} background={prepJob.running} onCancel={prepJob.running ? () => void prepJob.cancel().catch(() => undefined) : undefined} />
        : loadingReport ? <div className="card card-body"><Skeleton lines={5} /></div>
          : report ? <PrepReportView report={report} />
            : <div className="card"><EmptyState plain icon={<FileSearch />} title="No briefing yet" action={<button type="button" className="button secondary" onClick={() => setTab("inputs")}>Add inputs</button>}>Tell us who you are meeting, then generate a briefing.</EmptyState></div>}
      {loadError ? <p className="form-error" role="alert">{loadError}</p> : null}
    </Tabs.Panel>

    <Tabs.Panel value="inputs" className="prep-tab-panel">
      <section className="card meeting-prep-panel" aria-label="Meeting preparation">
        <div className="card-header">
          <div><h2>{report ? "Refresh your briefing" : "Build your briefing"}</h2><p>Your company profile, these inputs and, if allowed, cited public research.</p></div>
          {savedAt ? <small className="prep-saved">Saved {formatDateTime(savedAt)}</small> : null}
        </div>
        <div className="card-body form-stack">
          <div className="field-row">
            <div className="field">
              <label htmlFor="prep-company">Target company</label>
              <input id="prep-company" value={targetCompany} disabled={!canEdit} onChange={(change) => setTargetCompany(change.target.value)} placeholder="Inferred from attendees or the title if blank" maxLength={200} />
            </div>
            <div className="field">
              <label htmlFor="prep-website">Company website</label>
              <input id="prep-website" type="url" inputMode="url" value={website} disabled={!canEdit} onChange={(change) => setWebsite(change.target.value)} placeholder="https://company.com" aria-invalid={websiteProblem ? true : undefined} aria-describedby={websiteProblem ? "prep-website-error" : undefined} />
              {websiteProblem ? <p id="prep-website-error" className="inline-error">{websiteProblem}</p> : null}
            </div>
          </div>
          <PrepWhosWho eventId={event.id} targetCompany={targetCompany} website={websiteProblem ? "" : website}
            sides={sides} onSidesChange={setSides} canEdit={canEdit} disabled={busy} onOpenOrganization={onOpenOrganization} />
          <div className="field">
            <label htmlFor="prep-context">What you already know or want to learn</label>
            <textarea id="prep-context" rows={3} value={context} disabled={!canEdit} maxLength={8000} onChange={(change) => setContext(change.target.value)} placeholder="Meeting goal, relationship history, questions — e.g. their AI roadmap, recent deals, end clients" />
          </div>
          <PrepLinkChips id="prep-links" value={links} onChange={setLinks} disabled={!canEdit} />
          <PrepDocuments eventId={event.id} canEdit={canEdit} />
          <div className="inset-panel prep-research-options">
            <SwitchField id="prep-research" label="Research the public web" description={<>Uses the workspace <ProviderName brand="exa" label="Exa" /> key. Searches send the company, your links and attendee names only — never emails, titles, agendas or documents.</>} checked={researchEnabled} onChange={setResearchEnabled} />
            {apolloConnected || (report && isReportV2(report) && report.apollo) ? <SwitchField id="prep-apollo-refresh" label="Refresh from Apollo" description={<>Ask <ProviderName brand="apollo" label="Apollo" /> again instead of reusing company and people data saved in the last 30 days. Uses Apollo credits.</>} checked={apolloRefresh} onChange={setApolloRefresh} disabled={!researchEnabled} />
              : apolloConnected === false ? <p className="prep-apollo-hint field-hint"><ProviderName brand="apollo" label="Connect Apollo" /> for verified company and people data. <button type="button" className="text-button" onClick={onOpenProviders}>Open research sources</button></p> : null}
            {textProfiles.length ? <UiSelect id="prep-model" label="Analysis provider" size="sm" value={textProfileId} onChange={setTextProfileId} options={[{ value: "", label: "Workspace default" }, ...textProfiles.map((item) => ({ value: item.id, label: item.name, icon: providerOptionIcon(providerBrand(item.provider_type, item.base_url)) }))]} /> : null}
          </div>
          {failure ? needsSetup
            ? <Alert tone="warning" title="Setup needed" actions={onOpenProviders ? <button type="button" className="button secondary sm" onClick={onOpenProviders}><KeyRound aria-hidden="true" /> Open AI providers</button> : null}>{failure.message}{onOpenProviders ? "" : " Ask a workspace owner or admin."}</Alert>
            : <p role="alert" className="form-error">{failure.message}</p> : null}
          <div className="button-group">
            <button type="button" className="button primary" disabled={busy || !canEdit || Boolean(websiteProblem)} onClick={() => void generate()}>{primaryLabel}</button>
            {canEdit ? <button type="button" className="button ghost" disabled={busy || Boolean(websiteProblem)} onClick={() => { setFailure(null); void saveInputs(); }}>Save inputs</button> : null}
          </div>
        </div>
      </section>
    </Tabs.Panel>

    <Tabs.Panel value="history" className="prep-tab-panel">
      {history ? <PrepHistoryList history={history} currentId={report?.id ?? null} />
        : <div className="card"><EmptyState plain icon={<History />} title="No history available">Briefing history appears once a briefing is generated.</EmptyState></div>}
    </Tabs.Panel>
  </Tabs.Root>;
}
