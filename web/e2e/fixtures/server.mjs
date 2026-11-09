/**
 * Deterministic E2E fixture server.
 *
 * Serves the real production build from `dist/` AND a fixed, in-memory API on
 * a single origin. Same-origin on purpose: it removes CORS from the test
 * setup entirely and matches how the app is actually deployed behind one
 * hostname.
 *
 * This file is never imported by `src/`, so nothing here can reach a
 * production bundle. It exists only so the browser has something deterministic
 * to talk to — it is not a second implementation of the backend, and it must
 * not grow into one. Backend authorization is proven by the backend's own
 * test suites; these fixtures exist to drive the browser.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIST = resolve(HERE, '../../dist');
const PORT = Number(process.env.E2E_PORT ?? 4173);
const HOST = '127.0.0.1';

/** The only password any fixture account accepts. Not a credential. */
const FIXTURE_PASSWORD = 'e2e-fixture-password';

/**
 * Two personas, keyed by company code, so permission-aware navigation can be
 * asserted from opposite ends: a full-access account and a narrow one.
 */
const ACCOUNTS = {
  'CMP-FULL': {
    token: 'fixture-access-full',
    refreshToken: 'fixture-refresh-full', // security-scan-allow: synthetic e2e fixture value
    company: { id: 'company-full', code: 'CMP-FULL', name: 'Fixture Holding' },
    user: {
      id: 'user-full',
      name: 'Full Access',
      email: 'full@example.invalid',
      companyId: 'company-full',
      employeeId: 'employee-full',
      roleId: 'role-admin',
      roleName: 'Administrator',
      permissions: ['admin.full'],
      mustChangePassword: false,
    },
  },
  'CMP-LIMITED': {
    token: 'fixture-access-limited',
    refreshToken: 'fixture-refresh-limited', // security-scan-allow: synthetic e2e fixture value
    company: { id: 'company-limited', code: 'CMP-LIMITED', name: 'Fixture Branch' },
    user: {
      id: 'user-limited',
      name: 'Limited Access',
      email: 'limited@example.invalid',
      companyId: 'company-limited',
      employeeId: 'employee-limited',
      roleId: 'role-viewer',
      roleName: 'Employee Viewer',
      // Deliberately narrow: employees only, so payroll/finance/purchasing
      // must be absent from navigation and forbidden when addressed directly.
      permissions: ['employees.view'],
      mustChangePassword: false,
    },
  },
};

const byToken = new Map(
  Object.values(ACCOUNTS).map((account) => [account.token, account]),
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Bounded so a malformed test cannot hang the fixture server.
      if (size > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? header.match(/^Bearer\s+(\S+)$/i) : null;
  return match?.[1];
}

async function handleApi(req, res, url) {
  const path = url.pathname;

  if (req.method === 'POST' && path === '/api/v2/auth/login') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'InvalidJson', message: 'invalid', code: 400 });
    }
    const account = ACCOUNTS[String(body.companyCode ?? '').trim()];
    // One indistinguishable failure for wrong company, identity, or password
    // — the same shape the backend returns.
    if (!account || body.password !== FIXTURE_PASSWORD) {
      return sendJson(res, 401, {
        error: 'InvalidCredentials',
        message: 'بيانات الدخول غير صحيحة',
        code: 401,
      });
    }
    return sendJson(res, 200, {
      accessToken: account.token,
      refreshToken: account.refreshToken,
      user: account.user,
      company: account.company,
    });
  }

  if (req.method === 'GET' && path === '/api/auth/me') {
    const account = byToken.get(bearer(req) ?? '');
    if (!account) return sendJson(res, 401, { error: 'Unauthorized', code: 401 });
    return sendJson(res, 200, account.user);
  }

  if (req.method === 'POST' && path === '/api/auth/logout') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && path === '/api/v2/auth/sessions') {
    const account = byToken.get(bearer(req) ?? '');
    if (!account) return sendJson(res, 401, { error: 'Unauthorized', code: 401 });
    return sendJson(res, 200, [
      {
        sessionId: 'fixture-session',
        deviceLabel: 'Mawared Web',
        platform: 'web',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: '2026-01-01T00:00:00.000Z',
        revokedAt: null,
        isCurrent: true,
        isLegacyDevice: false,
      },
    ]);
  }

  // The HR list endpoints return bare arrays. Serving them empty lets the
  // Employees page reach its normal empty state, which is what distinguishes
  // "authorized but no data" from "forbidden" in the assertions.
  if (req.method === 'GET' && ['/api/employees', '/api/departments', '/api/roles'].includes(path)) {
    const account = byToken.get(bearer(req) ?? '');
    if (!account) return sendJson(res, 401, { error: 'Unauthorized', code: 401 });
    return sendJson(res, 200, []);
  }

  // Deny by default. Any route these fixtures do not model answers 403, which
  // is what the app should render a forbidden state for.
  return sendJson(res, 403, {
    error: 'Forbidden',
    message: 'غير مصرح',
    code: 403,
  });
}

async function serveStatic(res, pathname) {
  // Contained inside dist/: normalize then verify the resolved path still
  // starts at DIST, so `../` in a URL cannot escape the build output.
  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = resolve(join(DIST, normalize(requested)));
  const inside = candidate === DIST || candidate.startsWith(DIST + sep);

  let target = candidate;
  if (!inside) {
    target = join(DIST, 'index.html');
  } else {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) target = join(DIST, 'index.html');
    } catch {
      // SPA fallback: the app routes /employees, /payroll, ... client side.
      target = join(DIST, 'index.html');
    }
  }

  try {
    const file = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(() => {
      sendJson(res, 500, { error: 'FixtureError', code: 500 });
    });
    return;
  }
  serveStatic(res, url.pathname).catch(() => {
    res.writeHead(500);
    res.end();
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`e2e fixture server listening on http://${HOST}:${PORT}\n`);
});
