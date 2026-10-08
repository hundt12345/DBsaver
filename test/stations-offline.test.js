import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStationIndexFrom,
  lookupStationInIndex,
  searchStationIndex,
} from '../src/stations-offline.js';

const entries = [
  {
    id: '8011160',
    name: 'Berlin Hbf',
    type: 'station',
    weight: 2_543_302,
    products: {
      nationalExpress: true, national: true, regionalExpress: true, regional: true, suburban: true,
    },
  },
  {
    id: '727269',
    name: 'Hauptbahnhof (S+U)/Washingtonplatz, Berlin',
    type: 'stop',
    weight: 0.1,
    products: { bus: true },
    station: { id: '8011160', weight: 2_543_302 },
  },
  {
    id: '100001',
    name: 'Hauptwache, Frankfurt a.M.',
    type: 'stop',
    weight: 0.2,
    products: { subway: true },
    station: { id: '8006692', weight: 40_353 },
  },
  {
    id: '8000207',
    name: 'Köln Hbf',
    type: 'station',
    weight: 1_500_000,
    products: { nationalExpress: true, regional: true },
  },
  {
    id: '123456',
    name: 'Koelnmesse Bushalt, Köln',
    type: 'stop',
    weight: 30,
    products: { bus: true, tram: true },
  },
  { id: 'not-numeric', name: 'Kaputte Haltestelle', type: 'stop' },
  { id: '999999', name: '   ', type: 'stop' },
];

test('the offline index keeps every stop type and skips invalid entries', async () => {
  const index = await buildStationIndexFrom(entries);

  assert.equal(index.count, 5);
  assert.equal(index.rich, true);
  assert.equal(lookupStationInIndex(index, 'not-numeric'), null);
  assert.equal(lookupStationInIndex(index, '424242'), null);
});

test('bus and tram halts are found next to railway stations', async () => {
  const index = await buildStationIndexFrom(entries);

  const berlin = searchStationIndex(index, 'berlin', { limit: 5 });
  assert.deepEqual(berlin.map((station) => station.id), ['8011160', '727269']);
  assert.equal(berlin[0].category, 'rail');
  assert.equal(berlin[0].label, 'Fernverkehr');
  assert.equal(berlin[1].category, 'local');
  assert.equal(berlin[1].label, 'Bus/Tram');
  assert.equal(berlin[1].relatedStationId, '8011160');
  assert.equal(berlin[1].bookable, true);

  const hauptwache = searchStationIndex(index, 'hauptwache', { limit: 5 });
  assert.equal(hauptwache[0].id, '100001');
  assert.equal(hauptwache[0].label, 'U-Bahn');
});

test('umlaut-free queries find stations with umlauts', async () => {
  const index = await buildStationIndexFrom(entries);

  const results = searchStationIndex(index, 'koeln', { limit: 5 });
  assert.equal(results[0].name, 'Köln Hbf');
  assert.ok(results.some((station) => station.name === 'Koelnmesse Bushalt, Köln'));

  const umlaut = searchStationIndex(index, 'köln', { limit: 5 });
  assert.equal(umlaut[0].name, 'Köln Hbf');
});

test('Hbf and Hauptbahnhof are interchangeable', async () => {
  const index = await buildStationIndexFrom(entries);

  const results = searchStationIndex(index, 'berlin hauptbahnhof', { limit: 5 });
  assert.equal(results[0].id, '8011160');
});

test('lookups expose the related DB station for local halts', async () => {
  const index = await buildStationIndexFrom(entries);

  const hauptwache = lookupStationInIndex(index, '100001');
  assert.equal(hauptwache.name, 'Hauptwache, Frankfurt a.M.');
  assert.equal(hauptwache.relatedStationId, '8006692');
  assert.equal(hauptwache.local, true);
  assert.equal(hauptwache.rail, false);
});

test('unknown queries return an empty list', async () => {
  const index = await buildStationIndexFrom(entries);
  assert.deepEqual(searchStationIndex(index, 'xyz', { limit: 5 }), []);
  assert.deepEqual(searchStationIndex(index, '', { limit: 5 }), []);
});
