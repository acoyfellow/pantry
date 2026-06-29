// A tiny pantry client usable from terrarium, Pi, or a Worker.
//
// It reads PANTRY_URL + PANTRY_TOKEN from the environment by default. If either
// is unset it fails soft: list() returns [], get()/push() throw a clear,
// actionable error instead of making an unauthenticated request.
//
// The client only TRANSPORTS recipes. Deciding whether to run a fetched recipe,
// and in what sandbox, is the caller's trust decision. See examples/run-recipe.ts.

import type { FullRecipe, RecipeInput, RecipeListEntry } from './recipe.ts';

export type PantryConfig = {
  url?: string;
  token?: string;
  // Injectable for tests / Worker service bindings. Defaults to global fetch.
  fetch?: typeof fetch;
};

export class PantryClient {
  private url: string | undefined;
  private token: string | undefined;
  private fetchImpl: typeof fetch;

  constructor(config: PantryConfig = {}) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    this.url = (config.url ?? env?.PANTRY_URL)?.replace(/\/$/, '');
    this.token = config.token ?? env?.PANTRY_TOKEN;
    this.fetchImpl = config.fetch ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.url && this.token);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    };
  }

  private require(): void {
    if (!this.url) throw new Error('pantry client: PANTRY_URL is not set');
    if (!this.token) throw new Error('pantry client: PANTRY_TOKEN is not set');
  }

  // Fail-soft: an unconfigured client lists nothing rather than erroring, so a
  // recipe lookup degrades to "re-reason it" instead of crashing the caller.
  async list(options: { scope?: 'owner' | 'shared' } = {}): Promise<RecipeListEntry[]> {
    if (!this.configured) return [];
    const suffix = options.scope === 'shared' ? '?scope=shared' : '';
    const res = await this.fetchImpl(`${this.url}/recipes${suffix}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`pantry list failed: ${res.status}`);
    const body = (await res.json()) as { recipes: RecipeListEntry[] };
    return body.recipes ?? [];
  }

  async listShared(): Promise<RecipeListEntry[]> {
    return this.list({ scope: 'shared' });
  }

  // Returns the full recipe including code + capabilities + inputSchema.
  // The caller decides whether to run `code`.
  async get(name: string): Promise<FullRecipe | null> {
    this.require();
    const res = await this.fetchImpl(`${this.url}/recipe/${encodeURIComponent(name)}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`pantry get failed: ${res.status}`);
    return (await res.json()) as FullRecipe;
  }

  async push(recipe: RecipeInput): Promise<{ name: string; version: number }> {
    this.require();
    const res = await this.fetchImpl(`${this.url}/recipes`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(recipe),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`pantry push failed: ${res.status} ${detail}`);
    }
    return (await res.json()) as { name: string; version: number };
  }

  async delete(name: string): Promise<boolean> {
    this.require();
    const res = await this.fetchImpl(`${this.url}/recipe/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`pantry delete failed: ${res.status}`);
    return true;
  }
}

// Convenience: a default client wired to the ambient environment.
export const pantry = new PantryClient();
