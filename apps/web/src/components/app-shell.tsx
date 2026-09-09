"use client";

import { useCallback, useEffect, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { Meeting, ProviderProfile } from "@/lib/types";
import { Dashboard } from "./dashboard";
import { NewMeetingDialog } from "./new-meeting-dialog";
import { MeetingDetailScreen } from "./meeting-detail-screen";
import { ProviderSettings } from "./provider-settings";

type View = "dashboard" | "providers" | "meeting";

export function AppShell() {
  const [view, setView] = useState<View>("dashboard");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeMeetingId, setActiveMeetingId] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([meetingsService.listMeetings(), meetingsService.listProviderProfiles()]).then(([nextMeetings, nextProfiles]) => {
      setMeetings(nextMeetings);
      setProfiles(nextProfiles);
    });
  }, []);

  const openMeeting = useCallback((id: string) => { setActiveMeetingId(id); setView("meeting"); }, []);
  const updateMeeting = useCallback((meeting: Meeting) => {
    setMeetings((current) => current.some((candidate) => candidate.id === meeting.id) ? current.map((candidate) => candidate.id === meeting.id ? meeting : candidate) : [meeting, ...current]);
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
        {view === "dashboard" ? <Dashboard meetings={meetings} onNewMeeting={() => setDialogOpen(true)} onOpenProviders={() => setView("providers")} onOpenMeeting={openMeeting} /> : null}
        {view === "providers" ? <ProviderSettings profiles={profiles} onProfilesChange={setProfiles} /> : null}
        {view === "meeting" && activeMeetingId ? <MeetingDetailScreen meetingId={activeMeetingId} onBack={() => setView("dashboard")} onMeetingChange={updateMeeting} /> : null}
      </main>
      <NewMeetingDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onMeetingJoined={(meeting) => {
        setDialogOpen(false);
        updateMeeting(meeting);
        openMeeting(meeting.id);
      }} />
    </div>
  );
}
