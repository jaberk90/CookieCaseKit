import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
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
crm.handler; crm.router; crm.createCase({title:'Contact',description:'Hello'}, user); void crm.close();`,
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
import { createCloudTicketing } from '${packageName}/cloud';
import express from 'express';
const require = createRequire(import.meta.url);
for (const factory of [createTicketing, require('${packageName}').createTicketing]) {
 const crm = factory({ database:{filename:':memory:'},auth:()=>({id:'smoke',name:'Smoke',email:'smoke@example.com',role:'agent',tenantId:'demo'}) });
 const ticket = crm.createCase({title:'Contact',description:'Hello'},{id:'visitor',name:'Visitor',email:'visitor@example.com',tenantId:'demo'}); assert.equal(ticket.number,'CS-00001');
 const app = express(); app.use('/desk',crm.router);
 const server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
 try { for (const path of ['', 'app.js', 'style.css','brand.css','logo.svg','theme.js','api/me']) { const r = await fetch('http://127.0.0.1:'+server.address().port+'/desk/'+path); assert.equal(r.status,200,path); } }
 finally { await new Promise(r=>server.close(r)); await crm.close(); }
}
assert.equal(typeof createCloudTicketing,'function');
assert.equal(typeof require('${packageName}/cloud').createCloudTicketing,'function');
console.log('Packed ESM + CJS API, cloud imports without SDK peers, consumer types and bundled UI passed');`;
  writeFileSync(join(dir, 'smoke.mjs'), source);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: dir, stdio: 'inherit' });
  // React is optional for server-only consumers. Test browser imports only after installing peers.
  const serverManifest = JSON.parse(
    readFileSync(join(dir, 'node_modules', packageName, 'package.json'), 'utf8'),
  );
  assert.equal(serverManifest.peerDependenciesMeta.react.optional, true);
  for (const reactVersion of ['18', '19']) {
    execFileSync(
      process.execPath,
      [
        npm,
        'install',
        '--ignore-scripts',
        '--no-audit',
        `react@${reactVersion}`,
        `react-dom@${reactVersion}`,
        `@types/react@${reactVersion}`,
      ],
      { cwd: dir, stdio: 'inherit' },
    );
    writeFileSync(
      join(dir, 'react-types.mts'),
      `import { CaseKit, type CaseKitProps } from '${packageName}/react';
import { createElement } from 'react';
const props: CaseKitProps = {basePath:'/_casekit',onUnauthorized:()=>{},getToken:async()=> 'host-token'};
createElement(CaseKit, props);`,
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
        'react-types.mts',
      ],
      { cwd: dir, stdio: 'inherit' },
    );
    writeFileSync(
      join(dir, 'react-ssr.mjs'),
      `import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createRequire } from 'node:module';
import { CaseKit } from '${packageName}/react';
const require = createRequire(import.meta.url);
for (const Component of [CaseKit,require('${packageName}/react').CaseKit]) assert.match(renderToString(createElement(Component)),/Loading support workspace/);
`,
    );
    execFileSync(process.execPath, ['react-ssr.mjs'], { cwd: dir, stdio: 'inherit' });
    writeFileSync(
      join(dir, 'browser.mjs'),
      `export { CaseKit } from '${packageName}/react'; import '${packageName}/react.css';`,
    );
    const result = await build({
      entryPoints: [join(dir, 'browser.mjs')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      outfile: join(dir, 'browser.js'),
      metafile: true,
      logLevel: 'silent',
    });
    assert.ok(
      Object.keys(result.metafile.inputs).every(
        (file) =>
          !/(?:imapflow|nodemailer|mailparser|sqlite|cookiecasekit\/dist\/index)/.test(file),
      ),
      'Server code must never enter the browser bundle',
    );
    assert.match(readFileSync(join(dir, 'browser.css'), 'utf8'), /\.cck/);
    const entry = readFileSync(
      join(dir, 'node_modules', packageName, 'dist/react/index.js'),
      'utf8',
    );
    assert.match(entry, /["']use client["']/);
    console.log(
      `React ${reactVersion}: consumer types, ESM/CJS SSR and browser-only bundle passed`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
