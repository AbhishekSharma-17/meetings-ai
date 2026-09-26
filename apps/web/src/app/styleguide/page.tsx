import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, CalendarDays, Mic, Plus, Search, MessagesSquare, Settings2, Video } from "lucide-react";
import { Alert, Badge, EmptyState } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Meetings AI · UI system", robots: { index: false, follow: false } };

function Specimen({ theme }: { theme: "light" | "dark" }) {
  return <section className={`styleguide-preview ${theme === "light" ? "theme-light" : "dark"}`} aria-label={`${theme} theme preview`}>
    <div className="styleguide-preview-header"><span className="brand-mark"><Image src="/icon.svg" width={26} height={26} alt="" /></span><span className="brand-word">Meetings <b>AI</b></span><small>{theme} theme</small></div>
    <div className="styleguide-preview-content">
      <div><h2 className="styleguide-title">Review conversations</h2><p className="intro">A calm, accessible workspace for capture, minutes and follow-up.</p></div>
      <div className="button-group"><span className="button primary"><Plus /> New meeting</span><span className="button secondary"><CalendarDays /> Calendar</span><span className="button ghost">Cancel</span><span className="button danger-outline">Delete</span></div>
      <div className="button-group"><span className="status live">Live</span><span className="status ready">Ready to review</span><span className="status waiting_room">In lobby</span><span className="status failed">Needs attention</span><span className="status stopped">Stopped</span><Badge tone="brand">Default</Badge><span className="tag">#roadmap</span></div>
      <div className="field"><label htmlFor={`${theme}-search`}>Search meetings</label><div className="input-with-icon"><Search /><input id={`${theme}-search`} placeholder="Search a person, decision or topic" readOnly /></div></div>
      <div className="segmented" role="group" aria-label="Example modes"><button type="button" aria-pressed="true"><MessagesSquare /> Ask AI</button><button type="button" aria-pressed="false"><Search /> Sources</button><button type="button" aria-pressed="false">Wiki</button></div>
      <Alert tone="info" title="Assistant is in the lobby">Ask the host to admit Meetings AI.</Alert>
      <Alert tone="danger">Could not reach the meeting. Check the link and retry.</Alert>
      <div className="stat-grid"><article className="stat"><span className="stat-label"><Video />All meetings</span><strong className="stat-value">38</strong><span className="stat-hint">This workspace</span></article><article className="stat"><span className="stat-label"><Mic />Live now</span><strong className="stat-value">2</strong><span className="stat-hint">Transcripts updating</span></article></div>
      <Card title="Action items" description="Owners and dates reflect what was agreed." actions={<span className="button secondary sm"><Plus /> Add action</span>}>
        <div className="styleguide-row"><span className="avatar sm">DO</span><span>Share the SSO design doc</span><span className="tag">Friday</span></div>
      </Card>
      <EmptyState icon={<Settings2 />} title="No providers yet" action={<span className="button primary sm">Add provider</span>}>Add a transcription or minutes model to get started.</EmptyState>
    </div>
  </section>;
}

export default function StyleguidePage() {
  return <main className="styleguide-page">
    <header className="page-header"><div className="page-header-text"><p className="eyebrow">Internal design reference</p><h1>Meetings AI UI system</h1><p className="intro">One neutral surface system, one action accent and semantic status colours. Static page; no meeting data. Rules live in docs/design/ui-system.md.</p></div><div className="page-actions"><Link href="/" className="button secondary">Back to app <ArrowRight /></Link></div></header>
    <div className="styleguide-grid"><Specimen theme="light" /><Specimen theme="dark" /></div>
  </main>;
}
