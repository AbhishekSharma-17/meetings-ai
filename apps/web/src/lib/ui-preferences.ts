"use client";

import { useLayoutEffect, useState } from "react";

type StorageKind = "local" | "session";

function storage(kind: StorageKind): Storage | null {
  if (typeof window === "undefined") return null;
  try { return kind === "local" ? window.localStorage : window.sessionStorage; }
  catch { return null; }
}

export function readUiPreference<T>(key: string, fallback: T, validate: (value: unknown) => value is T, kind: StorageKind = "local"): T {
  try {
    const raw = storage(kind)?.getItem(key);
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    return validate(value) ? value : fallback;
  } catch { return fallback; }
}

export function useUiPreference<T>(key: string, fallback: T, validate: (value: unknown) => value is T, kind: StorageKind = "local") {
  // The owning screen is keyed by organization and user. This hook only stores
  // harmless view preferences; credentials and unsent content never belong here.
  const [value, setValue] = useState<T>(() => readUiPreference(key, fallback, validate, kind));
  useLayoutEffect(() => {
    try { storage(kind)?.setItem(key, JSON.stringify(value)); } catch { /* Optional browser storage. */ }
  }, [key, kind, value]);
  return [value, setValue] as const;
}
