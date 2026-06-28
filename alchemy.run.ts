import alchemy from 'alchemy';
import { D1Database, Worker } from 'alchemy/cloudflare';
import { CloudflareStateStore, FileSystemStateStore } from 'alchemy/state';

const projectName = 'pantry';

const project = await alchemy(projectName, {
  password: process.env.ALCHEMY_PASSWORD as string,
  stateStore: (scope) =>
    scope.local
      ? new FileSystemStateStore(scope)
      : new CloudflareStateStore(scope, {
          scriptName: `${projectName}-app-state`,
          apiToken: alchemy.secret(process.env.CLOUDFLARE_API_TOKEN || ''),
          stateToken: alchemy.secret(process.env.ALCHEMY_STATE_TOKEN || ''),
        }),
});

const isProduction = !project.stage || project.stage === 'production';
const resourcePrefix = isProduction ? projectName : `${projectName}-${project.stage}`;

const DB = await D1Database(`${projectName}-db`, {
  name: `${resourcePrefix}-db`,
  migrationsDir: 'migrations',
  adopt: true,
});

// PANTRY_TOKEN is a wrangler/alchemy secret, NEVER hardcoded. It must be present
// in the environment at deploy time; the worker fails closed if it is missing.
export const PANTRY_WORKER = await Worker(`${resourcePrefix}-worker`, {
  name: `${resourcePrefix}-worker`,
  entrypoint: './src/worker.ts',
  adopt: true,
  url: true,
  ...(isProduction ? { domains: ['pantry.coey.dev'] } : {}),
  bindings: {
    DB,
    PANTRY_TOKEN: alchemy.secret(process.env.PANTRY_TOKEN || ''),
    PANTRY_OWNER: process.env.PANTRY_OWNER || 'default',
  },
});

console.log({ url: PANTRY_WORKER.url });

await project.finalize();
