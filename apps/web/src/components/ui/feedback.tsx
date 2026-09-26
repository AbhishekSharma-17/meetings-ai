import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";

export type Tone = "info" | "success" | "warning" | "danger" | "brand" | "neutral";

const toneIcon = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert, brand: Info, neutral: Info } as const;

/** Inline message. Danger renders as an alert; everything else is a polite status. */
export function Alert({ tone = "info", title, children, actions, role, className = "" }: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  role?: "alert" | "status" | "note";
  className?: string;
}) {
  const Icon = toneIcon[tone];
  return <div className={`alert ${className}`.trim()} data-tone={tone} role={role ?? (tone === "danger" ? "alert" : "status")}>
    <Icon aria-hidden="true" />
    <div className="alert-body">{title ? <b>{title}</b> : null}{children ? <div>{children}</div> : null}</div>
    {actions ? <div className="alert-actions">{actions}</div> : null}
  </div>;
}

/** "Nothing yet" and "no matches" states. Keep copy to one sentence and one action. */
export function EmptyState({ icon, title, children, action, plain = false, className = "" }: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  plain?: boolean;
  className?: string;
}) {
  return <div className={`empty-state ${plain ? "plain" : ""} ${className}`.trim()}>
    {icon ? <span className="empty-icon" aria-hidden="true">{icon}</span> : null}
    <b>{title}</b>
    {children ? <p>{children}</p> : null}
    {action}
  </div>;
}

export function Badge({ tone = "neutral", dot = false, children, className = "" }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return <span className={`badge ${dot ? "dot" : ""} ${className}`.trim()} data-tone={tone === "danger" ? "danger" : tone}>{children}</span>;
}

export function Skeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return <div className={`stack ${className}`.trim()} aria-hidden="true">
    {Array.from({ length: lines }, (_, index) => <span key={index} className="skeleton" style={{ height: 14, width: `${index === lines - 1 ? 60 : 100 - index * 8}%` }} />)}
  </div>;
}

export function LoadingRow({ children }: { children: ReactNode }) {
  return <div className="loading-row" role="status"><span className="spinner" aria-hidden="true" />{children}</div>;
}
