import { readFullStations, readSimplifiedStations } from 'db-hafas-stations';
import {
  STATION_FLAG,
  describeStationFlags,
  normalizeStationName,
  scoreStationMatch,
  tokenVariants,
  tokenizeStationQuery,
} from './search-utils.js';

// The index is built once, lazily and compactly: the names live in two big
// strings (display + normalized) plus offset tables. That keeps ~292k stops
// including bus/tram/U-Bahn halts in memory without a fat object per stop.
const NAME_SEPARATOR = '\u0000';
const MAX_CANDIDATES = 40_000;
const MAX_RESULTS = 12;

let indexPromise = null;
let indexInfo = {
  status: 'idle',
  count: 0,
  rich: false,
  buildMs: null,
  error: null,
  loadedAt: null,
};

export function getStationIndexInfo() {
  return {
    status: indexInfo.status,
    count: indexInfo.count,
    rich: indexInfo.rich,
    buildMs: indexInfo.buildMs,
    error: indexInfo.error,
    loadedAt: indexInfo.loadedAt,
  };
}

/** Starts building the offline index without blocking the caller. */
export function warmUpStationIndex() {
  return loadStationIndex().then(
    () => true,
    (error) => {
      console.warn('[DBsaver] Offline-Bahnhofsindex konnte nicht aufgebaut werden:', error.message);
      return false;
    },
  );
}

function loadStationIndex() {
  if (!indexPromise) {
    indexInfo = { ...indexInfo, status: 'loading' };
    indexPromise = buildStationIndex()
      .then((index) => {
        indexInfo = {
          ...indexInfo,
          status: 'ready',
          count: index.count,
          rich: index.rich,
          buildMs: index.buildMs,
          loadedAt: new Date().toISOString(),
          error: null,
        };
        console.log(`[DBsaver] Stationsindex bereit: ${index.count} Haltestellen in ${index.buildMs} ms (${index.rich ? 'vollständig' : 'reduziert'}).`);
        return index;
      })
      .catch((error) => {
        indexPromise = null;
        indexInfo = { ...indexInfo, status: 'failed', error: error.message };
        throw error;
      });
  }
  return indexPromise;
}

function createBuilder() {
  return {
    ids: [],
    weights: [],
    flags: [],
    related: [],
    names: [],
    normalized: [],
    nameOffsets: [0],
    normalizedOffsets: [0],
  };
}

function pushStation(builder, { id, name, weight, flags, related }) {
  const normalized = normalizeStationName(name);
  if (!normalized) return;

  builder.ids.push(Number(id));
  builder.weights.push(Number(weight) || 0);
  builder.flags.push(flags);
  builder.related.push(related ? Number(related) : 0);
  builder.names.push(name);
  builder.normalized.push(normalized);
  builder.nameOffsets.push(builder.nameOffsets.at(-1) + name.length + NAME_SEPARATOR.length);
  builder.normalizedOffsets.push(builder.normalizedOffsets.at(-1) + normalized.length + NAME_SEPARATOR.length);
}

function finalizeBuilder(builder, { rich, buildMs }) {
  const count = builder.ids.length;
  const idOrder = new Uint32Array(count);
  for (let position = 0; position < count; position += 1) idOrder[position] = position;
  idOrder.sort((a, b) => builder.ids[a] - builder.ids[b]);

  return {
    count,
    rich,
    buildMs,
    ids: Int32Array.from(builder.ids),
    weights: Float32Array.from(builder.weights),
    flags: Uint8Array.from(builder.flags),
    related: Int32Array.from(builder.related),
    names: builder.names.join(NAME_SEPARATOR),
    normalized: builder.normalized.join(NAME_SEPARATOR),
    nameOffsets: Int32Array.from(builder.nameOffsets),
    normalizedOffsets: Int32Array.from(builder.normalizedOffsets),
    idOrder,
  };
}

async function buildStationIndex(entries = readFullStations(), { fallbackToSparse = true } = {}) {
  const startedAt = Date.now();
  const builder = createBuilder();
  let rich = true;

  try {
    for await (const entry of entries) {
      if (typeof entry?.id !== 'string' || !/^\d{6,15}$/.test(entry.id)) continue;
      if (typeof entry.name !== 'string' || entry.name.trim().length === 0) continue;
      if (entry.type === 'address') continue;

      let flags = stationEntryFlags(entry);
      const related = entry.station?.id && entry.station.id !== entry.id ? entry.station.id : null;
      if (related) flags |= STATION_FLAG.relatedStation;

      pushStation(builder, {
        id: entry.id,
        name: entry.name,
        weight: entry.weight ?? entry.station?.weight,
        flags,
        related,
      });
    }
  } catch (error) {
    // `full.ndjson` missing or broken: fall back to the reduced station list.
    console.warn('[DBsaver] Vollständige Haltestellendaten nicht lesbar, nutze reduzierte Liste:', error.message);
    rich = false;
    if (!fallbackToSparse) throw error;
    const reduced = createBuilder();
    for await (const station of readSimplifiedStations()) {
      if (typeof station?.id !== 'string' || !/^\d{6,15}$/.test(station.id)) continue;
      if (typeof station.name !== 'string' || station.name.trim().length === 0) continue;
      pushStation(reduced, {
        id: station.id,
        name: station.name,
        weight: station.weight,
        flags: 0,
        related: null,
      });
    }
    Object.assign(builder, reduced);
  }

  return finalizeBuilder(builder, { rich, buildMs: Date.now() - startedAt });
}

function stationEntryFlags(entry) {
  let flags = 0;
  const products = entry.products;

  if (products) {
    if (products.nationalExpress || products.national) flags |= STATION_FLAG.longDistance;
    if (products.regionalExpress || products.regional) flags |= STATION_FLAG.regional;
    if (products.suburban) flags |= STATION_FLAG.suburban;
    if (products.subway) flags |= STATION_FLAG.subway;
    if (products.tram || products.bus || products.ferry || products.taxi) flags |= STATION_FLAG.surface;
    if (flags & (STATION_FLAG.longDistance | STATION_FLAG.regional | STATION_FLAG.suburban)) {
      flags |= STATION_FLAG.rail;
    }
    if (products.subway || products.tram || products.bus || products.ferry || products.taxi) {
      flags |= STATION_FLAG.local;
    }
  } else if (entry.type === 'station') {
    // Without product data we still know that a `station` entry is a railway station.
    flags |= STATION_FLAG.rail;
  }

  return flags;
}

/**
 * Typeahead input often comes without umlauts ("muenchen", "koeln"). The query
 * is retried with expanded umlauts when the literal search finds nothing.
 */
function expandUmlautQuery(query) {
  return String(query)
    .replace(/ue/gi, (match) => (match[0] === 'U' ? 'Ü' : 'ü'))
    .replace(/oe/gi, (match) => (match[0] === 'O' ? 'Ö' : 'ö'))
    .replace(/ae/gi, (match) => (match[0] === 'A' ? 'Ä' : 'ä'))
    .replace(/ss/g, 'ß');
}

function entryIndexAtPosition(index, position) {
  const { normalizedOffsets } = index;
  let low = 0;
  let high = index.count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (normalizedOffsets[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

function entriesContainingSingleToken(index, token, matches) {
  const { normalized } = index;
  let from = 0;

  for (;;) {
    const position = normalized.indexOf(token, from);
    if (position === -1) break;
    matches.add(entryIndexAtPosition(index, position));
    if (matches.size > MAX_CANDIDATES) return;
    from = position + 1;
  }
}

function entriesContainingToken(index, token) {
  const matches = new Set();
  for (const variant of tokenVariants(token)) {
    entriesContainingSingleToken(index, variant, matches);
    if (matches.size > MAX_CANDIDATES) break;
  }
  return matches;
}

function readName(index, entryIndex) {
  return index.names.slice(index.nameOffsets[entryIndex], index.nameOffsets[entryIndex + 1] - 1);
}

function readNormalizedName(index, entryIndex) {
  return index.normalized.slice(index.normalizedOffsets[entryIndex], index.normalizedOffsets[entryIndex + 1] - 1);
}

function findEntryIndexById(index, id) {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return -1;

  let low = 0;
  let high = index.count - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = index.ids[index.idOrder[middle]];
    if (candidate === numericId) return index.idOrder[middle];
    if (candidate < numericId) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

export function toStationResult(index, entryIndex, { source = 'offline', score = 0 } = {}) {
  const flags = index.flags[entryIndex];
  const related = index.related[entryIndex];
  const { category, label } = describeStationFlags(flags);

  return {
    id: String(index.ids[entryIndex]),
    name: readName(index, entryIndex),
    category,
    label,
    rail: Boolean(flags & STATION_FLAG.rail),
    local: Boolean(flags & STATION_FLAG.local),
    bookable: true,
    relatedStationId: related ? String(related) : null,
    weight: index.weights[entryIndex],
    source,
    score,
  };
}

/**
 * Builds the compact index from any async iterable of station entries
 * (`db-hafas-stations` shape). Exported for tests.
 */
export function buildStationIndexFrom(entries) {
  return buildStationIndex(entries, { fallbackToSparse: false });
}

/**
 * @param {object} index index built by `buildStationIndexFrom`
 * @param {string} query raw user input
 */
export function searchStationIndex(index, query, { limit = MAX_RESULTS, expandUmlauts = true } = {}) {
  if (!query || String(query).trim().length === 0) return [];

  const variants = [query];
  const expandedQuery = expandUmlautQuery(query);
  // "muenchen" / "koeln" are expanded to "münchen" / "köln"; both spellings
  // are searched and merged, because some stop names really do use "ue".
  if (expandUmlauts && normalizeStationName(expandedQuery) !== normalizeStationName(query)) {
    variants.push(expandedQuery);
  }

  let results = [];
  for (const variant of variants) {
    const found = searchIndex(index, normalizeStationName(variant), tokenizeStationQuery(variant), limit);
    if (found.length === 0) continue;
    results = [...results, ...found]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  return results;
}

/**
 * Station typeahead over the bundled DB station directory (~292k stops,
 * including bus, tram, U-Bahn and S-Bahn halts).
 */
export async function searchOfflineStations(query, options = {}) {
  return searchStationIndex(await loadStationIndex(), query, options);
}

function searchIndex(index, normalizedQuery, tokens, limit) {
  if (tokens.length === 0) return [];

  let candidates = null;
  for (const token of tokens) {
    const matches = entriesContainingToken(index, token);
    if (matches.size === 0) return [];

    if (!candidates) {
      candidates = matches;
    } else {
      const intersection = new Set();
      for (const entryIndex of candidates) {
        if (matches.has(entryIndex)) intersection.add(entryIndex);
      }
      candidates = intersection;
    }

    if (candidates.size === 0) return [];
  }

  const scored = [];
  for (const entryIndex of candidates) {
    const score = scoreStationMatch({
      name: readName(index, entryIndex),
      normalizedName: readNormalizedName(index, entryIndex),
      weight: index.weights[entryIndex],
      flags: index.flags[entryIndex],
      source: 'offline',
    }, normalizedQuery, tokens);
    if (!Number.isFinite(score)) continue;
    scored.push({ entryIndex, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const results = [];
  const seen = new Set();
  for (const { entryIndex, score } of scored) {
    const normalizedName = readNormalizedName(index, entryIndex);
    if (seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    results.push(toStationResult(index, entryIndex, { source: 'offline', score }));
    if (results.length >= limit) break;
  }

  return results;
}

/** Looks up a single stop in an index, e.g. to find its bookable DB station. */
export function lookupStationInIndex(index, id) {
  const entryIndex = findEntryIndexById(index, id);
  if (entryIndex === -1) return null;
  return toStationResult(index, entryIndex, { source: 'offline' });
}

/** Looks up a single stop in the bundled offline index. */
export async function lookupOfflineStation(id) {
  return lookupStationInIndex(await loadStationIndex(), id);
}
