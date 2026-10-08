import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { curlRequest, detectCurl } from '../src/db-transport.js';

const profile = {
  transformReqBody: (_ctx, body) => body,
  defaultLanguage: 'de',
};

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const curl = await detectCurl();

test('curl transport keeps method, headers and body and parses JSON', { skip: !curl.available }, async () => {
  let received = null;

  await withServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received = {
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        accept: request.headers.accept,
        userAgent: request.headers['user-agent'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ verbindungen: [{ id: '1' }] }));
    });
  }, async (base) => {
    const result = await curlRequest(
      { profile, opt: { language: 'de' } },
      {
        endpoint: `${base}/mob/angebote/tagesbestpreis`,
        method: 'POST',
        query: { limit: 2 },
        body: { abfahrtsHalt: 'A=1@L=8000105@' },
        headers: { 'X-Correlation-ID': 'test' },
      },
      { userAgent: 'DBsaver/test', timeoutMs: 10_000 },
    );

    assert.deepEqual(result.res, { verbindungen: [{ id: '1' }] });
  });

  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/mob/angebote/tagesbestpreis?limit=2');
  assert.equal(received.contentType, 'application/json');
  assert.equal(received.accept, 'application/json');
  assert.equal(received.userAgent, 'DBsaver/test');
  assert.equal(received.body, JSON.stringify({ abfahrtsHalt: 'A=1@L=8000105@' }));
});

test('curl transport reports HTTP errors with their status', { skip: !curl.available }, async () => {
  await withServer((_request, response) => {
    response.writeHead(452, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ERROR', code: 'OPS_BLOCKED' }));
  }, async (base) => {
    await assert.rejects(
      () => curlRequest({ profile, opt: {} }, { endpoint: base, method: 'GET' }, { userAgent: 'test', timeoutMs: 10_000 }),
      (error) => error.status === 452 && /HTTP 452/.test(error.message),
    );
  });
});

test('curl transport rejects non-JSON answers (bot protection pages)', { skip: !curl.available }, async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body>Access Denied</body></html>');
  }, async (base) => {
    await assert.rejects(
      () => curlRequest({ profile, opt: {} }, { endpoint: base, method: 'GET' }, { userAgent: 'test', timeoutMs: 10_000 }),
      /kein gültiges JSON/,
    );
  });
});
