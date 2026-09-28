"use client";

import { useEffect, useState } from "react";
import { CircleAlert, Clock3, LinkIcon } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { AccountLinkPreview, AccountLinkPurpose, AccountLinkState } from "@/lib/types";
import { LoadingRow } from "./ui/feedback";
import { SetPasswordForm } from "./set-password-form";

export type AccountLink = { purpose: AccountLinkPurpose; token: string };

const LINK_PREFIX = /^#(accept|reset)=/;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Reads an emailed account link from the URL fragment and immediately removes it from the
 * address bar and history, so the credential isn't left behind in the browser.
 */
export function takeAccountLinkFromUrl(): AccountLink | null {
  const hash = window.location.hash;
  const kind = LINK_PREFIX.exec(hash);
  if (!kind) return null;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  const token = hash.slice(kind[0].length);
  return { purpose: kind[1] === "reset" ? "password_reset" : "invite", token: TOKEN_SHAPE.test(token) ? token : "" };
}

type Unusable = { state: Exclude<AccountLinkState, "valid"> };

const httpStatus = (cause: unknown) => typeof cause === "object" && cause !== null && "status" in cause ? Number((cause as { status: unknown }).status) : 0;

export function AccountLinkScreen({ link, onSignedIn, onSignIn, onRequestReset }: {
  link: AccountLink;
  onSignedIn(): void;
  onSignIn(): void;
  onRequestReset(): void;
}) {
  const [preview, setPreview] = useState<AccountLinkPreview | null>(null);
  const [unusable, setUnusable] = useState<Unusable | null>(link.token ? null : { state: "invalid" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!link.token) return;
    let active = true;
    meetingsService.inspectAccountLink(link.token)
      .then((result) => { if (!active) return; if (result.state === "valid") setPreview(result); else setUnusable({ state: result.state }); })
      .catch((cause) => { if (active) setLoadError(httpStatus(cause) === 429 ? "Too many attempts from this network. Wait a few minutes and reload." : "We couldn’t check this link. Check your connection and reload the page."); });
    return () => { active = false; };
  }, [link.token]);

  async function accept(password: string) {
    setBusy(true); setError(null);
    try {
      await meetingsService.acceptAccountLink(link.token, password);
      onSignedIn();
    } catch (cause) {
      if (httpStatus(cause) === 410) {
        // The link stopped working while the form was open; ask again for the precise reason.
        const again = await meetingsService.inspectAccountLink(link.token).catch(() => null);
        setUnusable({ state: again && again.state !== "valid" ? again.state : "invalid" });
      } else setError(cause instanceof Error ? cause.message : "Couldn’t save your password. Try again.");
      setBusy(false);
    }
  }

  const invite = link.purpose === "invite";
  if (unusable) return <LinkProblem purpose={link.purpose} problem={unusable} onSignIn={onSignIn} onRequestReset={onRequestReset} />;
  if (loadError) return <div className="login-card"><div><h1>{invite ? "Accept your invitation" : "Choose a new password"}</h1></div><p className="form-error" role="alert">{loadError}</p></div>;
  if (!preview) return <div className="login-card"><div><h1>{invite ? "Accept your invitation" : "Choose a new password"}</h1></div><LoadingRow>Checking your link…</LoadingRow></div>;

  return <div className="login-card account-link-card">
    <div>
      <p className="eyebrow">{invite ? `Join ${preview.workspace_name ?? "your workspace"}` : "Password reset"}</p>
      <h1>{invite ? "Accept your invitation" : "Choose a new password"}</h1>
      <p className="intro">{invite ? "Choose a password to finish setting up your account. You’ll be signed in right after." : "Your new password replaces the old one and signs out your other sessions."}</p>
    </div>
    <dl className="account-link-identity">
      <div><dt>Name</dt><dd>{preview.display_name}</dd></div>
      <div><dt>Sign-in email</dt><dd>{preview.email}</dd></div>
    </dl>
    <SetPasswordForm email={preview.email} busy={busy} error={error}
      submitLabel={invite ? "Accept invite and sign in" : "Save password and sign in"} busyLabel="Signing you in…" onSubmit={(password) => void accept(password)} />
  </div>;
}

const PROBLEM_TITLE: Record<Unusable["state"], string> = {
  expired: "This link has expired",
  used: "This link has already been used",
  revoked: "This link was replaced by a newer one",
  invalid: "This link isn’t valid",
};

function problemCopy(purpose: AccountLinkPurpose, state: Unusable["state"]): string {
  if (purpose === "invite") {
    if (state === "expired") return "This invitation link has expired. Invitation links work for 10 minutes; ask your admin to send a new one.";
    if (state === "used") return "This invitation has already been accepted. Sign in with the password you chose.";
    if (state === "revoked") return "A newer invitation was sent. Use the most recent email, or ask your admin to resend it.";
    return "This invitation link can’t be used. Check that you opened the whole link, or ask your admin to send a new one.";
  }
  if (state === "expired") return "Password reset links work for 10 minutes. Request a new one and use it right away.";
  if (state === "used") return "This reset link has already been used. Sign in with your new password, or request another link.";
  if (state === "revoked") return "A newer reset link was sent. Use the most recent email, or request another link.";
  return "This reset link can’t be used. Check that you opened the whole link, or request a new one.";
}

function LinkProblem({ purpose, problem, onSignIn, onRequestReset }: {
  purpose: AccountLinkPurpose; problem: Unusable; onSignIn(): void; onRequestReset(): void;
}) {
  const Icon = problem.state === "expired" ? Clock3 : problem.state === "invalid" ? CircleAlert : LinkIcon;
  return <div className="login-card account-link-problem" role="status">
    <span className="account-link-icon" aria-hidden="true"><Icon /></span>
    <div>
      <h1>{PROBLEM_TITLE[problem.state]}</h1>
      <p className="intro">{problemCopy(purpose, problem.state)}</p>
    </div>
    <div className="account-link-actions">
      <button type="button" className="button primary lg block" onClick={onSignIn}>Go to sign in</button>
      {purpose === "password_reset" ? <button type="button" className="button secondary lg block" onClick={onRequestReset}>Request a new link</button> : null}
    </div>
  </div>;
}
