import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Check, CircleAlert, Mic2, Plus, Settings2 } from "lucide-react";

export const metadata: Metadata = { title: "Meetings AI · UI system", robots: { index: false, follow: false } };

function Specimen({ theme }: { theme: "light" | "dark" }) {
  return <section className={`styleguide-preview ${theme === "light" ? "theme-light" : "dark"}`} aria-label={`${theme} theme preview`}>
    <div className="styleguide-preview-header"><span className="brand-mark"><Image src="/icon.svg" width={28} height={28} alt="" /></span><span>Meetings <b>AI</b></span><small>{theme} theme</small></div>
    <div className="styleguide-preview-content">
      <p className="eyebrow">MEETING WORKSPACE</p><h2>Review conversations</h2><p className="intro">A calm, accessible workspace for capture, minutes, and follow-up.</p>
      <div className="styleguide-actions"><span className="button primary"><Plus /> New meeting</span><span className="button secondary"><Settings2 /> Providers</span></div>
      <div className="styleguide-sample-card"><div><Mic2 /><span>Product planning</span></div><span className="status live">Live</span></div>
      <div className="styleguide-sample-card"><div><Check /><span>Weekly review</span></div><span className="status ready">Capture ready</span></div>
      <div className="styleguide-sample-card"><div><CircleAlert /><span>Needs a host</span></div><span className="status needs_attention">Needs attention</span></div>
    </div>
  </section>;
}

export default function StyleguidePage() {
  return <main className="styleguide-page">
    <div className="styleguide-heading"><div><p className="eyebrow">INTERNAL DESIGN REFERENCE</p><h1>Meetings AI UI system</h1><p className="intro">One neutral surface system, one action accent, and semantic status colors. This page is static and does not access meeting data.</p></div><Link href="/" className="button secondary">Back to app <ArrowRight /></Link></div>
    <section className="styleguide-section" aria-labelledby="preview-title"><h2 id="preview-title">Light and dark</h2><p>Compare the same controls and states side by side.</p><div className="styleguide-grid"><Specimen theme="light" /><Specimen theme="dark" /></div></section>
    <section className="styleguide-section" aria-labelledby="tokens-title"><h2 id="tokens-title">Foundations</h2><div className="styleguide-token-grid">
      <div><span className="styleguide-swatch brand-swatch" /><b>Action accent</b><small>Decisions, links, active navigation, focus</small></div>
      <div><span className="styleguide-swatch surface-swatch" /><b>Working surface</b><small>Cards, forms, transcript, and review</small></div>
      <div><span className="styleguide-swatch success-swatch" /><b>Success</b><small>Completed capture and sent recap</small></div>
      <div><span className="styleguide-swatch warning-swatch" /><b>Warning</b><small>Processing and review-required states</small></div>
      <div><span className="styleguide-swatch destructive-swatch" /><b>Attention</b><small>Join failures and blocked actions</small></div>
    </div></section>
  </main>;
}
