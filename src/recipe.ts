// The recipe model and its validation.
//
// Mirrored from my-ax/src/saved-recipes.ts so a recipe authored in my-ax and a
// recipe pushed to pantry are the same shape. pantry stores and hands these
// back; it never runs the `code`.

export const RECIPE_STATUSES = ['enabled', 'disabled'] as const;
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];
export const RECIPE_VISIBILITIES = ['private', 'shared'] as const;
export type RecipeVisibility = (typeof RECIPE_VISIBILITIES)[number];

// The stored row, as it lives in D1.
export type RecipeRow = {
  id: string;
  owner: string;
  name: string;
  description: string;
  input_schema_json: string;
  code: string;
  capabilities_json: string;
  status: RecipeStatus;
  version: number;
  source_run_id: string | null;
  visibility?: RecipeVisibility;
  created_at: string;
  updated_at: string;
};

// The validated input a caller pushes.
// `code` is executable JavaScript text that pantry only stores and returns.
// The demo runner accepts these authoring shapes: a bare function body that
// reads `ctx`, `export default (input, ctx) => ...` / `export default function`,
// or `module.exports = (input, ctx) => ...`. Exported callables receive
// `(ctx.input, ctx)`. This is a convenience contract, not a sandbox.
export type RecipeInput = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  code: string;
  capabilities: string[];
  sourceRunId: string | null;
  status: RecipeStatus;
  visibility?: RecipeVisibility;
};

export class RecipeError extends Error {
  constructor(
    public code: 'InvalidInput' | 'NotFound' | 'Conflict',
    message: string,
  ) {
    super(message);
    this.name = 'RecipeError';
  }
}

// Capability tags. Either a scoped namespace (workspace.*/machine.*/cloudbox.*)
// or a generic free tag (e.g. `text.transform`). A recipe must declare at least
// one so the caller can decide whether the script is safe to run.
const SCOPED_CAPABILITY = /^(workspace|machine|cloudbox)\.[a-zA-Z0-9_.-]+$/;
const GENERIC_CAPABILITY = /^[a-z][a-z0-9]*(\.[a-z0-9_-]+)+$/;

const MAX_CODE_BYTES = 32_000;

function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecipeError('InvalidInput', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) {
    throw new RecipeError('InvalidInput', 'name must match /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/');
  }
  return name;
}

function cleanCapabilities(value: unknown): string[] {
  const capabilities = Array.isArray(value) ? value : [];
  if (!capabilities.length) {
    throw new RecipeError('InvalidInput', 'capabilities must list at least one capability');
  }
  const cleaned = capabilities.map((capability) =>
    typeof capability === 'string' ? capability.trim() : '',
  );
  const invalid = cleaned.filter(
    (capability) => !SCOPED_CAPABILITY.test(capability) && !GENERIC_CAPABILITY.test(capability),
  );
  if (invalid.length) {
    throw new RecipeError('InvalidInput', `invalid capabilities: ${invalid.join(', ')}`);
  }
  return [...new Set(cleaned)].sort();
}

function cleanDescription(value: unknown): string {
  const description = typeof value === 'string' ? value.trim() : '';
  if (description.length < 5 || description.length > 500) {
    throw new RecipeError('InvalidInput', 'description must be 5-500 characters');
  }
  return description;
}

function cleanInputSchema(value: unknown): Record<string, unknown> {
  const inputSchema = assertObject(value ?? { type: 'object', properties: {} }, 'inputSchema');
  if (inputSchema.type !== 'object') {
    throw new RecipeError('InvalidInput', 'inputSchema.type must be object');
  }
  return inputSchema;
}

function cleanCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!code) throw new RecipeError('InvalidInput', 'code is required');
  if (new TextEncoder().encode(code).byteLength > MAX_CODE_BYTES) {
    throw new RecipeError('InvalidInput', `code must be <= ${MAX_CODE_BYTES} bytes`);
  }
  return code;
}

// Validate a full recipe push. Throws RecipeError('InvalidInput') on any failure.
export function validateRecipeInput(input: unknown): RecipeInput {
  const body = assertObject(input, 'recipe');
  const name = cleanName(body.name);
  const description = cleanDescription(body.description);
  const inputSchema = cleanInputSchema(body.inputSchema);
  const code = cleanCode(body.code);
  const capabilities = cleanCapabilities(body.capabilities);
  const status: RecipeStatus = body.status === 'disabled' ? 'disabled' : 'enabled';
  const visibility: RecipeVisibility = body.visibility === 'shared' ? 'shared' : 'private';
  const sourceRunId =
    typeof body.sourceRunId === 'string' && body.sourceRunId.trim()
      ? body.sourceRunId.trim()
      : null;
  return { name, description, inputSchema, code, capabilities, status, sourceRunId, visibility };
}

// The cheap discovery shape: everything a caller needs to choose a recipe,
// WITHOUT the code. Listing never ships the script.
export function listEntry(row: RecipeRow) {
  return {
    name: row.name,
    description: row.description,
    inputSchema: JSON.parse(row.input_schema_json) as Record<string, unknown>,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    status: row.status,
    version: row.version,
    sourceRunId: row.source_run_id,
    visibility: row.visibility ?? 'private',
    author: row.owner,
    updatedAt: row.updated_at,
  };
}

// The full shape: includes `code` and `capabilities`. This is what a caller
// fetches and then runs in its OWN sandbox.
export function fullRecipe(row: RecipeRow) {
  return {
    ...listEntry(row),
    code: row.code,
    createdAt: row.created_at,
  };
}

export type RecipeListEntry = Partial<ReturnType<typeof listEntry>> &
  Omit<ReturnType<typeof listEntry>, 'visibility' | 'author'>;
export type FullRecipe = Partial<ReturnType<typeof fullRecipe>> &
  Omit<ReturnType<typeof fullRecipe>, 'visibility' | 'author'>;
