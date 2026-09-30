"use client";

import { FormEvent, useCallback, useEffect, useState, type ReactNode } from "react";
import Image from "next/image";
import { meetingsService } from "@/lib/meetings-service";
import { readUiPreference } from "@/lib/ui-preferences";
import { bootDemoMode, exitDemo, startDemo } from "@/lib/demo-mode";
import type { CachedCalendarEvent, CurrentAccount, Meeting, ProviderProfile, Workspace, WorkspaceOption } from "@/lib/types";
import { Dashboard } from "./dashboard";
import { NewMeetingDialog } from "./new-meeting-dialog";
import type { CalendarSelection } from "./calendar-import-dialog";
import { CalendarWorkspace } from "./calendar-workspace";
import { MeetingPrepWorkspace } from "./meeting-prep-workspace";
import { MeetingsLibrary } from "./meetings-library";
import { MeetingDetailScreen } from "./meeting-detail-screen";
import { ProviderSettings } from "./provider-settings";
import { WorkspaceSettings } from "./workspace-settings";
import { ProfileSettings } from "./profile-settings";
import { KnowledgeScreen } from "./knowledge-screen";
import { SharedWithMeScreen } from "./shared-with-me-screen";
import { MemberMeetingScreen } from "./shared-meeting-screen";
import { ObservabilityScreen } from "./observability-screen";
import { ProvidersIcon } from "./ui-icons";
import { ThemeSwitcher } from "./theme-switcher";
import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { BrainCircuit, Building2, CalendarDays, ChartNoAxesCombined, Check, ChevronsUpDown, Compass, FileCheck2, House, LogOut, Menu, MessagesSquare, Mic, NotebookPen, ScanSearch, Share2, UserRound, Users, Video, X } from "lucide-react";
import { Avatar } from "./ui/avatar";
import { EmptyState, LoadingRow } from "./ui/feedback";
import { DemoBanner, DemoPill } from "./demo-banner";
import { NotificationCenter } from "./notification-center";
import { AccountLinkScreen, takeAccountLinkFromUrl, type AccountLink } from "./account-link-screen";
import { ForgotPasswordForm } from "./forgot-password-form";
import { PASSWORD_MIN } from "./set-password-form";
import { rememberSelection, type NotificationTarget } from "./notification-feed";
import { useTimePreferences, useTimePreferencesSync } from "@/lib/time-preferences";
import { TimeZoneIndicator } from "./time-preferences-control";
import { WorkspaceMenuList } from "./workspace-menu-list";
import { InPersonRecorder, type InPersonRequest } from "./in-person-flow";
import { PhoneTabBar } from "./phone-tab-bar";
import { InPersonResumeBanner, usePendingRecording } from "./in-person-resume";
import { ResearchScreen } from "./research-screen";
import type { ProfileLinks } from "./research-profile";
import type { AttendeeSides } from "@/lib/types";
import { BLANK_SEED } from "./in-person-seed";
import type { InPersonSeed } from "@/lib/in-person-types";

type View = "dashboard" | "meetings" | "calendar" | "prep" | "providers" | "meeting" | "workspace" | "knowledge" | "observability" | "profile" | "research" | "shared";
const views: View[] = ["dashboard", "meetings", "calendar", "prep", "providers", "meeting", "workspace", "knowledge", "observability", "profile", "research", "shared"];
const isView = (value: unknown): value is View => typeof value === "string" && views.includes(value as View);
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function restoredView(scope: string): View {
  const key = `meetings-ai:active-view:${scope}`;
  try {
    const legacy = sessionStorage.getItem(key);
    if (isView(legacy)) return legacy;
  } catch { /* Optional browser storage. */ }
  return readUiPreference(key, "dashboard" as View, isView, "session");
}

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
  const [navigationRestored, setNavigationRestored] = useState(false);
  const [account, setAccount] = useState<CurrentAccount | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  // An emailed invite/reset link (read from the URL fragment, then removed from the address bar).
  const [accountLink, setAccountLink] = useState<AccountLink | null>(null);
  const [forgotPassword, setForgotPassword] = useState(false);
  // Bumped when a notification opens a record on prep/knowledge, so the screen remounts and reads the new selection.
  const [focusNonce, setFocusNonce] = useState(0);
  // The in-person recorder (full screen) and a recording this device left unfinished.
  const [inPersonRequest, setInPersonRequest] = useState<InPersonRequest | null>(null);
  const [inPersonRevision, setInPersonRevision] = useState(0);
  // Navigating away sends the recorder page to the background (it keeps recording, a banner leads back).
  const [recorderBackground, setRecorderBackground] = useState<InPersonRequest | null>(null);
  const [recorderView, setRecorderView] = useState<View>(view);
  if (recorderView !== view) { setRecorderView(view); setRecorderBackground(inPersonRequest); }
  // Who's-who sides chosen in Research → Prepare a meeting, applied when meeting prep opens that event.
  const [prepSides, setPrepSides] = useState<{ eventId: string; sides: AttendeeSides } | null>(null);

  const identity = account ? `${account.organization_id}:${account.user_id}` : null;
  // Subscribing here re-renders every screen when the time zone or clock changes.
  useTimePreferences();
  useTimePreferencesSync(authenticated && account && !account.must_change_password ? account.user_id : null);
  const canRecord = Boolean(authenticated && account && !account.must_change_password && account.role !== "viewer");
  const pendingRecording = usePendingRecording(identity, canRecord && !inPersonRequest);

  useEffect(() => {
    const callback = new URLSearchParams(window.location.search);
    const invitedEmail = callback.get("invite");
    const calendarConnected = callback.get("calendar") === "connected";
    if (invitedEmail) queueMicrotask(() => setLoginEmail(invitedEmail));
    const link = takeAccountLinkFromUrl();
    if (link) queueMicrotask(() => setAccountLink(link));
    if (calendarConnected) {
      const connectedAccountId = callback.get("connected_account_id");
      queueMicrotask(() => setPreferredCalendarConnectionId(connectedAccountId));
    }
    // Demo mode (sample data served in the browser) must be installed before the first API call.
    void bootDemoMode().catch(() => false).then((demo) => { setDemoMode(demo); return meetingsService.getSession(); }).then(async (active) => {
      if (active) {
        const current = await meetingsService.getCurrentAccount();
        setAccount(current);
        const scope = `${current.organization_id}:${current.user_id}`;
        const restored = restoredView(scope);
        const allowed = current.role === "owner" || current.role === "admin" ? views.filter((item) => item !== "shared") : current.role === "viewer" ? ["knowledge", "profile", "meeting", "shared"] : ["knowledge", "calendar", "prep", "profile", "meeting", "research", "shared"];
        const next = calendarConnected && current.role !== "viewer" ? "calendar" : allowed.includes(restored) ? restored : current.role === "owner" || current.role === "admin" ? "dashboard" : "knowledge";
        if (next === "meeting") {
          const id = readUiPreference(`meetings-ai:active-meeting:${scope}`, "", isString, "session");
          if (id) { setActiveMeetingId(id); setView("meeting"); }
          else setView(current.role === "owner" || current.role === "admin" ? "meetings" : "knowledge");
        }
        if (next !== "meeting") setView(next);
      }
      setAuthenticated(active);
      setNavigationRestored(active);
      if (calendarConnected) window.history.replaceState(null, "", window.location.pathname);
    }).catch(() => setLoginError("Could not reach the API. Check that the local services are running."));
    const expired = () => {
      setAuthenticated(false); setAccount(null); setNavigationRestored(false); setView("dashboard");
      setMeetings([]); setProfiles([]); setWorkspace(null); setWorkspaces([]);
      setActiveMeetingId(null); setCalendarSelection(null); setPrepEvent(null);
      setPreferredCalendarConnectionId(null); setDialogOpen(false); setInPersonRequest(null);
    };
    window.addEventListener("meetings-ai-session-expired", expired);
    return () => window.removeEventListener("meetings-ai-session-expired", expired);
  }, []);

  useEffect(() => {
    if (!account || !navigationRestored) return;
    try { sessionStorage.setItem(`meetings-ai:active-view:${account.organization_id}:${account.user_id}`, JSON.stringify(view)); } catch { /* Navigation still works without session storage. */ }
  }, [account, navigationRestored, view]);

  useEffect(() => {
    if (!identity || !navigationRestored) return;
    try {
      if (view === "meeting" && activeMeetingId) sessionStorage.setItem(`meetings-ai:active-meeting:${identity}`, JSON.stringify(activeMeetingId));
      else if (view !== "meeting") sessionStorage.removeItem(`meetings-ai:active-meeting:${identity}`);
    } catch { /* Navigation still works without session storage. */ }
  }, [identity, navigationRestored, view, activeMeetingId]);

  useEffect(() => { if (view !== "prep") queueMicrotask(() => setPrepEvent(null)); }, [view]);

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
      const restored = restoredView(`${current.organization_id}:${current.user_id}`);
      setView(current.role === "owner" || current.role === "admin" ? restored === "meeting" ? "meetings" : restored === "shared" ? "dashboard" : restored : current.role === "viewer" ? restored === "shared" ? "shared" : "knowledge" : restored === "calendar" || restored === "prep" || restored === "research" || restored === "shared" ? restored : "knowledge");
      setNavigationRestored(true);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Sign in failed.");
    } finally { setLoggingIn(false); }
  }

  async function exploreDemo() {
    setLoggingIn(true); setLoginError(null);
    try {
      await startDemo();
      const current = await meetingsService.getCurrentAccount();
      setDemoMode(true); setAccount(current); setAuthenticated(true); setView("dashboard"); setNavigationRestored(true);
    } catch {
      setLoginError("The demo could not start. Refresh the page and try again.");
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
    setMeetingReturnView(view === "research" ? "research" : view === "shared" ? "shared" : view === "knowledge" || segmentId ? "knowledge" : view === "meetings" ? "meetings" : view === "calendar" ? "calendar" : "dashboard"); setView("meeting");
  }, [view]);
  const openNotification = useCallback((target: NotificationTarget) => {
    if (!identity || !account) return;
    const admin = account.role === "owner" || account.role === "admin";
    if (target.view === "meeting" && target.id) { openMeeting(target.id); return; }
    if (target.view === "prep" && account.role !== "viewer") {
      if (target.id) rememberSelection(`meetings-ai:prep-event:${identity}`, target.id);
      setPrepEvent(null); setFocusNonce((value) => value + 1); setView("prep"); return;
    }
    if (target.view === "knowledge") {
      if (target.id) rememberSelection(`meetings-ai:knowledge-base:${identity}`, target.id);
      setFocusNonce((value) => value + 1); setView("knowledge"); return;
    }
    if (isView(target.view) && (admin || ["calendar", "profile"].includes(target.view))) setView(target.view);
  }, [identity, account, openMeeting]);
  const researchLinks: ProfileLinks = {
    onOpenMeeting: openMeeting,
    onOpenPrep: (eventId) => { if (identity) rememberSelection(`meetings-ai:prep-event:${identity}`, eventId); setPrepEvent(null); setFocusNonce((value) => value + 1); setView("prep"); },
    onOpenKnowledge: (baseId) => { if (identity) rememberSelection(`meetings-ai:knowledge-base:${identity}`, baseId); setFocusNonce((value) => value + 1); setView("knowledge"); },
    onOpenCalendar: () => setView("calendar"),
    onPrepared: (result) => {
      if (identity) rememberSelection(`meetings-ai:prep-event:${identity}`, result.calendar_event_id);
      setPrepSides({ eventId: result.calendar_event_id, sides: result.attendee_sides });
      setPrepEvent(null); setFocusNonce((value) => value + 1); setView("prep");
    },
  };
  // A recording already running is brought back to the front instead of starting a second one.
  const recordInPerson = useCallback((seed: InPersonSeed) => { setRecorderBackground(null); setInPersonRequest((current) => current ?? { kind: "new", seed }); }, []);
  const closeRecorder = useCallback(() => { setInPersonRequest(null); setInPersonRevision((value) => value + 1); pendingRecording.recheck(); }, [pendingRecording]);
  const finishRecording = useCallback((meetingId: string) => {
    setInPersonRequest(null);
    setInPersonRevision((value) => value + 1);
    if (account?.role === "owner" || account?.role === "admin") void meetingsService.listMeetings().then(setMeetings).catch(() => undefined);
    openMeeting(meetingId);
  }, [account, openMeeting]);
  const updateMeeting = useCallback((meeting: Meeting) => {
    setMeetings((current) => current.some((candidate) => candidate.id === meeting.id) ? current.map((candidate) => candidate.id === meeting.id ? meeting : candidate) : [meeting, ...current]);
  }, []);
  const signOut = useCallback(() => { if (demoMode) { exitDemo(); return; } void meetingsService.logout().finally(() => {
    setAuthenticated(false); setAccount(null); setNavigationRestored(false); setView("dashboard"); setMeetings([]); setProfiles([]);
    setWorkspace(null); setWorkspaces([]); setActiveMeetingId(null); setCalendarSelection(null);
    setPrepEvent(null); setPreferredCalendarConnectionId(null); setDialogOpen(false);
  }); }, [demoMode]);
  const switchWorkspace = useCallback(async (id: string) => {
    await meetingsService.switchWorkspace(id);
    window.location.reload();
  }, []);
  const createWorkspace = useCallback(async (name: string) => {
    await meetingsService.createWorkspace(name);
    window.location.reload();
  }, []);

  if (accountLink) return <LoginLayout>
    <AccountLinkScreen link={accountLink} onSignedIn={() => window.location.replace(window.location.pathname)}
      onSignIn={() => setAccountLink(null)} onRequestReset={() => { setAccountLink(null); setForgotPassword(true); }} />
  </LoginLayout>;

  if (!authenticated && forgotPassword) return <LoginLayout>
    <ForgotPasswordForm initialEmail={loginEmail} onBack={() => setForgotPassword(false)} />
  </LoginLayout>;

  if (!authenticated) return <LoginLayout>
    <form className="login-card" onSubmit={(event) => void signIn(event)}>
      <div>
        <h1>Welcome back</h1>
        <p className="intro">{authenticated === null ? "Checking your session…" : "Sign in to review conversations, decisions and next steps."}</p>
      </div>
      {authenticated === false ? <>
        <div className="field"><label htmlFor="login-email">Work email</label><input id="login-email" type="email" autoComplete="username" placeholder="you@company.com" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} required /></div>
        <div className="field"><div className="login-label-row"><label htmlFor="admin-password">Password</label><button type="button" className="text-button" onClick={() => { setLoginError(null); setForgotPassword(true); }}>Forgot password?</button></div><input id="admin-password" type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} required /></div>
        <button className="button primary lg block" disabled={loggingIn}>{loggingIn ? "Signing in…" : "Sign in"}</button>
      </> : <div className="login-checking" role="status"><span className="spinner" aria-hidden="true" />Connecting to your workspace…</div>}
      {loginError ? <p className="form-error" role="alert">{loginError} <button type="button" onClick={() => void meetingsService.getSession().then(setAuthenticated).catch(() => setLoginError("Could not reach the API."))}>Retry</button></p> : null}
      {authenticated === false || loginError ? <div className="login-demo">
        <p className="login-divider" aria-hidden="true">or</p>
        <button type="button" className="button secondary lg block" disabled={loggingIn} onClick={() => void exploreDemo()}><Compass aria-hidden="true" />Explore the demo</button>
        <p className="login-demo-hint">Sample workspace · nothing is saved</p>
      </div> : null}
      <p className="login-footnote">Invited by a teammate? Open “Accept invite” in your invitation email to choose your password.</p>
    </form>
  </LoginLayout>;

  if (account?.must_change_password) return <LoginLayout>
    <form className="login-card" onSubmit={(event) => void changePassword(event)}>
      <div><p className="eyebrow">Account setup</p><h1>Choose your password</h1><p className="intro">{account.email} · {account.display_name}</p></div>
      <div className="field"><label htmlFor="temporary-password">Temporary password</label><input id="temporary-password" type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} required /></div>
      <div className="field"><label htmlFor="new-password">New password</label><input id="new-password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /><p className="field-hint">At least {PASSWORD_MIN} characters.</p></div>
      <button className="button primary lg block" disabled={loggingIn}>{loggingIn ? "Saving…" : "Set new password"}</button>
      {loginError ? <p className="form-error" role="alert">{loginError}</p> : null}
    </form>
  </LoginLayout>;

  const liveCount = meetings.filter((meeting) => meeting.status === "live" || meeting.status === "joining" || meeting.status === "waiting_room").length;
  // On phones the recorder page has its own bottom action bar, so the tab bar steps aside while it is in front.
  const recorderInFront = inPersonRequest !== null && recorderBackground !== inPersonRequest;
  const showTabBar = Boolean(account) && !recorderInFront;
  return (
    <div className={showTabBar ? "app-frame has-tabbar" : "app-frame"}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <SidebarPanel view={view} onNavigate={setView} workspaces={workspaces} account={account} liveCount={liveCount} onSignOut={signOut} onSwitchWorkspace={switchWorkspace} className="desktop-sidebar" />
      <div className="workspace-main">
        {demoMode ? <DemoBanner /> : null}
        <header className="topbar">
          <button className="icon-button mobile-nav-trigger" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu /></button>
          <nav className="topbar-context" aria-label="Breadcrumb"><span className="topbar-kicker">{workspace?.display_name ?? "Meetings AI"}</span><span className="topbar-sep" aria-hidden="true">/</span><span className="topbar-location" aria-current="page">{recorderInFront ? "In-person recording" : viewTitle[view]}</span></nav>
          <div className="topbar-actions">{demoMode ? <DemoPill /> : null}{liveCount && view !== "meetings" ? <button type="button" className="status live" onClick={() => setView("meetings")}>{liveCount} live</button> : null}{identity ? <NotificationCenter key={identity} identity={identity} onNavigate={openNotification} /> : null}</div>
        </header>
        <main id="main-content">
          {identity ? <InPersonRecorder request={inPersonRequest} identity={identity} canOpenProviders={account?.role === "owner" || account?.role === "admin"}
            background={inPersonRequest !== null && recorderBackground === inPersonRequest} onReturn={() => setRecorderBackground(null)}
            onClose={closeRecorder} onFinished={finishRecording} onOpenProviders={() => { setInPersonRequest(null); setView("providers"); }} /> : null}
          {pendingRecording.pending && !inPersonRequest ? <div className="ip-resume-region"><InPersonResumeBanner key={pendingRecording.pending.session.meeting_id} pending={pendingRecording.pending}
            onFinish={() => { if (pendingRecording.pending) setInPersonRequest({ kind: "resume", pending: pendingRecording.pending, action: "finish" }); }}
            onContinue={() => { if (pendingRecording.pending) setInPersonRequest({ kind: "resume", pending: pendingRecording.pending, action: "continue" }); }}
            onDiscarded={() => { pendingRecording.clear(); pendingRecording.recheck(); }} /></div> : null}
          {view === "dashboard" ? <Dashboard meetings={meetings} account={account} onNewMeeting={() => { setCalendarSelection(null); setDialogOpen(true); }} onRecordInPerson={() => recordInPerson(BLANK_SEED)} onOpenCalendar={() => setView("calendar")} onOpenProviders={() => setView("providers")} onOpenKnowledge={() => setView("knowledge")} onOpenMeetings={() => setView("meetings")} onOpenMeeting={openMeeting} /> : null}
          {view === "meetings" && identity ? <MeetingsLibrary key={identity} identity={identity} meetings={meetings} onOpen={openMeeting} onNew={() => { setCalendarSelection(null); setDialogOpen(true); }} onCalendar={() => setView("calendar")} onRecordInPerson={() => recordInPerson(BLANK_SEED)} /> : null}
          {view === "calendar" && account && account.role !== "viewer" ? <CalendarWorkspace key={identity} calendarIdentity={`${account.organization_id}:${account.user_id}`} preferredConnectionId={preferredCalendarConnectionId} onPreferredConnectionApplied={() => setPreferredCalendarConnectionId(null)} canSchedule={account.role === "owner" || account.role === "admin"} onChoose={(selection) => { setCalendarSelection(selection); setDialogOpen(true); }} onPrepare={(event) => { setPrepEvent(event); setView("prep"); }} onNewMeeting={account.role === "owner" || account.role === "admin" ? () => { setCalendarSelection(null); setDialogOpen(true); } : undefined} onOpenMeeting={openMeeting} onRecordInPerson={recordInPerson} inPersonRevision={inPersonRevision} /> : null}
          {view === "prep" && account && account.role !== "viewer" && identity ? <MeetingPrepWorkspace key={`${identity}:${focusNonce}`} identity={identity} initialEvent={prepEvent} initialSides={prepSides} onOpenCalendar={() => setView("calendar")} onOpenOrganization={() => setView("workspace")} onOpenProviders={account.role === "owner" || account.role === "admin" ? () => setView("providers") : undefined} /> : null}
          {view === "providers" ? providersLoadError ? <section className="page narrow"><EmptyState icon={<ProvidersIcon />} title="AI providers are unavailable" action={<button className="button secondary" onClick={() => void meetingsService.listProviderProfiles().then((nextProfiles) => { setProfiles(nextProfiles); setProvidersLoadError(null); }).catch(() => undefined)}>Retry</button>}><span role="alert">{providersLoadError}</span></EmptyState></section> : identity ? <ProviderSettings key={identity} identity={identity} profiles={profiles} onProfilesChange={setProfiles} /> : null : null}
          {view === "knowledge" && identity ? <KnowledgeScreen key={`${identity}:${focusNonce}`} identity={identity} account={account} onOpenSource={openMeeting} onOpenProviders={account?.role === "owner" || account?.role === "admin" ? () => setView("providers") : undefined} /> : null}
          {view === "observability" && (account?.role === "owner" || account?.role === "admin") ? <ObservabilityScreen /> : null}
          {view === "research" && account && account.role !== "viewer" && identity ? <ResearchScreen key={identity} userId={account.user_id} links={researchLinks} onOpenProviders={account.role === "owner" || account.role === "admin" ? () => setView("providers") : undefined} /> : null}
          {view === "workspace" ? workspace
            ? <WorkspaceSettings workspace={workspace} workspaces={workspaces} account={account} onWorkspaceChange={setWorkspace} onSwitchWorkspace={switchWorkspace} onCreateWorkspace={createWorkspace} onWorkspacesChange={setWorkspaces} onOpenObservability={() => setView("observability")} />
            : <section className="page narrow">{workspaceLoading ? <LoadingRow>Loading workspace…</LoadingRow> : <EmptyState icon={<Building2 />} title="Workspace profile is unavailable">Refresh the page to try again.</EmptyState>}</section>
            : null}
          {view === "profile" && account ? <ProfileSettings account={account} workspace={workspace} onAccountChange={setAccount} /> : null}
          {view === "meeting" && activeMeetingId ? account?.role === "owner" || account?.role === "admin"
            ? <MeetingDetailScreen meetingId={activeMeetingId} focusSegmentId={focusSegmentId} backLabel={backLabel[meetingReturnView] ?? "Back"} onBack={() => setView(meetingReturnView)} onMeetingChange={updateMeeting} onDeleted={(id) => { setMeetings((current) => current.filter((meeting) => meeting.id !== id)); setActiveMeetingId(null); setView("dashboard"); }} />
            : <MemberMeetingScreen meetingId={activeMeetingId} focusSegmentId={focusSegmentId} backLabel={backLabel[meetingReturnView] ?? "AI knowledge"} onBack={() => setView(meetingReturnView === "calendar" || meetingReturnView === "research" || meetingReturnView === "shared" ? meetingReturnView : "knowledge")} onBackToKnowledge={() => setView("knowledge")} /> : null}
          {view === "shared" && account && account.role !== "owner" && account.role !== "admin" ? <SharedWithMeScreen onOpenMeeting={(id) => openMeeting(id)} /> : null}
        </main>
      </div>
      <Dialog.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="mobile-nav-backdrop" />
          <Dialog.Popup className="mobile-nav-sheet">
            <Dialog.Title className="sr-only">Workspace navigation</Dialog.Title>
            <Dialog.Close className="icon-button mobile-nav-close" aria-label="Close navigation"><X /></Dialog.Close>
            <SidebarPanel view={view} onNavigate={(next) => { setView(next); setMobileNavOpen(false); }} workspaces={workspaces} account={account} liveCount={liveCount} onSignOut={signOut} onSwitchWorkspace={switchWorkspace} className="drawer-sidebar" />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      {showTabBar && account ? <PhoneTabBar role={account.role} view={view} liveCount={liveCount} moreOpen={mobileNavOpen}
        onNavigate={setView} onRecord={() => recordInPerson(BLANK_SEED)} onMore={() => setMobileNavOpen(true)} /> : null}
      <NewMeetingDialog open={dialogOpen && (account?.role === "owner" || account?.role === "admin")} calendarSelection={calendarSelection} onClose={() => { setDialogOpen(false); setCalendarSelection(null); }} onMeetingJoined={(meeting) => {
        setDialogOpen(false);
        setCalendarSelection(null);
        updateMeeting(meeting);
        openMeeting(meeting.id);
      }} />
    </div>
  );
}

const viewTitle: Record<View, string> = {
  dashboard: "Overview", meetings: "Meetings", calendar: "Calendar", prep: "Meeting prep", providers: "AI providers",
  meeting: "Meeting details", workspace: "Organization & people", knowledge: "AI knowledge", observability: "Observability", profile: "My profile",
  research: "Research", shared: "Shared with me",
};
const backLabel: Partial<Record<View, string>> = { dashboard: "Overview", meetings: "All meetings", calendar: "Calendar", knowledge: "AI knowledge", research: "Research", shared: "Shared with me" };

function LoginLayout({ children }: { children: ReactNode }) {
  return <main className="login-page">
    <div className="login-panel">
      <div className="login-panel-top"><span className="cluster"><span className="brand-mark" aria-hidden="true"><Image src="/icon.svg" width={26} height={26} alt="" /></span><span className="brand-word">Meetings <b>AI</b></span></span><ThemeSwitcher /></div>
      {children}
      <p className="login-footnote">Recordings start only after the host is told: “Meetings AI has joined and will record and transcribe this conversation.”</p>
    </div>
    <aside className="login-showcase" aria-label="What Meetings AI does">
      <div className="login-showcase-copy">
        <h2>From conversation to clarity, without losing the evidence.</h2>
        <p>An assistant that joins your calls, drafts reviewed minutes, and turns every approved meeting into searchable team knowledge.</p>
      </div>
      <LoginVignette />
      <div className="login-steps">
        <div className="login-step"><span className="step-icon"><Mic aria-hidden="true" /></span><span><b>Capture</b><small>Meet, Zoom, Teams</small></span></div>
        <div className="login-step"><span className="step-icon"><FileCheck2 aria-hidden="true" /></span><span><b>Review</b><small>Approved recaps</small></span></div>
        <div className="login-step"><span className="step-icon"><MessagesSquare aria-hidden="true" /></span><span><b>Ask</b><small>Cited answers</small></span></div>
      </div>
    </aside>
  </main>;
}

/** Decorative product vignette on the sign-in page: a call being transcribed into minutes. */
function LoginVignette() {
  const lines = [
    { who: "PN", name: "Priya", text: "Let’s ship SSO in the October release." },
    { who: "ML", name: "Marcus", text: "Audit logs can move to November." },
    { who: "DO", name: "Dana", text: "I’ll share the design doc by Friday." },
  ];
  return <div className="login-vignette" aria-hidden="true">
    <div className="vignette-call">
      <div className="vignette-head"><span className="vignette-rec"><i />Recording</span><b>Acme · Q4 roadmap</b><span className="vignette-wave">{Array.from({ length: 9 }, (_, index) => <i key={index} style={{ animationDelay: `${index * 0.11}s` }} />)}</span></div>
      <ul className="vignette-lines">{lines.map((line, index) => <li key={line.who} style={{ animationDelay: `${0.6 + index * 1.4}s` }}><span className="avatar sm">{line.who}</span><span><b>{line.name}</b>{line.text}</span></li>)}</ul>
    </div>
    <div className="vignette-mom">
      <div className="vignette-mom-head"><FileCheck2 /><b>Minutes draft</b><span className="vignette-badge">Ready to review</span></div>
      <ul>
        <li style={{ animationDelay: "5.2s" }}><Check /><span><small>Decision</small>SSO ships in October</span></li>
        <li style={{ animationDelay: "6s" }}><Check /><span><small>Action · Dana · Fri</small>Share the SSO design doc</span></li>
      </ul>
    </div>
  </div>;
}

function SidebarPanel({ view, onNavigate, workspaces, account, liveCount, onSignOut, onSwitchWorkspace, className }: { view: View; onNavigate(view: View): void; workspaces: WorkspaceOption[]; account: CurrentAccount | null; liveCount: number; onSignOut(): void; onSwitchWorkspace(id: string): Promise<void>; className: string }) {
  const canManageMeetings = account?.role === "owner" || account?.role === "admin";
  const canUseCalendar = Boolean(account && account.role !== "viewer");
  const [menuOpen, setMenuOpen] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const navigate = (next: View) => { setMenuOpen(false); onNavigate(next); };
  const changeWorkspace = async (id: string) => {
    setWorkspaceBusy(true); setWorkspaceError(null);
    try { await onSwitchWorkspace(id); }
    catch (error) { setWorkspaceError(error instanceof Error ? error.message : "Could not switch workspace."); setWorkspaceBusy(false); }
  };
  const item = (target: View, label: string, icon: ReactNode, active = view === target, extra?: ReactNode) => <button aria-current={active ? "page" : undefined} className={active ? "nav-link active" : "nav-link"} onClick={() => onNavigate(target)}>{icon}{label}{extra}</button>;
  return <aside className={`workspace-sidebar ${className}`} aria-label="Workspace navigation">
    <button className="sidebar-brand" onClick={() => navigate(canManageMeetings ? "dashboard" : "knowledge")} aria-label="Meetings AI home"><span className="brand-mark" aria-hidden="true"><Image src="/icon.svg" width={26} height={26} alt="" /></span><span className="brand-word">Meetings <b>AI</b></span></button>
    <nav aria-label="Main navigation">
      <div className="sidebar-group">
        {canManageMeetings ? item("dashboard", "Overview", <House />) : null}
        {canManageMeetings ? item("meetings", "Meetings", <Video />, view === "meetings" || view === "meeting", liveCount ? <span className="nav-live" aria-hidden="true" /> : null) : null}
        {canUseCalendar ? item("calendar", "Calendar", <CalendarDays />) : null}
        {canManageMeetings ? null : item("shared", "Shared with me", <Share2 />)}
      </div>
      <div className="sidebar-group">
        <p className="sidebar-label">Intelligence</p>
        {item("knowledge", "AI knowledge", <BrainCircuit />)}
        {canUseCalendar ? item("prep", "Meeting prep", <NotebookPen />) : null}
        {canUseCalendar ? item("research", "Research", <ScanSearch />) : null}
      </div>
      {canManageMeetings ? <div className="sidebar-group">
        <p className="sidebar-label">Administration</p>
        {item("providers", "AI providers", <ProvidersIcon />)}
        {item("observability", "Observability", <ChartNoAxesCombined />)}
      </div> : null}
    </nav>
    <div className="sidebar-spacer" />
    <div className="sidebar-foot">
      <TimeZoneIndicator />
      <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Popover.Trigger className="profile-trigger"><Avatar name={account?.display_name} photoUrl={account?.photo_url} /><span className="profile-trigger-copy"><span className="profile-trigger-name">{account?.display_name ?? "Account"}</span><span className="profile-trigger-meta">{account?.email ?? account?.role ?? "User"}</span></span><ChevronsUpDown aria-hidden="true" /></Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={6} className="ui-select-positioner">
            <Popover.Popup className="popover profile-popover" aria-label="Account and workspace menu">
              <div className="profile-popover-heading"><Avatar name={account?.display_name} photoUrl={account?.photo_url} size="lg" /><span><b>{account?.display_name ?? "Account"}</b><small>{account?.email ?? "Local account"}</small></span></div>
              <div className="menu-separator" />
              <p className="menu-label">Workspaces</p>
              <WorkspaceMenuList workspaces={workspaces} currentId={account?.organization_id} busy={workspaceBusy} onChoose={(id) => void changeWorkspace(id)} />
              {workspaceError ? <p role="alert" className="form-error">{workspaceError}</p> : null}
              <div className="menu-separator" />
              <button type="button" className="menu-item" onClick={() => navigate("workspace")}><Users /> Organization & people</button>
              <button type="button" className="menu-item" onClick={() => navigate("profile")}><UserRound /> My profile & password</button>
              <div className="profile-popover-theme"><span>Appearance</span><ThemeSwitcher /></div>
              <div className="menu-separator" />
              <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); onSignOut(); }}><LogOut /> Sign out</button>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  </aside>;
}
