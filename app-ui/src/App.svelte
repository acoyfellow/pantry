<script lang="ts">
import { onMount, tick } from 'svelte';

type Recipe = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  code?: string;
  capabilities: string[];
  status: string;
  version: number;
  visibility?: 'private' | 'shared';
  author?: string;
  tags?: string[];
  recipeDigest?: string | null;
  approvedVersion?: number | null;
  approvedDigest?: string | null;
  runCount?: number;
  lastRunAt?: string | null;
  retrievalCount?: number;
  lastRetrievedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type ApprovalDiff = {
  current: Recipe & { code: string };
  previous: {
    sourceCode: string;
    capabilities: string[];
    version: number;
    receiptDigest: string;
  } | null;
  sourceChanged: boolean;
  capabilitiesChanged: boolean;
};

type Draft = {
  name: string;
  description: string;
  code: string;
  capabilities: string;
};

type View = 'recipes' | 'people' | 'folders' | 'activity' | 'settings';
type Filter = 'all' | 'review' | 'active';
type SortMode = 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc';
type ConfirmationKind = 'approve' | 'reject' | 'request-revision' | 'delete';
type Confirmation = { kind: ConfirmationKind; recipe: Recipe };
type WorkspaceRole = 'reader' | 'contributor' | 'reviewer' | 'admin';
type WorkspaceCapabilities = {
  canWrite: boolean;
  canReview: boolean;
  canManageMembers: boolean;
  canManageFolders: boolean;
};
type WorkspaceSession = {
  actor: { id: string; kind: 'human'; displayEmail: string | null };
  workspace: { id: string; slug: string; displayName: string };
  role: WorkspaceRole;
  capabilities: WorkspaceCapabilities;
};
type WorkspaceMembership = {
  id: string;
  actor_id: string;
  role: WorkspaceRole;
  source: string;
  valid_from: string;
  valid_until: string | null;
  revoked_at: string | null;
};
type WorkspaceFolder = {
  id: string;
  parent_id: string | null;
  slug: string;
  display_name: string;
  archived_at: string | null;
};
type ResourceState = 'idle' | 'loading' | 'loaded' | 'error';

const navigation: Array<{ id: View; label: string; shortLabel: string }> = [
  { id: 'recipes', label: 'Recipes', shortLabel: 'Recipes' },
  { id: 'people', label: 'People', shortLabel: 'People' },
  { id: 'folders', label: 'Folders', shortLabel: 'Folders' },
  { id: 'activity', label: 'Activity', shortLabel: 'Activity' },
  { id: 'settings', label: 'Settings', shortLabel: 'Settings' },
];

let principal = '';
let workspaceOwner = '';
let workspaceSession: WorkspaceSession | null = null;
let memberships: WorkspaceMembership[] = [];
let folders: WorkspaceFolder[] = [];
let membershipsState: ResourceState = 'idle';
let foldersState: ResourceState = 'idle';
let membershipsError = '';
let foldersError = '';
let inviteTargetAccessSubject = '';
let inviteRole: Exclude<WorkspaceRole, 'reader'> = 'contributor';
let invitationResult = '';
let folderSlug = '';
let folderDisplayName = '';
let folderParentId = '';
let workspaceActionError = '';
let sessionState: 'loading' | 'connected' | 'denied' = 'loading';
let hydrationVisible = true;
let loadingPhase = 'Checking your Cloudflare Access session';
let activeView: View = 'recipes';
let filter: Filter = 'all';
let sortMode: SortMode = 'updated-desc';
let recipes: Recipe[] = [];
let pending: Recipe[] = [];
let selected: Recipe | null = null;
let diff: ApprovalDiff | null = null;
let detailLoading = false;
let draft: Draft = {
  name: '',
  description: '',
  code: 'return { value: ctx.input.text };',
  capabilities: 'text.transform',
};
let editing = false;
let busy = false;
let message = '';
let error = '';
let confirmation: Confirmation | null = null;
let confirmationReason = '';
let confirmationError = '';
let detailDialog: HTMLDialogElement;
let editorDialog: HTMLDialogElement;
let confirmationDialog: HTMLDialogElement;
let setupDialog: HTMLDialogElement;
let inviteDialog: HTMLDialogElement;
let folderDialog: HTMLDialogElement;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body as T;
}

function showDialog(dialog: HTMLDialogElement) {
  void tick().then(() => {
    if (!dialog.open) dialog.showModal();
  });
}

function openSetup() {
  showDialog(setupDialog);
}

function clearDetails() {
  selected = null;
  diff = null;
  detailLoading = false;
}

function closeDetails() {
  if (detailDialog?.open) detailDialog.close();
  else clearDetails();
}

function changeView(view: View) {
  activeView = view;
  message = '';
}

function isWorkspaceSession(session: unknown): session is WorkspaceSession {
  return (
    typeof session === 'object' &&
    session !== null &&
    'workspace' in session &&
    'actor' in session &&
    'capabilities' in session
  );
}

function workspaceApiPath(path: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceSession?.workspace.slug ?? '')}${path}`;
}

async function refreshRecipeInventory() {
  const [inventory, queue] = await Promise.all([
    request<{ recipes: Recipe[] }>('/recipes'),
    request<{ recipes: Recipe[] }>('/api/approvals'),
  ]);
  recipes = inventory.recipes;
  pending = queue.recipes;
  if (selected) {
    const refreshedRecipe = recipes.find((recipe) => recipe.name === selected?.name) ?? null;
    if (refreshedRecipe) await selectRecipe(refreshedRecipe);
    else closeDetails();
  }
}

async function loadMemberships() {
  if (!workspaceSession?.capabilities.canManageMembers) {
    memberships = [];
    membershipsState = 'idle';
    membershipsError = '';
    return;
  }
  membershipsState = 'loading';
  membershipsError = '';
  try {
    const response = await request<{ memberships: WorkspaceMembership[] }>(
      workspaceApiPath('/memberships'),
    );
    memberships = response.memberships;
    membershipsState = 'loaded';
  } catch (caught) {
    memberships = [];
    membershipsState = 'error';
    membershipsError =
      caught instanceof Error ? caught.message : 'Could not load membership records';
  }
}

async function loadFolders() {
  if (!workspaceSession) return;
  foldersState = 'loading';
  foldersError = '';
  try {
    const response = await request<{ folders: WorkspaceFolder[] }>(workspaceApiPath('/folders'));
    folders = response.folders;
    foldersState = 'loaded';
  } catch (caught) {
    folders = [];
    foldersState = 'error';
    foldersError = caught instanceof Error ? caught.message : 'Could not load folders';
  }
}

async function refreshWorkspaceResources() {
  await Promise.all([loadFolders(), loadMemberships()]);
}

async function refresh() {
  busy = true;
  error = '';
  try {
    if (workspaceSession) await refreshWorkspaceResources();
    else await refreshRecipeInventory();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not load Pantry';
  } finally {
    busy = false;
  }
}

async function loadSession() {
  error = '';
  sessionState = 'loading';
  loadingPhase = 'Checking your Cloudflare Access session';
  try {
    const session = await request<WorkspaceSession | { principal: string; owner?: string }>(
      '/api/session',
    );
    if (isWorkspaceSession(session)) {
      workspaceSession = session;
      principal = session.actor.displayEmail ?? session.actor.id;
      workspaceOwner = session.workspace.displayName;
      recipes = [];
      pending = [];
      loadingPhase = 'Loading workspace permissions';
      await refreshWorkspaceResources();
    } else {
      workspaceSession = null;
      principal = session.principal;
      workspaceOwner = session.owner ?? '';
      loadingPhase = 'Loading your recipe library';
      await refreshRecipeInventory();
    }
    sessionState = 'connected';
    window.setTimeout(() => {
      hydrationVisible = false;
    }, 180);
  } catch (caught) {
    sessionState = 'denied';
    error = caught instanceof Error ? caught.message : 'Cloudflare Access session required';
  }
}

function openInvite() {
  workspaceActionError = '';
  invitationResult = '';
  inviteTargetAccessSubject = '';
  inviteRole = 'contributor';
  showDialog(inviteDialog);
}

function openFolderCreator() {
  workspaceActionError = '';
  folderSlug = '';
  folderDisplayName = '';
  folderParentId = '';
  showDialog(folderDialog);
}

async function createInvitation(event: SubmitEvent) {
  event.preventDefault();
  if (!workspaceSession) return;
  busy = true;
  workspaceActionError = '';
  invitationResult = '';
  try {
    const result = await request<{
      id: string;
      role: WorkspaceRole;
      expiresAt: string;
      token: string;
    }>(workspaceApiPath('/invitations'), {
      method: 'POST',
      body: JSON.stringify({ targetAccessSubject: inviteTargetAccessSubject, role: inviteRole }),
    });
    invitationResult = `Invitation created for ${result.role}; it expires ${formatDate(result.expiresAt)}.`;
    inviteDialog.close();
    await loadMemberships();
  } catch (caught) {
    workspaceActionError = caught instanceof Error ? caught.message : 'Could not create invitation';
  } finally {
    busy = false;
  }
}

async function createFolder(event: SubmitEvent) {
  event.preventDefault();
  if (!workspaceSession) return;
  busy = true;
  workspaceActionError = '';
  try {
    await request(workspaceApiPath('/folders'), {
      method: 'POST',
      body: JSON.stringify({
        slug: folderSlug,
        displayName: folderDisplayName,
        parentId: folderParentId || null,
      }),
    });
    folderDialog.close();
    message = `${folderDisplayName} folder created`;
    await loadFolders();
  } catch (caught) {
    workspaceActionError = caught instanceof Error ? caught.message : 'Could not create folder';
  } finally {
    busy = false;
  }
}

onMount(loadSession);

async function selectRecipe(recipe: Recipe) {
  selected = recipe;
  diff = null;
  detailLoading = true;
  showDialog(detailDialog);
  error = '';
  try {
    diff = await request<ApprovalDiff>(`/recipe/${encodeURIComponent(recipe.name)}/approval-diff`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not load recipe details';
  } finally {
    detailLoading = false;
  }
}

function openCreate() {
  editing = false;
  draft = {
    name: '',
    description: '',
    code: 'return { value: ctx.input.text };',
    capabilities: 'text.transform',
  };
  showDialog(editorDialog);
}

function openEdit(recipe: Recipe) {
  editing = true;
  draft = {
    name: recipe.name,
    description: recipe.description,
    code: recipe.code ?? 'return { value: ctx.input.text };',
    capabilities: recipe.capabilities.join(', '),
  };
  showDialog(editorDialog);
}

function closeEditor() {
  editorDialog.close();
}

async function saveRecipe(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  error = '';
  try {
    await request('/recipes', {
      method: 'POST',
      body: JSON.stringify({
        name: draft.name,
        description: draft.description,
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        code: draft.code,
        capabilities: draft.capabilities
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        status: 'enabled',
        visibility: 'private',
        sourceRunId: null,
      }),
    });
    closeEditor();
    message = `${draft.name} saved and ready`;
    await refresh();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not save recipe';
  } finally {
    busy = false;
  }
}

function openConfirmation(kind: ConfirmationKind, recipe: Recipe) {
  confirmation = { kind, recipe };
  confirmationReason = '';
  confirmationError = '';
  showDialog(confirmationDialog);
}

function closeConfirmation() {
  confirmation = null;
  confirmationReason = '';
  confirmationError = '';
}

function confirmationNeedsReason(): boolean {
  return confirmation?.kind === 'reject' || confirmation?.kind === 'request-revision';
}

function confirmationTitle(): string {
  switch (confirmation?.kind) {
    case 'approve':
      return 'Approve recipe version';
    case 'reject':
      return 'Reject recipe version';
    case 'request-revision':
      return 'Request a revision';
    case 'delete':
      return 'Delete recipe';
    default:
      return 'Confirm action';
  }
}

function confirmationDescription(): string {
  if (!confirmation) return '';
  const version = `version ${confirmation.recipe.version}`;
  switch (confirmation.kind) {
    case 'approve':
      return `Approve ${confirmation.recipe.name} ${version} for use.`;
    case 'reject':
      return `Reject ${confirmation.recipe.name} ${version}. This decision is recorded with your reason.`;
    case 'request-revision':
      return `Send ${confirmation.recipe.name} ${version} back for revision.`;
    case 'delete':
      return `Permanently delete ${confirmation.recipe.name} ${version}. This cannot be undone.`;
  }
}

function confirmationSubmitLabel(): string {
  switch (confirmation?.kind) {
    case 'approve':
      return 'Approve version';
    case 'reject':
      return 'Reject version';
    case 'request-revision':
      return 'Request revision';
    case 'delete':
      return 'Delete recipe';
    default:
      return 'Continue';
  }
}

function confirmationButtonClass(): 'primary' | 'danger' {
  return confirmation?.kind === 'approve' || confirmation?.kind === 'request-revision'
    ? 'primary'
    : 'danger';
}

async function submitConfirmation(event: SubmitEvent) {
  event.preventDefault();
  const currentConfirmation = confirmation;
  if (!currentConfirmation) return;

  const reason = confirmationReason.trim();
  if (confirmationNeedsReason() && !reason) {
    confirmationError = 'Add a reason before continuing.';
    return;
  }

  busy = true;
  error = '';
  confirmationError = '';
  try {
    if (currentConfirmation.kind === 'delete') {
      await request(`/recipe/${encodeURIComponent(currentConfirmation.recipe.name)}`, {
        method: 'DELETE',
      });
      message = `${currentConfirmation.recipe.name} deleted`;
    } else {
      const recipeDigest = diff?.current.recipeDigest ?? currentConfirmation.recipe.recipeDigest;
      if (!recipeDigest) throw new Error('Recipe digest is unavailable. Refresh and try again.');
      const result = await request<{ receipt: { digest: string } }>(
        `/recipe/${encodeURIComponent(currentConfirmation.recipe.name)}/approval`,
        {
          method: 'POST',
          body: JSON.stringify({
            action: currentConfirmation.kind,
            version: currentConfirmation.recipe.version,
            recipeDigest,
            ...(reason ? { reason } : {}),
          }),
        },
      );
      message = `${currentConfirmation.recipe.name}: ${currentConfirmation.kind.replace('-', ' ')} receipt ${result.receipt.digest}`;
    }
    closeDetails();
    confirmationDialog.close();
    await refresh();
  } catch (caught) {
    const actionError = caught instanceof Error ? caught.message : 'Could not update the recipe';
    error = actionError;
    confirmationError = actionError;
  } finally {
    busy = false;
  }
}

function isActive(recipe: Recipe): boolean {
  return recipe.status === 'enabled' && (recipe.retrievalCount ?? 0) > 0;
}

function dateValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortRecipes(items: Recipe[]): Recipe[] {
  const descending = sortMode.endsWith('desc');
  const field: 'createdAt' | 'updatedAt' = sortMode.startsWith('created')
    ? 'createdAt'
    : 'updatedAt';
  return items.slice().sort((a, b) => {
    const difference = dateValue(a[field]) - dateValue(b[field]);
    return (descending ? -difference : difference) || a.name.localeCompare(b.name);
  });
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function activityLabel(recipe: Recipe): string {
  if (!recipe.lastRetrievedAt) return 'Never retrieved';
  const elapsed = Date.now() - new Date(recipe.lastRetrievedAt).getTime();
  const minutes = Math.max(1, Math.floor(elapsed / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function creatorLabel(recipe: Recipe): string {
  return recipe.author || 'Creator unavailable from this API';
}

function visibilityLabel(recipe: Recipe): string {
  return recipe.visibility === 'shared' ? 'Shared with workspace' : 'Private to workspace';
}

function workspaceLabel(): string {
  return workspaceOwner || 'Connected Pantry workspace';
}

function roleLabel(role: WorkspaceRole): string {
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

function membershipValidity(membership: WorkspaceMembership): string {
  if (membership.revoked_at) return 'Revoked';
  if (membership.valid_until) return `Ends ${formatDate(membership.valid_until)}`;
  return `Active since ${formatDate(membership.valid_from)}`;
}

function folderParentName(folder: WorkspaceFolder): string {
  if (!folder.parent_id) return 'Top level';
  return (
    folders.find((candidate) => candidate.id === folder.parent_id)?.display_name ??
    'Parent unavailable'
  );
}

$: workspaceFoundationEnabled = workspaceSession !== null;
$: currentWorkspaceRole = workspaceSession?.role ?? null;
$: retrievals = recipes.reduce((total, recipe) => total + (recipe.retrievalCount ?? 0), 0);
$: activeCount = recipes.filter(isActive).length;
$: visibleRecipes = sortRecipes(
  filter === 'review' ? pending : filter === 'active' ? recipes.filter(isActive) : recipes,
);
$: recentRecipes = recipes
  .slice()
  .sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt))
  .slice(0, 8);
$: folderLabels = [...new Set(recipes.flatMap((recipe) => recipe.tags ?? []))].sort();
</script>

<svelte:head>
  <title>Pantry · team recipes</title>
</svelte:head>

{#if sessionState === 'denied'}
  <main class="auth-shell">
    <section class="auth-card" aria-labelledby="access-title">
      <div class="brand-mark" aria-hidden="true">P</div>
      <p class="eyebrow">Pantry team workspace</p>
      <h1 id="access-title">Sign in with your organization.</h1>
      <p class="lede">Use your Cloudflare Access SSO session to open this workspace and review recipes.</p>
      <p class="error" role="alert">{error || 'Cloudflare Access session required.'}</p>
      <button class="primary" type="button" on:click={loadSession}>Check SSO session</button>
    </section>
  </main>
{:else}
  <div class="app-shell" class:app-shell-hydrating={hydrationVisible}>
    <aside class="sidebar" aria-label="Workspace navigation">
      <div class="sidebar-top">
        <div class="brand-lockup">
          <span class="brand-mark" aria-hidden="true">P</span>
          <span>Pantry</span>
        </div>
        <div class="workspace-identity">
          <span class="workspace-label">Workspace</span>
          <strong>{workspaceLabel()}</strong>
          <span class="workspace-subtitle">Team recipe library</span>
        </div>
        <nav class="sidebar-nav" aria-label="Primary navigation">
          {#each navigation as item}
            <button class:active={activeView === item.id} type="button" on:click={() => changeView(item.id)}>
              <span class="nav-symbol" aria-hidden="true">{item.label.slice(0, 1)}</span>
              <span>{item.label}</span>
              {#if item.id === 'recipes' && pending.length > 0}<b>{pending.length}</b>{/if}
            </button>
          {/each}
        </nav>
      </div>
      <div class="sidebar-footer">
        <span class="session-chip" title={principal}>
          <span class="status-dot" aria-hidden="true"></span>
          <span>{principal || 'SSO session connected'}</span>
        </span>
        <button class="text-button" type="button" on:click={openSetup}>MCP &amp; SSO access</button>
      </div>
    </aside>

    <main class="main-content">
      <header class="mobile-header">
        <div class="brand-lockup">
          <span class="brand-mark" aria-hidden="true">P</span>
          <div><strong>Pantry</strong><span>{workspaceLabel()}</span></div>
        </div>
        <span class="mobile-status" aria-label="SSO session connected"></span>
      </header>

      {#if message}<div class="toast" role="status">{message}</div>{/if}
      {#if error}
        <div class="error-banner" role="alert">
          <span>{error}</span>
          <button class="banner-action" type="button" disabled={busy} on:click={refresh}>Try again</button>
        </div>
      {/if}

      {#if activeView === 'recipes'}
        <section class="page-intro" aria-labelledby="recipes-title">
          <div>
            <p class="eyebrow">{workspaceLabel()}</p>
            <h1 id="recipes-title">Recipes</h1>
            <p>One shared place to create, review, and retrieve your team’s recipes.</p>
          </div>
          <div class="page-actions">
            <button class="secondary" type="button" on:click={openSetup}>MCP &amp; SSO</button>
            {#if !workspaceFoundationEnabled}<button class="primary" type="button" on:click={openCreate}>New recipe</button>{/if}
          </div>
        </section>

        {#if workspaceFoundationEnabled}
          <section class="team-card workspace-recipe-access" aria-labelledby="recipe-access-title">
            <div class="card-heading"><div><span class="section-kicker">Workspace recipe access</span><h2 id="recipe-access-title">{currentWorkspaceRole ? roleLabel(currentWorkspaceRole) : 'Workspace'} access</h2></div><span class="role-chip">Foundation enabled</span></div>
            <dl class="access-grid"><div><dt>Signed-in actor</dt><dd>{principal}</dd></div><div><dt>Create recipes</dt><dd>{workspaceSession?.capabilities.canWrite ? 'Permitted by your role' : 'Not permitted by your role'}</dd></div><div><dt>Review recipes</dt><dd>{workspaceSession?.capabilities.canReview ? 'Permitted by your role' : 'Not permitted by your role'}</dd></div><div><dt>Manage workspace</dt><dd>{workspaceSession?.capabilities.canManageMembers || workspaceSession?.capabilities.canManageFolders ? 'Administrator access' : 'Not permitted by your role'}</dd></div></dl>
            <div class="honest-state"><strong>Recipe inventory is not exposed by the workspace foundation APIs yet.</strong><span>This workspace view does not fall back to owner-scoped recipe APIs, so it cannot misstate recipe authorship, folder placement, or access.</span></div>
          </section>
        {:else}
        <section class="workspace-summary" aria-label="Workspace summary">
          <div><span>Recipe library</span><strong>{recipes.length}</strong><small>Recipes in this workspace</small></div>
          <div><span>Needs review</span><strong>{pending.length}</strong><small>Awaiting an approval decision</small></div>
          <div><span>Retrieved</span><strong>{retrievals}</strong><small>Successful retrievals recorded</small></div>
        </section>

        <section class="resource-card" aria-label="Recipe inventory">
          <div class="list-toolbar">
            <div class="filters" role="group" aria-label="Filter recipes">
              <button class:active={filter === 'all'} type="button" on:click={() => (filter = 'all')}>All <span>{recipes.length}</span></button>
              <button class:active={filter === 'review'} type="button" on:click={() => (filter = 'review')}>Needs review <span>{pending.length}</span></button>
              <button class:active={filter === 'active'} type="button" on:click={() => (filter = 'active')}>Active <span>{activeCount}</span></button>
            </div>
            <div class="toolbar-controls">
              <label class="sort-control">
                <span>Sort recipes</span>
                <select bind:value={sortMode} aria-label="Sort recipes">
                  <option value="updated-desc">Last updated, newest</option>
                  <option value="updated-asc">Last updated, oldest</option>
                  <option value="created-desc">Created, newest</option>
                  <option value="created-asc">Created, oldest</option>
                </select>
              </label>
              <button class:spinning={busy} class="refresh" type="button" on:click={refresh} disabled={busy} aria-label={busy ? 'Refreshing recipes' : 'Refresh recipes'}>
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 3a5 5 0 1 0 4.546 2.914l1.06-.53A6.25 6.25 0 1 1 8 1.75V.4l3 1.85-3 1.85V3Z"/></svg>
                <span>{busy ? 'Refreshing' : 'Refresh'}</span>
              </button>
            </div>
          </div>

          {#if visibleRecipes.length === 0}
            <div class="empty">
              <strong>{filter === 'review' ? 'Nothing needs review' : filter === 'active' ? 'No retrievals yet' : 'No recipes yet'}</strong>
              <span>{filter === 'review' ? 'New and changed recipes appear here before approval.' : filter === 'active' ? 'A recipe becomes active once a caller retrieves an approved version.' : 'Create your first recipe to start the approval loop.'}</span>
              {#if filter === 'all'}<button class="secondary" type="button" on:click={openCreate}>Create recipe</button>{/if}
            </div>
          {:else}
            <div class="resource-list">
              {#each visibleRecipes as recipe}
                <article class:selected={selected?.name === recipe.name} class="resource-row">
                  <button class="resource-select" type="button" aria-pressed={selected?.name === recipe.name} on:click={() => selectRecipe(recipe)}>
                    <span class="resource-main">
                      <span class="recipe-title-line"><strong>{recipe.name}</strong><span class:shared={recipe.visibility === 'shared'} class="visibility-pill">{recipe.visibility === 'shared' ? 'Shared' : 'Private'}</span></span>
                      <span>{recipe.description}</span>
                      <span class="row-capabilities">{recipe.capabilities.join(' · ')}</span>
                    </span>
                    <span class="resource-meta">
                      <span class="badge badge-{recipe.status}">{recipe.status}</span>
                      <span>Created by {creatorLabel(recipe)}</span>
                      <span>Last editor unavailable</span>
                      <span>{recipe.retrievalCount ?? 0} retrievals</span>
                      <span>Updated {formatDate(recipe.updatedAt)}</span>
                    </span>
                  </button>
                  <div class="row-actions" aria-label={`Actions for ${recipe.name}`}>
                    <button class="row-action" type="button" on:click={() => selectRecipe(recipe)}>Details</button>
                    <button class="row-action" type="button" on:click={() => openEdit(recipe)}>Create revision</button>
                  </div>
                </article>
              {/each}
            </div>
          {/if}
        </section>
        {/if}
      {:else if activeView === 'people'}
        <section class="page-intro" aria-labelledby="people-title">
          <div>
            <p class="eyebrow">Workspace access</p>
            <h1 id="people-title">People</h1>
            <p>People enter this Pantry workspace through your organization’s Cloudflare Access SSO policy.</p>
          </div>
        </section>
        {#if workspaceFoundationEnabled}
          <div class="content-grid workspace-people-grid">
            <section class="team-card">
              <div class="card-heading"><div><span class="section-kicker">Your workspace membership</span><h2>{principal}</h2></div><span class="role-chip">{currentWorkspaceRole ? roleLabel(currentWorkspaceRole) : 'Loading role'}</span></div>
              <dl><div><dt>Access subject</dt><dd>Verified by Cloudflare Access</dd></div><div><dt>Member management</dt><dd>{workspaceSession?.capabilities.canManageMembers ? 'Allowed' : 'Not allowed'}</dd></div><div><dt>Folder management</dt><dd>{workspaceSession?.capabilities.canManageFolders ? 'Allowed' : 'Not allowed'}</dd></div></dl>
            </section>
            <section class="team-card invite-card">
              <span class="section-kicker">Invite people</span>
              <h2>{workspaceSession?.capabilities.canManageMembers ? 'Create an invitation' : 'Administrator access required'}</h2>
              <p>{workspaceSession?.capabilities.canManageMembers ? 'Create a time-limited invitation for a verified Access subject. Pantry returns a one-time token but this UI never displays or stores it.' : 'Only workspace administrators can create invitations or read membership records.'}</p>
              {#if workspaceSession?.capabilities.canManageMembers}<button class="primary" type="button" on:click={openInvite}>Invite person</button>{/if}
              {#if invitationResult}<p class="success-text" role="status">{invitationResult}</p>{/if}
            </section>
            <section class="team-card role-card">
              <span class="section-kicker">Membership records</span>
              <h2>{workspaceSession?.capabilities.canManageMembers ? 'Workspace roles' : 'Role visibility is restricted'}</h2>
              {#if !workspaceSession?.capabilities.canManageMembers}
                <p>Pantry confirms your own {currentWorkspaceRole} role. Other memberships are intentionally not returned to non-administrators.</p>
              {:else if membershipsState === 'loading'}
                <div class="inline-loading" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>Loading membership records</span></div>
              {:else if membershipsState === 'error'}
                <div class="inline-error" role="alert"><span>{membershipsError}</span><button class="banner-action" type="button" on:click={loadMemberships}>Try again</button></div>
              {:else if memberships.length === 0}
                <div class="empty compact"><strong>No membership records</strong><span>There are no active or historical membership rows to display.</span></div>
              {:else}
                <div class="membership-list">
                  {#each memberships as membership}
                    <div class="membership-row"><div><strong>{membership.actor_id}</strong><span>{membership.source}</span></div><span class="role-chip">{roleLabel(membership.role)}</span><small>{membershipValidity(membership)}</small></div>
                  {/each}
                </div>
                <p class="helper-text">Membership records expose actor IDs, not an inferred people directory.</p>
              {/if}
            </section>
          </div>
        {:else}
          <div class="content-grid">
            <section class="team-card">
              <div class="card-heading"><div><span class="section-kicker">Current membership</span><h2>Who can access this workspace</h2></div><span class="role-chip">SSO managed</span></div>
              <div class="person-row">
                <span class="person-avatar" aria-hidden="true">{(principal || 'S').slice(0, 1).toUpperCase()}</span>
                <div><strong>{principal || 'Current SSO member'}</strong><span>Current signed-in member</span></div>
                <span class="role-chip">Role unavailable</span>
              </div>
              <p class="helper-text">This API identifies the signed-in person but does not expose a member directory or role assignments. Pantry cannot infer who else belongs to the workspace.</p>
            </section>
            <section class="team-card invite-card">
              <span class="section-kicker">Invite people</span>
              <h2>Managed outside Pantry</h2>
              <p>Invitations are not sent or stored by this UI. Ask a workspace administrator to add people or groups to the Cloudflare Access SSO policy.</p>
              <button class="secondary" type="button" on:click={openSetup}>View SSO access guidance</button>
            </section>
            <section class="team-card role-card">
              <span class="section-kicker">Roles</span>
              <h2>What roles mean today</h2>
              <dl><div><dt>Workspace access</dt><dd>Granted by the Cloudflare Access policy.</dd></div><div><dt>Recipe approvals</dt><dd>Recorded against the signed-in SSO identity.</dd></div><div><dt>Directory roles</dt><dd>Not available from the current Pantry API.</dd></div></dl>
            </section>
          </div>
        {/if}
      {:else if activeView === 'folders'}
        <section class="page-intro" aria-labelledby="folders-title">
          <div><p class="eyebrow">Organization</p><h1 id="folders-title">Folders</h1><p>Keep track of the labels currently attached to recipes in {workspaceLabel()}.</p></div>
        </section>
        {#if workspaceFoundationEnabled}
          <section class="team-card folder-card">
            <div class="card-heading"><div><span class="section-kicker">Workspace folders</span><h2>Folder organization</h2></div>{#if workspaceSession?.capabilities.canManageFolders}<button class="secondary" type="button" on:click={openFolderCreator}>New folder</button>{:else}<span class="role-chip">Read only</span>{/if}</div>
            {#if foldersState === 'loading'}
              <div class="inline-loading" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>Loading folders</span></div>
            {:else if foldersState === 'error'}
              <div class="inline-error" role="alert"><span>{foldersError}</span><button class="banner-action" type="button" on:click={loadFolders}>Try again</button></div>
            {:else if folders.length}
              <div class="workspace-folder-list">
                {#each folders as folder}
                  <div class="workspace-folder-row"><div><strong>{folder.display_name}</strong><span>/{folder.slug}</span></div><span>{folderParentName(folder)}</span></div>
                {/each}
              </div>
            {:else}
              <div class="empty compact"><strong>No folders yet</strong><span>{workspaceSession?.capabilities.canManageFolders ? 'Create the first workspace folder to organize future recipe records.' : 'An administrator can create workspace folders.'}</span></div>
            {/if}
          </section>
        {:else}
          <section class="team-card folder-card">
            <div class="card-heading"><div><span class="section-kicker">Recipe labels</span><h2>Available organization signals</h2></div><span class="role-chip">Read only</span></div>
            {#if folderLabels.length}
              <div class="folder-list">{#each folderLabels as label}<span class="folder-pill">{label}</span>{/each}</div>
              <p class="helper-text">These are existing recipe tags. Pantry does not currently provide folder creation, membership, or folder permissions through this API.</p>
            {:else}
              <div class="empty compact"><strong>No folder labels yet</strong><span>Recipes can carry tags, but folders are not persisted or managed by the current API.</span></div>
            {/if}
          </section>
        {/if}
      {:else if activeView === 'activity'}
        <section class="page-intro" aria-labelledby="activity-title">
          <div><p class="eyebrow">Workspace history</p><h1 id="activity-title">Activity</h1><p>Recent recipe updates and retrieval signals available from Pantry.</p></div>
          <button class="secondary" type="button" on:click={refresh} disabled={busy}>Refresh activity</button>
        </section>
        <section class="team-card activity-card">
          {#if workspaceFoundationEnabled}
            <div class="honest-state"><strong>Workspace activity is not exposed by the foundation APIs yet.</strong><span>Recipe and access events are not inferred from membership or folder records.</span></div>
          {:else if recentRecipes.length}
            <div class="activity-list">
              {#each recentRecipes as recipe}
                <button type="button" class="activity-row" on:click={() => { activeView = 'recipes'; selectRecipe(recipe); }}>
                  <span class="activity-mark" aria-hidden="true">R</span>
                  <span><strong>{recipe.name}</strong><span>Updated {formatDate(recipe.updatedAt)} · {visibilityLabel(recipe)}</span></span>
                  <span class="activity-side">{recipe.lastRetrievedAt ? `Retrieved ${activityLabel(recipe)}` : 'Not retrieved'}</span>
                </button>
              {/each}
            </div>
          {:else}
            <div class="empty compact"><strong>No activity yet</strong><span>Recipe updates and retrievals will appear here after the library has content.</span></div>
          {/if}
        </section>
      {:else}
        <section class="page-intro" aria-labelledby="settings-title">
          <div><p class="eyebrow">Workspace preferences</p><h1 id="settings-title">Settings</h1><p>Connection and workspace details for this Pantry team.</p></div>
        </section>
        <div class="content-grid">
          <section class="team-card"><span class="section-kicker">Workspace</span><h2>{workspaceLabel()}</h2><dl><div><dt>Signed in as</dt><dd>{principal || 'SSO session connected'}</dd></div>{#if currentWorkspaceRole}<div><dt>Workspace role</dt><dd>{roleLabel(currentWorkspaceRole)}</dd></div>{/if}<div><dt>Authentication</dt><dd>Cloudflare Access SSO</dd></div><div><dt>Recipe service</dt><dd>Pantry stores and returns recipes; it does not run them.</dd></div></dl></section>
          <section class="team-card"><span class="section-kicker">MCP access</span><h2>Use organization sign-on</h2><p>Connect through the SSO-enabled Pantry environment your team has approved. This workspace does not display or distribute personal credentials.</p><button class="secondary" type="button" on:click={openSetup}>MCP &amp; SSO guidance</button></section>
        </div>
      {/if}
    </main>

    <nav class="mobile-nav" aria-label="Primary navigation">
      {#each navigation as item}
        <button class:active={activeView === item.id} type="button" on:click={() => changeView(item.id)}>
          <span class="nav-symbol" aria-hidden="true">{item.label.slice(0, 1)}</span>
          <span>{item.shortLabel}</span>
        </button>
      {/each}
    </nav>
    {#if hydrationVisible}
      <div class:exiting={sessionState === 'connected'} class="hydration-overlay" role="status" aria-live="polite">
        <div class="hydration-indicator"><span class="loading-spinner" aria-hidden="true"></span><span>{loadingPhase}</span></div>
      </div>
    {/if}
  </div>
{/if}

<dialog bind:this={setupDialog} class="modal setup-modal" aria-labelledby="mcp-setup-title">
  <div class="modal-header"><div><p class="eyebrow">Workspace connection</p><h2 id="mcp-setup-title">MCP access uses SSO</h2><p class="modal-description">Connect to the Pantry environment approved by your organization and authenticate through Cloudflare Access.</p></div><button class="icon-close" type="button" on:click={() => setupDialog.close()} aria-label="Close MCP access guidance">×</button></div>
  <div class="setup-content">
    <section class="setup-panel"><strong>1. Start with your organization sign-on</strong><span>Open the approved Pantry URL in your browser and complete Cloudflare Access SSO. Your workspace access follows that organization policy.</span></section>
    <section class="setup-panel"><strong>2. Use an administrator-approved MCP connection</strong><span>Your team administrator can provide the approved MCP client setup and any required scoped agent identity. This UI does not create, show, or store credentials.</span></section>
    <section class="setup-panel"><strong>3. Keep access centralized</strong><span>To add or remove people, update the Cloudflare Access policy or its identity-provider groups. Pantry invitations and role changes are not persisted here.</span></section>
    <div class="modal-actions"><button class="primary" type="button" on:click={() => setupDialog.close()}>Done</button></div>
  </div>
</dialog>

<dialog bind:this={inviteDialog} class="modal confirmation-modal" aria-labelledby="invite-title">
  <div class="modal-header"><div><p class="eyebrow">Workspace invitation</p><h2 id="invite-title">Invite an Access subject</h2><p class="modal-description">Use the verified Access subject identifier, not an email address inferred by this UI.</p></div><button class="icon-close" type="button" on:click={() => inviteDialog.close()} aria-label="Close invitation form">×</button></div>
  <form on:submit={createInvitation}>
    <label for="invite-subject">Access subject</label><input id="invite-subject" bind:value={inviteTargetAccessSubject} required maxlength="256" autocomplete="off" />
    <label for="invite-role">Workspace role</label><select id="invite-role" bind:value={inviteRole}><option value="contributor">Contributor</option><option value="reviewer">Reviewer</option><option value="admin">Administrator</option></select>
    {#if workspaceActionError}<p class="form-error" role="alert">{workspaceActionError}</p>{/if}
    <div class="modal-actions"><button class="secondary" type="button" on:click={() => inviteDialog.close()}>Cancel</button><button class="primary" type="submit" disabled={busy}>Create invitation</button></div>
  </form>
</dialog>

<dialog bind:this={folderDialog} class="modal confirmation-modal" aria-labelledby="folder-title">
  <div class="modal-header"><div><p class="eyebrow">Workspace folder</p><h2 id="folder-title">Create folder</h2><p class="modal-description">Folders are created in the active workspace and require administrator access.</p></div><button class="icon-close" type="button" on:click={() => folderDialog.close()} aria-label="Close folder form">×</button></div>
  <form on:submit={createFolder}>
    <label for="folder-name">Display name</label><input id="folder-name" bind:value={folderDisplayName} required maxlength="128" />
    <label for="folder-slug">Slug</label><input id="folder-slug" bind:value={folderSlug} pattern={'[a-z][a-z0-9-]{0,63}'} required maxlength="64" aria-describedby="folder-slug-help" />
    <span id="folder-slug-help" class="field-help">Lowercase letters, numbers, and hyphens; starts with a letter.</span>
    <label for="folder-parent">Parent folder</label><select id="folder-parent" bind:value={folderParentId}><option value="">Top level</option>{#each folders as folder}<option value={folder.id}>{folder.display_name}</option>{/each}</select>
    {#if workspaceActionError}<p class="form-error" role="alert">{workspaceActionError}</p>{/if}
    <div class="modal-actions"><button class="secondary" type="button" on:click={() => folderDialog.close()}>Cancel</button><button class="primary" type="submit" disabled={busy}>Create folder</button></div>
  </form>
</dialog>

<dialog bind:this={detailDialog} class="modal detail-modal" aria-labelledby="detail-title" on:close={clearDetails}>
  {#if selected}
    <div class="detail-header"><div><p class="eyebrow">Version {selected.version}</p><h2 id="detail-title">{selected.name}</h2></div><button class="icon-close" type="button" on:click={closeDetails} aria-label="Close recipe details">×</button></div>
    {#if detailLoading}
      <div class="detail-loading" role="status" aria-live="polite"><span class="loading-spinner" aria-hidden="true"></span><span>Loading recipe details</span></div>
    {:else if diff}
      <p class="detail-description">{selected.description}</p>
      <div class="detail-grid">
        <div><span>Status</span><strong class="badge badge-{selected.status}">{selected.status}</strong></div>
        <div><span>Sharing</span><strong>{visibilityLabel(selected)}</strong></div>
        <div><span>Creator</span><strong>{creatorLabel(selected)}</strong></div>
        <div><span>Last editor</span><strong>Unavailable from this API</strong></div>
        <div><span>Version</span><strong>{selected.version}</strong></div>
        <div><span>Retrievals</span><strong>{selected.retrievalCount ?? 0}</strong></div>
        <div><span>Created</span><strong>{formatDate(selected.createdAt)}</strong></div>
        <div><span>Last updated</span><strong>{formatDate(selected.updatedAt)}</strong></div>
      </div>
      <div class="capability-block" class:changed={diff.capabilitiesChanged && Boolean(diff.previous)}>
        <span class="capability-label">Capabilities this recipe requests{#if diff.capabilitiesChanged && diff.previous}<em>Changed since approval</em>{/if}</span>
        <div class="capability-tags">{#each selected.capabilities as capability}<code class="capability-tag">{capability}</code>{/each}</div>
        {#if diff.previous && diff.capabilitiesChanged}<div class="capability-previous"><span>Previously approved</span><div class="capability-tags">{#each diff.previous.capabilities as capability}<code class="capability-tag muted">{capability}</code>{/each}</div></div>{/if}
      </div>
      {#if diff.previous}<div class="change-summary"><strong>Changes since approval</strong><span>Source changed: {diff.sourceChanged ? 'Yes' : 'No'}</span><span>Capabilities changed: {diff.capabilitiesChanged ? 'Yes' : 'No'}</span></div>{/if}
      <details open><summary>Current source</summary><pre>{diff.current.code}</pre></details>
      {#if diff.previous}<details><summary>Previous approved source</summary><pre>{diff.previous.sourceCode}</pre></details>{/if}
      {#if selected.status === 'pending'}<div class="actions" aria-label="Approval actions"><button class="primary" type="button" disabled={busy} on:click={() => openConfirmation('approve', selected!)}>Approve</button><button class="secondary" type="button" disabled={busy} on:click={() => openConfirmation('request-revision', selected!)}>Request revision</button><button class="danger" type="button" disabled={busy} on:click={() => openConfirmation('reject', selected!)}>Reject</button></div>{/if}
      <div class="detail-footer"><button class="quiet" type="button" on:click={() => openEdit(selected!)}>Create revision</button><button class="danger-link" type="button" on:click={() => openConfirmation('delete', selected!)}>Delete recipe</button></div>
    {:else}
      <div class="detail-error" role="alert"><strong>Recipe details are unavailable</strong><span>{error || 'Refresh the recipe inventory and try again.'}</span><button class="secondary" type="button" disabled={busy} on:click={() => selectRecipe(selected!)}>Try again</button></div>
    {/if}
  {/if}
</dialog>

<dialog bind:this={editorDialog} class="modal editor-modal" aria-labelledby="editor-title" on:close={() => (editing = false)}>
  <div class="modal-header"><div><p class="eyebrow">{editing ? 'Create revision' : 'New recipe'}</p><h2 id="editor-title">{editing ? draft.name : 'Create recipe'}</h2><p class="modal-description">{editing ? 'Save changes as a new immutable recipe version.' : 'Add source and capabilities for a new recipe.'}</p></div><button class="icon-close" type="button" on:click={closeEditor} aria-label="Close recipe editor">×</button></div>
  <form on:submit={saveRecipe}>
    <label for="name">Name</label><input id="name" bind:value={draft.name} pattern={'[a-zA-Z][a-zA-Z0-9_]{0,63}'} required disabled={editing} />
    <label for="description">Description</label><input id="description" bind:value={draft.description} minlength="5" maxlength="500" required />
    <label for="capabilities">Capabilities <span>Comma separated</span></label><input id="capabilities" bind:value={draft.capabilities} required />
    <label for="code">Source</label><textarea id="code" bind:value={draft.code} rows="9" required></textarea>
    <div class="modal-actions"><button class="secondary" type="button" on:click={closeEditor}>Cancel</button><button class="primary" type="submit" disabled={busy}>Save recipe</button></div>
  </form>
</dialog>

<dialog bind:this={confirmationDialog} class="modal confirmation-modal" aria-labelledby="confirmation-title" on:close={closeConfirmation}>
  <div class="modal-header"><div><p class="eyebrow">Recipe action</p><h2 id="confirmation-title">{confirmationTitle()}</h2></div><button class="icon-close" type="button" on:click={() => confirmationDialog.close()} aria-label="Close confirmation">×</button></div>
  <form on:submit={submitConfirmation}>
    <p class="modal-description">{confirmationDescription()}</p>
    {#if confirmationNeedsReason()}<label for="confirmation-reason">Reason</label><textarea id="confirmation-reason" bind:value={confirmationReason} rows="4" required aria-describedby="confirmation-reason-help"></textarea><span id="confirmation-reason-help" class="field-help">This reason is included in the approval record.</span>{/if}
    {#if confirmationError}<p class="form-error" role="alert">{confirmationError}</p>{/if}
    <div class="modal-actions"><button class="secondary" type="button" on:click={() => confirmationDialog.close()}>Cancel</button><button class={confirmationButtonClass()} type="submit" disabled={busy}>{confirmationSubmitLabel()}</button></div>
  </form>
</dialog>
