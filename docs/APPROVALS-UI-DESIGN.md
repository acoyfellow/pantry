# Pantry app design

## Product direction

Pantry should become a small authenticated operations app, not a static approval page. The app manages recipe artifacts and their lifecycle while the Hono Worker remains the API and policy boundary.

The primary user task is to answer three questions quickly:

1. What needs my review?
2. What changed since the last approved version?
3. What exactly is safe to run now?

## Information architecture

### App shell

- Header: Pantry mark, current owner, connection status, theme control.
- Sidebar: Overview, Pending approvals, Recipes, Activity.
- Main content: one page header, one primary action, one focused data surface.
- Right detail panel: opens for a selected recipe without losing the queue context.

### Overview

Show four compact metrics:

- Pending review.
- Enabled recipes.
- Reported uses.
- Recipes needing reapproval.

Below the metrics, show the pending queue and recent approval activity.

### Pending approvals

Use a resource list. Each row shows:

- recipe name and description;
- pending badge;
- version;
- source digest shortened for display;
- capability count;
- submitted time;
- primary action: Review.

Review opens a detail panel with:

- current source;
- previous approved source;
- inline source diff;
- capability additions and removals;
- version and digest comparison;
- reason field;
- Approve, Request revision, and Reject actions.

### Recipes

Use a table for the owner's inventory. Columns:

- Name;
- Status;
- Version;
- Capabilities;
- Reported uses;
- Last used;
- Updated.

The row menu contains View, Create revision, Disable, and Delete. Delete requires a confirmation dialog and displays the name and current digest.

### Recipe editor

Create and revision forms use a two-column layout:

- left: description, input schema, capabilities, visibility, tags;
- right: source editor, lint findings, version preview.

Submitting a new recipe or a revision always explains the resulting state. New and changed artifacts enter Pending review.

## Visual system

Use Kumo design guidance from https://kumo-ui.com/skill/:

- 14px content and control text;
- sentence case headings;
- no tracking changes;
- font-semibold for headings and font-medium for emphasis;
- immediate hover color changes with no hover transitions;
- rings instead of borders with drop shadows;
- concentric radii for nested surfaces;
- compact spacing for related metadata;
- smaller monospaced text for digests and source metadata;
- sticky queue and detail headers separated with a border;
- dialogs remain mounted and use open state for transitions.

Use a neutral Cloudflare-style canvas with restrained orange status accents. Color must not be the only status signal. Every status badge includes text and an accessible label.

## Interaction rules

- Never fetch or display recipe source until the user selects Review.
- Keep the approval queue visible while the detail panel is open.
- Disable destructive and approval actions while a request is pending.
- After an action, retain the receipt digest in a toast and add the event to Activity.
- Reject and Request revision require a reason.
- Approve requires the current digest to match the reviewed digest.
- A changed source or capability list creates a new pending version.
- The token is session memory only. Never store it in local storage, cookies, or the built bundle.

## Technical shape

- Hono remains the Cloudflare Worker API and authentication boundary.
- Svelte 5 owns the authenticated app view and local UI state.
- Vite builds the Svelte app into the Worker asset directory.
- The browser calls `/api/*` routes only; recipe source stays out of list responses.
- `PantryClient` remains the typed transport layer shared by the app and callers.
- Approval actions return immutable receipt metadata and refresh the selected resource.
- The API remains responsible for state enforcement. The UI never decides whether a recipe may execute.

## First implementation slice

1. Add a Svelte 5 plus Vite app shell.
2. Add the pending queue and review panel.
3. Add recipe inventory and create-revision flow.
4. Add API client methods for inventory, diffs, approvals, and deletion.
5. Replace the hand-written approval page after browser verification.
6. Keep the static docs and public landing page separate from the authenticated app.
