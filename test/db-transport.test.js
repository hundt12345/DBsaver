import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getTlsInfo,
  isBahnApiUrl,
  isEdgeBlockError,
  isRateLimitError,
  selectBahnAgent,
  withBahnTransport,
  withRequestFallback,
} from '../src/db-transport.js';

test('only DB API hosts and paths get the hardened agent', () => {
  assert.equal(isBahnApiUrl(new URL('https://int.bahn.de/web/api/reiseloesung/orte')), true);
  assert.equal(isBahnApiUrl(new URL('https://app.services-bahn.de/mob/angebote/tagesbestpreis')), true);
  assert.equal(isBahnApiUrl(new URL('https://www.bahn.de/web/api/angebote/fahrplan')), true);
  assert.equal(isBahnApiUrl(new URL('https://int.bahn.de/')), false);
  assert.equal(isBahnApiUrl(new URL('https://example.com/mob/angebote/fahrplan')), false);
  assert.equal(isBahnApiUrl('not a url'), false);

  assert.ok(selectBahnAgent(new URL('https://int.bahn.de/web/api/reiseloesung/orte')));
  assert.equal(selectBahnAgent(new URL('https://example.com/')), undefined);
});

test('the TLS setup picks a supported group order', () => {
  const info = getTlsInfo();
  assert.ok(info.supportedGroups.length > 0);
  assert.match(info.activeGroups, /X25519|P-256/);
  assert.ok(info.supportedGroups.includes(info.activeGroups));
});

test('blocked and rate limited responses are recognized', () => {
  assert.equal(isEdgeBlockError(Object.assign(new Error('Forbidden'), { response: { status: 403 } })), true);
  assert.equal(isEdgeBlockError(Object.assign(new Error('OPS_BLOCKED'), { status: 452 })), true);
  assert.equal(isEdgeBlockError(new Error('{"status":"ERROR","code":"OPS_BLOCKED"}')), true);
  assert.equal(isEdgeBlockError(new Error('Access Denied')), true);
  assert.equal(isEdgeBlockError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isEdgeBlockError(new Error('Keine Treffer')), false);
  assert.equal(isEdgeBlockError(null), false);

  assert.equal(isRateLimitError(Object.assign(new Error('Too Many Requests'), { response: { status: 429 } })), true);
  assert.equal(isRateLimitError(new Error('kaputt')), false);
});

test('withBahnTransport installs the request hook', () => {
  const profile = withBahnTransport({ randomizeUserAgent: true });
  assert.equal(profile.randomizeUserAgent, false);
  assert.equal(typeof profile.transformReq, 'function');

  const options = profile.transformReq({ profile, opt: {} }, { agent: null });
  assert.equal(typeof options.agent, 'function');
});

function createProfile(request, opt = {}) {
  return { request, ...opt };
}

const fakeCurlAvailable = { available: true, version: 'curl test', mode: 'auto' };
const noCurl = { available: false, version: null, mode: 'off' };

test('the native transport wins when it answers', async () => {
  let curlCalls = 0;
  const profile = withRequestFallback(createProfile(async () => ({ res: { ok: true }, common: {} })), {
    userAgent: 'test/1',
    detect: async () => fakeCurlAvailable,
    curl: async () => {
      curlCalls += 1;
      return { res: {}, common: {} };
    },
  });

  const result = await profile.request({ profile, opt: {} }, 'test/1', { endpoint: 'https://int.bahn.de/web/api/x' });
  assert.deepEqual(result.res, { ok: true });
  assert.equal(curlCalls, 0);
});

test('an OPS_BLOCKED answer is retried through curl', async () => {
  let seenRequest = null;
  const profile = withRequestFallback(createProfile(async () => {
    throw Object.assign(new Error('Forbidden'), { response: { status: 452 } });
  }), {
    userAgent: 'test/1',
    detect: async () => fakeCurlAvailable,
    curl: async (ctx, reqData) => {
      seenRequest = reqData;
      return { res: { answered: 'curl' }, common: {} };
    },
  });

  const reqData = { endpoint: 'https://int.bahn.de/web/api/reiseloesung/orte', method: 'GET' };
  const result = await profile.request({ profile, opt: {} }, 'test/1', reqData);

  assert.deepEqual(result.res, { answered: 'curl' });
  // the client library deletes `endpoint` before fetching, the retry keeps its own copy
  assert.equal(seenRequest.endpoint, 'https://int.bahn.de/web/api/reiseloesung/orte');
  assert.equal(reqData.endpoint, 'https://int.bahn.de/web/api/reiseloesung/orte');
});

test('blocked responses without curl stay blocked', async () => {
  const profile = withRequestFallback(createProfile(async () => {
    throw Object.assign(new Error('OPS_BLOCKED'), { status: 452 });
  }), {
    userAgent: 'test/1',
    detect: async () => noCurl,
  });

  await assert.rejects(
    () => profile.request({ profile, opt: {} }, 'test/1', { endpoint: 'https://int.bahn.de/web/api/x' }),
    /OPS_BLOCKED/,
  );
});

test('a hanging native request times out and moves on', async () => {
  const profile = withRequestFallback(createProfile(() => new Promise(() => {})), {
    userAgent: 'test/1',
    timeoutMs: 60,
    detect: async () => noCurl,
  });

  await assert.rejects(
    () => profile.request({ profile, opt: {} }, 'test/1', { endpoint: 'https://int.bahn.de/web/api/x' }),
    /nicht geantwortet/,
  );
});
