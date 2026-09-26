"use client";

import { FormEvent, useEffect, useState } from "react";
import { FileText, Upload } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { BriefDocument, OrganizationBrief } from "@/lib/types";
import { Skeleton } from "./ui/feedback";

/** Company context the meeting-prep assistant reads. Members can read it; admins can edit it. */
export function WorkspaceBrief({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const [brief, setBrief] = useState<OrganizationBrief | null>(null);
  const [briefDocuments, setBriefDocuments] = useState<BriefDocument[]>([]);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [briefMessage, setBriefMessage] = useState<string | null>(null);
  const locked = !canManage || briefBusy;

  useEffect(() => {
    void Promise.all([meetingsService.getOrganizationBrief(), meetingsService.listBriefDocuments()])
      .then(([nextBrief, nextDocuments]) => { setBrief(nextBrief); setBriefDocuments(nextDocuments); })
      .catch(() => setBriefError("Could not load the organization briefing profile."));
  }, [workspaceId]);

  async function saveBrief(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!brief) return;
    setBriefBusy(true); setBriefError(null); setBriefMessage(null);
    try { setBrief(await meetingsService.saveOrganizationBrief(brief)); setBriefMessage("Company context saved for meeting prep."); }
    catch (cause) { setBriefError(cause instanceof Error ? cause.message : "Could not save company context."); }
    finally { setBriefBusy(false); }
  }

  async function uploadBrief(file: File | undefined) {
    if (!file) return;
    setBriefBusy(true); setBriefError(null); setBriefMessage(null);
    try {
      const document = await meetingsService.uploadBriefDocument(file);
      setBriefDocuments((current) => [document, ...current]);
      setBriefMessage(`${file.name} added to private organization context.`);
    } catch (cause) { setBriefError(cause instanceof Error ? cause.message : "Could not upload document."); }
    finally { setBriefBusy(false); }
  }

  async function deleteBriefDocument(id: string) {
    setBriefBusy(true); setBriefError(null);
    try { await meetingsService.deleteBriefDocument(id); setBriefDocuments((current) => current.filter((item) => item.id !== id)); }
    catch (cause) { setBriefError(cause instanceof Error ? cause.message : "Could not remove document."); }
    finally { setBriefBusy(false); }
  }

  return <section className="card settings-section" id="settings-brief" aria-labelledby="organization-brief-title">
    <div className="card-header">
      <div><h2 id="organization-brief-title">Your company profile</h2><p>What the meeting-prep assistant knows about your organization. Visible to workspace members only.</p></div>
    </div>
    <div className="card-body stack-lg">
      {briefError ? <p className="form-error" role="alert">{briefError}</p> : null}
      {briefMessage ? <p className="form-success" role="status">{briefMessage}</p> : null}
      {brief ? <form id="organization-brief-form" className="form-stack" onSubmit={(event) => void saveBrief(event)}>
        <div className="field"><label htmlFor="brief-website">Company website</label><input id="brief-website" type="url" value={brief.website ?? ""} onChange={(event) => setBrief({ ...brief, website: event.target.value || null })} placeholder="https://yourcompany.com" disabled={locked} /></div>
        <div className="field"><label htmlFor="brief-overview">What your company does</label><textarea id="brief-overview" rows={3} value={brief.overview} onChange={(event) => setBrief({ ...brief, overview: event.target.value })} placeholder="Who you serve, the problems you solve, and how you work." disabled={locked} /></div>
        <div className="field-row">
          <div className="field"><label htmlFor="brief-services">Services <small>one per line</small></label><textarea id="brief-services" rows={4} value={brief.services.join("\n")} onChange={(event) => setBrief({ ...brief, services: event.target.value.split("\n") })} placeholder={"AI strategy\nWorkflow automation"} disabled={locked} /></div>
          <div className="field"><label htmlFor="brief-products">Products <small>one per line</small></label><textarea id="brief-products" rows={4} value={brief.products.join("\n")} onChange={(event) => setBrief({ ...brief, products: event.target.value.split("\n") })} placeholder="Product name — short description" disabled={locked} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label htmlFor="brief-differentiators">What makes you different</label><textarea id="brief-differentiators" rows={3} value={brief.differentiators} onChange={(event) => setBrief({ ...brief, differentiators: event.target.value })} disabled={locked} /></div>
          <div className="field"><label htmlFor="brief-positioning">Positioning and boundaries</label><textarea id="brief-positioning" rows={3} value={brief.positioning} onChange={(event) => setBrief({ ...brief, positioning: event.target.value })} placeholder="How to describe your offering; claims or pitches to avoid." disabled={locked} /></div>
        </div>
      </form> : briefError ? null : <div role="status" aria-label="Loading company context"><Skeleton lines={4} /></div>}
      <div className="brief-documents">
        <div className="section-heading">
          <div><h3>Reference documents</h3><p>PDF, DOCX, Markdown or text up to 8 MB. Scanned PDFs need OCR first.</p></div>
          {canManage ? <label className="button secondary sm brief-upload"><Upload aria-hidden="true" />Add document<input className="sr-only" type="file" accept=".pdf,.docx,.md,.txt" disabled={briefBusy} onChange={(event) => { void uploadBrief(event.target.files?.[0]); event.target.value = ""; }} /></label> : null}
        </div>
        {briefDocuments.length ? <ul className="list-card brief-document-list">{briefDocuments.map((item) => <li key={item.id} className="list-row">
          <span className="settings-icon" aria-hidden="true"><FileText /></span>
          <span className="brief-document-copy"><b>{item.filename}</b><small>{item.character_count.toLocaleString()} readable characters · {new Date(item.uploaded_at).toLocaleDateString()}</small></span>
          {canManage ? <button type="button" className="text-button destructive" disabled={briefBusy} aria-label={`Remove ${item.filename}`} onClick={() => void deleteBriefDocument(item.id)}>Remove</button> : null}
        </li>)}</ul> : <p className="field-hint">No company documents uploaded yet.</p>}
      </div>
    </div>
    {brief && canManage ? <div className="card-footer"><button className="button primary" form="organization-brief-form" disabled={briefBusy}>{briefBusy ? "Saving…" : "Save company profile"}</button></div> : null}
  </section>;
}
