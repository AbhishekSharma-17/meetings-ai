"use client";

import { useEffect, useState, type FormEvent } from "react";
import { calendarAutomationService as service, automationSettings, automationError, isAutomationSettings, type AutomationPolicy, type AutomationPreview, type AutomationSettings, type AutomationView } from "@/lib/calendar-automation-service";
import { meetingsService } from "@/lib/meetings-service";
import type { CalendarConnection, KnowledgeBase, MomGuidance, Team } from "@/lib/types";
import { formatDateTime } from "@/lib/time-preferences";
import { Card } from "./ui/card";
import { Alert, Badge, LoadingRow, Skeleton } from "./ui/feedback";
import { UiSelect } from "./ui-select";
import { ChipInput } from "./ui/chip-input";
import { CalendarBrandIcon } from "./brand-icons";
import { FilterInput, ScrollPanel } from "./scroll-panel";
import { useListSearch } from "./use-list-search";

function Choices({ label, items, value, onChange, disabled }: { label: string; items: { id: string; name: string }[]; value: string[]; onChange(ids: string[]): void; disabled: boolean }) {
  const search = useListSearch(items, (item) => [item.name]);
  return <fieldset className="form-stack" disabled={disabled}>
    <legend>{label}</legend>
    {search.offered ? <FilterInput id={`automation-${label.replaceAll(" ", "-")}`} label={`Search ${label.toLowerCase()}`} value={search.query} onChange={search.setQuery} placeholder="Search by name" /> : null}
    {!items.length ? <p className="field-hint">No teams available. Create a team in Workspace first.</p> : null}
    {search.noMatches ? <p className="field-hint">No teams match this search. <button className="text-button" type="button" onClick={search.clear}>Clear search</button></p> : null}
    {search.visible.map((item) => <label className="choice-card" key={item.id}><input type="checkbox" checked={value.includes(item.id)} onChange={(event) => onChange(event.target.checked ? [...value, item.id] : value.filter((id) => id !== item.id))} /><span>{item.name}</span></label>)}
  </fieldset>;
}

export function CalendarAutomationPanel({ connections, identity, canSchedule }: { connections: CalendarConnection[]; identity: string; canSchedule: boolean }) {
  const [view, setView] = useState<AutomationView | null>(null);
  const [draft, setDraft] = useState<AutomationSettings | null>(null);
  const [policy, setPolicy] = useState<AutomationPolicy | null>(null);
  const [savedPolicy, setSavedPolicy] = useState<AutomationPolicy | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [messageAt, setMessageAt] = useState<"rule" | "policy">("rule");
  const [reload, setReload] = useState(0);
  const draftKey = `meetings-ai:automation-draft:${identity}`;
  const dirty = !!view && !!draft && JSON.stringify(automationSettings(view)) !== JSON.stringify(draft);
  const policyDirty = !!policy && !!savedPolicy && JSON.stringify(policy) !== JSON.stringify(savedPolicy);

  useEffect(() => {
    let active = true;
    void Promise.all([service.get(), service.policy(), meetingsService.listTeams(), meetingsService.listKnowledgeBases()]).then(([next, nextPolicy, nextTeams, nextBases]) => {
      if (!active) return;
      setView(next); setPolicy(nextPolicy); setSavedPolicy(nextPolicy); setTeams(nextTeams); setBases(nextBases); setError(null);
      let restored: AutomationSettings | null = null;
      try { restored = JSON.parse(sessionStorage.getItem(draftKey) ?? "null") as AutomationSettings | null; } catch { /* Saved settings remain available. */ }
      setDraft(isAutomationSettings(restored) ? automationSettings(restored) : automationSettings(next));
      if (nextPolicy.can_manage) {
        try {
          const pending = JSON.parse(sessionStorage.getItem(`${draftKey}:policy`) ?? "null") as Partial<AutomationPolicy> | null;
          if (pending && typeof pending.automatic_delivery_enabled === "boolean" && Array.isArray(pending.allowed_group_ids) && pending.allowed_group_ids.every((id) => typeof id === "string")) setPolicy({ ...nextPolicy, automatic_delivery_enabled: pending.automatic_delivery_enabled, allowed_group_ids: pending.allowed_group_ids });
        } catch { /* Use the saved policy if the pending policy is malformed. */ }
      }
    }).catch(() => { if (active) setError("Automation settings could not be loaded. Retry to check availability."); });
    return () => { active = false; };
  }, [draftKey, reload]);

  useEffect(() => {
    if (!draft || !view) return;
    try { if (dirty) sessionStorage.setItem(draftKey, JSON.stringify(draft)); else sessionStorage.removeItem(draftKey); } catch { /* Keep the form usable without storage. */ }
    function beforeUnload(event: BeforeUnloadEvent) { if (dirty || policyDirty) event.preventDefault(); }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, policyDirty, draft, draftKey, view]);

  useEffect(() => {
    if (!policy || !savedPolicy) return;
    try { if (policyDirty) sessionStorage.setItem(`${draftKey}:policy`, JSON.stringify(policy)); else sessionStorage.removeItem(`${draftKey}:policy`); } catch { /* Keep the form usable without storage. */ }
  }, [policy, savedPolicy, policyDirty, draftKey]);

  const editable = !!view?.can_edit && canSchedule;
  const disabled = !editable || busy !== null;
  const activeConnections = connections.filter((item) => item.status === "ACTIVE");
  const connectionSearch = useListSearch(activeConnections, (item) => [item.label, item.identity, item.provider]);
  function change(values: Partial<AutomationSettings>) { setDraft((current) => current ? { ...current, ...values } : current); setPreview(null); setNotice(null); }
  async function act(name: string, action: () => Promise<void>) {
    setBusy(name); setError(null); setNotice(null); setMessageAt(name === "policy" ? "policy" : "rule");
    try { await action(); } catch (cause) { setError(automationError(cause, "The change could not be completed. Your settings are still here; check the options and try again.")); } finally { setBusy(null); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (draft.enabled && (!draft.connection_ids.length || !draft.recording_disclosure_acknowledged || !draft.bot_name.trim())) { setError("Select at least one account, enter an assistant name and acknowledge recording disclosure before enabling automation."); return; }
    if (draft.enabled && draft.mom_mode === "send_automatically" && (!savedPolicy?.automatic_delivery_enabled || !draft.delivery.internal_group_ids.length || draft.delivery.internal_group_ids.some((id) => !savedPolicy.allowed_group_ids.includes(id)))) { setMessageAt("rule"); setError("Choose at least one team authorized by your workspace admin for automatic delivery."); return; }
    await act("save", async () => { const next = await service.save(draft); setView(next); setDraft(automationSettings(next)); setNotice("Automation settings saved."); });
  }
  if (!view || !draft || !policy || !savedPolicy) return <Card title="Calendar automation"><Skeleton lines={4} />{error ? <Alert tone="danger" actions={<button className="button secondary sm" onClick={() => setReload((value) => value + 1)}>Retry</button>}>{error}</Alert> : <LoadingRow>Loading your automation settings…</LoadingRow>}</Card>;
  const available = view.availability.calendar_configured && view.availability.scheduler_enabled;
  const allowedTeams = teams.filter((team) => savedPolicy.allowed_group_ids.includes(team.id));
  return <div className="calendar-integrations form-stack calendar-automation-settings">
    <Card title="Calendar automation" description="Set your assistant to join eligible calendar meetings and prepare the minutes automatically." actions={<Badge tone={view.enabled ? "brand" : "neutral"} dot>{view.enabled ? "Enabled" : "Off"}</Badge>}>
      <div className="form-stack">
        {!editable ? <Alert tone="info">These settings are read-only. Ask a workspace admin for access to schedule assistants.</Alert> : null}
        {!available ? <Alert tone="warning">The calendar worker is unavailable. An admin must configure calendar access and enable the scheduler before meetings can be enrolled.</Alert> : null}
        {view.enabled && !available ? <Alert tone="warning">Your rule is saved and enabled, but automatic joining is paused until the calendar worker is available.</Alert> : null}
        {view.availability.auto_mom_enabled === false ? <Alert tone="warning">Automatic MOM processing is disabled. An admin must enable the post-meeting worker before minutes or automatic email can be processed.</Alert> : null}
        <p className="field-hint">Checks the next 14 days. Last check: {view.last_scan_at ? formatDateTime(view.last_scan_at) : "Not checked yet"}. {view.next_scan_at ? `Next check: ${formatDateTime(view.next_scan_at)}.` : "The next check is not scheduled yet."}</p>
        {view.last_error ? <Alert tone="warning">The last automation check needs attention. Save your settings and check again, or ask an admin to check the calendar worker.</Alert> : null}
        <p className="field-hint">The host controls admission and can reject the assistant. After admission it records and transcribes, leaves automatically when the call ends, then prepares the MOM.</p>
      </div>
    </Card>
    <form className="form-stack" onSubmit={(event) => void save(event)}>
      <Card title="Automatic joining">
        <div className="form-stack">
          <label className="choice-card"><input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={(event) => change({ enabled: event.target.checked })} /><span><b>Automatically schedule my assistant</b><small>Turning this off cancels pending automatic joins and automatic delivery. A recording already in progress continues.</small></span></label>
          <fieldset className="form-stack" disabled={disabled}><legend>Calendar accounts</legend>
            {!activeConnections.length ? <p className="field-hint">Connect an account in Integrations to enable automatic joining.</p> : null}
            {connectionSearch.offered ? <FilterInput id="automation-account-search" label="Search calendar accounts" value={connectionSearch.query} onChange={connectionSearch.setQuery} placeholder="Search account name or email" /> : null}
            {connectionSearch.noMatches ? <p className="field-hint">No calendar accounts match this search. <button className="text-button" type="button" onClick={connectionSearch.clear}>Clear search</button></p> : null}
            {connectionSearch.visible.map((item) => <label className="choice-card" key={item.id}><input type="checkbox" checked={draft.connection_ids.includes(item.id)} onChange={(event) => change({ connection_ids: event.target.checked ? [...draft.connection_ids, item.id] : draft.connection_ids.filter((id) => id !== item.id) })} /><CalendarBrandIcon provider={item.provider} size="sm" /><span><b>{item.label}</b><small>{item.identity}</small></span></label>)}
            {draft.connection_ids.some((id) => !activeConnections.some((item) => item.id === id)) ? <Alert tone="warning">A selected account is disconnected or unavailable. Reconnect it in Integrations or save with an active account selected.</Alert> : null}
          </fieldset>
          <div className="field-row">
            <UiSelect id="automation-meeting-types" label="Meeting types" value={draft.meeting_types} onChange={(value) => change({ meeting_types: value as AutomationSettings["meeting_types"] })} disabled={disabled} options={[{ value: "all", label: "One-off and recurring meetings" }, { value: "one_off", label: "One-off meetings only" }, { value: "recurring", label: "Recurring meetings only" }]} />
            <UiSelect id="automation-enrolment" label="Which meetings to enroll" value={draft.enrolment_scope} onChange={(value) => change({ enrolment_scope: value as AutomationSettings["enrolment_scope"] })} disabled={disabled} options={[{ value: "upcoming", label: "Existing upcoming and newly discovered" }, { value: "newly_discovered", label: "Newly discovered after the first scan" }]} />
          </div>
          <p className="field-hint">“Newly discovered” starts after the first complete scan establishes a baseline; it does not mean the event was created after you enabled this rule.</p>
          <div className="field"><label htmlFor="automation-bot-name">Default assistant name</label><input id="automation-bot-name" maxLength={100} value={draft.bot_name} disabled={disabled} onChange={(event) => change({ bot_name: event.target.value })} /></div>
          <label className="choice-card"><input type="checkbox" checked={draft.recording_disclosure_acknowledged} disabled={disabled} onChange={(event) => change({ recording_disclosure_acknowledged: event.target.checked })} /><span><b>I will disclose recording and transcription to meeting participants</b><small>Host admission and permission are still required for each meeting.</small></span></label>
        </div>
      </Card>
      <Card title="Minutes and delivery" description="Minutes are generated after the meeting. Automatic email is a separate, explicit choice.">
        <div className="form-stack">
          <UiSelect id="automation-mom-mode" label="After the MOM is generated" value={draft.mom_mode} disabled={disabled} options={[{ value: "draft", label: "Keep a draft for manual review" }, { value: "send_automatically", label: "Save and email automatically to authorized teams" }]} onChange={(value) => change({ mom_mode: value as AutomationSettings["mom_mode"] })} />
          {!savedPolicy.automatic_delivery_enabled ? <Alert tone="info">Automatic email is disabled by workspace policy. An admin can authorize it below; draft generation is available.</Alert> : null}
          {draft.mom_mode === "send_automatically" ? <>
            <Alert tone="warning">Generated minutes will be saved and emailed without a person reviewing them. Only selected authorized teams receive them; calendar invitees are not added automatically.</Alert>
            <Choices label="Recipient teams" items={allowedTeams} value={draft.delivery.internal_group_ids} onChange={(ids) => change({ delivery: { ...draft.delivery, internal_group_ids: ids } })} disabled={disabled || !savedPolicy.automatic_delivery_enabled} />
            <label className="choice-card"><input type="checkbox" checked={draft.delivery.include_transcript} disabled={disabled} onChange={(event) => change({ delivery: { ...draft.delivery, include_transcript: event.target.checked } })} /><span>Include transcript in automatic email</span></label>
          </> : null}
          <UiSelect id="automation-mom-template" label="MOM format" value={draft.mom_guidance.template} disabled={disabled} options={[{ value: "standard", label: "Balanced meeting minutes" }, { value: "actions", label: "Decisions & action tracker" }, { value: "client", label: "Client recap" }, { value: "discovery", label: "Discovery notes" }, { value: "custom", label: "Custom focus" }]} onChange={(value) => change({ mom_guidance: { ...draft.mom_guidance, template: value as MomGuidance["template"] } })} />
          <ChipInput id="automation-mom-focus" label="Focus fields" kind="text" value={draft.mom_guidance.focus_fields} onChange={(values) => change({ mom_guidance: { ...draft.mom_guidance, focus_fields: values } })} maxItems={8} maxItemLength={80} disabled={disabled} />
          <div className="field"><label htmlFor="automation-mom-instructions">MOM guidance (optional)</label><textarea id="automation-mom-instructions" rows={3} maxLength={2000} disabled={disabled} value={draft.mom_guidance.instructions} onChange={(event) => change({ mom_guidance: { ...draft.mom_guidance, instructions: event.target.value } })} /></div>
        </div>
      </Card>
      <Card title="AI knowledge" description="Keep knowledge inclusion off, or choose it now. You can also add a completed meeting later.">
        <div className="form-stack">
          <label className="choice-card"><input type="checkbox" checked={draft.knowledge_enabled} disabled={disabled} onChange={(event) => change({ knowledge_enabled: event.target.checked })} /><span>Include automatically enrolled meetings in AI knowledge</span></label>
          <UiSelect id="automation-knowledge-base" label="Knowledge base" value={draft.knowledge_base_id ?? "none"} disabled={disabled || !draft.knowledge_enabled} onChange={(value) => change({ knowledge_base_id: value === "none" ? null : value })} options={[{ value: "none", label: "No named knowledge base" }, ...bases.map((base) => ({ value: base.id, label: base.name }))]} />
          <p className="field-hint">Saved transcripts can be indexed later without recording again, even after minutes are generated or emailed. Approved minutes are included separately when available. Saved content remains subject to workspace retention.</p>
        </div>
      </Card>
      <Card title="Preview and save">
        <div className="form-stack">
          <p className="field-hint">Preview checks these unsaved options without creating assistants. Check now uses only your saved rule.</p>
          {dirty ? <Alert tone="warning">You have unsaved changes. Save to apply them, or discard to restore your saved rule.</Alert> : null}
          {error && messageAt === "rule" ? <Alert tone="danger">{error}</Alert> : null}
          {notice && messageAt === "rule" ? <Alert tone="success">{notice}</Alert> : null}
          {preview ? <div className="form-stack" role="status"><b>{preview.eligible.length} eligible · {preview.excluded.length} excluded</b>
            <ScrollPanel label="Automation preview results" size="sm"><div className="form-stack">
            {preview.eligible.map((item, index) => <p className="field-hint" key={`eligible-${index}`}>{item.event.title} · Eligible · {formatDateTime(item.event.starts_at)}</p>)}
            {preview.excluded.map((item, index) => <p className="field-hint" key={`excluded-${index}`}>{item.event.title} · {item.reason.replaceAll("_", " ")}</p>)}
            </div></ScrollPanel>
            {preview.truncated ? <p className="field-hint">This preview is a limited sample. Additional events will be checked by the worker.</p> : null}
          </div> : null}
          <div className="button-group">
            <button type="button" className="button secondary" disabled={disabled} onClick={() => void act("preview", async () => setPreview(await service.preview(draft)))}>{busy === "preview" ? "Previewing…" : "Preview matches"}</button>
            <button type="button" className="button secondary" disabled={disabled || dirty || !view.enabled || !available} onClick={() => void act("check", async () => { const result = await service.reconcile(); setNotice(`${result.scheduled} assistants scheduled; ${result.excluded} excluded.${result.errors.length ? " Some events could not be scheduled; check again after reviewing the calendar worker." : ""}`); const next = await service.get(); setView(next); })}>{busy === "check" ? "Checking…" : "Check now"}</button>
            {dirty ? <button className="button ghost" type="button" disabled={disabled} onClick={() => { setDraft(automationSettings(view)); setPreview(null); setError(null); }}>Discard changes</button> : null}
            <button className="button primary" type="submit" disabled={disabled || !dirty}>{busy === "save" ? "Saving…" : "Save automation"}</button>
          </div>
        </div>
      </Card>
    </form>
    {view.can_manage_policy && policy.can_manage ? <Card title="Workspace automatic delivery policy" description="Admins authorize automatic email separately from each person’s calendar rule.">
      <div className="form-stack">
        <label className="choice-card"><input type="checkbox" disabled={!!busy} checked={policy.automatic_delivery_enabled} onChange={(event) => setPolicy({ ...policy, automatic_delivery_enabled: event.target.checked })} /><span>Allow automatic MOM email to selected teams</span></label>
        <Choices label="Authorized teams" items={teams} value={policy.allowed_group_ids} onChange={(ids) => setPolicy({ ...policy, allowed_group_ids: ids })} disabled={!!busy} />
        <p className="field-hint">Team membership at send time determines recipients. Review membership before authorizing a team.</p>
        {policyDirty ? <Alert tone="warning">You have unsaved workspace policy changes. Save this policy before enabling automatic email in your calendar rule.</Alert> : null}
        {error && messageAt === "policy" ? <Alert tone="danger">{error}</Alert> : null}
        {notice && messageAt === "policy" ? <Alert tone="success">{notice}</Alert> : null}
        <div className="button-group">{policyDirty ? <button className="button ghost" type="button" disabled={!!busy} onClick={() => setPolicy(savedPolicy)}>Discard policy changes</button> : null}<button className="button secondary" type="button" disabled={!!busy || !policyDirty} onClick={() => void act("policy", async () => { const nextPolicy = await service.savePolicy(policy); setPolicy(nextPolicy); setSavedPolicy(nextPolicy); const next = await service.get(); setView(next); setNotice("Workspace delivery policy saved."); })}>{busy === "policy" ? "Saving…" : "Save delivery policy"}</button></div>
      </div>
    </Card> : null}
  </div>;
}
