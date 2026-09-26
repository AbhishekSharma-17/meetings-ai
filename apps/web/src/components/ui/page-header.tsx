import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

/** Standard page title block: optional back link, eyebrow, title, one-sentence intro and actions. */
export function PageHeader({ title, description, eyebrow, actions, back, titleId, badge }: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  back?: { label: string; onClick(): void };
  titleId?: string;
  badge?: ReactNode;
}) {
  return <header className="page-header">
    <div className="page-header-text">
      {back ? <button type="button" className="back-button" onClick={back.onClick}><ArrowLeft aria-hidden="true" />{back.label}</button> : null}
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h1 id={titleId}>{title}{badge}</h1>
      {description ? <p className="intro">{description}</p> : null}
    </div>
    {actions ? <div className="page-actions">{actions}</div> : null}
  </header>;
}
