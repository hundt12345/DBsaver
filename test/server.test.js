import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.DBSAVER_TEST_PORT) || 3987;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

async function waitForServer(timeoutMs = 40_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Der Testserver ist nicht gestartet.');
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await waitForServer();

  // The station index is built in the background after startup.
  const startedAt = Date.now();
  while (Date.now() - startedAt < 40_000) {
    const payload = await (await fetch(`${BASE}/api/stations?q=Hauptwache`)).json();
    if (payload.stations.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});

after(() => {
  child?.kill('SIGTERM');
});

test('health endpoint reports the station index', async () => {
  const response = await fetch(`${BASE}/api/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.stationIndex.status, 'ready');
  assert.ok(payload.stationIndex.count > 200_000, 'the offline index covers all stops');
});

test('station search finds local halts (U-Bahn, bus, tram)', async () => {
  const response = await fetch(`${BASE}/api/stations?q=Hauptwache`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  const ids = payload.stations.map((station) => station.id);
  assert.ok(ids.includes('100001'), `Hauptwache is missing in ${ids.join(', ')}`);

  const localStop = payload.stations.find((station) => station.id === '100001');
  assert.equal(localStop.category, 'local');
  assert.equal(localStop.label, 'U-Bahn');
  assert.equal(localStop.bookable, true);
  assert.equal(localStop.relatedStationId, '8006692');
});

test('station search understands umlaut-free input and abbreviations', async () => {
  const koeln = await (await fetch(`${BASE}/api/stations?q=koeln`)).json();
  assert.ok(koeln.stations.some((station) => station.name === 'Köln Hbf'));

  const hbf = await (await fetch(`${BASE}/api/stations?q=hbf%20berlin`)).json();
  assert.ok(hbf.stations.some((station) => station.name === 'Berlin Hbf'));
});

test('station search rejects unusable queries', async () => {
  const payload = await (await fetch(`${BASE}/api/stations?q=a`)).json();
  assert.deepEqual(payload.stations, []);
});

test('price search answers with a result or a clear error, never a fake price', async () => {
  const response = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: { id: '8000105', name: 'Frankfurt(Main)Hbf' },
      to: { id: '8011160', name: 'Berlin Hbf' },
      date: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    }),
  });
  const payload = await response.json();

  if (response.status === 200) {
    assert.ok(Array.isArray(payload.results));
    assert.ok(payload.results.every((offer) => offer.price > 0));
    assert.equal(payload.source, 'bahn.de');
    assert.ok(payload.bookingUrl.startsWith('https://www.bahn.de/'));
    return;
  }

  assert.equal(response.status, 503);
  assert.match(payload.error, /nicht erreichbar|keine Preise/);
  assert.ok(Array.isArray(payload.attempts));
  assert.ok(payload.attempts.length > 0);
});

test('price search validates the input', async () => {
  const badDate = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: { id: '8000105', name: 'Frankfurt(Main)Hbf' },
      to: { id: '8011160', name: 'Berlin Hbf' },
      date: '2000-01-01',
    }),
  });
  assert.equal(badDate.status, 400);

  const badStation = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: { id: 'Frankfurt', name: 'Frankfurt' },
      to: { id: '8011160', name: 'Berlin Hbf' },
      date: new Date().toISOString().slice(0, 10),
    }),
  });
  assert.equal(badStation.status, 400);

  const sameStation = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: { id: '8000105', name: 'Frankfurt(Main)Hbf' },
      to: { id: '8000105', name: 'Frankfurt(Main)Hbf' },
      date: new Date().toISOString().slice(0, 10),
    }),
  });
  assert.equal(sameStation.status, 400);
});

test('status endpoint reports transports and upstreams', async () => {
  const response = await fetch(`${BASE}/api/status`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.ok(payload.tls.activeGroups);
  assert.ok(payload.stationIndex.count > 200_000);
  assert.equal(payload.upstreams.length, 2);
  assert.ok(payload.upstreams.every((upstream) => typeof upstream.ok === 'boolean'));
});

test('unknown api routes answer with 404 and unsupported methods with 405', async () => {
  assert.equal((await fetch(`${BASE}/api/nope`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/stations`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${BASE}/api/search`)).status, 405);
});
