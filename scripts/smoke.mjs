import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const home = resolve(project, '.smoke-home');
const bin = resolve(project, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const env = { ...process.env, DSH_HOME: home };
const args = ['--profile', 'next-prompt-smoke'];
const profileExists = existsSync(resolve(home, 'profiles/next-prompt-smoke/package.json'));
const init = spawnSync(process.execPath, [bin, ...args, ...(profileExists ? [] : ['--from-default-profile', 'web']), '--dump-config'], { env, cwd: project, encoding: 'utf8' });
if (init.status !== 0) throw new Error(init.stderr);
const profile = resolve(home, 'profiles/next-prompt-smoke');
const manifestPath = resolve(profile, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.dependencies ??= {};
manifest.dependencies['dsh-next-prompt'] = `file:${project.replaceAll('\\', '/')}`;
manifest.dsh.profile.bundles = [...new Set([...manifest.dsh.profile.bundles, 'dsh-next-prompt'])];
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await mkdir(resolve(profile, 'node_modules'), { recursive: true });
const link = resolve(profile, 'node_modules/dsh-next-prompt');
if (!existsSync(link)) await symlink(project, link, process.platform === 'win32' ? 'junction' : 'dir');
const config = spawnSync(process.execPath, [bin, ...args, '--dump-config'], { env, cwd: project, encoding: 'utf8' });
if (config.status !== 0 || !config.stdout.includes('dsh-next-prompt')) throw new Error(config.stderr || 'plugin missing from composed config');

const child = spawn(process.execPath, [bin, ...args, '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, cwd: project, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let log = '';
let url;
child.stdout.on('data', chunk => { log += chunk.toString(); url ??= log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)?.[0]; });
child.stderr.on('data', chunk => { log += chunk.toString(); });
try {
  const start = Date.now();
  while (!url && Date.now() - start < 30_000 && child.exitCode === null) await new Promise(r => setTimeout(r, 100));
  if (!url) throw new Error(`web startup failed: ${log.slice(-5000)}`);
  const auth = await fetch(url, { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const response = auth.status >= 300 && auth.status < 400
    ? await fetch(new URL(auth.headers.get('location') ?? '/', url), { headers: { Cookie: cookie } }) : auth;
  const html = await response.text();
  if (!response.ok || !html.includes('dsh-next-prompt')) throw new Error(`client roster missing plugin: HTTP ${response.status}\n${log.slice(-3000)}`);
  const moduleRef = html.match(/"id"\s*:\s*"dsh-next-prompt"\s*,\s*"url"\s*:\s*"([^"]+)"/)?.[1];
  if (!moduleRef) throw new Error('could not locate next-prompt client module URL');
  const moduleResponse = await fetch(new URL(JSON.parse(`"${moduleRef}"`), url), { headers: { Cookie: cookie } });
  const moduleText = await moduleResponse.text();
  if (!moduleResponse.ok || !moduleText.includes('next-prompt')) throw new Error(`client module fetch failed: HTTP ${moduleResponse.status}`);
  await writeFile(resolve(project, 'docs/smoke-result.json'), JSON.stringify({
    runtime: 'DSH 0.2.0-rc.2', isolatedHome: '.smoke-home',
    composedPlugin: true, httpStatus: response.status, clientRoster: true, clientModuleStatus: moduleResponse.status,
    note: 'Host startup and client roster only; DOM interaction is covered by jsdom tests, not a desktop end-to-end run.'
  }, null, 2));
  console.log('PASS: isolated DSH composition, web startup, HTTP 200, client roster and client module delivery');
} finally {
  child.kill();
  await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 3000))]);
}
