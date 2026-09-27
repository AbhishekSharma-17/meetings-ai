import type { CurrentAccount, OrganizationBrief, BriefDocument, RetentionPolicy, Workspace, WorkspaceMember, WorkspaceOption } from "../../types";
import { type Clock, documentId, minutesFrom, ORG_MAIN, ORG_VENTURES, userId } from "./ids";

export const DOMAIN = "northwindlabs.example";
export const OWNER_ID = userId(1);

/** A simple illustrated portrait as an SVG data URL (sample "photo", no external image). */
function portrait(hue: number, skin: number, hair: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue},42%,84%)"/>`
    + `<path d="M10 66c2-14 11-21 22-21s20 7 22 21z" fill="hsl(${hue},34%,40%)"/>`
    + `<circle cx="32" cy="27" r="12" fill="hsl(${skin},42%,70%)"/>`
    + `<path d="M32 13c-8.5 0-14 5.5-14 13 0 2 .6 3.6.6 3.6 1.4-6.2 6.2-9.6 13.4-9.6s12 3.4 13.4 9.6c0 0 .6-1.6.6-3.6 0-7.5-5.5-13-14-13z" fill="hsl(${hair},32%,22%)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

type Person = { id: string; name: string; email: string; role: WorkspaceMember["role"]; status: string; photo: string | null; title: string };

export const team: Person[] = [
  { id: OWNER_ID, name: "Alex Morgan", email: `alex.morgan@${DOMAIN}`, role: "owner", status: "active", photo: portrait(212, 28, 24), title: "Managing partner" },
  { id: userId(2), name: "Priya Shah", email: `priya.shah@${DOMAIN}`, role: "admin", status: "active", photo: portrait(330, 22, 12), title: "Head of delivery" },
  { id: userId(3), name: "Daniel Kim", email: `daniel.kim@${DOMAIN}`, role: "member", status: "active", photo: null, title: "Solutions architect" },
  { id: userId(4), name: "Sofia Alvarez", email: `sofia.alvarez@${DOMAIN}`, role: "member", status: "active", photo: portrait(160, 30, 18), title: "ML engineer" },
  { id: userId(5), name: "Marcus Reed", email: `marcus.reed@${DOMAIN}`, role: "viewer", status: "active", photo: null, title: "Finance lead" },
  { id: userId(6), name: "Hannah Lee", email: `hannah.lee@${DOMAIN}`, role: "member", status: "invited", photo: null, title: "Delivery consultant" },
];

export const personByName = (name: string) => team.find((person) => person.name === name);

export function ownerAccount(orgId: string, photoUrl: string | null, displayName = "Alex Morgan"): CurrentAccount {
  return {
    user_id: OWNER_ID, organization_id: orgId, email: `alex.morgan@${DOMAIN}`, display_name: displayName,
    role: orgId === ORG_VENTURES ? "admin" : "owner", must_change_password: false, photo_url: photoUrl,
  };
}

export function workspaceRecord(clock: Clock, orgId: string): Workspace {
  const ventures = orgId === ORG_VENTURES;
  return {
    id: orgId, slug: ventures ? "northwind-ventures" : "northwind-labs",
    display_name: ventures ? "Northwind Ventures" : "Northwind Labs",
    contact_email: ventures ? `ventures@${DOMAIN}` : `operations@${DOMAIN}`,
    status: "active", created_at: minutesFrom(clock, -60 * 24 * (ventures ? 120 : 410)), updated_at: minutesFrom(clock, -60 * 26),
    tenant_isolation_enabled: true,
  };
}

export function workspaceOptions(defaultId: string | null): WorkspaceOption[] {
  return [
    { id: ORG_MAIN, slug: "northwind-labs", display_name: "Northwind Labs", role: "owner", is_default: defaultId === ORG_MAIN },
    { id: ORG_VENTURES, slug: "northwind-ventures", display_name: "Northwind Ventures", role: "admin", is_default: defaultId === ORG_VENTURES },
  ];
}

export function memberRecords(orgId: string): WorkspaceMember[] {
  const people = orgId === ORG_VENTURES ? team.filter((person) => [OWNER_ID, userId(2), userId(5)].includes(person.id)) : team;
  return people.map((person) => ({
    user_id: person.id, display_name: person.name, email: person.email,
    role: orgId === ORG_VENTURES && person.id === OWNER_ID ? "admin" : person.role,
    status: person.status, photo_url: person.photo,
  }));
}

export function organizationBrief(clock: Clock): OrganizationBrief {
  return {
    website: "https://www.northwindlabs.example",
    overview: "Northwind Labs is a 40-person AI and automation consultancy. We help operations-heavy companies — manufacturers, logistics and customer support teams — turn scattered documents, tickets and conversations into reliable AI assistants and automated workflows.",
    services: ["AI strategy workshops", "Retrieval (RAG) assistants over manuals and tickets", "Support automation and agent assist", "Workflow automation and integrations", "MLOps and model evaluation"],
    products: ["Northwind Assist (support copilot)", "FieldGuide (technician knowledge search)"],
    differentiators: "Two-week pilots with measurable success criteria, evaluation harnesses delivered with every build, and deployments inside the client's own cloud.",
    positioning: "The practical AI partner for operations teams: small pilots, clear metrics, production in a quarter.",
    updated_at: minutesFrom(clock, -60 * 24 * 9),
  };
}

export function briefDocuments(clock: Clock): BriefDocument[] {
  return [
    { id: documentId(1), filename: "northwind-capabilities-2026.pdf", content_type: "application/pdf", character_count: 48_211, uploaded_at: minutesFrom(clock, -60 * 24 * 30) },
    { id: documentId(2), filename: "case-study-fieldguide-rollout.docx", content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", character_count: 12_904, uploaded_at: minutesFrom(clock, -60 * 24 * 12) },
    { id: documentId(3), filename: "rate-card-q4.pdf", content_type: "application/pdf", character_count: 3_420, uploaded_at: minutesFrom(clock, -60 * 24 * 3) },
  ];
}

export const defaultRetention: RetentionPolicy = { enabled: true, meeting_days: 365, chat_days: 180, audit_days: 730 };
