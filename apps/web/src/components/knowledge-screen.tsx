"use client";

import { FormEvent, useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { meetingsService } from "@/lib/meetings-service";
import { useUiPreference } from "@/lib/ui-preferences";
import { UiSelect } from "./ui-select";
import type { CurrentAccount, KnowledgeBase, KnowledgeChatResponse, KnowledgeConversation, KnowledgeIndexStatus, KnowledgeMap, KnowledgeSearchResponse, KnowledgeSource, KnowledgeTextProfile, KnowledgeWikiOverview, ProviderProfile, TextModelCatalog, WorkspaceMember } from "@/lib/types";
import { ArrowUpRight, BookOpenText, GitBranch, Plus, Search, Sparkles, MessageCircle, Send, ShieldCheck, X } from "lucide-react";

type Exchange = { question: string; response: KnowledgeChatResponse };
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const isMode = (value: unknown): value is "search" | "ask" | "wiki" => value === "search" || value === "ask" || value === "wiki";

function conversationExchanges(conversation: Awaited<ReturnType<typeof meetingsService.getKnowledgeConversation>>): Exchange[] {
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

export function KnowledgeScreen({ identity, onOpenSource, account }: {
  identity: string;
  account: CurrentAccount | null;
  onOpenSource(meetingId: string, segmentId: string): void;
}) {
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [mode, setMode] = useUiPreference(`meetings-ai:knowledge-mode:${identity}`, "ask" as "search" | "ask" | "wiki", isMode);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useUiPreference(`meetings-ai:knowledge-base:${identity}`, "", isString);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [textProfiles, setTextProfiles] = useState<KnowledgeTextProfile[]>([]);
  const [chatProfileId, setChatProfileId] = useUiPreference(`meetings-ai:knowledge-profile:${identity}`, "", isString);
  const [modelCatalog, setModelCatalog] = useState<TextModelCatalog | null>(null);
  const [selectedModelId, setSelectedModelId] = useUiPreference(`meetings-ai:knowledge-model:${identity}`, "", isString);
  const [modelFilter, setModelFilter] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [shareVisibility, setShareVisibility] = useState<"private" | "organization" | "specific">("private");
  const [shareUserIds, setShareUserIds] = useState<string[]>([]);
  const [sharingOpen, setSharingOpen] = useState(false);
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
  const [pending, setPending] = useState<{ question: string; raw: string; answer: string } | null>(null);
  const [confirmDeleteConversation, setConfirmDeleteConversation] = useState(false);
  const [confirmDeleteBase, setConfirmDeleteBase] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedBase = bases.find((item) => item.id === selectedBaseId);
  const effectiveProfileId = textProfiles.some((profile) => profile.id === chatProfileId) ? chatProfileId : selectedBase?.text_profile_id || textProfiles[0]?.id || "";
  const selectedModel = modelCatalog?.models.find((item) => item.id === selectedModelId);
  const canManageBase = selectedBase && (account?.role === "owner" || account?.role === "admin" || selectedBase.created_by === account?.user_id);

  useEffect(() => {
    void meetingsService.listKnowledgeBases().then((items) => {
      setBases(items);
      setSelectedBaseId((current) => {
        if (current && items.some((item) => item.id === current)) return current;
        return items[0]?.id ?? "";
      });
      const chosen = items.find((item) => item.id === selectedBaseId) ?? items[0];
      if (chosen) { setShareVisibility(chosen.visibility); setShareUserIds(chosen.shared_user_ids); }
    }).catch(() => setError("Could not load knowledge bases."));
    if (account?.role === "owner" || account?.role === "admin") {
      void meetingsService.listProviderProfiles().then(setProfiles).catch(() => undefined);
    }
    void meetingsService.listKnowledgeTextProfiles().then((items) => {
      setTextProfiles(items);
      setChatProfileId((current) => current && !items.some((item) => item.id === current) ? "" : current);
    }).catch(() => setModelError("Could not load text providers."));
    void meetingsService.listWorkspaceMembers().then(setMembers).catch(() => undefined);
  }, [account, selectedBaseId, setChatProfileId, setSelectedBaseId]);

  useEffect(() => {
    if (!selectedBaseId) return;
    let active = true;
    void meetingsService.listKnowledgeConversations(selectedBaseId).then((items) => {
      if (!active) return;
      setConversations(items);
      if (conversationId) {
        if (items.some((item) => item.id === conversationId)) {
          void meetingsService.getKnowledgeConversation(selectedBaseId, conversationId)
            .then((conversation) => { if (active) setExchanges(conversationExchanges(conversation)); })
            .catch(() => { if (active) { setConversationId(null); setExchanges([]); } });
        } else { setConversationId(null); setExchanges([]); }
      }
    }).catch(() => { if (active) setError("Could not load conversations."); });
    void meetingsService.getKnowledgeOverview(selectedBaseId).then(setOverview).catch(() => setOverview(null));
    void meetingsService.getKnowledgeMap(selectedBaseId).then(setEvidenceMap).catch(() => setEvidenceMap(null));
    void meetingsService.getKnowledgeIndex(selectedBaseId).then(setIndexStatus).catch(() => setIndexStatus(null));
    return () => { active = false; };
  }, [selectedBaseId, conversationId, setConversationId]);

  useEffect(() => {
    if (!effectiveProfileId) return;
    let active = true;
    queueMicrotask(() => { if (active) { setModelCatalog(null); setModelError(null); } });
    void meetingsService.listKnowledgeModels(effectiveProfileId).then((catalog) => {
      if (!active) return;
      setModelCatalog(catalog);
      // A cost-conscious default for OpenAI, without changing the saved workspace MOM route.
      setSelectedModelId((current) => catalog.models.some((item) => item.id === current) ? current : catalog.provider === "openai" && catalog.models.some((item) => item.id === "gpt-6-luna") ? "gpt-6-luna" : catalog.configured_model);
    }).catch((cause) => { if (active) setModelError(cause instanceof Error ? cause.message : "Could not load the model catalog."); });
    return () => { active = false; };
  }, [effectiveProfileId, setSelectedModelId]);

  useEffect(() => {
    if (!selectedBaseId) return;
    const timer = window.setInterval(() => {
      void meetingsService.getKnowledgeIndex(selectedBaseId).then(setIndexStatus).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [selectedBaseId]);

  function chooseBase(id: string, baseOverride?: KnowledgeBase) {
    if (id === selectedBaseId) return;
    setSelectedBaseId(id); setSearch(null); setOverview(null); setEvidenceMap(null); setIndexStatus(null); setExchanges([]); setConversations([]); setConversationId(null); setError(null);
    setConfirmDeleteConversation(false); setConfirmDeleteBase(false); setNotice(null);
    const base = baseOverride ?? bases.find((item) => item.id === id);
    setShareVisibility(base?.visibility ?? "private");
    setShareUserIds(base?.shared_user_ids ?? []);
    setChatProfileId(""); setModelFilter(""); setModelPickerOpen(false);
  }

  async function createBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setCreatingBase(true); setError(null);
    try {
      const created = await meetingsService.createKnowledgeBase(newBaseName.trim());
      setBases((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewBaseName(""); chooseBase(created.id, created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create knowledge base.");
    } finally { setCreatingBase(false); }
  }

  async function chooseConversation(id: string) {
    if (!selectedBaseId) return;
    setBusy(true); setError(null);
    try {
      const conversation = await meetingsService.getKnowledgeConversation(selectedBaseId, id);
      setExchanges(conversationExchanges(conversation)); setConversationId(id); setMode("ask"); setConfirmDeleteConversation(false); setNotice(null);
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
    setError(null); setBusy(true);
    try {
      if (shareVisibility === "specific" && shareUserIds.length === 0) {
        throw new Error("Select at least one teammate for specific-person sharing.");
      }
      const updated = await meetingsService.shareKnowledgeBase(selectedBaseId, shareVisibility, shareUserIds);
      setBases((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(`Sharing saved for ${updated.name}.`);
      setSharingOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update sharing.");
    } finally { setBusy(false); }
  }

  function openSharing() {
    if (!selectedBase) return;
    setShareVisibility(selectedBase.visibility);
    setShareUserIds(selectedBase.shared_user_ids);
    setError(null);
    setSharingOpen(true);
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
        setPending({ question, raw: "", answer: "" });
        setQuery("");
        let raw = "";
        const response = await meetingsService.streamKnowledgeChat(question, tags, selectedBaseId, conversationId, effectiveProfileId || null, selectedModelId || null, (delta) => {
          raw += delta;
          const answer = streamedAnswer(raw);
          setPending({ question, raw, answer });
        });
        setExchanges((current) => [...current, { question, response }]);
        setConversationId(response.conversation_id);
        void meetingsService.listKnowledgeConversations(selectedBaseId).then(setConversations).catch(() => undefined);
        setQuery("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The knowledge request failed.");
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  return <><section className="page knowledge-page" aria-labelledby="knowledge-title">
    <div className="knowledge-hero"><p className="eyebrow">CONNECTED KNOWLEDGE</p><h1 id="knowledge-title">Your meeting wiki.</h1><p className="intro">Explore connected meetings, approved decisions, and transcript evidence. Ask questions across a knowledge base and follow every answer back to its source.</p></div>
    <div className="knowledge-policy" role="note"><b>Grounded in meeting records.</b> Only completed meetings marked “Add to AI knowledge” appear here. Approved MOM facts are linked to the meeting; individual answers cite timestamped transcript turns. Review speaker names before relying on attribution.</div>
    <div className="knowledge-layout"><aside className="knowledge-library" aria-label="Knowledge bases"><div className="section-heading"><div><h2>Knowledge bases</h2><p>One client or project per base</p></div></div>{account?.role === "owner" || account?.role === "admin" ? <button className={!selectedBaseId ? "knowledge-base-option selected" : "knowledge-base-option"} onClick={() => chooseBase("")}><BookOpenText /> All opted-in meetings</button> : null}{bases.map((base) => <button key={base.id} className={selectedBaseId === base.id ? "knowledge-base-option selected" : "knowledge-base-option"} onClick={() => chooseBase(base.id)}><span><b>{base.name}</b><small>{base.meeting_count} meeting{base.meeting_count === 1 ? "" : "s"} · {base.visibility}</small></span></button>)}<form className="knowledge-create" onSubmit={(event) => void createBase(event)}><label htmlFor="knowledge-base-new">Create a knowledge base</label><div><input id="knowledge-base-new" value={newBaseName} onChange={(event) => setNewBaseName(event.target.value)} minLength={2} maxLength={120} required placeholder="e.g. Acme client" /><button type="submit" className="button secondary" disabled={creatingBase} aria-label="Create knowledge base"><Plus /></button></div></form>{selectedBase ? <>{canManageBase && (account?.role === "owner" || account?.role === "admin") ? <><label className="knowledge-model-label" htmlFor="knowledge-model">Ask AI model for {selectedBase.name}</label><select id="knowledge-model" value={selectedBase.text_profile_id ?? ""} onChange={(event) => void setTextProfile(event.target.value)}><option value="">Workspace text-generation default</option>{profiles.filter((profile) => profile.capabilities.includes("text_generation") && !profile.id.startsWith("new-")).map((profile) => <option value={profile.id} key={profile.id}>{profile.label} · {profile.model}</option>)}</select><p className="field-hint">Configure credentials in AI providers. Base-specific selection does not change MOM or transcription models.</p></> : null}{canManageBase ? <div className="knowledge-sharing"><label htmlFor="knowledge-visibility">Share this base</label><select id="knowledge-visibility" value={shareVisibility} onChange={(event) => setShareVisibility(event.target.value as "private" | "organization" | "specific")}><option value="private">Private to creator and admins</option><option value="organization">Everyone in organization</option><option value="specific">Specific teammates</option></select>{shareVisibility === "specific" ? <div className="knowledge-share-members">{members.filter((member) => member.user_id !== account?.user_id).map((member) => <label key={member.user_id}><input type="checkbox" checked={shareUserIds.includes(member.user_id)} onChange={(event) => setShareUserIds((current) => event.target.checked ? [...current, member.user_id] : current.filter((id) => id !== member.user_id))} /> {member.display_name} <small>{member.email}</small></label>)}</div> : null}<button type="button" className="button secondary" onClick={() => void saveSharing()}>Save sharing</button></div> : null}<div className="knowledge-index"><b>Semantic index</b><small>{indexStatus?.indexed_sources ? `${indexStatus.indexed_sources} source${indexStatus.indexed_sources === 1 ? "" : "s"} indexed · ${indexStatus.model ?? "embedding model"}` : "No sources indexed yet"}</small><p>Search checks indexed hits against live meeting records. Completed meeting changes queue a background refresh.</p>{indexStatus?.job_status ? <p role="status">Background index: {indexStatus.job_status}{indexStatus.next_retry_at ? ` · retry ${new Date(indexStatus.next_retry_at).toLocaleString()}` : ""}</p> : null}{indexStatus?.last_error ? <p className="form-error" role="alert">{indexStatus.last_error}</p> : null}{canManageBase ? <button type="button" className="button secondary" disabled={indexing} onClick={() => void reindexBase()}>{indexing ? "Indexing…" : "Reindex now"}</button> : null}</div><div className="knowledge-conversations"><div className="section-heading"><h2>Chats</h2><button type="button" className="text-button" onClick={() => { setConversationId(null); setExchanges([]); setMode("ask"); }}>New chat</button></div>{conversations.map((conversation) => <button key={conversation.id} onClick={() => void chooseConversation(conversation.id)} className={conversationId === conversation.id ? "knowledge-chat-option selected" : "knowledge-chat-option"}>{conversation.title}</button>)}</div></> : null}</aside><div className="knowledge-main">
    {selectedBase && canManageBase ? <div className="knowledge-base-management" aria-label="Knowledge base controls"><span><b>{selectedBase.name}</b><small>{selectedBase.visibility === "organization" ? "Shared with everyone in this organization" : selectedBase.visibility === "specific" ? `Shared with ${selectedBase.shared_user_ids.length} selected teammate${selectedBase.shared_user_ids.length === 1 ? "" : "s"}` : "Private to the creator and workspace admins"}</small></span><button type="button" className="button secondary" onClick={openSharing}><ShieldCheck size={15} /> Manage sharing</button>{confirmDeleteBase ? <><button type="button" className="button danger" disabled={busy} onClick={() => void deleteBase()}>Confirm delete base</button><button type="button" className="button secondary" onClick={() => setConfirmDeleteBase(false)}>Cancel</button></> : <button type="button" className="button secondary" onClick={() => setConfirmDeleteBase(true)}>Delete knowledge base</button>}</div> : null}
    {selectedBase && canManageBase && (account?.role === "owner" || account?.role === "admin") ? <div className="knowledge-base-model-bar"><UiSelect id="knowledge-base-model" label="Default Ask AI provider for this base" value={selectedBase.text_profile_id ?? ""} onChange={(value) => void setTextProfile(value)} options={[{ value: "", label: "Workspace text-generation default" }, ...profiles.filter((profile) => profile.capabilities.includes("text_generation") && !profile.id.startsWith("new-")).map((profile) => ({ value: profile.id, label: `${profile.label} · ${profile.model}` }))]} /></div> : null}
    {selectedBase && conversationId ? <div className="knowledge-chat-management" aria-label="Saved chat controls"><span><b>Saved chat</b><small>Export includes stored answers and citations. Check them against current meeting records.</small></span><button type="button" className="button secondary" onClick={() => void exportConversation()}>Export JSON</button>{confirmDeleteConversation ? <><button type="button" className="button danger" disabled={busy} onClick={() => void deleteConversation()}>Confirm delete</button><button type="button" className="button secondary" onClick={() => setConfirmDeleteConversation(false)}>Cancel</button></> : <button type="button" className="button secondary" onClick={() => setConfirmDeleteConversation(true)}>Delete chat</button>}</div> : null}
    <div className="knowledge-mode" role="group" aria-label="Knowledge mode"><button type="button" aria-pressed={mode === "search"} onClick={() => setMode("search")}><Search /> Sources</button><button type="button" aria-pressed={mode === "ask"} onClick={() => setMode("ask")}><MessageCircle /> Ask AI</button><button type="button" aria-pressed={mode === "wiki"} onClick={() => setMode("wiki")}><BookOpenText /> Wiki</button></div>
    <form className="knowledge-query" onSubmit={(event) => void submit(event)}>
      {mode !== "wiki" ? <>
        {mode === "ask" ? <details className="knowledge-chat-settings"><summary>Model · {selectedModel?.name ?? modelCatalog?.configured_model ?? "Choose a model"}</summary><div className="knowledge-chat-settings-grid"><UiSelect id="chat-provider" label="Chat provider" value={effectiveProfileId} onChange={(value) => { setChatProfileId(value); setSelectedModelId(""); }} options={textProfiles.map((profile) => ({ value: profile.id, label: `${profile.name}${profile.base_url?.includes("openrouter.ai") ? " · OpenRouter" : profile.provider_type === "openai" ? " · OpenAI" : " · Compatible"}` }))} disabled={!textProfiles.length} /><div className="knowledge-model-picker"><label htmlFor="chat-model-search">Model</label><input id="chat-model-search" value={modelPickerOpen ? modelFilter : selectedModel?.name ?? modelCatalog?.configured_model ?? "Loading models…"} onFocus={() => { setModelPickerOpen(true); setModelFilter(""); }} onChange={(event) => { setModelFilter(event.target.value); setModelPickerOpen(true); }} autoComplete="off" placeholder="Search available models" disabled={!modelCatalog} />{modelPickerOpen && modelCatalog ? <div className="knowledge-model-options" role="listbox" aria-label="Available models">{modelCatalog.models.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(modelFilter.toLowerCase())).slice(0, 40).map((item) => <button type="button" role="option" aria-selected={item.id === selectedModelId} key={item.id} onClick={() => { setSelectedModelId(item.id); setModelPickerOpen(false); setModelFilter(""); }}><span><b>{item.name}</b><small>{item.id}</small></span>{item.input_per_million_usd !== null ? <small>${item.input_per_million_usd}/M in · ${item.output_per_million_usd}/M out</small> : null}</button>)}<button type="button" className="knowledge-model-close" onClick={() => setModelPickerOpen(false)}>Close model list</button></div> : null}</div>{modelError ? <small className="form-error">{modelError}</small> : <small className="field-hint">{modelCatalog?.live_catalog ? `${modelCatalog.models.length} live models available. Prices, if shown, are provider list rates.` : "Using this provider’s saved model."}</small>}</div></details> : null}
        <label htmlFor="knowledge-question">{mode === "ask" ? "Message your knowledge base" : "Search meetings"}</label>
        <div className="knowledge-query-row"><input id="knowledge-question" value={query} onChange={(event) => setQuery(event.target.value)} minLength={3} maxLength={500} required placeholder={mode === "ask" ? "Ask about a decision, person, date, or follow-up…" : "Try a person, decision, topic, or exact phrase"} /><button className="button primary" disabled={busy || (mode === "ask" && !selectedBaseId)}>{busy ? "Working…" : mode === "ask" ? <><Send size={16} /> Send</> : "Search"}</button></div>
        <details className="knowledge-chat-filters"><summary>Filter by tags (optional)</summary><input id="knowledge-tags" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} placeholder="e.g. roadmap, customer research" /></details>
        {mode === "ask" ? <p className="field-hint">{selectedBase ? `Chat memory is saved in ${selectedBase.name}; answers retrieve fresh, cited evidence.` : "Select a named knowledge base to start a saved chat."} {indexStatus?.indexed_sources ? "Hybrid keyword + semantic retrieval enabled." : "Keyword retrieval until this base is indexed."}</p> : null}
      </> : <p className="field-hint">Browse connected meetings, approved MOMs, people, and topics below.</p>}
    </form>
    {error ? <p className="form-error knowledge-error" role="alert">{error}</p> : null}
    {notice ? <p className="field-hint" role="status">{notice}</p> : null}
    {mode === "search" && search ? <div className="knowledge-results"><div className="section-heading"><div><h2>Matching sources</h2><p>{search.count} result{search.count === 1 ? "" : "s"} · {search.retrieval_mode === "hybrid" ? "hybrid lexical + semantic" : "lexical"} retrieval{search.truncated_meeting_scope ? " · newest 200 meetings searched" : ""}</p></div></div>{search.sources.length ? <div className="knowledge-source-list">{search.sources.map((source) => <SourceCard key={source.source_id} source={source} onOpenSource={onOpenSource} />)}</div> : <div className="empty-state"><b>No matching source found.</b><p>Try a different phrase or tag. Only opted-in completed meetings are searchable.</p></div>}</div> : null}
    {mode === "ask" ? <div className="knowledge-results knowledge-chat-panel"><div className="section-heading"><div><h2>{selectedBase ? `Ask ${selectedBase.name}` : "Choose a knowledge base"}</h2><p>Searches the selected base on every turn. Saved conversation history helps resolve follow-up questions.</p></div></div>{exchanges.length ? <div className="knowledge-chat-thread" aria-live="polite">{exchanges.map((exchange, index) => <div className="knowledge-chat-turn" key={`${index}:${exchange.question}`}><div className="knowledge-chat-user"><small>You</small><p>{exchange.question}</p></div><article className="knowledge-chat-assistant"><small>Meetings AI · {exchange.response.model ? `${exchange.response.provider} / ${exchange.response.model}` : "No matching sources"}</small><p className="knowledge-answer">{exchange.response.answer}</p>{exchange.response.citations.length ? <details className="knowledge-citations"><summary>{exchange.response.citations.length} cited source{exchange.response.citations.length === 1 ? "" : "s"} · open transcript</summary>{exchange.response.citations.map((source) => <SourceCard key={source.source_id} source={source} onOpenSource={onOpenSource} />)}</details> : null}</article></div>)}</div> : <div className="knowledge-chat-empty"><Sparkles /><h3>Start a conversation</h3><p>Ask what was decided, who committed to an action, or how a topic evolved across meetings. Each answer links back to a timestamped source.</p></div>}</div> : null}
    {mode === "ask" && pending ? <div className="knowledge-chat-thread knowledge-streaming" aria-live="polite" aria-busy="true"><div className="knowledge-chat-turn"><div className="knowledge-chat-user"><small>You</small><p>{pending.question}</p></div><article className="knowledge-chat-assistant"><small>Meetings AI · answering live</small><p className="knowledge-answer">{pending.answer || "Finding relevant meeting evidence…"}<span className="knowledge-stream-cursor" aria-hidden="true" /></p><small>Citations will appear after the answer is verified.</small></article></div></div> : null}
    {mode === "wiki" ? <div className="knowledge-results"><div className="section-heading"><div><h2>{selectedBase ? `${selectedBase.name} wiki` : "Choose a knowledge base"}</h2><p>Meetings, decisions, and conversations stay connected to their originals.</p></div></div>{overview ? <><WikiOverview overview={overview} onOpenMeeting={(id) => onOpenSource(id, "")} />{evidenceMap ? <EvidenceMap map={evidenceMap} onOpenSource={onOpenSource} /> : null}</> : <div className="empty-state"><b>No wiki to show yet.</b><p>Select a knowledge base with completed meetings.</p></div>}</div> : null}
  </div></div></section><Dialog.Root open={sharingOpen} onOpenChange={setSharingOpen}><Dialog.Portal><Dialog.Backdrop className="dialog-backdrop" /><Dialog.Popup className="dialog knowledge-sharing-dialog"><Dialog.Close className="close-button" aria-label="Close sharing"><X /></Dialog.Close><Dialog.Title>Share {selectedBase?.name}</Dialog.Title><Dialog.Description className="dialog-intro">Choose who can browse and ask questions about this knowledge base.</Dialog.Description><fieldset><legend>Access</legend><label><input type="radio" name="sharing" checked={shareVisibility === "private"} onChange={() => setShareVisibility("private")} /> Private to creator and admins</label><label><input type="radio" name="sharing" checked={shareVisibility === "organization"} onChange={() => setShareVisibility("organization")} /> Everyone in this organization</label><label><input type="radio" name="sharing" checked={shareVisibility === "specific"} onChange={() => setShareVisibility("specific")} /> Specific teammates</label></fieldset>{shareVisibility === "specific" ? <div className="knowledge-share-members">{members.filter((member) => member.user_id !== account?.user_id).map((member) => <label key={member.user_id}><input type="checkbox" checked={shareUserIds.includes(member.user_id)} onChange={(event) => setShareUserIds((current) => event.target.checked ? [...current, member.user_id] : current.filter((id) => id !== member.user_id))} /> <span>{member.display_name}<small>{member.email}</small></span></label>)}</div> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}<div className="knowledge-sharing-actions"><button type="button" className="button secondary" onClick={() => setSharingOpen(false)}>Cancel</button><button type="button" className="button primary" disabled={busy} onClick={() => void saveSharing()}>Save sharing</button></div></Dialog.Popup></Dialog.Portal></Dialog.Root></>;
}

function WikiOverview({ overview, onOpenMeeting }: { overview: KnowledgeWikiOverview; onOpenMeeting(id: string): void }) {
  return <div className="wiki-overview"><div className="wiki-overview-heading"><GitBranch /><span><b>Connected source map</b><small>{overview.meetings.length} completed meeting{overview.meetings.length === 1 ? "" : "s"} in this knowledge base</small></span></div>{overview.meetings.length ? <div className="wiki-meeting-list">{overview.meetings.map((meeting) => <article className="wiki-meeting" key={meeting.id}><div className="wiki-meeting-meta"><span>MEETING</span><time>{new Date(meeting.created_at).toLocaleDateString()}</time></div><h3>{meeting.title}</h3>{meeting.summary ? <p>{meeting.summary}</p> : <p className="wiki-muted">Approved MOM summary not available yet.</p>}{meeting.decisions.length ? <div className="wiki-facts"><b>Decisions</b><ul>{meeting.decisions.slice(0, 3).map((decision, index) => <li key={index}>{decision}</li>)}</ul></div> : null}{meeting.action_items.length ? <div className="wiki-facts"><b>Actions</b><ul>{meeting.action_items.slice(0, 3).map((action, index) => <li key={index}>{action}</li>)}</ul></div> : null}{meeting.tags.length ? <div className="knowledge-tags">{meeting.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}{meeting.related_meetings?.length ? <div className="wiki-related-links"><b>Connected meetings</b>{meeting.related_meetings.map((link) => <button type="button" key={link.meeting_id} onClick={() => onOpenMeeting(link.meeting_id)}><span>{link.title}</span><small>{link.reasons.join(" · ")}</small></button>)}</div> : null}<button type="button" className="text-button" onClick={() => onOpenMeeting(meeting.id)}>Open meeting record <ArrowUpRight /></button></article>)}</div> : <div className="empty-state"><b>No connected meetings yet.</b><p>Add a completed meeting to this knowledge base to build its wiki.</p></div>}</div>;
}

function EvidenceMap({ map, onOpenSource }: { map: KnowledgeMap; onOpenSource(meetingId: string, segmentId: string): void }) {
  return <section className="knowledge-evidence-map" aria-label="Evidence map"><div className="section-heading"><div><h2>People & topics</h2><p>Literal tags and speaker labels linked to timestamped source turns.</p></div></div><p className="field-hint">Speaker labels are not verified identities unless an email was explicitly confirmed. The same unverified name in two meetings is kept separate.</p>{map.truncated_meeting_scope ? <p className="field-hint">This map covers the newest 200 eligible meetings.</p> : null}<div className="knowledge-map-columns"><div><h3>Topics</h3>{map.topics.length ? map.topics.map((item) => <details key={item.key} className="knowledge-map-entry"><summary><b>#{item.label}</b><small>{item.meeting_count} meeting{item.meeting_count === 1 ? "" : "s"} · {item.source_count} source{item.source_count === 1 ? "" : "s"}</small></summary><div className="knowledge-map-sources">{item.sources.map((source) => <SourceCard key={source.source_id} source={source} onOpenSource={onOpenSource} />)}</div></details>) : <p className="field-hint">No tags on eligible meetings yet.</p>}</div><div><h3>Speaker labels</h3>{map.speaker_labels.length ? map.speaker_labels.map((item) => <details key={item.key} className="knowledge-map-entry"><summary><b>{item.label}</b><small>{item.verified_identity ? `Confirmed email · ${item.email}` : "Unverified label"} · {item.meeting_count} meeting{item.meeting_count === 1 ? "" : "s"}</small></summary><div className="knowledge-map-sources">{item.sources.map((source) => <SourceCard key={source.source_id} source={source} onOpenSource={onOpenSource} />)}</div></details>) : <p className="field-hint">No named speaker turns yet.</p>}</div></div></section>;
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
