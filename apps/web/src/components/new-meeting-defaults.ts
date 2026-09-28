"use client";

import { readUiPreference } from "@/lib/ui-preferences";

/**
 * Per-user set-up defaults for the New meeting dialog: the teams and knowledge base used last time.
 * Keyed by organization and user like every other UI preference; ids only, never content. A
 * remembered knowledge base is preselected but never switches AI knowledge on by itself.
 */
const teamsKey = (identity: string) => `meetings-ai:new-meeting-teams:${identity}`;
const baseKey = (identity: string) => `meetings-ai:new-meeting-knowledge-base:${identity}`;
const MAX_REMEMBERED_TEAMS = 20;

const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= MAX_REMEMBERED_TEAMS && value.every((item) => typeof item === "string" && item.length <= 64);
const isId = (value: unknown): value is string => typeof value === "string" && value.length <= 64;

export type SetupDefaults = { teamIds: string[]; knowledgeBaseId: string };

export function readSetupDefaults(identity: string): SetupDefaults {
  return {
    teamIds: readUiPreference(teamsKey(identity), [] as string[], isIdList),
    knowledgeBaseId: readUiPreference(baseKey(identity), "", isId),
  };
}

export function saveSetupDefaults(identity: string, defaults: SetupDefaults): void {
  try {
    window.localStorage.setItem(teamsKey(identity), JSON.stringify(defaults.teamIds.slice(0, MAX_REMEMBERED_TEAMS)));
    window.localStorage.setItem(baseKey(identity), JSON.stringify(defaults.knowledgeBaseId));
  } catch { /* Optional browser storage; the dialog works without it. */ }
}
