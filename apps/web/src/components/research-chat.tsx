"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowUpRight, ChevronDown, Globe, MessagesSquare, Plus, Quote, Trash2 } from "lucide-react";
import { researchService } from "@/lib/research-service";
import type { ResearchCitation, ResearchConversationSummary, ResearchMessage, ResearchProfile } from "@/lib/research-types";
import { AnswerText } from "./knowledge-chat";
import { ProviderName } from "./provider-brand-icons";
import { Alert, LoadingRow } from "./ui/feedback";
import { SwitchField } from "./ui/switch";
import { safeLink } from "./research-shared";

type Turn = { question: string; answer: string; citations: ResearchCitation[]; note?: string | null; webSearches?: number };

function turnsFrom(messages: ResearchMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const reply = messages[index + 1]?.role === "assistant" ? messages[index + 1] : null;
    turns.push({ question: message.content, answer: reply?.content ?? "", citations: reply?.citations ?? [] });
  }
  return turns;
}

/** Citations placed at their label's position (S3 → index 2) so answer markers resolve to the right source. */
function byLabel(citations: ResearchCitation[]): (ResearchCitation | undefined)[] {
  const slots: (ResearchCitation | undefined)[] = [];
  for (const citation of citations) {
    const position = Number(citation.id.slice(1)) - 1;
    if (Number.isInteger(position) && position >= 0 && position < 200) slots[position] = citation;
  }
  return Array.from(slots);
}

const kindLabel: Record<ResearchCitation["kind"], string> = { apollo: "Apollo", meeting: "Meeting", briefing: "Your briefing", web: "Web" };

function CitationCard({ citation, onOpenMeeting }: { citation: ResearchCitation; onOpenMeeting(id: string, segmentId?: string): void }) {
  const href = citation.kind === "web" || citation.kind === "apollo" ? safeLink(citation.url) : undefined;
  return <li className="rx-citation" id={`rx-cite-${citation.id}`}>
    <span className="citation-index" aria-hidden="true">{citation.id.slice(1)}</span>
    <div>
      <p className="rx-citation-head">{citation.kind === "apollo" ? <ProviderName brand="apollo" label="Apollo" /> : <span>{kindLabel[citation.kind]}</span>}{citation.date ? <time>{citation.date}</time> : null}</p>
      <b>{citation.title.replace(/^Apollo · /, "")}</b>
      {citation.snippet ? <p className="rx-citation-text">{citation.snippet.replace(/^Apollo structured B2B data \(retrieved [^)]*\)\. /, "")}</p> : null}
      {citation.meeting_id ? <button type="button" className="text-button" onClick={() => onOpenMeeting(citation.meeting_id as string, citation.segment_id ?? undefined)}>Open meeting <ArrowUpRight aria-hidden="true" /></button>
        : href ? <a href={href} target="_blank" rel="noopener noreferrer">Open source <ArrowUpRight aria-hidden="true" /></a> : null}
    </div>
  </li>;
}

function TurnView({ turn, onOpenMeeting }: { turn: Turn; onOpenMeeting(id: string, segmentId?: string): void }) {
  const [open, setOpen] = useState(false);
  const cite = (index: number) => { setOpen(true); requestAnimationFrame(() => document.getElementById(`rx-cite-S${index}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })); };
  return <div className="rx-turn">
    <p className="rx-question">{turn.question}</p>
    <div className="rx-answer">
      <AnswerText text={turn.answer} citations={byLabel(turn.citations)} onCite={cite} marker="S" />
      {turn.note ? <p className="field-hint">{turn.note}</p> : null}
      {turn.citations.length ? <button type="button" className={open ? "source-toggle open" : "source-toggle"} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Quote aria-hidden="true" />{turn.citations.length} source{turn.citations.length === 1 ? "" : "s"}{turn.webSearches ? ` · ${turn.webSearches} web search${turn.webSearches === 1 ? "" : "es"}` : ""}<ChevronDown aria-hidden="true" />
      </button> : null}
      {open ? <ul className="rx-citations">{turn.citations.map((citation) => <CitationCard key={citation.id} citation={citation} onOpenMeeting={onOpenMeeting} />)}</ul> : null}
    </div>
  </div>;
}

/** Ask AI about one saved profile: private, saved chats with cited answers; web search only when switched on. */
export function ResearchChat({ profile, onOpenMeeting }: { profile: ResearchProfile; onOpenMeeting(id: string, segmentId?: string): void }) {
  const [conversations, setConversations] = useState<ResearchConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [includeWeb, setIncludeWeb] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped whenever the chat on screen changes, so a slow response for an earlier chat is ignored.
  const view = useRef(0);
  const showChat = (id: string | null, next: Turn[]) => { view.current += 1; setConversationId(id); setTurns(next); };

  const loadList = useCallback(() => {
    void researchService.conversations(profile.id).then(setConversations).catch(() => setConversations([]));
  }, [profile.id]);
  useEffect(() => { loadList(); }, [loadList]);

  async function open(id: string) {
    const requested = ++view.current;
    setLoading(true); setError(null);
    try {
      const conversation = await researchService.conversation(profile.id, id);
      if (requested !== view.current) return;
      setConversationId(id); setTurns(turnsFrom(conversation.messages));
    } catch { if (requested === view.current) setError("That chat couldn't be opened."); }
    finally { if (requested === view.current) setLoading(false); }
  }

  async function remove(id: string) {
    try {
      await researchService.deleteConversation(profile.id, id);
      if (conversationId === id) showChat(null, []);
      loadList();
    } catch { setError("That chat couldn't be deleted. Try again."); }
  }

  async function ask(event?: FormEvent) {
    event?.preventDefault();
    const text = question.trim();
    if (text.length < 3 || pending) return;
    const askedIn = view.current;
    setPending(text); setQuestion(""); setError(null);
    try {
      const response = await researchService.ask(profile.id, text, conversationId, includeWeb);
      if (!conversationId) loadList();
      // Another chat was opened meanwhile: the answer is saved in its own chat; don't show it here.
      if (askedIn !== view.current) return;
      setTurns((current) => [...current, { question: text, answer: response.answer, citations: response.citations, note: response.note, webSearches: response.web_searches }]);
      setConversationId(response.conversation_id);
    } catch (cause) {
      setQuestion(text);
      setError(cause instanceof Error ? cause.message : "Ask AI couldn't answer. Try again.");
    } finally { setPending(null); }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); }
  };
  const suggestions = profile.kind === "company"
    ? ["What should I know before our next call?", "What are they hiring for right now?", "What have we discussed with them before?"]
    : ["What does this person care about?", "What have they said in our meetings?", "How long have they been in this role?"];

  return <section className="card rx-chat" aria-labelledby="rx-chat-title">
    <div className="card-header">
      <div><h2 id="rx-chat-title"><MessagesSquare aria-hidden="true" /> Ask AI</h2><p>Answers use the saved profile and meetings you can open. Only you see these chats.</p></div>
      {conversationId ? <button type="button" className="button ghost sm" onClick={() => showChat(null, [])}><Plus aria-hidden="true" />New chat</button> : null}
    </div>
    <div className="card-body rx-chat-body">
      {conversations.length ? <details className="rx-chat-history"><summary>Your chats ({conversations.length})</summary>
        <ul>{conversations.map((item) => <li key={item.id}>
          <button type="button" className="text-button" aria-current={item.id === conversationId ? "true" : undefined} onClick={() => void open(item.id)}>{item.title}</button>
          <button type="button" className="icon-button sm" aria-label={`Delete chat “${item.title}”`} onClick={() => void remove(item.id)}><Trash2 /></button>
        </li>)}</ul>
      </details> : null}
      {loading ? <LoadingRow>Opening chat…</LoadingRow> : null}
      {turns.length || pending ? <div className="rx-turns" aria-live="polite">
        {turns.map((turn, index) => <TurnView key={index} turn={turn} onOpenMeeting={onOpenMeeting} />)}
        {pending ? <div className="rx-turn"><p className="rx-question">{pending}</p><p className="thinking"><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>{includeWeb ? "Reading saved data and searching the web…" : "Reading saved data…"}</p></div> : null}
      </div> : !loading ? <div className="rx-prompts">{suggestions.map((item) => <button key={item} type="button" className="prompt-card" onClick={() => setQuestion(item)}>{item}</button>)}</div> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form className="rx-composer" onSubmit={(event) => void ask(event)}>
        <label className="sr-only" htmlFor="rx-question">Ask about {profile.name}</label>
        <textarea id="rx-question" rows={2} maxLength={800} value={question} placeholder={`Ask about ${profile.name}…`} onChange={(event) => setQuestion(event.target.value)} onKeyDown={onKeyDown} />
        <div className="rx-composer-bar">
          <SwitchField id="rx-include-web" label={<><Globe aria-hidden="true" className="rx-inline-icon" /> Include web search</>} checked={includeWeb} onChange={setIncludeWeb} />
          <button className="button primary icon" aria-label="Ask" disabled={Boolean(pending) || question.trim().length < 3}>{pending ? <span className="spinner on-brand" aria-hidden="true" /> : <ArrowUp />}</button>
        </div>
        <p className="composer-note">Answers can be wrong. Check the cited sources before relying on them.</p>
      </form>
    </div>
  </section>;
}
