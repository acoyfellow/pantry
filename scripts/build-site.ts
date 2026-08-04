import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type BuildTarget = 'ops' | 'public';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = join(root, 'app');
const targetArgument = process.argv[2] ?? 'public';

if (targetArgument !== 'public' && targetArgument !== 'ops') {
  throw new Error(`Unknown build target: ${targetArgument}`);
}

const target: BuildTarget = targetArgument;
const distDir = join(appDir, 'dist', target);
const publicAssets = [
  'docs.html',
  'favicon.svg',
  'hero-f1.jpg',
  'hero-f2.jpg',
  'hero-f3.jpg',
  'index.html',
  'logo.svg',
  'proof.html',
  'style.css',
];

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

for (const asset of publicAssets) {
  cpSync(join(appDir, asset), join(distDir, asset));
}

for (const page of ['docs', 'proof']) {
  mkdirSync(join(distDir, page), { recursive: true });
  cpSync(join(appDir, `${page}.html`), join(distDir, page, 'index.html'));
}

if (target === 'ops') {
  execFileSync(
    process.execPath,
    [
      'x',
      'vite',
      'build',
      '--config',
      'app-ui/vite.config.ts',
      '--outDir',
      '../app/dist/ops/manage',
    ],
    { cwd: root, stdio: 'inherit' },
  );
}

console.log(`built ${target} assets: ${readdirSync(distDir).join(', ')}`);
