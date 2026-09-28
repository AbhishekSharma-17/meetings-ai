"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { formatTime } from "@/lib/time-store";
import type { InviteResult } from "@/lib/types";
import { Alert } from "./ui/feedback";

/**
 * What happened after an invite, resend or reset. When the email could not be sent the API
 * returns the one-time link once; it lives only in this component's props and is never stored.
 */
export function AccessLinkResult({ result, sentTitle }: { result: InviteResult; sentTitle: string }) {
  if (result.email_sent) return <Alert tone="success" title={sentTitle}><p>{result.note}</p></Alert>;
  if (!result.accept_url) return <Alert tone="warning" title="No email was sent"><p>{result.note}</p></Alert>;
  return <Alert tone="warning" title="Email not sent · copy the link instead">
    <p>{result.note}</p>
    <CopyLink url={result.accept_url} expiresAt={result.link_expires_at ?? null} />
  </Alert>;
}

function CopyLink({ url, expiresAt }: { url: string; expiresAt: string | null }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  function copy() {
    setCopyFailed(false);
    void navigator.clipboard.writeText(url).then(() => setCopied(true)).catch(() => setCopyFailed(true));
  }
  return <div className="access-link">
    <label className="field-label" htmlFor="access-link-url">One-time link · shown once</label>
    <div className="access-link-row">
      <input id="access-link-url" readOnly value={url} onFocus={(event) => event.currentTarget.select()} spellCheck={false} />
      <button type="button" className="button secondary sm" onClick={copy} aria-label="Copy link">
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "Copied" : "Copy link"}
      </button>
    </div>
    <p className="field-hint">{expiresAt ? `Works once, until ${formatTime(expiresAt)}.` : "Works once, for 10 minutes."} Anyone with it can set this person’s password, so send it privately.</p>
    {copyFailed ? <p className="form-error" role="alert">Couldn’t copy automatically. Select the link and copy it manually.</p> : null}
  </div>;
}
