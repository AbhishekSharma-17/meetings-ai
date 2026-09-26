import type { ReactNode } from "react";

/** A resting surface with an optional header row and footer action bar. */
export function Card({ title, description, actions, footer, children, id, className = "", bodyClassName = "", headingLevel = 2, labelledBy, as = "section", plainHeader = false }: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  id?: string;
  className?: string;
  bodyClassName?: string;
  headingLevel?: 2 | 3;
  labelledBy?: string;
  as?: "section" | "div" | "article";
  plainHeader?: boolean;
}) {
  const Tag = as;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const headingId = id ? `${id}-title` : undefined;
  return <Tag className={`card ${className}`.trim()} id={id} aria-labelledby={labelledBy ?? (title && Tag === "section" ? headingId : undefined)}>
    {title || actions ? <div className={plainHeader ? "card-header plain" : "card-header"}>
      <div>{title ? <Heading id={headingId}>{title}</Heading> : null}{description ? <p>{description}</p> : null}</div>
      {actions ? <div className="button-group">{actions}</div> : null}
    </div> : null}
    {children !== undefined && children !== null ? <div className={`card-body ${bodyClassName}`.trim()}>{children}</div> : null}
    {footer ? <div className="card-footer">{footer}</div> : null}
  </Tag>;
}
