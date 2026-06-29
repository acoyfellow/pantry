// Build the pantry static site into app/dist.
//
// The site is two hand-written static pages (a landing page and a docs page)
// plus a stylesheet and a favicon. There is no framework and no bundling: the
// "build" copies the source files into app/dist and lays out the pretty path
// /docs as docs/index.html so the assets binding serves it without a redirect.
//
// Run: bun run build:site

import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // repo root
const appDir = join(root, 'app');
const distDir = join(appDir, 'dist');

// The files that make up the site source (everything in app/ except dist/).
const sources = readdirSync(appDir).filter((name) => name !== 'dist');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

for (const name of sources) {
  const from = join(appDir, name);
  if (statSync(from).isDirectory()) continue; // site is flat; skip nested dirs
  cpSync(from, join(distDir, name));
}

// Pretty paths: serve /docs and /proof as */index.html so the assets binding
// resolves extensionless URLs without a trailing-slash redirect.
mkdirSync(join(distDir, 'docs'), { recursive: true });
cpSync(join(appDir, 'docs.html'), join(distDir, 'docs', 'index.html'));
mkdirSync(join(distDir, 'proof'), { recursive: true });
cpSync(join(appDir, 'proof.html'), join(distDir, 'proof', 'index.html'));

const built = readdirSync(distDir);
console.log(`built app/dist: ${built.join(', ')}`);
