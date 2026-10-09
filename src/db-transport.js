import { execFile } from 'node:child_process';
import https from 'node:https';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { stringify } from 'qs';
import { checkIfResponseIsOk } from 'db-vendo-client/lib/request.js';

const execFileAsync = promisify(execFile);

// DB's edge (Akamai) blocks server-side requests with `452 OPS_BLOCKED` /
// `403 Access Denied`, apparently based on the TLS fingerprint. The settings
// below (TLS 1.2, browser-like cipher and group order, optional curl fallback)
// are a workaround that is not reliable: on Render (Node 24, OpenSSL 3.5) both
// upstreams were still blocked on 2026-10-09.
// See https://github.com/public-transport/db-vendo-client/issues/46 (and #50/#53).
const BAHN_HOSTS = new Set([
  'int.bahn.de',
  'www.bahn.de',
  'app.services-bahn.de',
  'app.vendo.noncd.db.de',
]);

const BAHN_CHROMIUM_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':');

// The order of the TLS supported_groups vector is what the edge seems to grade.
// Hybrid post-quantum groups first, then the classic ones.
const GROUP_CANDIDATES = [
  'X25519MLKEM768:X25519:P-256:P-384',
  'X25519:P-256:P-384',
  'P-256:P-384',
];

const BLOCK_PATTERNS = /ops[_ -]?blocked|access denied|forbidden|akamai|bot detection|blocked by|unusual traffic/i;
const CURL_MODES = new Set(['auto', 'off', 'force']);

const stats = {
  requests: 0,
  blocked: 0,
  curlAttempts: 0,
  curlSuccesses: 0,
  lastBlockAt: null,
  lastError: null,
};

let agent = null;
let tlsInfo = null;
let curlInfo = null;
let curlPromise = null;

export function getTlsInfo() {
  if (tlsInfo) return tlsInfo;

  const supportedGroups = GROUP_CANDIDATES.filter((groups) => {
    try {
      tls.createSecureContext({ ecdhCurve: groups });
      return true;
    } catch {
      return false;
    }
  });

  tlsInfo = {
    node: process.version,
    openssl: process.versions.openssl,
    maxVersion: 'TLSv1.2',
    supportedGroups,
    activeGroups: supportedGroups[0] ?? null,
  };
  return tlsInfo;
}

export function getBahnAgent() {
  if (!agent) {
    const { activeGroups } = getTlsInfo();
    agent = new https.Agent({
      keepAlive: true,
      maxSockets: 4,
      ALPNProtocols: ['http/1.1'],
      ciphers: BAHN_CHROMIUM_CIPHERS,
      // Force TLS 1.2 to avoid DB's Akamai edge blocking TLS 1.3 handshakes
      // with OPS_BLOCKED (same workaround as sparpreis.guru).
      maxVersion: 'TLSv1.2',
      ...(activeGroups ? { ecdhCurve: activeGroups } : {}),
    });
  }
  return agent;
}

export function isBahnApiUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    if (url.protocol !== 'https:') return false;
    if (!BAHN_HOSTS.has(url.hostname)) return false;
    return url.pathname.startsWith('/web/api/') || url.pathname.startsWith('/mob/');
  } catch {
    return false;
  }
}

/**
 * node-fetch (used by db-vendo-client) accepts a function that receives the
 * parsed URL and returns the agent for that request.
 */
export function selectBahnAgent(url) {
  return isBahnApiUrl(url) ? getBahnAgent() : undefined;
}

export function withBahnTransport(profile) {
  return {
    ...profile,
    randomizeUserAgent: false,
    transformReq: (_context, options) => {
      // When a proxy is configured, keep the proxy agent the client built.
      if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) return options;
      return { ...options, agent: selectBahnAgent };
    },
  };
}

export function isEdgeBlockError(error) {
  if (!error) return false;
  if (typeof error.status === 'number' && [403, 451, 452].includes(error.status)) return true;
  if (typeof error.response?.status === 'number' && [403, 451, 452].includes(error.response.status)) return true;
  if (error.code === 'ECONNRESET') return true;

  const text = [
    error.message,
    error.hafasMessage,
    error.hafasDescription,
    error.props?.code,
    typeof error.body === 'string' ? error.body.slice(0, 500) : '',
  ].filter(Boolean).join(' ');

  return BLOCK_PATTERNS.test(text);
}

export function isRateLimitError(error) {
  if (!error) return false;
  if (error.response?.status === 429 || error.status === 429) return true;
  return /too many requests|rate ?limit|429/i.test(String(error.message || ''));
}

function getCurlMode() {
  const mode = String(process.env.DBSAVER_CURL || 'auto').toLowerCase();
  return CURL_MODES.has(mode) ? mode : 'auto';
}

export async function detectCurl() {
  if (curlInfo) return curlInfo;

  if (!curlPromise) {
    curlPromise = execFileAsync('curl', ['--version'], { timeout: 5000 })
      .then(({ stdout }) => {
        curlInfo = {
          available: true,
          version: stdout.split('\n')[0]?.trim() || 'curl',
          mode: getCurlMode(),
        };
        return curlInfo;
      })
      .catch(() => {
        curlInfo = { available: false, version: null, mode: getCurlMode() };
        return curlInfo;
      });
  }

  return curlPromise;
}

export async function curlRequest(ctx, reqData, { userAgent, timeoutMs = 15_000 } = {}) {
  const { profile, opt } = ctx;
  const method = reqData.method || 'GET';
  const query = reqData.query ? `?${stringify(reqData.query, { arrayFormat: 'brackets', encodeValuesOnly: true })}` : '';
  const url = `${reqData.endpoint}${reqData.path || ''}${query}`;
  const body = reqData.body === undefined ? null : JSON.stringify(profile.transformReqBody(ctx, reqData.body));

  const headers = {
    accept: 'application/json',
    'accept-language': opt?.language || profile.defaultLanguage || 'de',
    'user-agent': userAgent,
    ...reqData.headers,
  };
  if (body !== null && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }

  const args = [
    '--silent', '--show-error',
    '--http1.1',
    '--compressed',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '--request', method,
    '--write-out', '\n%{http_code}',
  ];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    args.push('--header', `${key}: ${value}`);
  }
  if (body !== null) args.push('--data-binary', body);
  args.push(url);

  stats.curlAttempts += 1;

  let stdout;
  try {
    ({ stdout } = await execFileAsync('curl', args, {
      timeout: timeoutMs + 5_000,
      maxBuffer: 24 * 1024 * 1024,
    }));
  } catch (error) {
    // execFile puts the complete command line into the message - keep the
    // error short so that it stays safe to log and to show in the UI.
    const reason = String(error.stderr || error.message || '').split('\n')[0].trim();
    throw new Error(`curl-Transport fehlgeschlagen: ${reason.slice(0, 160) || 'unbekannter Fehler'}`);
  }

  const separator = stdout.lastIndexOf('\n');
  const status = Number(stdout.slice(separator + 1));
  const text = stdout.slice(0, separator);

  if (!Number.isFinite(status)) {
    throw new Error('curl hat keine gültige Antwort geliefert.');
  }

  const errorProps = { url, transport: 'curl', status };

  if (status < 200 || status >= 300) {
    const error = new Error(`Upstream antwortete mit HTTP ${status}.`);
    Object.assign(error, errorProps, { body: text.slice(0, 500) });
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const error = new Error('Antwort war kein gültiges JSON (evtl. Bot-Schutz-Seite).');
    Object.assign(error, errorProps, { body: text.slice(0, 500) });
    throw error;
  }

  checkIfResponseIsOk({ body: parsed, errProps: errorProps });
  stats.curlSuccesses += 1;

  return { res: parsed, common: {} };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} hat nach ${Math.round(timeoutMs / 1000)} s nicht geantwortet.`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Wraps the client's request function: the native Node transport is tried
 * first, and only if DB's edge blocks it (or the connection is reset) the same
 * request is retried through curl. Both transports keep the same request body.
 */
export function withRequestFallback(profile, {
  userAgent,
  timeoutMs = 12_000,
  label = 'DB-Abfrage',
  curl = curlRequest,
  detect = detectCurl,
} = {}) {
  const nativeRequest = profile.request;

  return {
    ...profile,
    request: async (ctx, requestUserAgent, reqData) => {
      // db-vendo-client deletes `reqData.endpoint` after building the request,
      // so the retry through curl needs its own copy.
      const curlReqData = { ...reqData };
      const agentUser = requestUserAgent || userAgent;
      // Callers may pass a per-request budget via `opt.timeoutMs`
      // (station search wants to fail fast, the price search may take longer).
      const requestTimeoutMs = Number(ctx?.opt?.timeoutMs) || timeoutMs;
      stats.requests += 1;

      try {
        return await withTimeout(nativeRequest(ctx, agentUser, reqData), requestTimeoutMs, label);
      } catch (error) {
        stats.lastError = String(error.message || '').split('\n')[0].slice(0, 200);

        if (!isEdgeBlockError(error)) throw error;

        stats.blocked += 1;
        stats.lastBlockAt = new Date().toISOString();

        const curlTool = await detect();
        if (!curlTool.available || getCurlMode() === 'off') {
          error.hint = 'DB blockiert die Server-Anfrage (Bot-Schutz). Ein curl-Fallback ist nicht verfügbar.';
          throw error;
        }

        try {
          console.warn(`[DBsaver] ${label}: DB-Bot-Schutz erkannt (${error.message}); versuche curl-Fallback.`);
          return await curl(ctx, curlReqData, { userAgent: agentUser, timeoutMs: requestTimeoutMs });
        } catch (curlError) {
          curlError.cause = error;
          curlError.hint = 'Sowohl Node- als auch curl-Transport wurden blockiert.';
          throw curlError;
        }
      }
    },
  };
}

/** Keeps two clients (db + dbweb) from firing the same request twice in parallel. */
export function getTransportStats() {
  return {
    ...stats,
    curl: curlInfo
      ? { available: curlInfo.available, mode: curlInfo.mode, version: String(curlInfo.version || '').slice(0, 60) }
      : null,
  };
}
