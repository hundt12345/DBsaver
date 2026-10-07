import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeStationFlags,
  isPricableStationId,
  isValidStation,
  isValidStationId,
  nameContainsToken,
  normalizeStationName,
  scoreStationMatch,
  stationFlagsFromProducts,
  tokenizeStationQuery,
} from '../src/search-utils.js';

test('station ids accept DB numbers, IFOPT ids and opaque HAFAS ids', () => {
  assert.equal(isValidStationId('8000105'), true);
  assert.equal(isValidStationId('100001'), true);
  assert.equal(isValidStationId('de:11000:900100001'), true);
  assert.equal(isValidStationId('A=1@O=Berlin Hbf@X=13369549@Y=52525589@L=8011160@'), true);
  assert.equal(isValidStationId('Berlin'), false);
  assert.equal(isValidStationId(''), false);
  assert.equal(isValidStationId(null), false);
  assert.equal(isValidStationId(`8000105${'0'.repeat(200)}`), false);
});

test('only numeric ids count as bookable at the DB price endpoint', () => {
  assert.equal(isPricableStationId('8000105'), true);
  assert.equal(isPricableStationId('de:11000:900100001'), false);
  assert.equal(isPricableStationId(undefined), false);
});

test('station inputs require a usable id and name', () => {
  assert.equal(isValidStation({ id: '8000105', name: 'Frankfurt (Main) Hbf' }), true);
  assert.equal(isValidStation({ id: 'de:11000:900100001', name: 'S+U Alexanderplatz' }), true);
  assert.equal(isValidStation({ id: '8000105', name: ' ' }), false);
  assert.equal(isValidStation({ id: 'Berlin', name: 'Berlin Hbf' }), false);
  assert.equal(isValidStation({ id: '8000105', name: 'A'.repeat(141) }), false);
});

test('station names are normalized for search', () => {
  assert.equal(normalizeStationName('Frankfurt(Main)Hbf'), 'frankfurt main hbf');
  assert.equal(normalizeStationName('München Ost'), 'munchen ost');
  assert.equal(normalizeStationName('  Köln   Hbf '), 'koln hbf');
  assert.equal(normalizeStationName('Weißenfels'), 'weissenfels');
  assert.deepEqual(tokenizeStationQuery('Berlin Hbf'), ['berlin', 'hbf']);
});

test('product flags work for array and object shaped product lists', () => {
  const fromArray = stationFlagsFromProducts(['ICE', 'EC_IC', 'S']);
  assert.equal(describeStationFlags(fromArray).category, 'rail');
  assert.equal(describeStationFlags(fromArray).label, 'Fernverkehr');

  const fromObject = stationFlagsFromProducts({
    nationalExpress: false,
    suburban: true,
    subway: true,
    bus: false,
  });
  assert.equal(describeStationFlags(fromObject).category, 'rail');
  assert.equal(describeStationFlags(fromObject).label, 'S-Bahn');

  const localOnly = stationFlagsFromProducts({ bus: true, tram: true });
  assert.equal(describeStationFlags(localOnly).category, 'local');
  assert.equal(describeStationFlags(localOnly).label, 'Bus/Tram');

  assert.equal(describeStationFlags(0).category, 'unknown');
});

test('abbreviations like Hbf match Hauptbahnhof', () => {
  assert.equal(nameContainsToken('hamburg hbf', 'hauptbahnhof'), true);
  assert.equal(nameContainsToken('hamburg hauptbahnhof', 'hbf'), true);

  const score = scoreStationMatch(
    { name: 'Hamburg Hbf', weight: 1_400_000, flags: 1, source: 'offline' },
    normalizeStationName('hamburg hauptbahnhof'),
  );
  assert.ok(Number.isFinite(score));
});

test('scoring prefers exact matches, then popular stations', () => {
  const query = normalizeStationName('berlin');
  const exact = scoreStationMatch({ name: 'Berlin', weight: 10, flags: 1, source: 'offline' }, query);
  const hub = scoreStationMatch({ name: 'Berlin Hbf', weight: 2_500_000, flags: 1, source: 'offline' }, query);
  const small = scoreStationMatch({ name: 'Berliner Straße, Xstadt', weight: 1, flags: 0, source: 'offline' }, query);

  assert.ok(exact > hub, 'an exact name match wins');
  assert.ok(hub > small, 'within the same match class the bigger station wins');
  assert.equal(scoreStationMatch({ name: 'Hamburg Hbf', weight: 1, flags: 1, source: 'offline' }, query), -Infinity);
});
