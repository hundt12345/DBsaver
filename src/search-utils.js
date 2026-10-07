const STATION_ID_PATTERN = /^\d{6,15}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

export function isValidStation(station) {
  return Boolean(
    station
    && typeof station === 'object'
    && typeof station.id === 'string'
    && STATION_ID_PATTERN.test(station.id)
    && typeof station.name === 'string'
    && station.name.trim().length > 0
    && station.name.length <= 140,
  );
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
