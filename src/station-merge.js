import {
  STATION_FLAG,
  describeStationFlags,
  isPricableStationId,
  normalizeStationName,
  stationFlagsFromProducts,
} from './search-utils.js';

/**
 * Maps one hit of the live DB location search onto the shape the frontend uses.
 */
export function liveStationToResult(match) {
  const flags = stationFlagsFromProducts(match.products);
  const { category, label } = describeStationFlags(flags);

  return {
    id: match.id,
    name: match.name,
    category: match.products ? category : 'unknown',
    label: match.products ? label : 'Haltestelle',
    rail: Boolean(flags & STATION_FLAG.rail),
    local: Boolean(flags & STATION_FLAG.local),
    // Only ids that look like a DB station number can be sent to the price API unchanged.
    bookable: isPricableStationId(match.id),
    relatedStationId: null,
    weight: 0,
    source: 'live',
  };
}

/**
 * Live hits keep the relevance order of the DB, offline hits fill up the list
 * (they are already ranked by the offline index). Duplicates are dropped.
 */
export function mergeAndDedupeStations(liveResults, offlineResults, limit) {
  const results = [];
  const seenNames = new Set();
  const seenIds = new Set();

  for (const candidate of [...liveResults, ...offlineResults]) {
    const normalizedName = normalizeStationName(candidate.name);
    if (seenNames.has(normalizedName) || seenIds.has(candidate.id)) continue;
    seenNames.add(normalizedName);
    seenIds.add(candidate.id);
    results.push(candidate);
    if (results.length >= limit) break;
  }

  return results;
}

/** Drops scoring/weight helpers that only the server needs internally. */
export function stripInternalStationFields(station) {
  const { score, weight, numericId, ...rest } = station;
  return rest;
}
