import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { oidcAuth } from '../src/cloud/auth.js';
import type { Request } from 'express';

test('OIDC validates signature, issuer, audience, expiry and host role mapping', async (t) => {
  const pair = await generateKeyPair('RS256');
  const key = await exportJWK(pair.publicKey);
  Object.assign(key, { kid: 'test-key', alg: 'RS256', use: 'sig' });
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ keys: [key] }), {
      headers: { 'content-type': 'application/json' },
    });
  t.after(() => {
    globalThis.fetch = original;
  });
  const auth = oidcAuth({
    issuer: 'https://issuer.example',
    audience: 'my-app',
    jwksUrl: 'https://issuer.example/keys',
    mapClaims: (c) =>
      c.role === 'admin'
        ? { id: c.sub!, name: 'Admin', email: 'admin@example.com', role: 'admin', tenantId: 'one' }
        : null,
  });
  const token = async (
    issuer = 'https://issuer.example',
    audience = 'my-app',
    role = 'admin',
    exp = '1h',
  ) =>
    new SignJWT({ role })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('staff')
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(pair.privateKey);
  const req = (value: string) => ({ get: () => value }) as unknown as Request;
  const valid = await token();
  assert.equal((await auth(req('Bearer ' + valid)))?.id, 'staff');
  assert.equal(await auth(req('Bearer ' + (await token('https://evil.example')))), null);
  assert.equal(await auth(req('Bearer ' + (await token(undefined, 'wrong-app')))), null);
  assert.equal(await auth(req('Bearer ' + (await token(undefined, undefined, 'requester')))), null);
  assert.equal(
    await auth(req('Bearer ' + (await token(undefined, undefined, undefined, '-1h')))),
    null,
  );
  assert.equal(await auth(req('Bearer ' + valid.slice(0, -20) + 'tampered')), null);
  assert.equal(await auth(req('')), null);
  assert.throws(
    () =>
      oidcAuth({
        issuer: 'x',
        audience: 'x',
        jwksUrl: 'http://unsafe.example',
        mapClaims: () => null,
      }),
    /HTTPS/,
  );
});
