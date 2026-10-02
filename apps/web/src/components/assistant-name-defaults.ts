"use client";

import { api } from "@/lib/meetings-service";
import { readUiPreference } from "@/lib/ui-preferences";

type SavedName = { name: string; updatedAt: string };
const keyFor = (identity: string) => `meetings-ai:assistant-name:${identity}`;
const valid = (value: unknown): value is SavedName => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SavedName>;
  return typeof candidate.name === "string" && candidate.name.trim().length > 0 && candidate.name.length <= 100
    && typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt));
};

/** Workspace + person scoped; never reuse the name of an assistant merely shared with you. */
export async function loadAssistantName(identity: string): Promise<string> {
  const local = readUiPreference<SavedName | null>(keyFor(identity), null, (value): value is SavedName | null => valid(value));
  try {
    const saved = await api<{ assistant_name: string; updated_at: string | null }>("/v1/me/assistant-name");
    const remote = { name: saved.assistant_name, updatedAt: saved.updated_at ?? "" };
    if (valid(remote) && (!local || Date.parse(remote.updatedAt) > Date.parse(local.updatedAt))) {
      store(identity, remote);
      return remote.name;
    }
  } catch { /* Older APIs or a brief outage: retain this person's browser preference. */ }
  return local?.name ?? "Meetings AI";
}

/** Save only after creating/scheduling the meeting; cancelling the form doesn't rename anything. */
export function rememberAssistantName(identity: string, name: string): void {
  const saved = { name: name.trim(), updatedAt: new Date().toISOString() };
  if (valid(saved)) store(identity, saved);
}

function store(identity: string, value: SavedName): void {
  try { window.localStorage.setItem(keyFor(identity), JSON.stringify(value)); }
  catch { /* Names are also stored on the person's meeting records for other devices. */ }
}
