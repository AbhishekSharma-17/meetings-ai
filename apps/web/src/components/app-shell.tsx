"use client";

import { useEffect, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { Meeting, ProviderProfile } from "@/lib/types";
import { Dashboard } from "./dashboard";
import { NewMeetingDialog } from "./new-meeting-dialog";
import { ProviderSettings } from "./provider-settings";

type View = "dashboard" | "providers";

export function AppShell() {
  const [view, setView] = useState<View>("dashboard");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    void Promise.all([meetingsService.listMeetings(), meetingsService.listProviderProfiles()]).then(([nextMeetings, nextProfiles]) => {
      setMeetings(nextMeetings);
      setProfiles(nextProfiles);
    });
  }, []);

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="topbar">
        <button className="brand" onClick={() => setView("dashboard")} aria-label="Meetings AI home">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span>Meetings <b>AI</b></span>
        </button>
        <nav aria-label="Main navigation">
          <button className={view === "dashboard" ? "nav-link active" : "nav-link"} onClick={() => setView("dashboard")}>Meetings</button>
          <button className={view === "providers" ? "nav-link active" : "nav-link"} onClick={() => setView("providers")}>AI providers</button>
        </nav>
        <button className="avatar" aria-label="Open account menu">A</button>
      </header>
      <main id="main-content">
        {view === "dashboard" ? <Dashboard meetings={meetings} onNewMeeting={() => setDialogOpen(true)} onOpenProviders={() => setView("providers")} /> : null}
        {view === "providers" ? <ProviderSettings profiles={profiles} onProfilesChange={setProfiles} /> : null}
      </main>
      <NewMeetingDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
