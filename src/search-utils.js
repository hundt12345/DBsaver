const STATION_NUMBER_PATTERN = /^\d{6,15}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Local transport stops are often identified by IFOPT-style ids, e.g. `de:11000:900100001`.
const IFOPT_STATION_ID_PATTERN = /^[A-Za-z]{2,8}:[A-Za-z0-9]{1,12}:[A-Za-z0-9*:_-]{1,48}$/;
// The DB "Vendo" APIs also hand out opaque HAFAS location ids, e.g. `A=1@O=Berlin Hbf@X=...@L=8011160@`.
const OPAQUE_STATION_ID_PATTERN = /^(?:[A-Za-z]=[^@]{0,140}@){2,}$/;

const RAIL_PRODUCTS = ['nationalExpress', 'national', 'regionalExpress', 'regional', 'suburban'];
const LOCAL_PRODUCTS = ['subway', 'tram', 'bus', 'ferry', 'taxi'];

// Vendo product codes, in case a response carries raw product ids instead of
// the parsed boolean object (`parseProducts` of db-vendo-client).
const VENDO_PRODUCT_ALIASES = {
  nationalExpress: ['nationalExpress', 'ICE'],
  national: ['national', 'EC_IC'],
  regionalExpress: ['regionalExpress', 'IR'],
  regional: ['regional', 'REGIONAL', 'RE', 'RB'],
  suburban: ['suburban', 'SBAHN', 'S'],
  subway: ['subway', 'UBAHN', 'U'],
  tram: ['tram', 'TRAM'],
  bus: ['bus', 'BUS'],
  ferry: ['ferry', 'SCHIFF'],
  taxi: ['taxi', 'ANRUFPFLICHTIG'],
};

export const STATION_FLAG = {
  rail: 1 << 0,
  longDistance: 1 << 1,
  regional: 1 << 2,
  suburban: 1 << 3,
  local: 1 << 4,
  relatedStation: 1 << 5,
  subway: 1 << 6,
  surface: 1 << 7,
};

export function todayInGermany(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isValidTravelDate(value, today = todayInGermany()) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return false;
  }

  return value >= today;
}

/**
 * Station ids come in different flavours:
 *  - DB station numbers / EVA-ids (`8000105`, `100001`),
 *  - IFOPT ids of local transport stops (`de:11000:900100001`),
 *  - opaque HAFAS location ids handed out by the DB APIs.
 * All of them are usable for the station search; only the numeric ones can be
 * sent to the DB price endpoints without further mapping.
 */
export function isValidStationId(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 2 || value.length > 200) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;

  return STATION_NUMBER_PATTERN.test(value)
    || IFOPT_STATION_ID_PATTERN.test(value)
    || OPAQUE_STATION_ID_PATTERN.test(value);
}

export function isPricableStationId(value) {
  return typeof value === 'string' && STATION_NUMBER_PATTERN.test(value);
}

export function isValidStation(station) {
  return Boolean(
    station
    && typeof station === 'object'
    && isValidStationId(station.id)
    && typeof station.name === 'string'
    && station.name.trim().length > 0
    && station.name.length <= 140,
  );
}

export function normalizeStationName(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('de-DE')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenizeStationQuery(query) {
  return normalizeStationName(query).split(' ').filter(Boolean);
}

/**
 * Live results expose `products` either as an array of Vendo product ids
 * (`['ICE', 'EC_IC']`) or as an object of booleans (db-hafas-stations format).
 * Both shapes are mapped onto the same flag bitmask.
 */
export function stationFlagsFromProducts(products) {
  let flags = 0;
  if (!products) return flags;

  const has = (names) => {
    const aliases = names.flatMap((name) => VENDO_PRODUCT_ALIASES[name] || [name]);
    if (Array.isArray(products)) return products.some((entry) => aliases.includes(entry));
    if (typeof products === 'object') return aliases.some((name) => products[name] === true);
    return false;
  };

  if (has(['nationalExpress', 'national'])) flags |= STATION_FLAG.longDistance;
  if (has(['regionalExpress', 'regional'])) flags |= STATION_FLAG.regional;
  if (has(['suburban'])) flags |= STATION_FLAG.suburban;
  if (has(['subway'])) flags |= STATION_FLAG.subway;
  if (has(['tram', 'bus', 'ferry', 'taxi'])) flags |= STATION_FLAG.surface;
  if (RAIL_PRODUCTS.some((name) => has([name]))) flags |= STATION_FLAG.rail;
  if (LOCAL_PRODUCTS.some((name) => has([name]))) flags |= STATION_FLAG.local;

  return flags;
}

export function describeStationFlags(flags = 0) {
  const category = flags & STATION_FLAG.rail ? 'rail' : flags & STATION_FLAG.local ? 'local' : 'unknown';

  let label;
  if (flags & STATION_FLAG.longDistance) label = 'Fernverkehr';
  else if (flags & STATION_FLAG.regional) label = 'Regionalverkehr';
  else if (flags & STATION_FLAG.suburban) label = 'S-Bahn';
  else if (category === 'rail') label = 'Bahnhof';
  else if (flags & STATION_FLAG.subway && flags & STATION_FLAG.surface) label = 'U-Bahn & Bus/Tram';
  else if (flags & STATION_FLAG.subway) label = 'U-Bahn';
  else if (flags & STATION_FLAG.surface) label = 'Bus/Tram';
  else label = 'Haltestelle';

  return { category, label };
}

// Common abbreviations people type for station names.
export const TOKEN_SYNONYMS = {
  hbf: ['hauptbahnhof'],
  hb: ['hbf', 'hauptbahnhof'],
  hauptbahnhof: ['hbf'],
  bf: ['bahnhof'],
  flughafen: ['flgh'],
};

export function tokenVariants(token) {
  return [token, ...(TOKEN_SYNONYMS[token] || [])];
}

export function nameContainsToken(normalizedName, token) {
  return tokenVariants(token).some((variant) => normalizedName.includes(variant));
}

function countTokensAtWordStart(normalizedName, tokens) {
  const startsWithAnyVariant = (token) => tokenVariants(token)
    .some((variant) => normalizedName.startsWith(variant));
  const containsWord = (token) => tokenVariants(token)
    .some((variant) => normalizedName.includes(` ${variant}`));
  let hits = 0;
  for (const token of tokens) {
    if (startsWithAnyVariant(token)) {
      hits += 2;
      continue;
    }
    if (containsWord(token)) hits += 1;
  }
  return hits;
}

/**
 * One shared ranking for live and offline station candidates so that both
 * sources can be merged into a single, predictable list.
 */
export function scoreStationMatch(candidate, normalizedQuery, tokens = tokenizeStationQuery(normalizedQuery)) {
  const normalizedName = candidate.normalizedName || normalizeStationName(candidate.name);
  if (tokens.length === 0) return -Infinity;
  if (!tokens.every((token) => nameContainsToken(normalizedName, token))) return -Infinity;

  const rawWeight = Number.isFinite(candidate.weight) && candidate.weight > 0 ? candidate.weight : 0;
  // `weight` is a popularity proxy from the DB station directory. Cap it to
  // prevent major hubs from completely dominating over local transport stops.
  const weight = Math.min(rawWeight, 1000);
  let score = Math.log10(1 + weight) * 600;

  if (normalizedName === normalizedQuery) score += 10_000_000;
  else if (normalizedName.startsWith(normalizedQuery)) score += 1_000_000;
  else if (tokens.every((token) => normalizedName.startsWith(token))) score += 400_000;

  score += countTokensAtWordStart(normalizedName, tokens) * 2_500;

  if (candidate.flags & STATION_FLAG.rail) score += 200;
  if (candidate.flags & STATION_FLAG.longDistance) score += 100;
  if (candidate.flags & STATION_FLAG.local) score += 150;
  if (candidate.source === 'live') score += 20_000;

  score -= normalizedName.length * 8;
  return score;
}

export function formatJourneyAsOffer(journey, { fromName, toName } = {}) {
  if (journey?.price?.amount === null || journey?.price?.amount === undefined) return null;
  const amount = Number(journey.price.amount);
  if (!Number.isFinite(amount)) return null;

  const legs = Array.isArray(journey.legs) ? journey.legs : [];
  const firstLeg = legs.find((leg) => leg?.origin) ?? {};
  const lastLeg = [...legs].reverse().find((leg) => leg?.destination) ?? {};
  const vehicleLegs = legs.filter((leg) => !leg?.walking);
  const departure = firstLeg.departure || firstLeg.plannedDeparture || null;
  const arrival = lastLeg.arrival || lastLeg.plannedArrival || null;

  let durationMinutes = null;
  if (departure && arrival) {
    const durationMs = Date.parse(arrival) - Date.parse(departure);
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      durationMinutes = Math.round(durationMs / 60_000);
    }
  }

  const trains = [...new Set(vehicleLegs
    .map((leg) => leg?.line?.name || leg?.line?.product || leg?.name)
    .filter((name) => typeof name === 'string' && name.trim()))];

  return {
    price: amount,
    currency: journey.price.currency || 'EUR',
    partialFare: Boolean(
      journey.price.partialFare
      || journey.price.hint?.toLocaleLowerCase('de-DE').includes('teilpreis'),
    ),
    departure,
    arrival,
    durationMinutes,
    changes: Math.max(0, vehicleLegs.length - 1),
    trains,
    from: firstLeg.origin?.name || fromName || '',
    to: lastLeg.destination?.name || toName || '',
  };
}

export function buildBahnDeUrl({ from, to, date }) {
  const params = new URLSearchParams({
    sts: 'true',
    so: from.name,
    zo: to.name,
    kl: '2',
    r: '13:16:KLASSENLOS:1',
    soid: `O=${from.name}`,
    zoid: `O=${to.name}`,
    soei: from.id,
    zoei: to.id,
    sot: 'ST',
    zot: 'ST',
    hd: `${date}T08:00:00`,
    hza: 'D',
    ar: 'false',
    s: 'true',
    d: 'false',
    hz: '[]',
    fm: 'false',
    bp: 'true',
  });

  return `https://www.bahn.de/buchung/fahrplan/suche#${params.toString()}`;
}
