"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { formatDate, formatDateTime } from "@/lib/time-preferences";
import { Popover } from "@base-ui/react/popover";
import { BookOpenText, Building2, Database, Download, Ellipsis, Library, Lock, MessageSquare, Plus, Search, ShieldCheck, Trash2, Users } from "lucide-react";
import { jobService, meetingsService, serviceErrorStatus } from "@/lib/meetings-service";
import { useBackgroundJob } from "./use-background-job";
import { useUiPreference } from "@/lib/ui-preferences";
import type { AiSettingsView, CurrentAccount, KnowledgeBase, ProviderProfile, KnowledgeConversation, KnowledgeIndexStatus, KnowledgeMap, KnowledgeSearchResponse, KnowledgeWikiOverview, WorkspaceMember } from "@/lib/types";
import { BasePicker, ChatModelInfo, ChatTurn, ChatWelcome, Composer, PendingTurn, type Exchange, type PendingAnswer } from "./knowledge-chat";
import { EvidenceMap, SourceCard, WikiOverview } from "./knowledge-sources";
import { KnowledgeSharingDialog, type Visibility } from "./knowledge-sharing-dialog";
import { Alert, EmptyState, LoadingRow } from "./ui/feedback";
import { FilterInput, NoMatches } from "./scroll-panel";
import { useListSearch } from "./use-list-search";

type Mode = "search" | "ask" | "wiki";
const ALL_MEETINGS = "__all__";
const INDEX_POLL_MS = 15_000;
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const isMode = (value: unknown): value is Mode => value === "search" || value === "ask" || value === "wiki";
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function conversationExchanges(conversation: KnowledgeConversation): Exchange[] {
  const pairs: Exchange[] = [];
  for (let index = 0; index < conversation.messages.length - 1; index += 2) {
    const question = conversation.messages[index];
    const answer = conversation.messages[index + 1];
    if (question.role !== "user" || answer.role !== "assistant") continue;
    pairs.push({ question: question.content, response: {
      answer: answer.content, citations: answer.citations,
      provider: answer.provider, model: answer.model,
      retrieval_mode: "lexical", conversation_id: conversation.id,
      note: "Verify the cited transcript turn.",
    } });
  }
  return pairs;
}

/** Extracts the partial "answer" string from a streamed JSON object. */
function streamedAnswer(raw: string): string {
  const match = /"answer"\s*:\s*"/.exec(raw);
  if (!match) return "";
  let literal = "";
  let escaped = false;
  for (const character of raw.slice(match.index + match[0].length)) {
    if (character === '"' && !escaped) break;
    literal += character;
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  try { return JSON.parse(`"${literal}"`) as string; } catch { return ""; }
}

function visibilitySummary(base: KnowledgeBase): string {
  if (base.visibility === "organization") return "Shared with everyone in this organization";
  if (base.visibility === "specific") return `Shared with ${plural(base.shared_user_ids.length, "selected teammate")}`;
  return "Private to the creator and workspace admins";
}

function VisibilityIcon({ visibility }: { visibility: KnowledgeBase["visibility"] }) {
  if (visibility === "organization") return <Building2 aria-hidden="true" />;
  if (visibility === "specific") return <Users aria-hidden="true" />;
  return <Lock aria-hidden="true" />;
}

function relativeDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return formatDate(date, { month: "short", day: "numeric" });
}

export function KnowledgeScreen({ identity, onOpenSource, onOpenProviders, account }: {
  identity: string;
  account: CurrentAccount | null;
  onOpenProviders?(): void;
  onOpenSource(meetingId: string, segmentId: string): void;
}) {
  const isAdmin = account?.role === "owner" || account?.role === "admin";
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [mode, setMode] = useUiPreference(`meetings-ai:knowledge-mode:${identity}`, "ask" as Mode, isMode);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [basesLoaded, setBasesLoaded] = useState(false);
  const [storedBaseId, setStoredBaseId] = useUiPreference(`meetings-ai:knowledge-base:${identity}`, "", isString);
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfile[]>([]);
  // undefined while loading; null when the settings could not be read.
  const [aiSettings, setAiSettings] = useState<AiSettingsView | null | undefined>(undefined);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [shareVisibility, setShareVisibility] = useState<Visibility>("private");
  const [shareUserIds, setShareUserIds] = useState<string[]>([]);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newBaseName, setNewBaseName] = useState("");
  const [creatingBase, setCreatingBase] = useState(false);
  const [conversations, setConversations] = useState<KnowledgeConversation[]>([]);
  const [conversationId, setConversationId] = useUiPreference(`meetings-ai:knowledge-conversation:${identity}`, null as string | null, isNullableString);
  const [search, setSearch] = useState<KnowledgeSearchResponse | null>(null);
  const [overview, setOverview] = useState<KnowledgeWikiOverview | null>(null);
  const [evidenceMap, setEvidenceMap] = useState<KnowledgeMap | null>(null);
  const [indexStatus, setIndexStatus] = useState<KnowledgeIndexStatus | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [pending, setPending] = useState<PendingAnswer | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<"chat" | "base" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationRef = useRef(conversationId);
  const threadRef = useRef<HTMLDivElement>(null);
  const reindexJob = useBackgroundJob("knowledge_reindex", storedBaseId && storedBaseId !== ALL_MEETINGS ? storedBaseId : "no-base", {
    onFinish: (job) => {
      const baseId = storedBaseId === ALL_MEETINGS ? "" : storedBaseId;
      if (baseId) void meetingsService.getKnowledgeIndex(baseId).then(setIndexStatus).catch(() => undefined);
      if (job.status === "failed") setError(job.error || "Reindexing failed.");
    },
  });
  // Bumped whenever the visible base or thread changes, so a late streamed answer is not shown in the wrong chat.
  const threadGeneration = useRef(0);

  // "" means "not chosen yet"; the sentinel records an explicit "All opted-in meetings" choice.
  const selectedBaseId = storedBaseId === ALL_MEETINGS ? "" : storedBaseId;
  const selectedBase = bases.find((item) => item.id === selectedBaseId);
  const canManageBase = Boolean(selectedBase && (isAdmin || selectedBase.created_by === account?.user_id));

  useEffect(() => { conversationRef.current = conversationId; }, [conversationId]);

  useEffect(() => {
    let active = true;
    void meetingsService.listKnowledgeBases().then((items) => {
      if (!active) return;
      setBases(items);
      setBasesLoaded(true);
      setStoredBaseId((current) => {
        if (current === ALL_MEETINGS && isAdmin) return current;
        if (current && items.some((item) => item.id === current)) return current;
        return items[0]?.id ?? (isAdmin ? ALL_MEETINGS : "");
      });
    }).catch(() => { if (active) { setBasesLoaded(true); setError("Could not load knowledge bases."); } });
    void meetingsService.getAiSettings().then((value) => { if (active) setAiSettings(value); }).catch(() => { if (active) setAiSettings(null); });
    void meetingsService.listWorkspaceMembers().then((items) => { if (active) setMembers(items); }).catch(() => undefined);
    if (isAdmin) void meetingsService.listProviderProfiles().then((items) => { if (active) setProviderProfiles(items); }).catch(() => undefined);
    return () => { active = false; };
  }, [isAdmin, setStoredBaseId]);

  useEffect(() => {
    if (!selectedBaseId) return;
    let active = true;
    void meetingsService.listKnowledgeConversations(selectedBaseId).then((items) => {
      if (!active) return;
      setConversations(items);
      const remembered = conversationRef.current;
      if (!remembered) return;
      if (!items.some((item) => item.id === remembered)) { setConversationId(null); setExchanges([]); return; }
      void meetingsService.getKnowledgeConversation(selectedBaseId, remembered)
        .then((conversation) => { if (active) setExchanges(conversationExchanges(conversation)); })
        .catch(() => { if (active) { setConversationId(null); setExchanges([]); } });
    }).catch(() => { if (active) setError("Could not load conversations."); });
    void meetingsService.getKnowledgeOverview(selectedBaseId).then((value) => { if (active) setOverview(value); }).catch(() => { if (active) setOverview(null); });
    void meetingsService.getKnowledgeMap(selectedBaseId).then((value) => { if (active) setEvidenceMap(value); }).catch(() => { if (active) setEvidenceMap(null); });
    void meetingsService.getKnowledgeIndex(selectedBaseId).then((value) => { if (active) setIndexStatus(value); }).catch(() => { if (active) setIndexStatus(null); });
    const timer = window.setInterval(() => {
      void meetingsService.getKnowledgeIndex(selectedBaseId).then((value) => { if (active) setIndexStatus(value); }).catch(() => undefined);
    }, INDEX_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [selectedBaseId, setConversationId]);

  useEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [exchanges, pending]);

  const resetForBase = useCallback(() => {
    threadGeneration.current += 1;
    setMenuOpen(false);
    setSearch(null); setOverview(null); setEvidenceMap(null); setIndexStatus(null); setExchanges([]); setConversations([]);
    setConversationId(null); setError(null); setConfirmDelete(null); setNotice(null);
  }, [setConversationId]);

  function chooseBase(id: string) {
    const next = id || ALL_MEETINGS;
    if (next === storedBaseId) return;
    setStoredBaseId(next);
    resetForBase();
  }

  function startNewChat() {
    threadGeneration.current += 1;
    setConversationId(null); setExchanges([]); setMode("ask"); setConfirmDelete(null); setNotice(null); setError(null);
  }

  async function createBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setCreatingBase(true); setError(null);
    try {
      const created = await meetingsService.createKnowledgeBase(newBaseName.trim());
      setBases((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewBaseName(""); setCreateOpen(false); chooseBase(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create knowledge base.");
    } finally { setCreatingBase(false); }
  }

  async function chooseConversation(id: string) {
    if (!selectedBaseId) return;
    setBusy(true); setError(null);
    try {
      const conversation = await meetingsService.getKnowledgeConversation(selectedBaseId, id);
      threadGeneration.current += 1;
      setExchanges(conversationExchanges(conversation)); setConversationId(id); setMode("ask"); setConfirmDelete(null); setNotice(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open conversation.");
    } finally { setBusy(false); }
  }

  async function setBaseDefaultProfile(value: string) {
    if (!selectedBaseId) return;
    setError(null);
    try {
      const updated = await meetingsService.updateKnowledgeBase(selectedBaseId, { text_profile_id: value || null });
      setBases((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(`Default AI provider updated for ${updated.name}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update AI model.");
    }
  }

  function openSharing() {
    if (!selectedBase) return;
    setShareVisibility(selectedBase.visibility);
    setShareUserIds(selectedBase.shared_user_ids);
    setError(null);
    setSharingOpen(true);
  }

  async function saveSharing() {
    if (!selectedBaseId) return;
    setError(null); setBusy(true);
    try {
      if (shareVisibility === "specific" && shareUserIds.length === 0) throw new Error("Select at least one teammate for specific-person sharing.");
      const updated = await meetingsService.shareKnowledgeBase(selectedBaseId, shareVisibility, shareUserIds);
      setBases((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(`Sharing saved for ${updated.name}.`);
      setSharingOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update sharing.");
    } finally { setBusy(false); }
  }

  async function reindexBase() {
    if (!selectedBaseId) return;
    setIndexing(true); setError(null);
    try {
      // Runs as a background job so it keeps going if the user leaves this page.
      reindexJob.track(await jobService.startReindex(selectedBaseId));
    } catch (cause) {
      const status = serviceErrorStatus(cause);
      if (status === 404 || status === 405) {
        // An API without job endpoints: fall back to the synchronous reindex.
        try { setIndexStatus(await meetingsService.reindexKnowledge(selectedBaseId)); }
        catch (inner) { setError(inner instanceof Error ? inner.message : "Could not update the knowledge index."); }
      } else {
        setError(cause instanceof Error ? cause.message : "Could not update the knowledge index.");
      }
    } finally { setIndexing(false); }
  }

  async function exportConversation() {
    if (!selectedBaseId || !conversationId) return;
    setError(null); setMenuOpen(false);
    try {
      const conversation = await meetingsService.getKnowledgeConversation(selectedBaseId, conversationId);
      const url = URL.createObjectURL(new Blob([JSON.stringify(conversation, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `meetings-ai-chat-${conversationId}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export this chat.");
    }
  }

  async function deleteConversation() {
    if (!selectedBaseId || !conversationId) return;
    const deletedId = conversationId;
    setBusy(true); setError(null);
    try {
      await meetingsService.deleteKnowledgeConversation(selectedBaseId, deletedId);
      setConversations((current) => current.filter((item) => item.id !== deletedId));
      setConversationId(null); setExchanges([]); setConfirmDelete(null);
      setNotice("Saved chat deleted. Downloaded copies are not affected.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this chat.");
    } finally { setBusy(false); }
  }

  async function deleteBase() {
    if (!selectedBaseId) return;
    const deletedId = selectedBaseId;
    setBusy(true); setError(null);
    try {
      await meetingsService.deleteKnowledgeBase(deletedId);
      const remaining = bases.filter((base) => base.id !== deletedId);
      setBases(remaining);
      chooseBase(remaining[0]?.id ?? "");
      setNotice("Knowledge base deleted. Meeting records remain, but their AI knowledge opt-in was turned off.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this knowledge base.");
    } finally { setBusy(false); }
  }

  async function ask(question: string) {
    if (question.length < 3) return;
    const tags = tagFilter.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean);
    setBusy(true); setError(null); setNotice(null); setConfirmDelete(null);
    try {
      if (mode === "search") {
        setSearch(await meetingsService.searchKnowledge(question, tags, selectedBaseId || null));
        return;
      }
      if (!selectedBaseId) throw new Error("Select a knowledge base before starting a saved chat.");
      const generation = threadGeneration.current;
      const current = () => generation === threadGeneration.current;
      setPending({ question, raw: "", answer: "" });
      setQuery("");
      let raw = "";
      const response = await meetingsService.streamKnowledgeChat(question, tags, selectedBaseId, conversationId, null, null, (delta) => {
        raw += delta;
        if (current()) setPending({ question, raw, answer: streamedAnswer(raw) });
      });
      if (!current()) return;
      setExchanges((items) => [...items, { question, response }]);
      setConversationId(response.conversation_id);
      void meetingsService.listKnowledgeConversations(selectedBaseId).then((items) => { if (current()) setConversations(items); }).catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The knowledge request failed.");
      if (mode === "ask") setQuery((current) => current || question);
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(query.trim());
  }

  const baseTitle = selectedBase?.name ?? (selectedBaseId ? "Knowledge base" : "All opted-in meetings");
  const indexed = indexStatus?.indexed_sources ?? 0;
  const emptyBase = Boolean(selectedBase) && selectedBase?.meeting_count === 0;
  // Hybrid = meaning (vector) + keyword search; a base searches by keyword until its index has sources.
  const retrievalHint = emptyBase ? "No meetings in this base yet" : indexed ? "Hybrid search" : "Keyword search (not indexed yet)";
  const defaultProfile = selectedBase?.text_profile_id ?? "";
  const picker = <ChatModelInfo
    settings={aiSettings}
    onOpenProviders={onOpenProviders}
    baseDefault={isAdmin && canManageBase && selectedBase ? {
      baseName: selectedBase.name,
      value: defaultProfile,
      options: [{ value: "", label: "Workspace text-generation default" }, ...providerProfiles.filter((profile) => profile.capabilities.includes("text_generation") && !profile.id.startsWith("new-")).map((profile) => ({ value: profile.id, label: `${profile.label} · ${profile.model}` }))],
      onChange: (value) => { if (value !== defaultProfile) void setBaseDefaultProfile(value); },
    } : null}
  />;
  const hasMenu = Boolean(selectedBase && (conversationId || canManageBase));
  const baseSearch = useListSearch(bases, (base) => [base.name, plural(base.meeting_count, "meeting"), visibilitySummary(base)]);
  const chatSearch = useListSearch(conversations, (conversation) => [conversation.title, relativeDay(conversation.updated_at)]);

  return <>
    <section className="knowledge-page" aria-labelledby="knowledge-title">
      <aside className="knowledge-library" aria-label="Knowledge bases">
        <div className="kl-head">
          <h1 id="knowledge-title">AI knowledge</h1>
          <button type="button" className="button secondary sm" onClick={startNewChat} disabled={!selectedBase}><Plus /> New chat</button>
        </div>
        <div className="kl-section">
          <div className="kl-label"><span>Knowledge bases</span><button type="button" className="icon-button sm" aria-label="New knowledge base" aria-expanded={createOpen} onClick={() => setCreateOpen((value) => !value)}><Plus /></button></div>
          {createOpen ? <form className="kl-create" onSubmit={(event) => void createBase(event)}>
            <label className="sr-only" htmlFor="knowledge-base-new">Knowledge base name</label>
            <input id="knowledge-base-new" value={newBaseName} onChange={(event) => setNewBaseName(event.target.value)} minLength={2} maxLength={120} required placeholder="e.g. Acme client" autoFocus />
            <button type="submit" className="button primary sm" disabled={creatingBase} aria-label="Create knowledge base">{creatingBase ? "Creating…" : "Create"}</button>
          </form> : null}
          {baseSearch.offered ? <div className="kl-search"><FilterInput id="knowledge-base-search" label="Search knowledge bases" value={baseSearch.query} onChange={baseSearch.setQuery} placeholder="Search knowledge bases" /></div> : null}
          <div className="kl-list">
            {isAdmin && !baseSearch.query.trim() ? <button type="button" className={storedBaseId === ALL_MEETINGS ? "knowledge-base-option selected" : "knowledge-base-option"} onClick={() => chooseBase("")}><span className="kl-icon"><BookOpenText aria-hidden="true" /></span><span className="kl-copy"><b>All opted-in meetings</b><small>Search only</small></span></button> : null}
            {baseSearch.noMatches ? <NoMatches query={baseSearch.query} noun="knowledge bases" onClear={baseSearch.clear} /> : null}
            {baseSearch.visible.map((base) => <button type="button" key={base.id} className={selectedBaseId === base.id ? "knowledge-base-option selected" : "knowledge-base-option"} onClick={() => chooseBase(base.id)}>
              <span className="kl-icon"><Library aria-hidden="true" /></span>
              <span className="kl-copy"><b>{base.name}</b><small>{plural(base.meeting_count, "meeting")}</small></span>
              <span className="kl-visibility" title={visibilitySummary(base)}><VisibilityIcon visibility={base.visibility} /></span>
            </button>)}
            {basesLoaded && !bases.length && !isAdmin ? <p className="field-hint kl-empty">No knowledge bases are shared with you yet.</p> : null}
          </div>
        </div>
        {selectedBase ? <div className="kl-section kl-chats">
          <div className="kl-label"><span>Chats</span><span className="section-count">{conversations.length || ""}</span></div>
          {chatSearch.offered ? <div className="kl-search"><FilterInput id="knowledge-chat-search" label="Search chats" value={chatSearch.query} onChange={chatSearch.setQuery} placeholder="Search chats" /></div> : null}
          <div className="kl-list">
            {chatSearch.noMatches ? <NoMatches query={chatSearch.query} noun="chats" onClear={chatSearch.clear} />
              : conversations.length ? chatSearch.visible.map((conversation) => <button type="button" key={conversation.id} onClick={() => void chooseConversation(conversation.id)} className={conversationId === conversation.id ? "knowledge-chat-option selected" : "knowledge-chat-option"}><MessageSquare aria-hidden="true" /><span>{conversation.title}</span><small>{relativeDay(conversation.updated_at)}</small></button>)
              : <p className="field-hint kl-empty">Saved chats for {selectedBase.name} appear here.</p>}
          </div>
        </div> : null}
        {selectedBase ? <div className="kl-index" role="group" aria-label="Semantic index">
          <div className="kl-index-head"><Database aria-hidden="true" /><b>Semantic index</b>{canManageBase ? <button type="button" className="text-button" disabled={indexing || reindexJob.running} onClick={() => void reindexBase()}>{indexing || reindexJob.running ? "Indexing…" : "Reindex now"}</button> : null}</div>
          <small>{indexed ? `${plural(indexed, "source")} indexed · ${indexStatus?.model ?? "embedding model"}` : "No sources indexed yet"}</small>
          {indexStatus?.job_status && indexStatus.job_status !== "succeeded" ? <small role="status">Background index: {indexStatus.job_status}{indexStatus.next_retry_at ? ` · retry ${formatDateTime(indexStatus.next_retry_at)}` : ""}</small> : null}
          {indexStatus?.last_error ? <small className="inline-error" role="alert">{indexStatus.last_error}</small> : null}
        </div> : null}
      </aside>

      <div className="knowledge-main">
        <header className="knowledge-header">
          <div className="kh-title">
            <h2>{baseTitle}</h2>
            <p>{selectedBase ? <><VisibilityIcon visibility={selectedBase.visibility} /><span>{visibilitySummary(selectedBase)}</span><span aria-hidden="true">·</span><span>{plural(selectedBase.meeting_count, "meeting")}</span></> : <span>Only completed meetings marked “Add to AI knowledge” are included.</span>}</p>
          </div>
          <div className="segmented kh-modes" role="group" aria-label="Knowledge mode">
            <button type="button" aria-pressed={mode === "ask"} onClick={() => setMode("ask")}><MessageSquare /> Ask AI</button>
            <button type="button" aria-pressed={mode === "search"} onClick={() => setMode("search")}><Search /> Sources</button>
            <button type="button" aria-pressed={mode === "wiki"} onClick={() => setMode("wiki")}><BookOpenText /> Wiki</button>
          </div>
          <div className="kh-actions">
            {canManageBase ? <button type="button" className="button secondary sm" onClick={openSharing}><ShieldCheck /> Manage sharing</button> : null}
            {hasMenu ? <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <Popover.Trigger className="icon-button" aria-label="More options"><Ellipsis /></Popover.Trigger>
              <Popover.Portal><Popover.Positioner side="bottom" align="end" sideOffset={6} className="ui-select-positioner"><Popover.Popup className="popover">
                {conversationId ? <button type="button" className="menu-item" onClick={() => void exportConversation()}><Download /> Export JSON</button> : null}
                {conversationId ? <button type="button" className="menu-item destructive" onClick={() => { setMenuOpen(false); setConfirmDelete("chat"); }}><Trash2 /> Delete chat</button> : null}
                {conversationId && canManageBase ? <div className="menu-separator" /> : null}
                {canManageBase ? <button type="button" className="menu-item destructive" onClick={() => { setMenuOpen(false); setConfirmDelete("base"); }}><Trash2 /> Delete knowledge base</button> : null}
              </Popover.Popup></Popover.Positioner></Popover.Portal>
            </Popover.Root> : null}
          </div>
        </header>

        {confirmDelete === "chat" ? <Alert tone="danger" role="alert" className="knowledge-banner" title="Delete this saved chat?" actions={<><button type="button" className="button secondary sm" onClick={() => setConfirmDelete(null)}>Cancel</button><button type="button" className="button danger sm" disabled={busy} onClick={() => void deleteConversation()}>Confirm delete</button></>}>Stored answers and citations are removed. Exported copies are not affected.</Alert> : null}
        {confirmDelete === "base" ? <Alert tone="danger" role="alert" className="knowledge-banner" title={`Delete ${selectedBase?.name ?? "this knowledge base"}?`} actions={<><button type="button" className="button secondary sm" onClick={() => setConfirmDelete(null)}>Cancel</button><button type="button" className="button danger sm" disabled={busy} onClick={() => void deleteBase()}>Confirm delete base</button></>}>Meeting records stay, but their AI knowledge opt-in is turned off and saved chats are removed.</Alert> : null}
        {error && !sharingOpen ? <Alert tone="danger" className="knowledge-banner">{error}</Alert> : null}
        {notice ? <Alert tone="success" className="knowledge-banner">{notice}</Alert> : null}

        {mode === "ask" ? <>
          <div className="chat-scroll" ref={threadRef}>
            <div className="chat-column">
              {exchanges.length || pending ? <div className="chat-thread" aria-live="polite">
                {exchanges.map((exchange, index) => <ChatTurn key={`${index}:${exchange.question}`} exchange={exchange} onOpenSource={onOpenSource} />)}
                {pending ? <PendingTurn pending={pending} /> : null}
              </div> : !basesLoaded ? <LoadingRow>Loading knowledge bases…</LoadingRow> : <ChatWelcome baseName={selectedBase?.name ?? null} disabled={busy} onPrompt={(prompt) => void ask(prompt)} />}
            </div>
          </div>
          <div className="chat-dock"><div className="chat-column">
            <Composer value={query} onChange={setQuery} onSubmit={submit} busy={busy} disabled={!selectedBase} tags={tagFilter} onTags={setTagFilter} picker={picker} basePicker={<BasePicker bases={bases.map((base) => ({ id: base.id, name: base.name, meetings: base.meeting_count }))} selectedId={selectedBaseId} onSelect={chooseBase} />} hint={selectedBase ? `${retrievalHint} · memory saved in this chat` : ""} />
          </div></div>
        </> : null}

        {mode === "search" ? <div className="knowledge-pane">
          <form className="source-search" onSubmit={submit}>
            <div className="input-with-icon source-search-query"><Search aria-hidden="true" /><label className="sr-only" htmlFor="knowledge-search">Search meetings</label><input id="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} minLength={3} maxLength={500} required placeholder="Search a person, decision, topic or exact phrase" /></div>
            <label className="sr-only" htmlFor="knowledge-tags">Filter by tags</label>
            <input id="knowledge-tags" className="source-search-tags" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} placeholder="Tags (optional)" />
            <button className="button primary" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
          </form>
          {search ? <section className="source-results" aria-labelledby="source-results-title">
            <div className="section-heading"><div><h2 id="source-results-title">Matching sources</h2><p>{plural(search.count, "result")} · {search.retrieval_mode === "hybrid" ? "hybrid keyword + semantic" : "keyword"} retrieval{search.truncated_meeting_scope ? " · newest 200 meetings searched" : ""}</p></div></div>
            {search.sources.length ? <div className="source-list">{search.sources.map((source) => <SourceCard key={source.source_id} source={source} onOpenSource={onOpenSource} />)}</div>
              : <EmptyState icon={<Search />} title="No matching sources">Try a different phrase or tag. Only opted-in, completed meetings are searchable.</EmptyState>}
          </section> : <EmptyState plain icon={<Search />} title={`Search ${baseTitle}`}>Find the exact transcript turns and approved minutes behind any topic, with timestamps and speakers.</EmptyState>}
        </div> : null}

        {mode === "wiki" ? <div className="knowledge-pane">
          {overview ? <><WikiOverview overview={overview} onOpenMeeting={(id) => onOpenSource(id, "")} />{evidenceMap ? <EvidenceMap map={evidenceMap} onOpenSource={onOpenSource} /> : null}</>
            : <EmptyState icon={<BookOpenText />} title="No wiki to show yet">{selectedBase ? "This knowledge base has no completed meetings yet." : "Select a knowledge base with completed meetings."}</EmptyState>}
        </div> : null}
      </div>
    </section>
    <KnowledgeSharingDialog open={sharingOpen} onOpenChange={setSharingOpen} baseName={selectedBase?.name ?? ""} visibility={shareVisibility} onVisibility={setShareVisibility} userIds={shareUserIds} onUserIds={setShareUserIds} members={members} currentUserId={account?.user_id} busy={busy} error={error} onSave={() => void saveSharing()} />
  </>;
}
