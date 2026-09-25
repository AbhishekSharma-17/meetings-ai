"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { meetingsService } from "@/lib/meetings-service";
import type { CachedCalendarEvent, CurrentAccount, Meeting, ProviderProfile, Workspace, WorkspaceOption } from "@/lib/types";
import { Dashboard } from "./dashboard";
import { NewMeetingDialog } from "./new-meeting-dialog";
import { CalendarImportDialog, type CalendarSelection } from "./calendar-import-dialog";
import { CalendarWorkspace } from "./calendar-workspace";
import { MeetingPrepWorkspace } from "./meeting-prep-workspace";
import { MeetingsLibrary } from "./meetings-library";
import { MeetingDetailScreen } from "./meeting-detail-screen";
import { ProviderSettings } from "./provider-settings";
import { WorkspaceSettings } from "./workspace-settings";
import { ProfileSettings } from "./profile-settings";
import { KnowledgeScreen } from "./knowledge-screen";
import { KnowledgeEvidenceScreen } from "./knowledge-evidence-screen";
import { ObservabilityScreen } from "./observability-screen";
import { ProvidersIcon } from "./ui-icons";
import { ThemeSwitcher } from "./theme-switcher";
import { Dialog } from "@base-ui/react/dialog";
import { Activity, BookOpenText, Building2, CalendarDays, ChevronUp, LayoutDashboard, LogOut, Menu, Sparkles, UserRound, Video, X } from "lucide-react";

type View = "dashboard" | "meetings" | "calendar" | "prep" | "providers" | "meeting" | "workspace" | "knowledge" | "observability" | "profile";

export function AppShell() {
  const [view, setView] = useState<View>("dashboard");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [providersLoadError, setProvidersLoadError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preferredCalendarConnectionId, setPreferredCalendarConnectionId] = useState<string | null>(null);
  const [calendarSelection, setCalendarSelection] = useState<CalendarSelection | null>(null);
  const [prepEvent, setPrepEvent] = useState<CachedCalendarEvent | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [activeMeetingId, setActiveMeetingId] = useState<string | null>(null);
  const [focusSegmentId, setFocusSegmentId] = useState<string | null>(null);
  const [meetingReturnView, setMeetingReturnView] = useState<View>("dashboard");
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [account, setAccount] = useState<CurrentAccount | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    const callback = new URLSearchParams(window.location.search);
    const invitedEmail = callback.get("invite");
    const calendarConnected = callback.get("calendar") === "connected";
    if (invitedEmail) queueMicrotask(() => setLoginEmail(invitedEmail));
    if (calendarConnected) {
      const connectedAccountId = callback.get("connected_account_id");
      queueMicrotask(() => { setPreferredCalendarConnectionId(connectedAccountId); setView("calendar"); });
      window.history.replaceState(null, "", window.location.pathname);
    }
    void meetingsService.getSession().then(async (active) => {
      if (active) {
        const current = await meetingsService.getCurrentAccount();
        setAccount(current);
        let restored: string | null = null;
        try { restored = sessionStorage.getItem(`meetings-ai:active-view:${current.organization_id}:${current.user_id}`); } catch { /* Session storage is optional. */ }
        if (current.role !== "viewer" && (calendarConnected || restored === "calendar" || restored === "prep")) {
          setView(calendarConnected ? "calendar" : restored as View);
        } else if (current.role !== "owner" && current.role !== "admin") setView("knowledge");
      }
      setAuthenticated(active);
    }).catch(() => setLoginError("Could not reach the API. Check that the local services are running."));
    const expired = () => setAuthenticated(false);
    window.addEventListener("meetings-ai-session-expired", expired);
    return () => window.removeEventListener("meetings-ai-session-expired", expired);
  }, []);

  useEffect(() => {
    if (!account) return;
    try { sessionStorage.setItem(`meetings-ai:active-view:${account.organization_id}:${account.user_id}`, view); } catch { /* Navigation still works without session storage. */ }
  }, [account, view]);

  useEffect(() => {
    if (!authenticated || !account || account.must_change_password) return;
    if (account.role === "owner" || account.role === "admin") {
      void meetingsService.listMeetings().then(setMeetings).catch(() => undefined);
      void meetingsService.listProviderProfiles().then((nextProfiles) => { setProfiles(nextProfiles); setProvidersLoadError(null); }).catch(() => setProvidersLoadError("Could not load provider configurations. Check the API connection and retry."));
    }
    void meetingsService.getWorkspace().then(setWorkspace).catch(() => setWorkspace(null)).finally(() => setWorkspaceLoading(false));
    void meetingsService.listWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([]));
  }, [authenticated, account]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoggingIn(true); setLoginError(null);
    try {
      await meetingsService.login(loginEmail.trim(), loginPassword);
      const current = await meetingsService.getCurrentAccount();
      setLoginPassword(""); setAccount(current); setAuthenticated(true);
      if (current.role !== "owner" && current.role !== "admin") setView("knowledge");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Sign in failed.");
    } finally { setLoggingIn(false); }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoggingIn(true); setLoginError(null);
    try {
      await meetingsService.changePassword(loginPassword, newPassword);
      setAccount(await meetingsService.getCurrentAccount());
      setLoginPassword(""); setNewPassword("");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Could not change password.");
    } finally { setLoggingIn(false); }
  }

  const openMeeting = useCallback((id: string, segmentId?: string) => {
    setActiveMeetingId(id); setFocusSegmentId(segmentId ?? null);
    setMeetingReturnView(view === "knowledge" || segmentId ? "knowledge" : view === "meetings" ? "meetings" : view === "calendar" ? "calendar" : "dashboard"); setView("meeting");
  }, [view]);
  const updateMeeting = useCallback((meeting: Meeting) => {
    setMeetings((current) => current.some((candidate) => candidate.id === meeting.id) ? current.map((candidate) => candidate.id === meeting.id ? meeting : candidate) : [meeting, ...current]);
  }, []);
  const signOut = useCallback(() => { void meetingsService.logout().finally(() => { setAuthenticated(false); setAccount(null); }); }, []);
  const switchWorkspace = useCallback(async (id: string) => {
    await meetingsService.switchWorkspace(id);
    window.location.reload();
  }, []);
  const createWorkspace = useCallback(async (name: string) => {
    await meetingsService.createWorkspace(name);
    window.location.reload();
  }, []);

  if (!authenticated) return <main className="login-page">
    <form className="login-card" onSubmit={(event) => void signIn(event)}>
      <div className="login-brand"><span className="brand-mark" aria-hidden="true"><Image src="/icon.svg" width={28} height={28} alt="" /></span><span>Meetings <b>AI</b></span></div>
      <p className="eyebrow">YOUR MEETING WORKSPACE</p>
      <h1>Make every conversation count.</h1>
      <p>{authenticated === null ? "Checking your session…" : "Sign in to review conversations, decisions, and next steps."}</p>
      <ThemeSwitcher />
      {authenticated === false ? <><label htmlFor="login-email">Work email</label><input id="login-email" type="email" autoComplete="username" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} required /><label htmlFor="admin-password">Password</label><input id="admin-password" type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} required /><button className="button primary" disabled={loggingIn}>{loggingIn ? "Signing in…" : "Sign in"}</button></> : null}
      {loginError ? <p className="form-error" role="alert">{loginError} <button type="button" onClick={() => void meetingsService.getSession().then(setAuthenticated).catch(() => setLoginError("Could not reach the API."))}>Retry</button></p> : null}
    </form>
  </main>;

  if (account?.must_change_password) return <main className="login-page"><form className="login-card" onSubmit={(event) => void changePassword(event)}><p className="eyebrow">ACCOUNT SETUP</p><h1>Change your temporary password.</h1><p>{account.email} · {account.display_name}</p><label htmlFor="temporary-password">Temporary password</label><input id="temporary-password" type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} required /><label htmlFor="new-password">New password</label><input id="new-password" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /><button className="button primary" disabled={loggingIn}>{loggingIn ? "Saving…" : "Set new password"}</button>{loginError ? <p className="form-error" role="alert">{loginError}</p> : null}</form></main>;

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <SidebarPanel view={view} onNavigate={setView} workspaces={workspaces} account={account} onSignOut={signOut} onSwitchWorkspace={switchWorkspace} className="desktop-sidebar" />
      <div className="workspace-main">
      <header className="topbar">
        <button className="mobile-nav-trigger" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu /></button>
        <div className="topbar-context"><span className="topbar-kicker">{workspace?.display_name ?? "Meetings AI"}</span><span className="topbar-location">{view === "providers" ? "AI providers" : view === "workspace" ? "Organization & people" : view === "knowledge" ? "AI knowledge" : view === "observability" ? "Observability" : view === "profile" ? "My profile" : view === "meeting" ? "Meeting details" : view === "meetings" ? "Meetings" : view === "calendar" ? "Calendar" : view === "prep" ? "Meeting prep" : "Overview"}</span></div>
        <span className="topbar-environment"><span aria-hidden="true" /> Local environment</span>
      </header>
      <main id="main-content">
        {view === "dashboard" ? <Dashboard meetings={meetings} onNewMeeting={() => { setCalendarSelection(null); setDialogOpen(true); }} onOpenCalendar={() => setView("calendar")} onOpenProviders={() => setView("providers")} onOpenMeeting={openMeeting} /> : null}
        {view === "meetings" ? <MeetingsLibrary meetings={meetings} onOpen={openMeeting} onNew={() => { setCalendarSelection(null); setDialogOpen(true); }} onCalendar={() => setView("calendar")} /> : null}
        {view === "calendar" && account && account.role !== "viewer" ? <CalendarWorkspace calendarIdentity={`${account.organization_id}:${account.user_id}`} preferredConnectionId={preferredCalendarConnectionId} canSchedule={account.role === "owner" || account.role === "admin"} onChoose={(selection) => { setCalendarSelection(selection); setDialogOpen(true); }} onPrepare={(event) => { setPrepEvent(event); setView("prep"); }} /> : null}
        {view === "prep" && account && account.role !== "viewer" ? <MeetingPrepWorkspace initialEvent={prepEvent} onOpenCalendar={() => setView("calendar")} onOpenOrganization={() => setView("workspace")} /> : null}
        {view === "providers" ? providersLoadError ? <section className="page" role="alert"><h1>AI providers are unavailable</h1><p className="intro">{providersLoadError}</p><button className="button secondary" onClick={() => void meetingsService.listProviderProfiles().then((nextProfiles) => { setProfiles(nextProfiles); setProvidersLoadError(null); }).catch(() => undefined)}>Retry</button></section> : <ProviderSettings profiles={profiles} onProfilesChange={setProfiles} /> : null}
        {view === "knowledge" ? <KnowledgeScreen account={account} onOpenSource={openMeeting} /> : null}
        {view === "observability" && (account?.role === "owner" || account?.role === "admin") ? <ObservabilityScreen /> : null}
        {view === "workspace" ? workspace
          ? <WorkspaceSettings workspace={workspace} workspaces={workspaces} account={account} onWorkspaceChange={setWorkspace} onSwitchWorkspace={switchWorkspace} onCreateWorkspace={createWorkspace} />
          : <section className="page" role="status">{workspaceLoading ? "Loading workspace…" : "Workspace profile is unavailable. Refresh the page to try again."}</section>
          : null}
        {view === "profile" && account ? <ProfileSettings account={account} workspace={workspace} onAccountChange={setAccount} /> : null}
        {view === "meeting" && activeMeetingId ? account?.role === "owner" || account?.role === "admin"
          ? <MeetingDetailScreen meetingId={activeMeetingId} focusSegmentId={focusSegmentId} onBack={() => setView(meetingReturnView)} onMeetingChange={updateMeeting} onDeleted={(id) => { setMeetings((current) => current.filter((meeting) => meeting.id !== id)); setActiveMeetingId(null); setView("dashboard"); }} />
          : <KnowledgeEvidenceScreen meetingId={activeMeetingId} focusSegmentId={focusSegmentId} onBack={() => setView("knowledge")} /> : null}
      </main>
      </div>
      <Dialog.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="mobile-nav-backdrop" />
          <Dialog.Popup className="mobile-nav-sheet">
            <Dialog.Title className="sr-only">Workspace navigation</Dialog.Title>
            <Dialog.Close className="mobile-nav-close" aria-label="Close navigation"><X /></Dialog.Close>
            <SidebarPanel view={view} onNavigate={(next) => { setView(next); setMobileNavOpen(false); }} workspaces={workspaces} account={account} onSignOut={signOut} onSwitchWorkspace={switchWorkspace} className="drawer-sidebar" />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <NewMeetingDialog open={dialogOpen && (account?.role === "owner" || account?.role === "admin")} calendarSelection={calendarSelection} onClose={() => { setDialogOpen(false); setCalendarSelection(null); }} onMeetingJoined={(meeting) => {
        setDialogOpen(false);
        setCalendarSelection(null);
        updateMeeting(meeting);
        openMeeting(meeting.id);
      }} />
    </div>
  );
}

function SidebarPanel({ view, onNavigate, workspaces, account, onSignOut, onSwitchWorkspace, className }: { view: View; onNavigate(view: View): void; workspaces: WorkspaceOption[]; account: CurrentAccount | null; onSignOut(): void; onSwitchWorkspace(id: string): Promise<void>; className: string }) {
  const canManageMeetings = account?.role === "owner" || account?.role === "admin";
  const canUseCalendar = Boolean(account && account.role !== "viewer");
  const [menuOpen, setMenuOpen] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [menuOpen]);
  const navigate = (next: View) => { setMenuOpen(false); onNavigate(next); };
  const changeWorkspace = async (id: string) => {
    setWorkspaceBusy(true); setWorkspaceError(null);
    try { await onSwitchWorkspace(id); }
    catch (error) { setWorkspaceError(error instanceof Error ? error.message : "Could not switch workspace."); setWorkspaceBusy(false); }
  };
  return <aside className={`workspace-sidebar ${className}`} aria-label="Workspace navigation">
    <button className="brand" onClick={() => navigate("dashboard")} aria-label="Meetings AI home"><span className="brand-mark" aria-hidden="true"><Image src="/icon.svg" width={28} height={28} alt="" /></span><span>Meetings <b>AI</b></span></button>
    <p className="sidebar-label">YOUR WORK</p>
    <nav aria-label="Main navigation">
      {canManageMeetings ? <button aria-current={view === "dashboard" ? "page" : undefined} className={view === "dashboard" ? "nav-link active" : "nav-link"} onClick={() => onNavigate("dashboard")}><LayoutDashboard /> Overview</button> : null}
      {canManageMeetings ? <button aria-current={view === "meetings" || view === "meeting" ? "page" : undefined} className={view === "meetings" || view === "meeting" ? "nav-link active" : "nav-link"} onClick={() => onNavigate("meetings")}><Video /> Meetings</button> : null}
      {canUseCalendar ? <button aria-current={view === "calendar" ? "page" : undefined} className={view === "calendar" ? "nav-link active" : "nav-link"} onClick={() => onNavigate("calendar")}><CalendarDays /> Calendar</button> : null}
      {canManageMeetings ? <button aria-current={view === "providers" ? "page" : undefined} className={view === "providers" ? "nav-link active" : "nav-link"} onClick={() => onNavigate("providers")}><ProvidersIcon /> AI providers</button> : null}
      <button aria-current={view === "knowledge" ? "page" : undefined} className={view === "knowledge" ? "nav-link active" : "nav-link"} onClick={() => onNavigate("knowledge")}><BookOpenText /> AI knowledge</button>
      {canManageMeetings ? <button aria-current={view === "observability" ? "page" : undefined} className={view === "observability" ? "nav-link active" : "nav-link"} onClick={() => onNavigate("observability")}><Activity /> Observability</button> : null}
      {canUseCalendar ? <div className="sidebar-prep-section"><p className="sidebar-label">PREPARE</p><button aria-current={view === "prep" ? "page" : undefined} className={view === "prep" ? "nav-link active" : "nav-link"} onClick={() => onNavigate("prep")}><Sparkles /> Meeting prep</button></div> : null}
    </nav>
    <div className="sidebar-foot" ref={menuRef}>
      {menuOpen ? <div className="profile-popover" aria-label="Account and workspace menu"><div className="profile-popover-heading"><b>Signed in as {account?.display_name ?? "Account"}</b><small>{account?.email ?? "Local account"}</small></div><div className="profile-workspaces"><span className="profile-workspaces-label">WORKSPACES</span>{workspaces.map((item) => <button key={item.id} type="button" className={item.id === account?.organization_id ? "profile-workspace current" : "profile-workspace"} disabled={workspaceBusy || item.id === account?.organization_id} onClick={() => void changeWorkspace(item.id)}><Building2 size={15} /><span>{item.display_name}</span><small>{item.id === account?.organization_id ? "Current" : item.role}</small></button>)}{workspaceError ? <p role="alert" className="form-error">{workspaceError}</p> : null}</div><button onClick={() => navigate("workspace")}><Building2 /> Organization & people</button><button onClick={() => navigate("profile")}><UserRound /> My profile & password</button><div className="profile-popover-theme"><span>Appearance</span><ThemeSwitcher /></div><button className="profile-signout" onClick={() => { setMenuOpen(false); onSignOut(); }}><LogOut /> Sign out</button></div> : null}
      <button className="profile-trigger" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((value) => !value)}><span className="profile-trigger-avatar" aria-hidden="true">{account?.display_name[0]?.toUpperCase() ?? "U"}</span><span className="profile-trigger-copy"><b>{account?.display_name ?? "Account"}</b><small>{account?.email ?? account?.role ?? "User"}</small></span><ChevronUp className={menuOpen ? "profile-chevron open" : "profile-chevron"} /></button>
    </div>
  </aside>;
}
