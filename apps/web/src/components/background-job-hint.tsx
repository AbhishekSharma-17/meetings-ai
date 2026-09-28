import type { ReactNode } from "react";
import { BellRing } from "lucide-react";

/** Quiet "this keeps running if you leave" note shown while a server-side background job is in progress. */
export function BackgroundJobHint({ children }: { children: ReactNode }) {
  return <p className="field-hint minutes-background-hint" role="status"><BellRing aria-hidden="true" />{children}</p>;
}
