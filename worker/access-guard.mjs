import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwksByIssuer = new Map();

function accessSettings(env) {
  const audience = env?.ACCESS_AUD?.trim();
  const domain = env?.ACCESS_TEAM_DOMAIN?.trim();
  const emailDomain = env?.ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!audience || !domain || !emailDomain || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(emailDomain)) return null;

  let issuer;
  try {
    issuer = new URL(domain);
  } catch {
    return null;
  }
  if (
    issuer.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(issuer.hostname) ||
    issuer.port || issuer.pathname !== '/' || issuer.search || issuer.hash ||
    issuer.username || issuer.password
  ) return null;
  return { audience, issuer: issuer.origin, emailDomain };
}

function remoteJwks(issuer) {
  if (!jwksByIssuer.has(issuer)) {
    jwksByIssuer.set(
      issuer,
      createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
    );
  }
  return jwksByIssuer.get(issuer);
}

function deny() {
  return new Response('Access denied', {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
}

// `getJwks` is injectable only for local signature tests; production uses Access's certs.
export async function authorizeAndServe(request, env, getJwks = remoteJwks) {
  const settings = accessSettings(env);
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!settings || !token || !env.ASSETS?.fetch) return deny();

  try {
    const { payload } = await jwtVerify(token, getJwks(settings.issuer), {
      issuer: settings.issuer,
      audience: settings.audience,
      algorithms: ['RS256'],
    });
    if (!Number.isFinite(payload.exp) || typeof payload.email !== 'string' ||
      !/^[^@\s]+@[^@\s]+$/.test(payload.email) ||
      payload.email.split('@')[1].toLowerCase() !== settings.emailDomain) {
      return deny();
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return deny();
  }
}

export default {
  fetch(request, env) {
    return authorizeAndServe(request, env);
  },
};
