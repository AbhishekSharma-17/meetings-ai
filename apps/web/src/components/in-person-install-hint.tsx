"use client";

import { useEffect, useState } from "react";
import { MonitorSmartphone, X } from "lucide-react";
import { canPromptInstall, dismissInstallHint, installHintDismissed, onInstallAvailabilityChange, promptInstall } from "@/lib/in-person-install";
import { isAppleMobile, isHandheld, isStandalone } from "@/lib/in-person-media";

/** A small, dismissible "Add to home screen" tip for phones, shown on the recorder's setup screen. */
export function InPersonInstallHint() {
  const [visible, setVisible] = useState(false);
  const [installable, setInstallable] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      setVisible(isHandheld() && !isStandalone() && !installHintDismissed());
      setInstallable(canPromptInstall());
    });
    return onInstallAvailabilityChange(() => setInstallable(canPromptInstall()));
  }, []);

  if (!visible) return null;
  const dismiss = () => { dismissInstallHint(); setVisible(false); };
  const install = async () => { if (await promptInstall()) dismiss(); };
  const how = isAppleMobile()
    ? "In Safari, tap Share, then Add to Home Screen. Recording from the home screen app keeps the screen steadier."
    : installable ? "Install Meetings AI to open the recorder in one tap."
      : "Open the browser menu and choose Install app or Add to home screen.";
  return <aside className="ip-install" aria-label="Add Meetings AI to your home screen">
    <MonitorSmartphone aria-hidden="true" />
    <p><b>Add to your home screen</b><span>{how}</span></p>
    {installable && !isAppleMobile() ? <button type="button" className="button secondary sm" onClick={() => void install()}>Install app</button> : null}
    <button type="button" className="icon-button sm" aria-label="Dismiss home screen tip" onClick={dismiss}><X aria-hidden="true" /></button>
  </aside>;
}
