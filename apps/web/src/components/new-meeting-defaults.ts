"use client";

import { readUiPreference } from "@/lib/ui-preferences";

/**
 * Per-user recipient-team defaults for the New meeting dialog.
 * Knowledge bases are deliberately not remembered: every assistant needs an explicit choice.
 */
const teamsKey = (identity: string) => `meetings-ai:new-meeting-teams:${identity}`;
const legacyBaseKey = (identity: string) => `meetings-ai:new-meeting-knowledge-base:${identity}`;
const MAX_REMEMBERED_TEAMS = 20;

const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= MAX_REMEMBERED_TEAMS && value.every((item) => typeof item === "string" && item.length <= 64);

export type SetupDefaults = { teamIds: string[] };

export function readSetupDefaults(identity: string): SetupDefaults {
  return {
    teamIds: readUiPreference(teamsKey(identity), [] as string[], isIdList),
  };
}

export function saveSetupDefaults(identity: string, defaults: SetupDefaults): void {
  try {
    window.localStorage.setItem(teamsKey(identity), JSON.stringify(defaults.teamIds.slice(0, MAX_REMEMBERED_TEAMS)));
    window.localStorage.removeItem(legacyBaseKey(identity));
  } catch { /* Optional browser storage; the dialog works without it. */ }
}
