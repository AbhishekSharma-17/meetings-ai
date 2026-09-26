# Meetings AI UI system

The web app (`apps/web`) uses one small design system. Every screen composes the same primitives so a settings page, a meeting record and the AI chat read as one product.

## Direction

A calm, professional operator console: cool slate neutrals, white working surfaces separated by 1px hairlines, one deep-sea accent (taken from the logo) used only where a decision lives — the primary action, the active navigation item, links, focus and selection. Type is Inter at 14px with weight and tone doing the hierarchy work. Motion is 100–220ms and only confirms an action.

## Where things live

| File | Contents |
| --- | --- |
| `src/app/styles.css` | Tokens only: light values in `:root`, dark values in `.dark`, bridge in `@theme inline`. Run `npm run test:contrast` after any colour change. |
| `src/styles/base.css` | Reset, type scale, global form-control styling (inputs, textareas, checkboxes). |
| `src/styles/primitives.css` | The shared vocabulary (below). Feature files may lay primitives out but must not restyle them. |
| `src/styles/shell.css` | Sidebar, inset main panel, top bar, profile menu, sign-in. |
| `src/styles/features/*.css` | One file per feature area: layout only, built from tokens. |
| `src/components/ui/*` | React primitives: `PageHeader`, `Card`, `Alert`, `EmptyState`, `Badge`, `Skeleton`, `LoadingRow`, `SwitchField`. |
| `src/components/ui-select.tsx` | `UiSelect`, the only select. Never use a native `<select>`. |
| `src/lib/meeting-status.ts` | Shared meeting status labels, monograms and initials. |

## Rules

- **Tokens only.** No hex, `rgb()`, `oklch()` or named colours in components or feature CSS. Use `var(--token)`. Shadows only via `--elevation-*`; focus via `--focus-shadow` or the global `:focus-visible` outline.
- **One primary action per view.** `button primary` for the main action, `button secondary` for alternatives, `button ghost` for low-emphasis toolbar actions, `text-button` for inline links, `button danger` only inside a confirmation step. Sizes: default 34px, `sm` 28px, `lg` 40px, `icon` square.
- **Hairlines over shadows.** Resting surfaces are `.card` (border, 12px radius, no shadow). Only floating layers (popover, select, dialog, sheet) carry shadows.
- **Page anatomy.** `section.page` → `PageHeader` (title, one-sentence description, actions) → content cards. Use `.page.wide` for dense tools and `.page.narrow` for forms.
- **Status is a word, never colour alone.** Meeting status uses `.status <status>`; other states use `Badge` with a tone. Labels come from `meetingStatusLabel`.
- **Every state is designed.** Loading uses `LoadingRow` or `Skeleton`, empty uses `EmptyState` (one sentence, one action), errors use `.form-error` / `Alert tone="danger"`, successes use `.form-success` / `Alert tone="success"`.
- **Overlays use Base UI.** Dialog (`.dialog`, `.dialog-backdrop`, `.close-button`, `.dialog-footer`), Popover (`.popover`, `.menu-item`), Select (`UiSelect`), Switch (`SwitchField`). No `window.confirm`; destructive actions use an inline two-step confirm or a dialog.
- **Sentence case** for every label, button, heading and tab. The only uppercase is `.eyebrow`.
- **Responsive.** Layouts collapse at 1100px, 820px (sidebar becomes a sheet) and 640px. No horizontal page scroll at 390px.

## Primitive classes

Layout `page`, `page-header`, `section-heading`, `grid-2`, `grid-3`, `stack`, `cluster` · Surfaces `card`, `card-header`, `card-body`, `card-footer`, `inset-panel`, `list-card`, `list-row` · Actions `button {primary|secondary|ghost|danger|danger-outline} {sm|lg|icon|block}`, `text-button {destructive|neutral}`, `icon-button` · Status `status`, `badge[data-tone]`, `tag`, `tag-list` · Messages `alert[data-tone]`, `form-error`, `form-success`, `notice` · States `empty-state`, `skeleton`, `spinner`, `loading-row` · Forms `field`, `field-row`, `form-stack`, `check-label`, `choice-card`, `input-with-icon`, `switch-row` · Navigation `segmented`, `tabs-list` · Data `table-wrap`, `data-table`, `meta-list`, `stat`, `stat-grid` · Identity `avatar {sm|lg|brand}`.

## Verification

`npm run typecheck`, `npm run lint`, `npm run lint:design`, `npm run test:contrast`, and the Playwright suite (`npm run test:e2e`, mocked API) before calling a UI change done. Review both themes and a 390px width.
