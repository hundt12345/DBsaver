import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from 'db-vendo-client';
import { withThrottling } from 'db-vendo-client/throttle.js';
import { readSimplifiedStations } from 'db-hafas-stations';
import { profile as dbwebProfile } from 'db-vendo-client/p/dbweb/index.js';
import {
  buildBahnDeUrl,
  formatJourneyAsOffer,
  isValidStation,
  isValidTravelDate,
} from './src/search-utils.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const BODY_LIMIT = 8 * 1024;
const STATION_CACHE_TTL = 2 * 60 * 1000;
const stationCache = new Map();
let offlineStationIndexPromise;

// DB-Vendo's bahn.de profile is used server-side because the API does not enable browser CORS.
// Keep the upstream request rate low; the upstream service can throttle or block clients.
const client = createClient(
  withThrottling(dbwebProfile, 2, 1000),
  process.env.DB_USER_AGENT || 'DBsaver/1.0 (+https://github.com/hundt12345/DBsaver)',
  { enrichStations: false },
);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw fail(413, 'Die Anfrage ist zu groß.');
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fail(400, 'Die Anfrage konnte nicht gelesen werden.');
  }
}

function pruneStationCache() {
  const now = Date.now();
  for (const [key, entry] of stationCache) {
    if (entry.expiresAt <= now) stationCache.delete(key);
  }
  while (stationCache.size > 100) {
    stationCache.delete(stationCache.keys().next().value);
  }
}

function normalizeStationName(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('de-DE')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

async function loadOfflineStationIndex() {
  if (!offlineStationIndexPromise) {
    offlineStationIndexPromise = (async () => {
      const stations = [];
      for await (const station of readSimplifiedStations()) {
        if (!isValidStation(station)) continue;
        stations.push({
          id: station.id,
          name: station.name,
          weight: Number(station.weight) || 0,
          normalizedName: normalizeStationName(station.name),
        });
      }
      return stations;
    })().catch((error) => {
      offlineStationIndexPromise = null;
      throw error;
    });
  }
  return offlineStationIndexPromise;
}

async function searchOfflineStations(query) {
  const normalizedQuery = normalizeStationName(query);
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  if (tokens.length === 0) return [];

  const index = await loadOfflineStationIndex();
  const matches = [];
  for (const station of index) {
    if (!tokens.every((token) => station.normalizedName.includes(token))) continue;
    const exactMatch = station.normalizedName === normalizedQuery ? 1_000_000 : 0;
    const prefixMatch = station.normalizedName.startsWith(normalizedQuery) ? 100_000 : 0;
    const score = exactMatch + prefixMatch + Math.min(station.weight, 1_000_000) / 10 - station.name.length;
    matches.push({ station, score });
  }

  matches.sort((a, b) => b.score - a.score);
  const results = [];
  const seenNames = new Set();
  for (const { station } of matches) {
    if (seenNames.has(station.normalizedName)) continue;
    seenNames.add(station.normalizedName);
    results.push({ id: station.id, name: station.name });
    if (results.length === 8) break;
  }
  return results;
}

async function searchStations(query) {
  const cacheKey = query.toLocaleLowerCase('de-DE');
  const cached = stationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  let result;
  try {
    const matches = await client.locations(query, {
      results: 8,
      stops: true,
      addresses: false,
      poi: false,
      language: 'de',
    });
    result = {
      stations: matches
        .filter((match) => (match.type === 'station' || match.type === 'stop') && isValidStation(match))
        .slice(0, 8)
        .map(({ id, name }) => ({ id, name })),
      fallback: false,
    };
  } catch (error) {
    console.warn('[DBsaver] Live-Bahnhofssuche nicht erreichbar; nutze lokalen Stationsindex:', error.message);
    result = {
      stations: await searchOfflineStations(query),
      fallback: true,
    };
  }

  stationCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + STATION_CACHE_TTL,
  });
  pruneStationCache();
  return result;
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health') {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      return sendJson(response, 405, { error: 'Diese Methode wird nicht unterstützt.' });
    }
    return sendJson(response, 200, { ok: true });
  }

  if (url.pathname === '/api/stations') {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      return sendJson(response, 405, { error: 'Diese Methode wird nicht unterstützt.' });
    }

    const query = (url.searchParams.get('q') || '').trim();
    if (query.length < 2 || query.length > 80) {
      return sendJson(response, 200, { stations: [] });
    }

    try {
      const result = await searchStations(query);
      return sendJson(response, 200, result);
    } catch (error) {
      console.error('[DBsaver] Stationssuche fehlgeschlagen:', error);
      return sendJson(response, 503, {
        error: 'Die Bahnhofssuche ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.',
      });
    }
  }

  if (url.pathname === '/api/search') {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'Diese Methode wird nicht unterstützt.' });
    }

    let input;
    try {
      input = await readJsonBody(request);
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { error: error.message });
    }

    const { from, to, date } = input || {};
    if (!isValidStation(from) || !isValidStation(to)) {
      return sendJson(response, 400, { error: 'Bitte wähle Start und Ziel aus der Bahnhofsliste aus.' });
    }
    if (from.id === to.id) {
      return sendJson(response, 400, { error: 'Start und Ziel müssen unterschiedlich sein.' });
    }
    if (!isValidTravelDate(date)) {
      return sendJson(response, 400, { error: 'Bitte wähle ein gültiges Datum ab heute.' });
    }

    try {
      // Noon UTC always falls on the selected calendar date in Germany. The DB best-price
      // endpoint searches the whole day, so the time itself is not used as a departure filter.
      const result = await client.journeys(from.id, to.id, {
        departure: new Date(`${date}T12:00:00.000Z`),
        bestprice: true,
        ageGroup: 'E', // one adult; extend this traveller model when needed
        firstClass: false,
        language: 'de',
      });

      const offers = result.journeys
        .map((journey) => formatJourneyAsOffer(journey, {
          fromName: from.name,
          toName: to.name,
        }))
        .filter(Boolean)
        .sort((a, b) => a.price - b.price)
        .slice(0, 6);

      return sendJson(response, 200, {
        date,
        from: from.name,
        to: to.name,
        passengers: 1,
        passengerLabel: '1 erwachsene Person',
        travelClass: 2,
        direction: 'one-way',
        source: 'bahn.de',
        queriedAt: new Date().toISOString(),
        bookingUrl: buildBahnDeUrl({ from, to, date }),
        results: offers,
      });
    } catch (error) {
      console.error('[DBsaver] Preisabfrage fehlgeschlagen:', error);
      return sendJson(response, 503, {
        error: 'Die Live-Auskunft von bahn.de antwortet gerade nicht. Bitte versuche es später erneut.',
      });
    }
  }

  return sendJson(response, 404, { error: 'API-Endpunkt nicht gefunden.' });
}

async function serveStatic(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end('Ungültige URL.');
    return;
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    response.writeHead(404);
    response.end('Nicht gefunden.');
    return;
  }

  try {
    const contents = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'content-type': contentTypes[extension] || 'application/octet-stream',
      'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
    });
    if (request.method === 'HEAD') {
      response.end();
    } else {
      response.end(contents);
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Nicht gefunden.');
      return;
    }
    console.error('[DBsaver] Datei konnte nicht ausgeliefert werden:', error);
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Interner Serverfehler.');
  }
}

const server = createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  } catch {
    response.writeHead(400);
    response.end('Ungültige URL.');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    await handleApi(request, response, url);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end('Diese Methode wird nicht unterstützt.');
    return;
  }

  await serveStatic(request, response, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`DBsaver läuft auf http://${HOST}:${PORT}`);
});
