"use client";

import { useId, useMemo, useState } from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Check, ChevronsUpDown, Image as ImageIcon, LoaderCircle, PenLine } from "lucide-react";
import type { CatalogModel } from "@/lib/types";
import type { CatalogState } from "./use-model-catalog";
import { matchesQuery } from "@/lib/search";

/** How many catalog rows the popup renders at once; typing narrows the rest. */
const RESULT_LIMIT = 60;

type Row = CatalogModel & { custom?: boolean };
type RowGroup = { label: string; items: Row[] };

/** $2 · $0.10 · $0.0005: whole dollars stay short, cents always show two digits. */
const usd = (value: number) => `$${new Intl.NumberFormat("en-US", {
  minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  maximumFractionDigits: value < 0.01 ? 5 : value < 1 ? 3 : 2,
}).format(value)}`;

/** Price as the provider lists it; "No listed price" when unknown (never estimated here). */
export function modelPriceText(model: CatalogModel): string {
  if (model.usd_per_minute !== null) return model.usd_per_minute === 0 ? "Free" : `${usd(model.usd_per_minute)}/min`;
  const input = model.input_per_million_usd, output = model.output_per_million_usd;
  if (input === null) return "No listed price";
  if (input === 0 && !output) return "Free";
  if (output === null) return `${usd(input)} per 1M tokens`;
  return `${usd(input)} in · ${usd(output)} out per 1M`;
}

function matches(model: CatalogModel, query: string): boolean {
  return matchesQuery(query, model.name, model.id, model.vendor);
}

function buildGroups(models: CatalogModel[], query: string, value: string, recommendedIds: readonly string[]): { groups: RowGroup[]; total: number } {
  const trimmed = query.trim();
  const found = trimmed ? models.filter((model) => matches(model, trimmed)) : models;
  const current = !trimmed ? found.find((model) => model.id === value) : undefined;
  const recommended = recommendedIds.map((id) => found.find((model) => model.id === id)).filter((model): model is CatalogModel => Boolean(model) && model !== current);
  const shown = new Set([current?.id, ...recommended.map((model) => model.id)]);
  const rest = found.filter((model) => !shown.has(model.id));
  const groups: RowGroup[] = [];
  if (current) groups.push({ label: "Current", items: [current] });
  if (recommended.length) groups.push({ label: "Recommended", items: recommended });
  if (rest.length) groups.push({ label: shown.size > 1 || current ? "All models" : `${found.length} models`, items: rest.slice(0, RESULT_LIMIT) });
  // Model ids never contain spaces, so "gpt 6 luna" is only a search, not a custom id.
  if (trimmed && !/\s/.test(trimmed) && !models.some((model) => model.id === trimmed)) {
    groups.push({ label: "Custom model id", items: [{ id: trimmed, name: trimmed, vendor: null, input_per_million_usd: null, output_per_million_usd: null, usd_per_minute: null, context_length: null, accepts_images: null, custom: true }] });
  }
  return { groups, total: found.length };
}

/**
 * Searchable model picker that still accepts any typed or pasted model id.
 * The list loads on first focus; typing filters it, and a non-matching entry is
 * offered as "Use … as a custom model id". Label stays a real <label> for the input.
 */
export function ModelCombobox({ id, label, value, onChange, catalog, unavailableNote, recommendedIds = [], placeholder = "Search or type a model id", required = false, disabled = false, hint }: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  catalog: CatalogState;
  /** Shown instead of a list when this provider has no model list (e.g. endpoint not set). */
  unavailableNote?: string;
  recommendedIds?: readonly string[];
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Raw input text (may hold spaces while searching); the parent only ever receives the trimmed id.
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    if (value !== text.trim()) setText(value);
  }
  const hintId = useId();
  const models = useMemo(() => catalog.catalog?.models ?? [], [catalog.catalog]);
  const { groups, total } = useMemo(() => buildGroups(models, query, value, recommendedIds), [models, query, value, recommendedIds]);
  const selected = models.find((model) => model.id === value);
  const canList = !unavailableNote;
  const hiddenCount = Math.max(0, total - RESULT_LIMIT - (groups.find((group) => group.label === "Current") ? 1 : 0));

  function status(): string | null {
    if (!canList) return unavailableNote ?? null;
    if (catalog.status === "loading" || catalog.status === "idle") return "Loading models…";
    if (catalog.status === "error") return "Models could not be loaded. You can still type a model id.";
    if (!models.length) return catalog.catalog?.note ?? "No models listed. Type a model id.";
    if (query.trim() && total === 0) return "No listed model matches.";
    return hiddenCount > 0 ? `Showing ${RESULT_LIMIT} of ${total}. Type to narrow the list.` : null;
  }

  function handleOpenChange(next: boolean, details: Autocomplete.Root.ChangeEventDetails) {
    // Typing opens the list only once there is something to pick from; free text never needs it.
    if (next && details.reason === "input-change" && !(catalog.status === "ready" && models.length)) return;
    if (next && details.reason !== "input-change") setQuery("");
    if (next) catalog.load();
    setOpen(next);
  }

  function handleValueChange(next: string, details: Autocomplete.Root.ChangeEventDetails) {
    const trimmed = next.trim();
    setText(next); setSynced(trimmed);
    if (trimmed !== value) onChange(trimmed);
    setQuery(details.reason === "input-change" ? next : "");
  }

  const note = unavailableNote ?? catalog.catalog?.note ?? null;
  const hasFoot = Boolean(hint || selected || note || (catalog.status === "error" && catalog.error));
  const statusText = status();

  return <div className="field model-combobox">
    <label htmlFor={id}>{label}</label>
    <Autocomplete.Root items={groups} filter={null} value={text} onValueChange={handleValueChange} open={open} onOpenChange={handleOpenChange}
      itemToStringValue={(item: Row) => item.id} openOnInputClick disabled={disabled}>
      <Autocomplete.InputGroup className="model-combobox-control" data-disabled={disabled || undefined}>
        <Autocomplete.Input id={id} className="model-combobox-input" placeholder={placeholder} required={required} spellCheck={false} autoComplete="off"
          aria-describedby={hasFoot ? hintId : undefined} onFocus={() => { if (canList) catalog.load(); }} />
        {catalog.status === "loading" ? <LoaderCircle className="model-combobox-spinner" aria-hidden="true" /> : null}
        <Autocomplete.Trigger className="model-combobox-trigger" aria-label="Show suggestions"><ChevronsUpDown aria-hidden="true" /></Autocomplete.Trigger>
      </Autocomplete.InputGroup>
      <Autocomplete.Portal>
        <Autocomplete.Positioner sideOffset={4} align="start" className="ui-select-positioner">
          <Autocomplete.Popup className="model-combobox-popup" aria-busy={catalog.status === "loading" || undefined}>
            <Autocomplete.Status className="model-combobox-status">{statusText}</Autocomplete.Status>
            <Autocomplete.List className="model-combobox-list">
              {(group: RowGroup) => <Autocomplete.Group key={group.label} items={group.items} className="model-combobox-group">
                <Autocomplete.GroupLabel className="model-combobox-group-label">{group.label}</Autocomplete.GroupLabel>
                <Autocomplete.Collection>
                  {(item: Row) => <Autocomplete.Item key={`${group.label}:${item.id}`} value={item} className="model-combobox-item">
                    {item.custom ? <span className="model-combobox-custom"><PenLine aria-hidden="true" />Use “{item.id}” as a custom model id</span> : <ModelRowContent model={item} />}
                    {!item.custom && item.id === value ? <Check className="model-combobox-check" aria-hidden="true" /> : null}
                  </Autocomplete.Item>}
                </Autocomplete.Collection>
              </Autocomplete.Group>}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
    <FieldFoot id={hintId} hint={hint} selected={selected} note={note} error={catalog.status === "error" ? catalog.error : null} onRetry={catalog.retry} />
  </div>;
}

function ModelRowContent({ model }: { model: CatalogModel }) {
  return <>
    <span className="model-combobox-item-main">
      <b>{model.name}</b>
      {model.name !== model.id ? <small>{model.id}</small> : null}
    </span>
    <span className="model-combobox-item-meta">
      {model.accepts_images ? <span className="model-combobox-images" title="Reads images"><ImageIcon aria-hidden="true" /><span className="sr-only">Reads images</span></span> : null}
      <small className="model-combobox-price">{modelPriceText(model)}</small>
    </span>
  </>;
}

function FieldFoot({ id, hint, selected, note, error, onRetry }: { id: string; hint?: string; selected?: CatalogModel; note: string | null; error: string | null; onRetry(): void }) {
  if (error) return <p id={id} className="form-error model-combobox-foot" role="alert">{error} <button type="button" className="text-button" onClick={onRetry}>Retry</button></p>;
  // A provider note (e.g. how a list was filtered) replaces the generic hint rather than repeating it.
  const parts = [selected ? `${selected.name !== selected.id ? `${selected.name} · ` : ""}${modelPriceText(selected)}` : null, note ?? hint].filter(Boolean);
  return parts.length ? <p id={id} className="field-hint model-combobox-foot">{parts.join(" · ")}</p> : null;
}
