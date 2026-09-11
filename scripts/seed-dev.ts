// Local development seed for the Operations UI. It writes only to the local
// wrangler D1 state used by `bun run dev:ops`, never to a remote database.

import { spawnSync } from 'node:child_process';

type SeedRecipe = {
  name: string;
  description: string;
  code: string;
  capabilities: string[];
  status: 'pending' | 'enabled';
  runCount: number;
  lastRunHoursAgo: number | null;
};

const recipes: SeedRecipe[] = [
  {
    name: 'slugify',
    description: 'Lowercase, hyphenate, strip punctuation from a title string.',
    code: "return { slug: String(ctx.input.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') };",
    capabilities: ['workspace.none', 'text.transform'],
    status: 'enabled',
    runCount: 42,
    lastRunHoursAgo: 1,
  },
  {
    name: 'project_check',
    description: 'Return the standard verification command for a repository.',
    code: "return { command: `bun run ${ctx.input.task || 'check'}` };",
    capabilities: ['workspace.none'],
    status: 'enabled',
    runCount: 17,
    lastRunHoursAgo: 6,
  },
  {
    name: 'tweet_char_count',
    description: 'Effective character count of a draft with URLs counted as 23.',
    code: "return { count: String(ctx.input.text || '').replace(/https?:\\/\\/\\S+/g, 'x'.repeat(23)).length };",
    capabilities: ['text.transform'],
    status: 'enabled',
    runCount: 5,
    lastRunHoursAgo: 30,
  },
  {
    name: 'evidence_capture',
    description: 'Deterministic evidence-capture playbook for verifying agent work.',
    code: "return { plan: ['screenshot', 'api-receipt', 'test-log'] };",
    capabilities: ['workspace.none'],
    status: 'enabled',
    runCount: 0,
    lastRunHoursAgo: null,
  },
  {
    name: 'rfc_preflight',
    description: 'Pre-flight RFC compliance rules for changed paths before review.',
    code: "return { rules: (ctx.input.changedPaths || []).map((path) => ({ path, rule: 'RFC-009' })) };",
    capabilities: ['workspace.none'],
    status: 'pending',
    runCount: 0,
    lastRunHoursAgo: null,
  },
  {
    name: 'review_this_mr',
    description:
      'Audit one merge request for reviewer follow-up, author responses, and pipeline state.',
    code: `const mr = ctx.input.mergeRequest || {};
const reviewer = String(ctx.input.reviewer || '');
const discussions = Array.isArray(mr.discussions) ? mr.discussions : [];
const unresolvedDiscussions = discussions.filter((discussion) => !discussion.resolved);
const myUnresolvedComments = unresolvedDiscussions.filter((discussion) =>
  Array.isArray(discussion.notes) && discussion.notes.some((note) => note.author === reviewer),
).length;
const ownerReplied = unresolvedDiscussions.some((discussion) => {
  const notes = Array.isArray(discussion.notes) ? discussion.notes : [];
  const latestMine = notes.filter((note) => note.author === reviewer).at(-1);
  const latestAuthor = notes.filter((note) => note.author === mr.author).at(-1);
  return Boolean(latestMine && latestAuthor && latestAuthor.createdAt > latestMine.createdAt);
});
const reviewedByMe = discussions.some((discussion) =>
  Array.isArray(discussion.notes) && discussion.notes.some((note) => note.author === reviewer),
);
const approvedByMe = Array.isArray(mr.approvedBy) && mr.approvedBy.includes(reviewer);
const ownerActionNeeded = ownerReplied && myUnresolvedComments > 0;
const nextAction = mr.draft
  ? 'wait_for_ready'
  : ownerActionNeeded
    ? 'respond_to_author'
    : myUnresolvedComments > 0
      ? 'resolve_or_follow_up'
      : approvedByMe
        ? 'monitor_pipeline'
        : 'review_needed';
return { row: { ...mr, reviewedByMe, approvedByMe, myUnresolvedComments, ownerActionNeeded, ownerReplied, unresolvedDiscussions: unresolvedDiscussions.length, nextAction } };`,
    capabilities: ['workspace.none'],
    status: 'enabled',
    runCount: 8,
    lastRunHoursAgo: 3,
  },
];

const owner = 'agent-experience';
const identity = 'dev@localhost';

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

function recipeStatements(recipe: SeedRecipe, index: number): string[] {
  const now = isoHoursAgo(72 - index);
  const digest = `${index.toString(16).padStart(2, '0')}`.repeat(32);
  const approvedColumns =
    recipe.status === 'enabled'
      ? `${recipe.runCount ? 1 : 1}, ${sqlString(digest)}, 1, ${sqlString(digest)}`
      : 'NULL, NULL, NULL, NULL';
  const lastRunAt =
    recipe.lastRunHoursAgo === null ? 'NULL' : sqlString(isoHoursAgo(recipe.lastRunHoursAgo));
  return [
    `INSERT OR REPLACE INTO recipes (id, owner, name, description, input_schema_json, code, capabilities_json, status, version, source_run_id, visibility, tags_json, run_count, last_run_at, recipe_digest, created_at, updated_at, approved_version, approved_digest, reviewed_version, reviewed_digest) VALUES (${sqlString(`dev-${recipe.name}`)}, ${sqlString(owner)}, ${sqlString(recipe.name)}, ${sqlString(recipe.description)}, ${sqlString('{"type":"object","properties":{"text":{"type":"string"}}}')}, ${sqlString(recipe.code)}, ${sqlString(JSON.stringify(recipe.capabilities))}, ${sqlString(recipe.status)}, 1, NULL, 'private', '[]', ${recipe.runCount}, ${lastRunAt}, ${sqlString(digest)}, ${sqlString(now)}, ${sqlString(now)}, ${approvedColumns});`,
  ];
}

const statements = [
  `DELETE FROM recipes WHERE owner = ${sqlString(owner)};`,
  ...recipes.flatMap(recipeStatements),
].join('\n');

const migrate = spawnSync(
  'bunx',
  [
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'pantry-db',
    '--local',
    '--config',
    'wrangler.ax.jsonc',
  ],
  { stdio: 'inherit' },
);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const seed = spawnSync(
  'bunx',
  [
    'wrangler',
    'd1',
    'execute',
    'pantry-db',
    '--local',
    '--config',
    'wrangler.ax.jsonc',
    '--command',
    statements,
  ],
  { stdio: 'inherit' },
);
if (seed.status !== 0) process.exit(seed.status ?? 1);

console.log(`seeded ${recipes.length} dev recipes for ${owner}`);
console.log(`dev Access identity: ${identity}`);
