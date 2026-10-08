import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBahnDeUrl,
  formatJourneyAsOffer,
  isPricableStationId,
  isValidStation,
  isValidTravelDate,
  normalizeStationName,
} from './src/search-utils.js';
import {
  liveStationToResult,
  mergeAndDedupeStations,
  stripInternalStationFields,
} from './src/station-merge.js';
import { USER_AGENT, upstreams } from './src/db-clients.js';
import {
  detectCurl,
  getTlsInfo,
  getTransportStats,
  isEdgeBlockError,
  isRateLimitError,
} from './src/db-transport.js';
import {
  getStationIndexInfo,
  lookupOfflineStation,
  searchOfflineStations,
  warmUpStationIndex,
} from './src/stations-offline.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const BODY_LIMIT = 8 * 1024;
const STATION_CACHE_TTL = 2 * 60 * 1000;
const PRICE_CACHE_TTL = Number(process.env.DBSAVER_PRICE_CACHE_TTL_MS) || 10 * 60 * 1000;
const STATION_RESULT_LIMIT = 10;
const STATUS_CACHE_TTL = 60 * 1000;
const SEARCH_RATE_LIMIT = { windowMs: 60 * 1000, max: 30 };

const stationCache = new Map();
const priceCache = new Map();
const priceInFlight = new Map();
const rateLimitBuckets = new Map();
let statusCache = null;
// After a failed/blocked live call the typeahead should not wait for the
// upstream again for a while - the offline index answers instantly.
const liveCooldownSeconds = 90;
const liveCooldownUntil = new Map();

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

function fail(statusCode, message, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
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

function pruneCache(cache, { maxEntries }) {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

function clientKey(request) {
  return request.socket?.remoteAddress || 'unknown';
}

function isRateLimited(request) {
  const key = clientKey(request);
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + SEARCH_RATE_LIMIT.windowMs });
    if (rateLimitBuckets.size > 5000) rateLimitBuckets.clear();
    return false;
  }

  bucket.count += 1;
  return bucket.count > SEARCH_RATE_LIMIT.max;
}

function isUpstreamCoolingDown(upstreamId) {
  const until = liveCooldownUntil.get(upstreamId) || 0;
  return until > Date.now();
}

function coolDownUpstream(upstreamId, seconds = liveCooldownSeconds) {
  liveCooldownUntil.set(upstreamId, Date.now() + seconds * 1000);
}

async function searchLiveStations(query) {
  const errors = [];

  for (const upstream of upstreams) {
    if (isUpstreamCoolingDown(upstream.id)) {
      errors.push({ upstream: upstream.label, error: 'Kurzzeitig deaktiviert (Bot-Schutz)' });
      continue;
    }

    try {
      const matches = await upstream.client.locations(query, {
        results: STATION_RESULT_LIMIT,
        stops: true,
        addresses: false,
        poi: false,
        language: 'de',
        timeoutMs: 4000,
      });

      const stations = matches
        .filter((match) => (match.type === 'station' || match.type === 'stop') && isValidStation(match))
        .map((match) => liveStationToResult(match));

      if (stations.length > 0) {
        liveCooldownUntil.delete(upstream.id);
        return { stations, upstream: upstream.label, errors };
      }
      errors.push({ upstream: upstream.label, error: 'Keine Treffer' });
    } catch (error) {
      console.warn(`[DBsaver] Haltestellensuche über ${upstream.label} fehlgeschlagen:`, error.message);
      errors.push({ upstream: upstream.label, error: error.message });
      // Fast failing upstreams should not slow down the typeahead.
      coolDownUpstream(upstream.id, isEdgeBlockError(error) ? 300 : 60);
    }
  }

  return { stations: [], upstream: null, errors };
}

/**
 * Enriches live results that carry an IFOPT/opaque id with the numeric station
 * number from the offline directory, so that the price search can use them.
 */
async function attachBookableIds(stations) {
  const needsLookup = stations.filter((station) => !station.bookable);
  if (needsLookup.length === 0) return stations;

  for (const station of needsLookup) {
    try {
      const offlineMatches = await searchOfflineStations(station.name, { limit: 3 });
      const normalizedName = normalizeStationName(station.name);
      const match = offlineMatches.find((candidate) => normalizeStationName(candidate.name) === normalizedName)
        || offlineMatches[0];

      if (match) {
        station.numericId = match.id;
        station.relatedStationId = match.relatedStationId ? String(match.relatedStationId) : null;
        station.category = match.category;
        station.label = match.label;
        station.rail = match.rail;
        station.local = match.local;
      }
    } catch (error) {
      console.warn('[DBsaver] Haltestelle konnte nicht ergänzt werden:', error.message);
    }
  }

  return stations;
}

async function searchStations(query) {
  const cacheKey = query.toLocaleLowerCase('de-DE');
  const cached = stationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const [live, offline] = await Promise.all([
    searchLiveStations(query).catch((error) => ({ stations: [], upstream: null, errors: [{ upstream: null, error: error.message }] })),
    searchOfflineStations(query, { limit: STATION_RESULT_LIMIT }).catch((error) => {
      console.warn('[DBsaver] Offline-Haltestellensuche fehlgeschlagen:', error.message);
      return [];
    }),
  ]);

  const merged = await attachBookableIds([...live.stations, ...offline].slice(0, 30))
    .catch(() => [...live.stations, ...offline]);

  const stations = mergeAndDedupeStations(
    merged.filter((station) => station.source === 'live'),
    merged.filter((station) => station.source !== 'live'),
    STATION_RESULT_LIMIT,
  ).map(stripInternalStationFields);

  const result = {
    stations,
    // `fallback` stays for the frontend: true means "no live answer, offline list only".
    fallback: live.stations.length === 0,
    sources: {
      live: live.stations.length > 0 ? live.upstream : null,
      offline: offline.length > 0,
    },
    offlineIndex: getStationIndexInfo().count,
  };

  stationCache.set(cacheKey, { result, expiresAt: Date.now() + STATION_CACHE_TTL });
  pruneCache(stationCache, { maxEntries: 200 });
  return result;
}

function travelTimeLabel(journey) {
  const departure = journey?.legs?.[0]?.departure;
  return departure ? new Date(departure).toISOString() : null;
}

async function requestPriceSearch({ from, to, date }) {
  const attempts = [];
  let sawUnpricedResult = false;

  for (const upstream of upstreams) {
    // Noon UTC always falls on the selected calendar date in Germany. The DB
    // best-price endpoint searches the whole day, the time itself is not a filter.
    const departure = new Date(`${date}T12:00:00.000Z`);

    try {
      const result = await upstream.client.journeys(from.id, to.id, {
        departure,
        bestprice: true,
        ageGroup: 'E', // one adult
        firstClass: false,
        language: 'de',
        timeoutMs: 20_000,
      });

      const offers = (result.journeys || [])
        .map((journey) => formatJourneyAsOffer(journey, {
          fromName: from.name,
          toName: to.name,
        }))
        .filter(Boolean)
        .sort((a, b) => a.price - b.price)
        .slice(0, 6);

      if (offers.length === 0) {
        sawUnpricedResult = true;
        attempts.push({ upstream: upstream.id, label: upstream.label, status: 'no-prices', connections: result.journeys?.length ?? 0, sample: travelTimeLabel(result.journeys?.[0]) });
        continue;
      }

      attempts.push({ upstream: upstream.id, label: upstream.label, status: 'ok' });

      return {
        offers,
        upstream: { id: upstream.id, label: upstream.label },
        attempts,
      };
    } catch (error) {
      const blocked = isEdgeBlockError(error);
      const rateLimited = isRateLimitError(error);
      console.warn(`[DBsaver] Preisabfrage über ${upstream.label} fehlgeschlagen:`, error.message);
      attempts.push({
        upstream: upstream.id,
        label: upstream.label,
        status: blocked ? 'blocked' : rateLimited ? 'rate-limited' : 'error',
        error: String(error.message || '').split('\n')[0].slice(0, 160),
      });
    }
  }

  const error = fail(503, sawUnpricedResult
    ? 'Die DB hat für diesen Tag keine Preise zurückgegeben. Bitte prüfe die Strecke direkt bei bahn.de.'
    : 'Die Live-Auskunft der DB ist gerade nicht erreichbar (Bot-Schutz oder Drosselung). Bitte versuche es in ein paar Minuten erneut.');
  error.attempts = attempts;
  throw error;
}

async function resolvePriceStation(rawStation, label) {
  if (!isValidStation(rawStation)) {
    throw fail(400, 'Bitte wähle Start und Ziel aus der Haltestellenliste aus.');
  }

  const station = {
    id: String(rawStation.id),
    name: String(rawStation.name),
  };

  const localOnly = rawStation.category === 'local' || rawStation.local === true;

  if (isPricableStationId(station.id)) return { station, adjusted: false, localOnly };

  // The DB price endpoint needs a station number. Stops that only carry an
  // IFOPT id (typical for bus/tram halts) are mapped to the DB station that
  // the offline directory lists for them.
  let offline = null;
  try {
    if (rawStation.numericId && isPricableStationId(String(rawStation.numericId))) {
      offline = await lookupOfflineStation(String(rawStation.numericId));
    }
    offline = offline || await lookupOfflineStation(station.id);
  } catch (error) {
    console.warn('[DBsaver] Offline-Zuordnung fehlgeschlagen:', error.message);
  }

  const numericId = offline?.id
    || (isPricableStationId(String(rawStation.numericId)) ? String(rawStation.numericId) : null)
    || (isPricableStationId(String(rawStation.relatedStationId)) ? String(rawStation.relatedStationId) : null);

  if (!numericId) {
    throw fail(400, `Für „${station.name}“ (${label}) liegt der DB keine Bahnhofsnummer vor. Bitte wähle einen Bahnhof oder eine größere Haltestelle in der Nähe.`);
  }

  return {
    station: { id: numericId, name: station.name },
    adjusted: true,
    localOnly: localOnly || offline?.local === true,
  };
}

async function handleStations(response, url) {
  const query = (url.searchParams.get('q') || '').trim();
  if (query.length < 2 || query.length > 80) {
    return sendJson(response, 200, { stations: [], fallback: false, sources: { live: null, offline: false } });
  }

  try {
    const result = await searchStations(query);
    return sendJson(response, 200, result);
  } catch (error) {
    console.error('[DBsaver] Haltestellensuche fehlgeschlagen:', error);
    return sendJson(response, 503, {
      error: 'Die Haltestellensuche ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.',
    });
  }
}

async function handleSearch(request, response) {
  if (isRateLimited(request)) {
    return sendJson(response, 429, {
      error: 'Zu viele Anfragen in kurzer Zeit. Bitte warte einen Moment – die DB drosselt häufige Abfragen.',
    });
  }

  let input;
  try {
    input = await readJsonBody(request);
  } catch (error) {
    return sendJson(response, error.statusCode || 400, { error: error.message });
  }

  const { from: rawFrom, to: rawTo, date } = input || {};

  if (!isValidTravelDate(date)) {
    return sendJson(response, 400, { error: 'Bitte wähle ein gültiges Datum ab heute.' });
  }

  let from;
  let to;
  let adjustedFrom = false;
  let adjustedTo = false;
  let localOnlyStation = false;

  try {
    const resolvedFrom = await resolvePriceStation(rawFrom, 'Start');
    from = resolvedFrom.station;
    adjustedFrom = resolvedFrom.adjusted;

    const resolvedTo = await resolvePriceStation(rawTo, 'Ziel');
    to = resolvedTo.station;
    adjustedTo = resolvedTo.adjusted;
    localOnlyStation = Boolean(resolvedFrom.localOnly || resolvedTo.localOnly);
  } catch (error) {
    return sendJson(response, error.statusCode || 400, { error: error.message });
  }

  if (from.id === to.id) {
    return sendJson(response, 400, { error: 'Start und Ziel müssen unterschiedlich sein.' });
  }

  const cacheKey = `${from.id}|${to.id}|${date}`;
  const cached = priceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return sendJson(response, 200, { ...cached.payload, cached: true });
  }

  try {
    const pending = priceInFlight.get(cacheKey) || requestPriceSearch({ from, to, date });
    priceInFlight.set(cacheKey, pending);

    let result;
    try {
      result = await pending;
    } finally {
      priceInFlight.delete(cacheKey);
    }

    const payload = {
      date,
      from: from.name,
      to: to.name,
      passengers: 1,
      passengerLabel: '1 erwachsene Person',
      travelClass: 2,
      direction: 'one-way',
      source: 'bahn.de',
      sourceLabel: result.upstream.label,
      sourceId: result.upstream.id,
      attempts: result.attempts,
      stationAdjusted: adjustedFrom || adjustedTo,
      queriedAt: new Date().toISOString(),
      bookingUrl: buildBahnDeUrl({ from, to, date }),
      results: result.offers,
    };

    priceCache.set(cacheKey, { payload, expiresAt: Date.now() + PRICE_CACHE_TTL });
    pruneCache(priceCache, { maxEntries: 300 });

    return sendJson(response, 200, payload);
  } catch (error) {
    if (localOnlyStation && (error.attempts || []).every((attempt) => attempt.status === 'no-prices')) {
      error.message = `${error.message} Die gewählte Haltestelle wird nur vom Stadtverkehr bedient – dafür berechnet die DB oft keinen Preis. Wähle in diesem Fall einen Bahnhof in der Nähe.`;
    }

    const [firstAttempt] = error.attempts || [];
    const statusLabels = {
      blocked: 'Bot-Schutz der DB (OPS_BLOCKED)',
      'rate-limited': 'zu viele Anfragen (429)',
      error: 'technischer Fehler',
      'no-prices': 'keine Preise für diesen Tag',
    };
    return sendJson(response, error.statusCode || 503, {
      error: error.message,
      details: firstAttempt
        ? `${firstAttempt.label}: ${statusLabels[firstAttempt.status] || firstAttempt.status}`
        : undefined,
      attempts: (error.attempts || []).map(({ upstream, label, status }) => ({ upstream, label, status })),
    });
  }
}

async function buildStatus() {
  if (statusCache && statusCache.expiresAt > Date.now()) return statusCache.payload;

  const curl = await detectCurl();
  const probes = [];

  for (const upstream of upstreams) {
    const startedAt = Date.now();
    try {
      const matches = await upstream.client.locations('Berlin Hbf', {
        results: 1,
        stops: true,
        addresses: false,
        poi: false,
        language: 'de',
        timeoutMs: 8000,
      });
      probes.push({
        upstream: upstream.id,
        label: upstream.label,
        ok: matches.length > 0,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      probes.push({
        upstream: upstream.id,
        label: upstream.label,
        ok: false,
        blocked: isEdgeBlockError(error),
        ms: Date.now() - startedAt,
        error: error.message,
      });
    }
  }

  const payload = {
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    userAgent: USER_AGENT,
    transport: {
      ...getTransportStats(),
      curlAvailable: curl.available,
      curlVersion: curl.available ? String(curl.version || '').slice(0, 60) : null,
      curlMode: curl.mode,
    },
    tls: getTlsInfo(),
    stationIndex: getStationIndexInfo(),
    upstreams: probes,
    checkedAt: new Date().toISOString(),
  };

  statusCache = { payload, expiresAt: Date.now() + STATUS_CACHE_TTL };
  return payload;
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health') {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      return sendJson(response, 405, { error: 'Diese Methode wird nicht unterstützt.' });
    }
    return sendJson(response, 200, { ok: true, stationIndex: getStationIndexInfo() });
  }

  if (url.pathname === '/api/status') {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      return sendJson(response, 405, { error: 'Diese Methode wird nicht unterstützt.' });
    }
    try {
      return sendJson(response, 200, await buildStatus());
    } catch (error) {
      console.error('[DBsaver] Statusprüfung fehlgeschlagen:', error);
      return sendJson(response, 503, { ok: false, error: error.message });
    }
  }

  if (url.pathname === '/api/stations') {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      return sendJson(response, 405, { error: 'Diese Methode wird nicht unterstützt.' });
    }
    return handleStations(response, url);
  }

  if (url.pathname === '/api/search') {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'Diese Methode wird nicht unterstützt.' });
    }
    return handleSearch(request, response);
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
  const { activeGroups } = getTlsInfo();
  console.log(`[DBsaver] TLS-Gruppen für DB-Endpunkte: ${activeGroups || 'Standard'}`);
  detectCurl().then((curl) => {
    console.log(curl.available
      ? `[DBsaver] curl-Fallback verfügbar (${curl.version}, Modus ${curl.mode}).`
      : '[DBsaver] Kein curl gefunden – Node-Transport ist die einzige Option.');
  });
  // Warm up the bundled station index in the background so the first search is fast.
  warmUpStationIndex();
});
