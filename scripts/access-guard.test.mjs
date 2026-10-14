import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, SignJWT } from 'jose';
import { authorizeAndServe } from '../worker/access-guard.mjs';

const issuer = 'https://example-team.cloudflareaccess.com';
const audience = 'access-app-aud';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...await exportJWK(publicKey), alg: 'RS256', use: 'sig', kid: 'test-key' };
const getJwks = () => createLocalJWKSet({ keys: [jwk] });

async function signed(claims = {}) {
  const { email = 'person@example.com', ...overrides } = claims;
  return new SignJWT({ email, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function scenario(token, changes = {}) {
  let assetCalls = 0;
  const env = {
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUD: audience,
    ALLOWED_EMAIL_DOMAIN: 'example.com',
    ASSETS: { fetch: async () => {
      assetCalls += 1;
      return new Response('private asset', { headers: { 'content-type': 'text/plain' } });
    } },
    ...changes,
  };
  const request = new Request('https://kms.example.test/assets/private.js', {
    headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {},
  });
  return { request, env, calls: () => assetCalls };
}

test('valid company token alone can fetch static assets', async () => {
  const run = scenario(await signed({ email: 'Person@Example.com' }));
  const response = await authorizeAndServe(run.request, run.env, getJwks);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'private asset');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(run.calls(), 1);
});

test('missing Access config and missing token deny before asset lookup', async () => {
  for (const run of [
    scenario(null),
    scenario(await signed(), { ACCESS_AUD: '' }),
    scenario(await signed(), { ACCESS_TEAM_DOMAIN: '' }),
    scenario(await signed(), { ALLOWED_EMAIL_DOMAIN: '' }),
    scenario(await signed(), { ACCESS_TEAM_DOMAIN: 'http://example-team.cloudflareaccess.com' }),
  ]) {
    const response = await authorizeAndServe(run.request, run.env, getJwks);
    assert.equal(response.status, 403);
    assert.equal(run.calls(), 0);
  }
});

test('invalid signature, issuer, audience, expiry and email are denied', async () => {
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const base = () => new SignJWT({ email: 'person@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt().setExpirationTime('1h');
  const badTokens = [
    await base().setIssuer(issuer).setAudience(audience).sign(otherKey),
    await base().setIssuer('https://other.cloudflareaccess.com').setAudience(audience).sign(privateKey),
    await base().setIssuer(issuer).setAudience('another-aud').sign(privateKey),
    await new SignJWT({ email: 'person@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('-1h').sign(privateKey),
    await signed({ email: 'person@outside.example' }),
    await signed({ email: 'person@example.com.evil.example' }),
    await signed({ email: 'person@sub.example.com' }),
  ];
  for (const token of badTokens) {
    const run = scenario(token);
    const response = await authorizeAndServe(run.request, run.env, getJwks);
    assert.equal(response.status, 403);
    assert.equal(run.calls(), 0);
  }
});

test('wrangler invokes guard for every static asset and disables alternate URLs', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.main, './worker/access-guard.mjs');
  assert.equal(config.assets.binding, 'ASSETS');
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});
