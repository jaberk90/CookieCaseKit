import { execFileSync } from 'node:child_process';
execFileSync(
  process.execPath,
  ['node_modules/@playwright/test/cli.js', 'test', 'tests/ui.spec.ts', '--project=desktop'],
  { stdio: 'inherit', env: { ...process.env, SCREENSHOTS: '1' } },
);
