import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Request } from 'express';
import type { User } from '../types.js';
/** Validates signature, issuer, audience, expiry and required claims. Host maps roles/tenants and handles revocation. */
export function oidcAuth(options: {
  issuer: string;
  audience: string;
  jwksUrl: string;
  mapClaims(claims: JWTPayload): User | null | Promise<User | null>;
}) {
  const url = new URL(options.jwksUrl);
  if (url.protocol !== 'https:') throw new Error('JWKS requires HTTPS');
  const keys = createRemoteJWKSet(url, { timeoutDuration: 5000, cooldownDuration: 30000 });
  return async (req: Request): Promise<User | null> => {
    const match = /^Bearer ([^\s]+)$/.exec(req.get('Authorization') ?? '');
    if (!match) return null;
    try {
      const { payload } = await jwtVerify(match[1], keys, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      return await options.mapClaims(payload);
    } catch {
      return null;
    }
  };
}
