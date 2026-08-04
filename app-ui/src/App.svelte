<script lang="ts">
import { onMount } from 'svelte';

type Recipe = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  code?: string;
  capabilities: string[];
  status: string;
  version: number;
  recipeDigest?: string | null;
  approvedVersion?: number | null;
  approvedDigest?: string | null;
  runCount?: number;
  lastRunAt?: string | null;
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

let principal = '';
let sessionState: 'loading' | 'connected' | 'denied' = 'loading';
type Filter = 'all' | 'review' | 'active';

let filter: Filter = 'all';
let recipes: Recipe[] = [];
let pending: Recipe[] = [];
let selected: Recipe | null = null;
let diff: ApprovalDiff | null = null;
let draft: Draft = {
  name: '',
  description: '',
  code: 'return { value: ctx.input.text };',
  capabilities: 'text.transform',
};
let editorOpen = false;
let editing = false;
let busy = false;
let message = '';
let error = '';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body as T;
}

async function refresh() {
  busy = true;
  error = '';
  try {
    const [inventory, queue] = await Promise.all([
      request<{ recipes: Recipe[] }>('/recipes'),
      request<{ recipes: Recipe[] }>('/api/approvals'),
    ]);
    recipes = inventory.recipes;
    pending = queue.recipes;
    if (selected) {
      selected = recipes.find((recipe) => recipe.name === selected?.name) ?? null;
      if (selected) await selectRecipe(selected);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not load Pantry';
  } finally {
    busy = false;
  }
}

async function loadSession() {
  error = '';
  try {
    const session = await request<{ principal: string }>('/api/session');
    principal = session.principal;
    sessionState = 'connected';
    await refresh();
  } catch (caught) {
    sessionState = 'denied';
    error = caught instanceof Error ? caught.message : 'Cloudflare Access session required';
  }
}

onMount(loadSession);

async function selectRecipe(recipe: Recipe) {
  selected = recipe;
  error = '';
  try {
    diff = await request<ApprovalDiff>(`/recipe/${encodeURIComponent(recipe.name)}/approval-diff`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not load recipe details';
  }
}

function selectFilter(next: Filter) {
  filter = next;
}

function openCreate() {
  editing = false;
  draft = {
    name: '',
    description: '',
    code: 'return { value: ctx.input.text };',
    capabilities: 'text.transform',
  };
  editorOpen = true;
}

function openEdit(recipe: Recipe) {
  editing = true;
  draft = {
    name: recipe.name,
    description: recipe.description,
    code: recipe.code ?? 'return { value: ctx.input.text };',
    capabilities: recipe.capabilities.join(', '),
  };
  editorOpen = true;
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
        status: 'pending',
        visibility: 'private',
        sourceRunId: null,
      }),
    });
    editorOpen = false;
    message = `${draft.name} saved and queued for review`;
    await refresh();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not save recipe';
  } finally {
    busy = false;
  }
}

async function approve(action: 'approve' | 'reject' | 'request-revision') {
  if (!selected || !diff?.current.recipeDigest) return;
  const reason = action === 'approve' ? undefined : (window.prompt('Reason') ?? '');
  if (action !== 'approve' && !reason) return;
  busy = true;
  error = '';
  try {
    const result = await request<{ receipt: { digest: string } }>(
      `/recipe/${encodeURIComponent(selected.name)}/approval`,
      {
        method: 'POST',
        body: JSON.stringify({
          action,
          version: diff.current.version,
          recipeDigest: diff.current.recipeDigest,
          ...(reason ? { reason } : {}),
        }),
      },
    );
    message = `${selected.name}: ${action.replace('-', ' ')} receipt ${result.receipt.digest}`;
    await refresh();
    selected = null;
    diff = null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not update approval';
  } finally {
    busy = false;
  }
}

async function removeRecipe(recipe: Recipe) {
  if (!window.confirm(`Delete ${recipe.name} at version ${recipe.version}?`)) return;
  busy = true;
  error = '';
  try {
    await request(`/recipe/${encodeURIComponent(recipe.name)}`, { method: 'DELETE' });
    message = `${recipe.name} deleted`;
    selected = null;
    diff = null;
    await refresh();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not delete recipe';
  } finally {
    busy = false;
  }
}

function isActive(recipe: Recipe): boolean {
  return recipe.status === 'enabled' && (recipe.runCount ?? 0) > 0;
}

$: reportedUses = recipes.reduce((total, recipe) => total + (recipe.runCount ?? 0), 0);
$: activeCount = recipes.filter(isActive).length;
$: visibleRecipes = (
  filter === 'review' ? pending : filter === 'active' ? recipes.filter(isActive) : recipes
)
  .slice()
  .sort((a, b) => (b.runCount ?? 0) - (a.runCount ?? 0) || b.updatedAt.localeCompare(a.updatedAt));

function activityLabel(recipe: Recipe): string {
  if (!recipe.lastRunAt) return 'never used';
  const elapsed = Date.now() - new Date(recipe.lastRunAt).getTime();
  const minutes = Math.max(1, Math.floor(elapsed / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
</script>

<svelte:head>
  <title>Pantry · recipe operations</title>
</svelte:head>

{#if sessionState === 'denied'}
  <main class="auth-shell">
    <section class="auth-card">
      <div class="brand-mark">P</div>
      <p class="eyebrow">Pantry operations</p>
      <h1>Review recipes before they run.</h1>
      <p class="lede">Cloudflare Access is required to manage immutable recipe versions, approvals, and caller-reported usage.</p>
      <p class="error" role="alert">{error || 'Checking your Cloudflare Access session…'}</p>
    </section>
  </main>
{:else}
  <div class:loading={sessionState === 'loading'} class="app-shell" aria-busy={sessionState === 'loading'}>
    <main class="main-content">
      <header class="page-header">
        <div class="page-title">
          <span class="brand-mark">P</span>
          <div>
            <h1>Recipes</h1>
            <p class="lede">Review recipes before they run. {pending.length} awaiting review · {reportedUses} reported uses</p>
          </div>
        </div>
        <div class="header-actions">
          <span class="session-chip"><span class="status-dot"></span>{principal || 'Checking Access session…'}</span>
          <button class="primary" disabled={sessionState !== 'connected'} on:click={openCreate}>New recipe</button>
        </div>
      </header>

      {#if message}<div class="toast" role="status">{message}</div>{/if}
      {#if error}<div class="error-banner" role="alert">{error}</div>{/if}

      <div class:split={Boolean(selected && diff)} class="workspace-grid">
        <section class="resource-card">
          <div class="list-toolbar">
            <div class="filters" role="group" aria-label="Filter recipes">
              <button class:active={filter === 'all'} on:click={() => selectFilter('all')}>All <span>{recipes.length}</span></button>
              <button class:active={filter === 'review'} on:click={() => selectFilter('review')}>Needs review <span>{pending.length}</span></button>
              <button class:active={filter === 'active'} on:click={() => selectFilter('active')}>Active <span>{activeCount}</span></button>
            </div>
            <button class:spinning={busy} class="refresh" on:click={refresh} disabled={busy} title="Refresh" aria-label={busy ? 'Refreshing recipes' : 'Refresh recipes'}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 3a5 5 0 1 0 4.546 2.914l1.06-.53A6.25 6.25 0 1 1 8 1.75V.4l3 1.85-3 1.85V3Z"/></svg>
            </button>
          </div>
          {#if visibleRecipes.length === 0}
            <div class="empty">
              <strong>{filter === 'review' ? 'Nothing needs review' : filter === 'active' ? 'No reported usage yet' : 'No recipes yet'}</strong>
              <span>{filter === 'review' ? 'New and changed artifacts appear here before execution.' : filter === 'active' ? 'A recipe becomes active once a caller reports using an approved version.' : 'Create your first recipe to start the approval loop.'}</span>
            </div>
          {:else}
            <div class="resource-list">
              {#each visibleRecipes as recipe}
                <button class:selected={selected?.name === recipe.name} class="resource-row" on:click={() => selectRecipe(recipe)}>
                  <span class="resource-main">
                    <strong>{recipe.name}</strong>
                    <span>{recipe.description}</span>
                    <span class="row-capabilities">{recipe.capabilities.join(' · ')}</span>
                  </span>
                  <span class="resource-meta">
                    <span class="badge badge-{recipe.status}">{recipe.status}</span>
                    <span class="usage">{recipe.runCount ?? 0} uses</span>
                    <span>{activityLabel(recipe)}</span>
                    <span>v{recipe.version}</span>
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </section>

        {#if selected && diff}
          <aside class="detail-card" aria-label="Recipe details">
            <div class="detail-header"><div><p class="eyebrow">Version {selected.version}</p><h2>{selected.name}</h2></div><button class="icon-close" on:click={() => (selected = null)} title="Close" aria-label="Close recipe details"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
            <p class="detail-description">{selected.description}</p>
            <div class="detail-grid"><div><span>Status</span><strong class="badge badge-{selected.status}">{selected.status}</strong></div><div><span>Digest</span><code>{selected.recipeDigest?.slice(0, 12) ?? '—'}</code></div><div><span>Version</span><strong>{selected.version}</strong></div><div><span>Reported uses</span><strong>{selected.runCount ?? 0}</strong></div></div>
            <div class="capability-block" class:changed={diff.capabilitiesChanged && Boolean(diff.previous)}>
              <span class="capability-label">Capabilities this recipe requests{#if diff.capabilitiesChanged && diff.previous}<em>changed since approval</em>{/if}</span>
              <div class="capability-tags">
                {#each selected.capabilities as capability}
                  <code class="capability-tag">{capability}</code>
                {/each}
              </div>
              {#if diff.previous && diff.capabilitiesChanged}
                <div class="capability-previous">
                  <span>Previously approved</span>
                  <div class="capability-tags">
                    {#each diff.previous.capabilities as capability}
                      <code class="capability-tag muted">{capability}</code>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>
            {#if diff.previous}<div class="change-summary"><strong>Changes since approval</strong><span>Source changed: {diff.sourceChanged ? 'yes' : 'no'}</span><span>Capabilities changed: {diff.capabilitiesChanged ? 'yes' : 'no'}</span></div>{/if}
            <details open><summary>Current source</summary><pre>{diff.current.code}</pre></details>
            {#if diff.previous}<details><summary>Previous approved source</summary><pre>{diff.previous.sourceCode}</pre></details>{/if}
            {#if selected.status === 'pending'}<div class="actions"><button class="primary" disabled={busy} on:click={() => approve('approve')}>Approve</button><button class="secondary" disabled={busy} on:click={() => approve('request-revision')}>Request revision</button><button class="danger" disabled={busy} on:click={() => approve('reject')}>Reject</button></div>{/if}
            <div class="detail-footer"><button class="quiet" on:click={() => openEdit(selected!)}>Create revision</button><button class="danger-link" on:click={() => removeRecipe(selected!)}>Delete recipe</button></div>
          </aside>
        {/if}
      </div>
    </main>
  </div>
{/if}

{#if editorOpen}
  <div class="modal-backdrop" role="presentation">
    <dialog open class="modal" aria-labelledby="editor-title">
      <div class="detail-header"><div><p class="eyebrow">{editing ? 'Create revision' : 'New artifact'}</p><h2 id="editor-title">{editing ? draft.name : 'Create recipe'}</h2></div><button class="icon-close" on:click={() => (editorOpen = false)} title="Close" aria-label="Close editor"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
      <form on:submit={saveRecipe}>
        <label for="name">Name</label><input id="name" bind:value={draft.name} pattern={'[a-zA-Z][a-zA-Z0-9_]{0,63}'} required disabled={editing} />
        <label for="description">Description</label><input id="description" bind:value={draft.description} minlength="5" maxlength="500" required />
        <label for="capabilities">Capabilities <span>comma separated</span></label><input id="capabilities" bind:value={draft.capabilities} required />
        <label for="code">Source</label><textarea id="code" bind:value={draft.code} rows="9" required></textarea>
        <div class="modal-actions"><button class="secondary" type="button" on:click={() => (editorOpen = false)}>Cancel</button><button class="primary" type="submit" disabled={busy}>Save as pending</button></div>
      </form>
    </dialog>
  </div>
{/if}
