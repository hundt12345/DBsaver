import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBahnDeUrl,
  formatJourneyAsOffer,
  isValidStation,
  isValidTravelDate,
  todayInGermany,
} from '../src/search-utils.js';

test('todayInGermany returns a stable ISO calendar date', () => {
  assert.equal(todayInGermany(new Date('2026-10-07T23:30:00.000Z')), '2026-10-08');
});

test('travel dates must be real ISO dates that are not in the past', () => {
  assert.equal(isValidTravelDate('2026-10-07', '2026-10-07'), true);
  assert.equal(isValidTravelDate('2026-10-08', '2026-10-07'), true);
  assert.equal(isValidTravelDate('2026-10-06', '2026-10-07'), false);
  assert.equal(isValidTravelDate('2026-02-30', '2026-01-01'), false);
  assert.equal(isValidTravelDate('07.10.2026', '2026-01-01'), false);
});

test('station inputs require a usable DB station id and name', () => {
  assert.equal(isValidStation({ id: '8000105', name: 'Frankfurt (Main) Hbf' }), true);
  assert.equal(isValidStation({ id: '8000105', name: ' ' }), false);
  assert.equal(isValidStation({ id: 'Berlin', name: 'Berlin Hbf' }), false);
  assert.equal(isValidStation({ id: '8000105', name: 'A'.repeat(141) }), false);
});

test('journeys are normalized to one offer with price, times and changes', () => {
  const offer = formatJourneyAsOffer({
    price: { amount: 19.9, currency: 'EUR', partialFare: false },
    legs: [
      {
        origin: { name: 'Berlin Hbf' },
        destination: { name: 'Hannover Hbf' },
        departure: '2026-10-08T08:00:00+02:00',
        arrival: '2026-10-08T09:45:00+02:00',
        line: { name: 'ICE 700' },
      },
      { walking: true },
      {
        origin: { name: 'Hannover Hbf' },
        destination: { name: 'Hamburg Hbf' },
        departure: '2026-10-08T10:00:00+02:00',
        arrival: '2026-10-08T11:15:00+02:00',
        line: { name: 'ICE 800' },
      },
    ],
  });

  assert.equal(offer.price, 19.9);
  assert.equal(offer.from, 'Berlin Hbf');
  assert.equal(offer.to, 'Hamburg Hbf');
  assert.equal(offer.departure, '2026-10-08T08:00:00+02:00');
  assert.equal(offer.arrival, '2026-10-08T11:15:00+02:00');
  assert.equal(offer.durationMinutes, 195);
  assert.equal(offer.changes, 1);
  assert.deepEqual(offer.trains, ['ICE 700', 'ICE 800']);
});

test('unpriced connections are not presented as fares', () => {
  assert.equal(formatJourneyAsOffer({ legs: [] }), null);
  assert.equal(formatJourneyAsOffer({ price: { amount: null }, legs: [] }), null);
});

test('the bahn.de link carries the chosen route and travel date', () => {
  const url = buildBahnDeUrl({
    from: { id: '8000105', name: 'Frankfurt (Main) Hbf' },
    to: { id: '8000096', name: 'Stuttgart Hbf' },
    date: '2026-10-08',
  });
  const params = new URLSearchParams(url.split('#')[1]);

  assert.equal(params.get('so'), 'Frankfurt (Main) Hbf');
  assert.equal(params.get('zo'), 'Stuttgart Hbf');
  assert.equal(params.get('hd'), '2026-10-08T08:00:00');
  assert.equal(params.get('kl'), '2');
  assert.equal(params.get('r'), '13:16:KLASSENLOS:1');
  assert.match(url, /^https:\/\/www\.bahn\.de\/buchung\/fahrplan\/suche#/);
});
