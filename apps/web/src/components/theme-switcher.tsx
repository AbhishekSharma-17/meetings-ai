"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

const noopSubscribe = () => () => {};

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const selected = hydrated ? theme ?? "system" : "system";
  return <div className="theme-switcher" role="group" aria-label="Color theme">
    <button type="button" aria-label="Light theme" aria-pressed={selected === "light"} onClick={() => setTheme("light")}><Sun /></button>
    <button type="button" aria-label="Dark theme" aria-pressed={selected === "dark"} onClick={() => setTheme("dark")}><Moon /></button>
    <button type="button" aria-label="System theme" aria-pressed={selected === "system"} onClick={() => setTheme("system")}><Monitor /></button>
  </div>;
}
