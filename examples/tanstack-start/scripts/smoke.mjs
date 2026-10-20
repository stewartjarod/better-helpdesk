// Serves the built app with `vite preview` on a free port, checks the three
// paths that matter for the trailing-slash fix, and stops the server. Run
// `pnpm build` first.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(join(root, 'dist/server/server.js'))) {
  console.error(
    'No build found. Run `pnpm --filter better-helpdesk-tanstack-start build` first.'
  );
  process.exit(1);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'helpdesk-tanstack-smoke-'));

const server = spawn(
  process.execPath,
  [
    join(root, 'node_modules/vite/bin/vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      ORIGIN: origin,
      HELPDESK_SQLITE: join(dataDir, 'helpdesk.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
let log = '';
server.stdout.on('data', chunk => (log += chunk));
server.stderr.on('data', chunk => (log += chunk));

const stop = () =>
  new Promise(resolve => {
    if (server.exitCode !== null) return resolve();
    server.once('exit', resolve);
    server.kill('SIGTERM');
  });

const get = path => fetch(`${origin}${path}`, { redirect: 'manual' });

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`server exited early:\n${log}`);
    }
    try {
      await get('/');
      return;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  throw new Error(`server did not answer within ${timeoutMs} ms:\n${log}`);
}

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${detail})`);
  if (!ok) failures.push(name);
};
const isType = (res, type) =>
  (res.headers.get('content-type') ?? '').includes(type);

try {
  await waitForServer();

  const api = await get('/api/helpdesk/widget/session/');
  const apiBody = await api.text();
  check(
    'GET /api/helpdesk/widget/session/ is 200 JSON, not a redirect',
    api.status === 200 && isType(api, 'json'),
    `${api.status} ${api.headers.get('content-type')} ${apiBody.slice(0, 60)}`
  );

  const admin = await get('/helpdesk/');
  await admin.text();
  check(
    'GET /helpdesk/ is 200 HTML',
    admin.status === 200 && isType(admin, 'text/html'),
    `${admin.status} ${admin.headers.get('content-type')}`
  );

  const home = await get('/');
  const homeBody = await home.text();
  check(
    'GET / is 200 HTML',
    home.status === 200 &&
      isType(home, 'text/html') &&
      homeBody.includes('TanStack Start with Better Helpdesk'),
    `${home.status} ${home.headers.get('content-type')}`
  );
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`smoke failed: ${failures.length} check(s)`);
  process.exit(1);
}
console.log('smoke passed');
