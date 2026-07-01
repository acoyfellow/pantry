// branding_loop — the reusable terraloop for giving any project its OWN brand.
//
// We ran this BY HAND for keel, then airlock: take a working repo, and loop a
// cracked-designer panel over REAL cmux screenshots until the look + copy are
// sharp, simple, crisp, and the project's OWN identity (not a clone of a sibling).
// The hard-won rule baked in: DESIGN = VISUAL + COPY = ONE THING. A branding
// pass that fixes pixels but not words is not done; every pass runs copy through
// coey.dev/WRITING-GUIDE.md (kill rule-of-three triads, "X not Y" reframes,
// apophasis, oversized headlines, arrows-in-prose).
//
// Like the other recipes here, `code` is a PURE planner: given an input it
// returns the loop spec (a loopPrompt string + ordered steps + terminal). It
// runs no shell, no build, no deploy. The caller hands `loopPrompt` to its own
// loop driver (loops_task / terrarium) and runs it, eyes open.

import type { RecipeInput } from '../../src/recipe.ts';

const BRANDING_LOOP_CODE = `
const input = (ctx && ctx.input) || {};
const name = String(input.name || 'project');
const domain = String(input.domain || (name + '.coey.dev'));
const path = String(input.projectPath || ('/Users/jcoeyman/cloudflare/' + name));
const metaphor = String(input.metaphor || 'its core idea');
const accent = String(input.accentDirection || 'an accent distinct from sibling projects');
const references = Array.isArray(input.references) && input.references.length
  ? input.references
  : ['AX/site (bracket mono eyebrows, faint grid + low grain, coated-glass surfaces, Inter + IBM Plex Mono, orange-signals/blue-expands)', 'terrarium', 'deja', 'gateproof', 'cloudbox'];
const port = Number(input.previewPort || 4199);

const loopPrompt =
  'Give ' + name + ' its OWN brand identity at ' + path + ', iterating locally (vite preview + real cmux screenshots) until the cracked-designer panel agrees it is SHARP, not cringe; SIMPLE, not overdone; CRISP; and reads as ' + name + "'s own identity, not a clone. Then deploy https://" + domain + '/.\\n\\n' +
  'DESIGN = VISUAL + COPY = ONE THING. Every design pass MUST also run the copy through coey.dev/WRITING-GUIDE.md: kill rule-of-three triads, "X not Y" reframes, apophasis (protesting too much), oversized headlines (the owner hates them), and arrows in prose (ASCII -> only inside code/diagram blocks). Copy that trips the guide fails the pass even if the pixels are clean.\\n\\n' +
  'OWN IDENTITY (a COMBO, not a 1:1 carbon): read the CSS/sites of the references [' + references.join(', ') + '] for ideas, then SYNTHESIZE ' + name + "'s own look. Lean the " + name + ' metaphor (' + metaphor + '). Give it its own mark (img-gen works after bun install in cloudflare/img-gen), its own accent (' + accent + '), and its own texture. Modest headlines. Plain copy. Light, clean, responsive.\\n\\n' +
  'DIAGRAM OF TRUTH: put one accurate diagram of the core flow on the page, and make it actually help a newcomer SEE the flow. A cramped or confusing ASCII block fails this even if it is technically correct; if ASCII reads badly, build a clean CSS/SVG diagram instead. Show only the slice this project owns and leave the ends OPEN (label what feeds in and what it flows on to) rather than absorbing adjacent systems like the scheduler or observability. No unicode arrow in prose.\\n\\n' +
  'DESIGNER PANEL (loop until unanimous): each round (a) make a concrete visual+copy improvement, (b) build + restart vite preview on --host 127.0.0.1 --port ' + port + ' --strictPort, (c) cmux screenshot / and /docs and READ them, (d) review AS the panel from cloudflare/contributron/CRACKED_ENGINEERS.md, led by Kevin Kipp (taste, minimalism, every state intentional, design-system consistency) with Nick Downie (kill cringe/clever copy), Tom Bremer (delete overdone elements), Dane Knecht (operationally honest, not marketing fluff), Sam Rhea (cohesive whole). List each designer concrete objections (visual AND copy), FIX them, re-screenshot. Iterate until every named designer would sign off.\\n\\n' +
  'DEPLOY + PROVE: deploy to ' + domain + ' (alchemy --stage production; CF token from ~/.wrangler/config/default.toml oauth_token, refresh with bunx wrangler whoami on 401; CLOUDFLARE_ACCOUNT_ID from the account). Confirm curl 200 and that it serves the real new look (cmux screenshot the live URL). Custom-domain certs can take minutes.\\n\\n' +
  'SAFETY: keep tests green; never break sibling live sites; no fake metrics; never expose tokens; commit logically. TERMINAL: diagram of truth on the page + accurate; ' + name + ' has a distinct own identity (mark + accent + texture + guide-clean copy) every named designer signs off as sharp/simple/crisp on real cmux screenshots; tests green; ' + domain + ' returns 200 serving the new look. Then append the designers sign-off to LAUNCH-NOTES.md and report the live URL. Do NOT declare done until you have SEEN the polished screenshots and curl shows 200.';

const steps = [
  { n: 1, title: 'Own identity, not a clone', do: 'Read references, synthesize ' + name + "'s own mark + accent + texture; lean the " + metaphor + ' metaphor.' },
  { n: 2, title: 'Copy is design', do: 'Run all copy through coey.dev/WRITING-GUIDE.md; kill triads / X-not-Y / apophasis / oversized headlines / prose arrows.' },
  { n: 3, title: 'Diagram of truth', do: 'One accurate flow diagram on the page (ASCII mono or crisp SVG).' },
  { n: 4, title: 'Designer panel loop', do: 'Build, vite preview, cmux screenshot, review as Kevin/Nick/Tom Bremer/Dane/Sam Rhea, fix, repeat until unanimous.' },
  { n: 5, title: 'Deploy + prove', do: 'alchemy deploy --stage production; curl 200 on ' + domain + '; cmux screenshot the live URL.' },
];

return {
  name: name,
  domain: domain,
  principle: 'design = visual + copy = one thing',
  loopPrompt: loopPrompt,
  steps: steps,
  terminal: 'every named designer signs off (visual + guide-clean copy) on real cmux screenshots AND ' + domain + ' returns 200 serving the new look.',
  note: 'Planner only. Hand loopPrompt to your loop driver (loops_task / terrarium) and run it. Pantry runs nothing.',
};
`.trim();

export const brandingLoopRecipe: RecipeInput = {
  name: 'branding_loop',
  description:
    "Reusable terraloop to give any project its OWN brand identity. Returns a parameterized loop spec (loopPrompt + steps + terminal) that loops a cracked-designer panel over real cmux screenshots until the look AND copy are sharp/simple/crisp and the project's own (not a clone). Bakes in: design = visual + copy = one thing (always run copy through coey.dev/WRITING-GUIDE.md). Plans only; runs nothing.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'project name, e.g. "airlock"' },
      domain: { type: 'string', description: 'deploy domain, e.g. "airlock.coey.dev". Defaults to <name>.coey.dev.' },
      metaphor: { type: 'string', description: 'the brand metaphor to lean into, e.g. "a sealed chamber; a candidate held dark until a proof opens the door"' },
      accentDirection: { type: 'string', description: 'accent direction distinct from siblings, e.g. "teal sealed-chamber, not warm orange"' },
      projectPath: { type: 'string', description: 'absolute repo path. Defaults to /Users/jcoeyman/cloudflare/<name>.' },
      references: { type: 'array', items: { type: 'string' }, description: 'sibling brands/assets to synthesize from (not clone). Defaults to AX/site + terrarium/deja/gateproof/cloudbox.' },
      previewPort: { type: 'number', description: 'free local vite preview port. Default 4199.' },
    },
    required: ['name', 'metaphor'],
  },
  code: BRANDING_LOOP_CODE,
  // The emitted plan tells the caller to run builds, cmux, and a deploy. The code
  // itself is a pure planner; the plan's actions are machine.shell + browser.
  capabilities: ['machine.shell'],
  status: 'enabled',
  sourceRunId: null,
};

async function main(): Promise<void> {
  const { pantry } = await import('../../src/client.ts');
  if (!pantry.configured) {
    console.error('set PANTRY_URL and PANTRY_TOKEN to push branding_loop');
    process.exit(1);
  }
  const result = await pantry.push(brandingLoopRecipe);
  console.log(`pushed '${result.name}' as version ${result.version}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
