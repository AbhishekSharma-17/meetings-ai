"use client";

import { FormEvent, useEffect, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { CurrentAccount, KnowledgeBase, KnowledgeChatResponse, KnowledgeConversation, KnowledgeIndexStatus, KnowledgeSearchResponse, KnowledgeSource, KnowledgeWikiOverview, ProviderProfile, WorkspaceMember } from "@/lib/types";
import { ArrowUpRight, BookOpenText, GitBranch, Plus, Search, Sparkles } from "lucide-react";

type Exchange = { question: string; response: KnowledgeChatResponse };

export function KnowledgeScreen({ onOpenSource, account }: {
  account: CurrentAccount | null;
  onOpenSource(meetingId: string, segmentId: string): void;
}) {
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [mode, setMode] = useState<"search" | "ask">("ask");
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState("");
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [shareVisibility, setShareVisibility] = useState<"private" | "organization" | "specific">("private");
  const [shareUserIds, setShareUserIds] = useState<string[]>([]);
  const [newBaseName, setNewBaseName] = useState("");
  const [creatingBase, setCreatingBase] = useState(false);
  const [conversations, setConversations] = useState<KnowledgeConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [search, setSearch] = useState<KnowledgeSearchResponse | null>(null);
  const [overview, setOverview] = useState<KnowledgeWikiOverview | null>(null);
  const [indexStatus, setIndexStatus] = useState<KnowledgeIndexStatus | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [confirmDeleteConversation, setConfirmDeleteConversation] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedBase = bases.find((item) => item.id === selectedBaseId);
  const canManageBase = selectedBase && (account?.role === "owner" || account?.role === "admin" || selectedBase.created_by === account?.user_id);

  useEffect(() => {
    void meetingsService.listKnowledgeBases().then((items) => {
      setBases(items);
      if (items.length) setSelectedBaseId((current) => current || items[0].id);
    }).catch(() => setError("Could not load knowledge bases."));
    if (account?.role === "owner" || account?.role === "admin") {
      void meetingsService.listProviderProfiles().then(setProfiles).catch(() => undefined);
    }
    void meetingsService.listWorkspaceMembers().then(setMembers).catch(() => undefined);
  }, [account]);

  useEffect(() => {
    if (!selectedBaseId) return;
    void meetingsService.listKnowledgeConversations(selectedBaseId).then(setConversations).catch(() => setError("Could not load conversations."));
    void meetingsService.getKnowledgeOverview(selectedBaseId).then(setOverview).catch(() => setOverview(null));
    void meetingsService.getKnowledgeIndex(selectedBaseId).then(setIndexStatus).catch(() => setIndexStatus(null));
  }, [selectedBaseId]);

  function chooseBase(id: string) {
    setSelectedBaseId(id); setSearch(null); setOverview(null); setIndexStatus(null); setExchanges([]); setConversations([]); setConversationId(null); setError(null);
    setConfirmDeleteConversation(false); setNotice(null);
    const base = bases.find((item) => item.id === id);
    setShareVisibility(base?.visibility ?? "private");
    setShareUserIds(base?.shared_user_ids ?? []);
  }

  async function createBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setCreatingBase(true); setError(null);
    try {
      const created = await meetingsService.createKnowledgeBase(newBaseName.trim());
      setBases((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewBaseName(""); chooseBase(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create knowledge base.");
    } finally { setCreatingBase(false); }
  }

  async function chooseConversation(id: string) {
    if (!selectedBaseId) return;
    setBusy(true); setError(null);
    try {
      const conversation = await meetingsService.getKnowledgeConversation(selectedBaseId, id);
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
      setExchanges(pairs); setConversationId(id); setMode("ask"); setConfirmDeleteConversation(false); setNotice(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open conversation.");
    } finally { setBusy(false); }
  }

  async function setTextProfile(value: string) {
    if (!selectedBaseId) return;
    setError(null);
    try {
      const updated = await meetingsService.updateKnowledgeBase(selectedBaseId, { text_profile_id: value || null });
      setBases((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update AI model.");
    }
  }

  async function saveSharing() {
    if (!selectedBaseId) return;
    setError(null);
    try {
      const updated = await meetingsService.shareKnowledgeBase(selectedBaseId, shareVisibility, shareUserIds);
      setBases((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update sharing.");
    }
  }

  async function reindexBase() {
    if (!selectedBaseId) return;
    setIndexing(true); setError(null);
    try { setIndexStatus(await meetingsService.reindexKnowledge(selectedBaseId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the knowledge index."); }
    finally { setIndexing(false); }
  }

  async function exportConversation() {
    if (!selectedBaseId || !conversationId) return;
    setError(null);
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
      setConversationId(null); setExchanges([]); setConfirmDeleteConversation(false);
      setNotice("Saved chat deleted. Downloaded copies are not affected.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this chat.");
    } finally { setBusy(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = query.trim();
    if (question.length < 3) return;
    const tags = tagFilter.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean);
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === "search") {
        setSearch(await meetingsService.searchKnowledge(question, tags, selectedBaseId || null));
      } else {
        if (!selectedBaseId) throw new Error("Select a knowledge base before starting a saved chat.");
        const response = await meetingsService.chatKnowledge(question, tags, selectedBaseId, conversationId);
        setExchanges((current) => [...current, { question, response }]);
        setConversationId(response.conversation_id);
        void meetingsService.listKnowledgeConversations(selectedBaseId).then(setConversations).catch(() => undefined);
        setQuery("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The knowledge request failed.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="page knowledge-page" aria-labelledby="knowledge-title">
    <div className="knowledge-hero"><p className="eyebrow">CONNECTED KNOWLEDGE</p><h1 id="knowledge-title">Your meeting wiki.</h1><p className="intro">Explore connected meetings, approved decisions, and transcript evidence. Ask questions across a knowledge base and follow every answer back to its source.</p></div>
    <div className="knowledge-policy" role="note"><b>Grounded in meeting records.</b> Only completed meetings marked “Add to AI knowledge” appear here. Approved MOM facts are linked to the meeting; individual answers cite timestamped transcript turns. Review speaker names before relying on attribution.</div>
    <div className="knowledge-layout"><aside className="knowledge-library" aria-label="Knowledge bases"><div className="section-heading"><div><h2>Knowledge bases</h2><p>One client or project per base</p></div></div>{account?.role === "owner" || account?.role === "admin" ? <button className={!selectedBaseId ? "knowledge-base-option selected" : "knowledge-base-option"} onClick={() => chooseBase("")}><BookOpenText /> All opted-in meetings</button> : null}{bases.map((base) => <button key={base.id} className={selectedBaseId === base.id ? "knowledge-base-option selected" : "knowledge-base-option"} onClick={() => chooseBase(base.id)}><span><b>{base.name}</b><small>{base.meeting_count} meeting{base.meeting_count === 1 ? "" : "s"} · {base.visibility}</small></span></button>)}<form className="knowledge-create" onSubmit={(event) => void createBase(event)}><label htmlFor="knowledge-base-new">Create a knowledge base</label><div><input id="knowledge-base-new" value={newBaseName} onChange={(event) => setNewBaseName(event.target.value)} minLength={2} maxLength={120} required placeholder="e.g. Acme client" /><button type="submit" className="button secondary" disabled={creatingBase} aria-label="Create knowledge base"><Plus /></button></div></form>{selectedBase ? <>{canManageBase && (account?.role === "owner" || account?.role === "admin") ? <><label className="knowledge-model-label" htmlFor="knowledge-model">Ask AI model for {selectedBase.name}</label><select id="knowledge-model" value={selectedBase.text_profile_id ?? ""} onChange={(event) => void setTextProfile(event.target.value)}><option value="">Workspace text-generation default</option>{profiles.filter((profile) => profile.capabilities.includes("text_generation") && !profile.id.startsWith("new-")).map((profile) => <option value={profile.id} key={profile.id}>{profile.label} · {profile.model}</option>)}</select><p className="field-hint">Configure credentials in AI providers. Base-specific selection does not change MOM or transcription models.</p></> : null}{canManageBase ? <div className="knowledge-sharing"><label htmlFor="knowledge-visibility">Share this base</label><select id="knowledge-visibility" value={shareVisibility} onChange={(event) => setShareVisibility(event.target.value as "private" | "organization" | "specific")}><option value="private">Private to creator and admins</option><option value="organization">Everyone in organization</option><option value="specific">Specific teammates</option></select>{shareVisibility === "specific" ? <div className="knowledge-share-members">{members.filter((member) => member.user_id !== account?.user_id).map((member) => <label key={member.user_id}><input type="checkbox" checked={shareUserIds.includes(member.user_id)} onChange={(event) => setShareUserIds((current) => event.target.checked ? [...current, member.user_id] : current.filter((id) => id !== member.user_id))} /> {member.display_name} <small>{member.email}</small></label>)}</div> : null}<button type="button" className="button secondary" onClick={() => void saveSharing()}>Save sharing</button></div> : null}<div className="knowledge-index"><b>Semantic index</b><small>{indexStatus?.indexed_sources ? `${indexStatus.indexed_sources} source${indexStatus.indexed_sources === 1 ? "" : "s"} indexed · ${indexStatus.model ?? "embedding model"}` : "No sources indexed yet"}</small><p>Search checks indexed hits against live meeting records. Reindex after transcript or MOM changes to refresh semantic matches.</p>{canManageBase ? <button type="button" className="button secondary" disabled={indexing} onClick={() => void reindexBase()}>{indexing ? "Indexing…" : "Reindex knowledge"}</button> : null}</div><div className="knowledge-conversations"><div className="section-heading"><h2>Chats</h2><button type="button" className="text-button" onClick={() => { setConversationId(null); setExchanges([]); setMode("ask"); }}>New chat</button></div>{conversations.map((conversation) => <button key={conversation.id} onClick={() => void chooseConversation(conversation.id)} className={conversationId === conversation.id ? "knowledge-chat-option selected" : "knowledge-chat-option"}>{conversation.title}</button>)}</div></> : null}</aside><div className="knowledge-main">
    {selectedBase && conversationId ? <div className="knowledge-chat-management" aria-label="Saved chat controls"><span><b>Saved chat</b><small>Export includes stored answers and citations. Check them against current meeting records.</small></span><button type="button" className="button secondary" onClick={() => void exportConversation()}>Export JSON</button>{confirmDeleteConversation ? <><button type="button" className="button danger" disabled={busy} onClick={() => void deleteConversation()}>Confirm delete</button><button type="button" className="button secondary" onClick={() => setConfirmDeleteConversation(false)}>Cancel</button></> : <button type="button" className="button secondary" onClick={() => setConfirmDeleteConversation(true)}>Delete chat</button>}</div> : null}
    <form className="knowledge-query" onSubmit={(event) => void submit(event)}>
      <div className="knowledge-mode" role="group" aria-label="Knowledge mode"><button type="button" aria-pressed={mode === "search"} onClick={() => setMode("search")}><Search /> Find sources</button><button type="button" aria-pressed={mode === "ask"} onClick={() => setMode("ask")}><Sparkles /> Ask AI</button></div>
      <label htmlFor="knowledge-question">{mode === "ask" ? "Ask a question" : "Search meetings"}</label>
      <div className="knowledge-query-row"><input id="knowledge-question" value={query} onChange={(event) => setQuery(event.target.value)} minLength={3} maxLength={500} required placeholder={mode === "ask" ? "Who committed to the launch plan?" : "Try a person, decision, topic, or exact phrase"} /><button className="button primary" disabled={busy}>{busy ? "Working…" : mode === "ask" ? "Ask AI" : "Search"}</button></div>
      <label htmlFor="knowledge-tags">Limit to tags <span className="optional">optional, comma-separated</span></label>
      <input id="knowledge-tags" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} placeholder="e.g. roadmap, customer research" />
      {mode === "ask" ? <p className="field-hint">{selectedBase ? `Chat with ${selectedBase.name}. Conversations are saved; each answer retrieves fresh sources and cites transcript turns.` : "Select a named knowledge base on the left to start a saved chat."} {indexStatus?.indexed_sources ? "Hybrid lexical and semantic retrieval is available for indexed sources." : "Retrieval is lexical until this base is indexed."}</p> : null}
    </form>
    {error ? <p className="form-error knowledge-error" role="alert">{error}</p> : null}
    {notice ? <p className="field-hint" role="status">{notice}</p> : null}
    {mode === "search" && search ? <div className="knowledge-results"><div className="section-heading"><div><h2>Matching sources</h2><p>{search.count} result{search.count === 1 ? "" : "s"} · {search.retrieval_mode === "hybrid" ? "hybrid lexical + semantic" : "lexical"} retrieval{search.truncated_meeting_scope ? " · newest 200 meetings searched" : ""}</p></div></div>{search.sources.length ? <div className="knowledge-source-list">{search.sources.map((source) => <SourceCard key={source.source_id} source={source} onOpenSource={onOpenSource} />)}</div> : <div className="empty-state"><b>No matching source found.</b><p>Try a different phrase or tag. Only opted-in completed meetings are searchable.</p></div>}</div> : null}
    {mode === "ask" ? <div className="knowledge-results"><div className="section-heading"><div><h2>{conversationId ? "Saved conversation" : selectedBase ? `${selectedBase.name} wiki` : "Choose a knowledge base"}</h2><p>{conversationId ? "Answers are drafts; verify each cited source." : "Meetings, decisions, and conversations stay connected to their originals."}</p></div></div>{exchanges.length ? <div className="knowledge-chat-thread" aria-live="polite">{exchanges.map((exchange, index) => <div className="knowledge-chat-turn" key={`${index}:${exchange.question}`}><div className="knowledge-chat-user"><small>You</small><p>{exchange.question}</p></div><article className="knowledge-chat-assistant"><small>Meetings AI · {exchange.response.model ? `${exchange.response.provider} / ${exchange.response.model}` : "No matching sources"}</small><p className="knowledge-answer">{exchange.response.answer}</p>{exchange.response.citations.length ? <div className="knowledge-citations"><b>Evidence</b>{exchange.response.citations.map((source) => <SourceCard key={source.source_id} source={source} onOpenSource={onOpenSource} />)}</div> : null}</article></div>)}</div> : overview ? <WikiOverview overview={overview} onOpenMeeting={(id) => onOpenSource(id, "")} /> : <div className="empty-state"><b>Start with a question.</b><p>Select a knowledge base, then ask about a person, commitment, decision, or date.</p></div>}</div> : null}
  </div></div></section>;
}

function WikiOverview({ overview, onOpenMeeting }: { overview: KnowledgeWikiOverview; onOpenMeeting(id: string): void }) {
  return <div className="wiki-overview"><div className="wiki-overview-heading"><GitBranch /><span><b>Connected source map</b><small>{overview.meetings.length} completed meeting{overview.meetings.length === 1 ? "" : "s"} in this knowledge base</small></span></div>{overview.meetings.length ? <div className="wiki-meeting-list">{overview.meetings.map((meeting) => <article className="wiki-meeting" key={meeting.id}><div className="wiki-meeting-meta"><span>MEETING</span><time>{new Date(meeting.created_at).toLocaleDateString()}</time></div><h3>{meeting.title}</h3>{meeting.summary ? <p>{meeting.summary}</p> : <p className="wiki-muted">Approved MOM summary not available yet.</p>}{meeting.decisions.length ? <div className="wiki-facts"><b>Decisions</b><ul>{meeting.decisions.slice(0, 3).map((decision, index) => <li key={index}>{decision}</li>)}</ul></div> : null}{meeting.action_items.length ? <div className="wiki-facts"><b>Actions</b><ul>{meeting.action_items.slice(0, 3).map((action, index) => <li key={index}>{action}</li>)}</ul></div> : null}{meeting.tags.length ? <div className="knowledge-tags">{meeting.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}{meeting.related_meeting_ids.length ? <small className="wiki-related">Connected to {meeting.related_meeting_ids.length} other meeting{meeting.related_meeting_ids.length === 1 ? "" : "s"} by shared tags</small> : null}<button type="button" className="text-button" onClick={() => onOpenMeeting(meeting.id)}>Open meeting record <ArrowUpRight /></button></article>)}</div> : <div className="empty-state"><b>No connected meetings yet.</b><p>Add a completed meeting to this knowledge base to build its wiki.</p></div>}</div>;
}

function SourceCard({ source, onOpenSource }: {
  source: KnowledgeSource;
  onOpenSource(meetingId: string, segmentId: string): void;
}) {
  const dateValue = source.meeting_joined_at ?? source.meeting_created_at;
  const date = new Date(dateValue);
  const dateLabel = Number.isNaN(date.getTime()) ? dateValue : new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
  return <article className="knowledge-source"><div className="knowledge-source-meta"><span className="knowledge-kind">{source.kind}</span><span>{dateLabel}{source.meeting_joined_at ? " meeting" : " record"} date</span><span>{formatOffset(source.start_seconds)} into transcript</span><span>{source.kind === "transcript" ? "Speaker" : "Evidence speaker"}: {source.speaker ?? "Unidentified"}</span></div><h3>{source.meeting_title}</h3><p>{source.text}</p>{source.tags.length ? <div className="knowledge-tags">{source.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}<button className="text-button" type="button" onClick={() => onOpenSource(source.meeting_id, source.segment_id)}>Open cited transcript <ArrowUpRight /></button></article>;
}

function formatOffset(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}
