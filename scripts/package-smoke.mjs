import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'cookiecasekit-package-'));
const packageName = JSON.parse(readFileSync('package.json', 'utf8')).name;
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run test:package');
try {
  execFileSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', dir], {
    encoding: 'utf8',
  });
  const filename = readdirSync(dir).find((file) => file.endsWith('.tgz'));
  if (!filename) throw new Error('npm pack did not create an archive');
  const packed = { filename };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync(
    process.execPath,
    [npm, 'install', '--ignore-scripts', '--no-audit', join(dir, packed.filename)],
    { cwd: dir, stdio: 'inherit' },
  );
  writeFileSync(
    join(dir, 'types.mts'),
    `import { createTicketing, type User } from '${packageName}';
const user: User = { id:'a', name:'A', email:'a@example.com', role:'agent', tenantId:'one' };
const crm = createTicketing({ database:{filename:':memory:'}, auth:()=>user, email:{from:'help@example.com',transport:{host:'localhost',port:25}} });
crm.handler; crm.router; void crm.close();`,
  );
  execFileSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      'types.mts',
    ],
    { cwd: dir, stdio: 'inherit' },
  );
  writeFileSync(join(dir, 'types.cts'), readFileSync(join(dir, 'types.mts')));
  execFileSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      'types.cts',
    ],
    { cwd: dir, stdio: 'inherit' },
  );
  const source = `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTicketing } from '${packageName}';
import express from 'express';
const require = createRequire(import.meta.url);
for (const factory of [createTicketing, require('${packageName}').createTicketing]) {
 const crm = factory({ database:{filename:':memory:'},auth:()=>({id:'smoke',name:'Smoke',email:'smoke@example.com',role:'agent',tenantId:'demo'}) });
 const app = express(); app.use('/desk',crm.router);
 const server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
 try { for (const path of ['', 'app.js', 'style.css','brand.css','logo.svg','theme.js','api/me']) { const r = await fetch('http://127.0.0.1:'+server.address().port+'/desk/'+path); assert.equal(r.status,200,path); } }
 finally { await new Promise(r=>server.close(r)); await crm.close(); }
}
console.log('Packed ESM + CJS API, consumer types and bundled UI passed');`;
  writeFileSync(join(dir, 'smoke.mjs'), source);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: dir, stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
