import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Long-lived (non-expiring) HS256 tokens for the website frontend.
 *
 * There is deliberately no `exp` claim — the frontend ships this token in its
 * build, so it must keep working forever. That also means the token is PUBLIC:
 * treat it as an API key that identifies the app, not the visitor. Revoke a
 * leaked one by adding its `jti` to REVOKED_TOKEN_IDS, or rotate JWT_SECRET to
 * invalidate every token at once.
 */
export function mintToken({ subject = 'neohives-web', label } = {}) {
  const jti = randomUUID();
  const token = jwt.sign(
    { scope: 'chat', ...(label ? { label } : {}) },
    config.auth.secret,
    {
      algorithm: 'HS256',
      subject,
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      jwtid: jti,
      // No expiresIn -> no exp claim -> never expires.
    },
  );
  return { token, jti };
}

/** @returns {{ok: true, claims: object} | {ok: false, reason: string}} */
export function verifyToken(token) {
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const claims = jwt.verify(token, config.auth.secret, {
      // Pinning the algorithm blocks "alg": "none" and HS/RS confusion attacks.
      algorithms: ['HS256'],
      issuer: config.auth.issuer,
      audience: config.auth.audience,
    });
    if (claims.jti && config.auth.revokedIds.includes(claims.jti)) {
      return { ok: false, reason: 'revoked_token' };
    }
    return { ok: true, claims };
  } catch (err) {
    return { ok: false, reason: err.name === 'TokenExpiredError' ? 'expired_token' : 'invalid_token' };
  }
}

/** Express middleware guarding the API endpoint. */
export function requireToken(req, res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, value] = header.split(' ');
  const token = scheme?.toLowerCase() === 'bearer' ? value : null;

  const result = verifyToken(token);
  if (!result.ok) {
    logger.warn({ ip: req.ip, reason: result.reason }, 'rejected unauthenticated request');
    res.set('www-authenticate', 'Bearer realm="neohives-chatbot"');
    return res.status(401).json({
      error: result.reason,
      message: 'A valid bearer token is required. Send: Authorization: Bearer <token>',
    });
  }

  req.auth = result.claims;
  next();
}
