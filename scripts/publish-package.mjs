import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const registry = process.argv[2];
if (!['https://registry.npmjs.org', 'https://npm.pkg.github.com'].includes(registry)) {
  throw new Error('Unsupported registry');
}
if (!process.env.NODE_AUTH_TOKEN)
  throw new Error('Missing registry token; configure the NPM Actions secret for npm');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(
  npm,
  ['view', `${pkg.name}@${pkg.version}`, 'version', '--json', '--registry', registry],
  { encoding: 'utf8' },
);
if (result.error) throw result.error;
if (result.status === 0) {
  if (JSON.parse(result.stdout) !== pkg.version)
    throw new Error('Unexpected registry version response');
  console.log(`${pkg.name}@${pkg.version} already exists at ${registry}; skipping`);
} else {
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    /* Non-JSON network/auth failures must not permit publication. */
  }
  if (response?.error?.code !== 'E404')
    throw new Error(`Registry lookup failed (exit ${result.status}); refusing publication`);
  const args = ['publish', '--access', 'public', '--registry', registry];
  if (registry === 'https://registry.npmjs.org') args.push('--provenance');
  const published = spawnSync(npm, args, { stdio: 'inherit' });
  if (published.error) throw published.error;
  if (published.status !== 0) process.exit(published.status ?? 1);
}
