#!/usr/bin/env node
/**
 * Mints the non-expiring frontend token.
 *
 *   npm run token                    # mint with JWT_SECRET from .env
 *   npm run token -- --label staging # tag it so you know which build it went to
 *   npm run token -- --secret        # also generate a fresh JWT_SECRET first
 *
 * Paste the printed token into the frontend's .env. Record the `jti` — that is
 * what you add to REVOKED_TOKEN_IDS if the token ever needs killing.
 */
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : (args[index + 1]?.startsWith('--') ? true : args[index + 1] ?? true);
};

if (flag('secret')) {
  // Set it before config.js reads the environment.
  process.env.JWT_SECRET = randomBytes(48).toString('base64url');
  console.log('# Add this to the BACKEND .env (keep it secret, never ship it to the browser):');
  console.log(`JWT_SECRET=${process.env.JWT_SECRET}\n`);
}

const { config } = await import('../src/config.js');
if (!config.auth.secret) {
  console.error('JWT_SECRET is not set. Run `npm run token -- --secret` to generate one.');
  process.exit(1);
}
if (config.auth.secret.length < 32) {
  console.error('JWT_SECRET is too short — use at least 32 characters.');
  process.exit(1);
}

const { mintToken } = await import('../src/auth/token.js');
const label = flag('label');
const { token, jti } = mintToken({ label: typeof label === 'string' ? label : undefined });

console.log('# Frontend .env — this value is visible to anyone who opens DevTools.');
console.log('# Vite:');
console.log(`VITE_NEOHIVES_CHAT_TOKEN=${token}\n`);
console.log('# Next.js:');
console.log(`NEXT_PUBLIC_NEOHIVES_CHAT_TOKEN=${token}\n`);
console.log(`# jti (for REVOKED_TOKEN_IDS): ${jti}`);
console.log(`# issuer: ${config.auth.issuer}   audience: ${config.auth.audience}   expires: never`);
