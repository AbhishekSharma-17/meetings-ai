"use client";

import { useMemo, type ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { Users, X } from "lucide-react";
import type { Team, WorkspaceMember } from "@/lib/types";
import { Avatar } from "./ui/avatar";
import type { ChipSuggestion } from "./ui/chip-input";
import { EmailChips, mergeEmails } from "./ui/email-chips";

const TEAM = "team:";
const MEMBER = "member:";
const TOOLTIP_NAMES = 12;

const memberCount = (count: number) => `${count} member${count === 1 ? "" : "s"}`;

/** A team as one chip: icon, name and size; hover or focus lists who it currently reaches. */
export function TeamChip({ team, disabled, onRemove }: { team: Team | null; disabled?: boolean; onRemove(): void }) {
  const name = team?.name ?? "Unavailable team";
  const people = (team?.members ?? []).filter((member) => member.active);
  const names = people.map((member) => member.display_name ? `${member.display_name} · ${member.email}` : member.email);
  const shown = people.slice(0, TOOLTIP_NAMES);
  const summary = team ? `${name}, team of ${memberCount(team.member_count)}` : "A team that no longer exists or could not be loaded";
  return <li className="email-chip team-chip" data-unavailable={team ? undefined : true}>
    <span className="email-chip-avatar team-chip-icon" aria-hidden="true"><Users /></span>
    <Tooltip.Root>
      <Tooltip.Trigger type="button" className="team-chip-label" delay={250} aria-label={`${summary}${names.length ? `: ${names.join(", ")}` : ""}`}>
        <span className="email-chip-text">{name}</span>
        {team ? <span className="team-chip-count">{team.member_count}</span> : null}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6} className="chip-tooltip-positioner">
          <Tooltip.Popup className="chip-tooltip">
            <b>{name}</b>
            {team ? <small>{memberCount(team.member_count)} · members as of now</small> : <small>Remove it or pick another team.</small>}
            {shown.length ? <ul>{shown.map((member) => <li key={member.email}>
              <span>{member.display_name ?? member.email}</span>{member.display_name ? <small>{member.email}</small> : null}
            </li>)}
              {people.length > TOOLTIP_NAMES ? <li>and {people.length - TOOLTIP_NAMES} more</li> : null}</ul> : null}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
    <button type="button" className="email-chip-remove" disabled={disabled} onClick={onRemove} aria-label={`Remove team ${name}`}><X aria-hidden="true" /></button>
  </li>;
}

/**
 * Email chips that also accept internal teams. Typing "@" or part of a team or teammate's name opens
 * suggestions; a team becomes one team chip (sent by reference, expanded to its members at send time)
 * and a teammate becomes their email chip. `groupName` submits the team ids in a hidden input.
 */
export function TeamRecipientChips({ id, label, name, groupName, value, onChange, groupIds, onGroupIdsChange, teams, members, placeholder, disabled, hint, labelSuffix }: {
  id: string;
  label: string;
  name?: string;
  groupName?: string;
  value: string[];
  onChange(next: string[]): void;
  groupIds: string[];
  onGroupIdsChange(next: string[]): void;
  teams: Team[];
  members: WorkspaceMember[];
  placeholder?: string;
  disabled?: boolean;
  hint?: ReactNode;
  labelSuffix?: ReactNode;
}) {
  const byId = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams]);
  const suggestions = useMemo<ChipSuggestion[]>(() => {
    const chosen = new Set(value.map((item) => item.toLowerCase()));
    return [
      ...teams.filter((team) => !groupIds.includes(team.id)).map((team) => ({
        id: `${TEAM}${team.id}`, label: team.name, detail: `Team · ${memberCount(team.member_count)}`, icon: <Users />,
        keywords: team.description ? [team.description] : [],
      })),
      ...members.filter((member) => member.email && member.status !== "disabled" && !chosen.has(member.email.toLowerCase())).map((member) => ({
        id: `${MEMBER}${member.user_id}`, label: member.display_name, detail: member.email ?? undefined,
        icon: <Avatar name={member.display_name} photoUrl={member.photo_url} size="sm" />, keywords: member.email ? [member.email] : [],
      })),
    ];
  }, [teams, members, groupIds, value]);

  function pick(option: ChipSuggestion) {
    if (option.id.startsWith(TEAM)) {
      const teamId = option.id.slice(TEAM.length);
      if (!groupIds.includes(teamId)) onGroupIdsChange([...groupIds, teamId]);
      return;
    }
    const member = members.find((item) => `${MEMBER}${item.user_id}` === option.id);
    if (member?.email) onChange(mergeEmails(value, [member.email]));
  }

  const leading = groupIds.length ? groupIds.map((teamId) => <TeamChip key={teamId} team={byId.get(teamId) ?? null} disabled={disabled}
    onRemove={() => onGroupIdsChange(groupIds.filter((item) => item !== teamId))} />) : null;

  return <>
    <EmailChips id={id} label={label} name={name} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled}
      hint={hint ?? (suggestions.length ? "Type @ to add a team or teammate." : undefined)} labelSuffix={labelSuffix}
      leading={leading} onRemoveLeading={() => onGroupIdsChange(groupIds.slice(0, -1))}
      suggestions={teams.length || members.length ? suggestions : undefined} onPick={pick} suggestionsLabel="Teams and teammates" />
    {groupName ? <input type="hidden" name={groupName} value={groupIds.join(",")} /> : null}
  </>;
}
