import test from 'node:test';
import assert from 'node:assert/strict';
import { drawAlerts, alertSummary, alertColor } from './alerts.js';
import { drawAirspace } from './airspace.js';
import { drawDisasters } from './disasters.js';
import { createRadiationSource, drawRadiation } from './radiation.js';
import {
  createResourceSource,
  drawResources,
  normalizeResources,
  resourceQuery,
} from './resources.js';
import { createFeedLayer } from './feedLayer.js';
import { sanitizeOverpassBody } from '../../../server/providers/overpass/query.js';
import plants from '../../data/local_data/nuclear_plants/nuclear_plants.json' with { type: 'json' };

const house = { lat: 34.0205, lon: -83.8805 };
const ring = [
  [-84, 34],
  [-83.9, 34],
  [-83.9, 34.1],
  [-84, 34],
];

test('alerts put the act-now event and the house first', () => {
  const snapshot = {
    houseChecked: true,
    space: { kp: 7, gScale: 3 },
    rows: [
      {
        id: 'a',
        event: 'Civil Danger Warning',
        severity: 'Extreme',
        critical: true,
        rank: 14,
        rings: [ring],
        center: [-83.95, 34.03],
        atHouse: true,
      },
      {
        id: 'b',
        event: 'Frost Advisory',
        severity: 'Minor',
        critical: false,
        rank: 1,
        rings: [],
        center: null,
        atHouse: false,
      },
    ],
  };
  const picture = drawAlerts(snapshot, { house });
  assert.equal(picture.count, 2);
  assert.equal(picture.overlay[0].title, 'HOME: Civil Danger Warning');
  assert.equal(picture.entities.length, 2);
  assert.match(alertSummary(snapshot), /AT THE HOUSE: Civil Danger Warning/);
  assert.match(alertSummary(snapshot), /G3 storm/);
  assert.equal(alertColor(snapshot.rows[0]), '#ff2bd6');
  const quiet = drawAlerts(
    { rows: [], space: { kp: 2, gScale: 0 }, houseChecked: true },
    { house },
  );
  assert.equal(quiet.overlay.length, 0);
  assert.match(quiet.summary, /none at the house/);
});

test('airspace draws squawks above jamming cells', () => {
  const picture = drawAirspace({
    squawks: [
      {
        id: 's1',
        code: '7500',
        meaning: 'Hijack',
        flight: 'X1',
        lat: 1,
        lon: 2,
      },
    ],
    cells: [
      {
        id: 'g1',
        west: 21,
        south: 55,
        east: 22,
        north: 56,
        lat: 55.5,
        lon: 21.5,
        share: 0.6,
        total: 10,
        level: 'high',
      },
    ],
    sampled: [{ name: 'Georgia (home)', aircraft: 40 }],
  });
  assert.equal(picture.count, 2);
  assert.equal(picture.overlay[0].title, '7500 X1');
  assert.match(picture.summary, /40 aircraft sampled near home/);
});

test('disasters label only Orange and Red', () => {
  const picture = drawDisasters({
    rows: [
      {
        id: 'r',
        type: 'EQ',
        typeName: 'Earthquake',
        level: 'Red',
        rank: 3,
        lat: 1,
        lon: 1,
        country: 'Peru',
      },
      {
        id: 'g',
        type: 'FL',
        typeName: 'Flood',
        level: 'Green',
        rank: 1,
        lat: 2,
        lon: 2,
      },
    ],
  });
  assert.equal(picture.overlay.length, 1);
  assert.match(picture.summary, /1 red/);
});

test('bundled plants are sorted by distance and the nearest is Oconee', () => {
  assert.equal(plants.plants.length, 195);
  assert.equal(plants.plants[0].name, 'Oconee');
  assert.ok(
    plants.plants.every((p, i, a) => i === 0 || a[i - 1].homeMi <= p.homeMi),
  );
  assert.equal(plants.zones.plumeMi, 10);
});

test('radiation keeps drawing plants when live readings fail', async () => {
  const source = createRadiationSource({
    plants,
    readings: {
      getSnapshot: async () => {
        throw new Error('down');
      },
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.readingError, 'down');
  const picture = drawRadiation(snapshot);
  assert.equal(picture.count, 195);
  assert.match(picture.summary, /nearest Oconee 77 mi/);
  assert.match(picture.summary, /live readings unavailable/);
});

test('resource query passes the Overpass proxy guard', () => {
  const body = new URLSearchParams({ data: resourceQuery(house) }).toString();
  const result = sanitizeOverpassBody(body);
  assert.equal(result.ok, true, result.error);
});

test('resources sort by distance and label the nearest of each kind', async () => {
  const payload = {
    elements: [
      {
        type: 'node',
        id: 1,
        lat: 34.1,
        lon: -83.88,
        tags: { amenity: 'hospital', name: 'Far' },
      },
      {
        type: 'way',
        id: 2,
        center: { lat: 34.03, lon: -83.88 },
        tags: { amenity: 'hospital', name: 'Near' },
      },
      {
        type: 'node',
        id: 3,
        lat: 34.02,
        lon: -83.87,
        tags: { amenity: 'bench' },
      },
    ],
  };
  const rows = normalizeResources(payload, house);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Near', 'Far'],
  );
  const picture = drawResources({ rows });
  assert.equal(picture.overlay.length, 1);
  assert.match(picture.overlay[0].title, /Nearest hospital/);
  let posted;
  const source = createResourceSource({
    house,
    fetchImpl: async (url, init) => {
      posted = { url, init };
      return { ok: true, json: async () => payload };
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(posted.url, '/api/overpass');
  assert.equal(posted.init.method, 'POST');
  assert.equal(snapshot.rows.length, 2);
});

test('feed layer keeps the last picture when a refresh fails', async () => {
  const added = [];
  const overlay = {
    setVisible() {},
    clearSource() {},
    setEntries: (...a) => added.push(a),
  };
  let fail = false;
  const layer = createFeedLayer({
    id: 'demo',
    name: 'Demo',
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('down');
        return { n: 1 };
      },
    },
    overlayHost: overlay,
    draw: () => ({ entities: [], overlay: [], count: 3, summary: 'ok' }),
    records: () => [{ a: 1 }],
  });
  const viewer = { dataSources: { add() {}, remove() {} } };
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  fail = true;
  assert.equal(await layer.update(viewer), false);
  const stats = layer.getStats();
  assert.equal(stats.count, 3);
  assert.equal(stats.error, 'down');
  assert.deepEqual(layer.getAnalystRecords(), [{ a: 1 }]);
  layer.destroy(viewer);
});

test('resources retry a busy Overpass and give up on other errors', async () => {
  const statuses = [503, 504, 200];
  const waits = [];
  const source = createResourceSource({
    house,
    wait: async (ms) => waits.push(ms),
    fetchImpl: async (url) => {
      if (url.includes('feeds')) return { ok: false, status: 502 };
      const status = statuses.shift();
      return {
        ok: status === 200,
        status,
        json: async () => ({ elements: [] }),
      };
    },
  });
  assert.deepEqual((await source.getSnapshot()).rows, []);
  assert.deepEqual(waits, [5000, 15000]);
  const failing = createResourceSource({
    house,
    wait: async () => {},
    fetchImpl: async (url) =>
      url.includes('feeds')
        ? { ok: false, status: 502 }
        : { ok: false, status: 400 },
  });
  await assert.rejects(failing.getSnapshot(), /Overpass HTTP 400/);
  const busy = createResourceSource({
    house,
    wait: async () => {},
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(busy.getSnapshot(), /Overpass HTTP 503/);
});

test('saved places become resources within 25 miles, nearest first', async () => {
  const { placesToResources } = await import('./resources.js');
  const rows = placesToResources(
    [
      { osmId: '1', fclass: 'hospital', name: 'Far', lat: 34.5, lon: -83.88 },
      { osmId: '2', fclass: 'fuel', name: 'Near', lat: 34.03, lon: -83.88 },
      { osmId: '3', fclass: 'bench', name: 'Bench', lat: 34.02, lon: -83.88 },
      { osmId: '2', fclass: 'fuel', name: 'Near', lat: 34.03, lon: -83.88 },
    ],
    house,
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.kind, r.name]),
    [['osm/2', 'fuel', 'Near']],
  );
});

test('resources use the saved list first and only go live without one', async () => {
  const urls = [];
  const savedRow = {
    id: 'osm/2',
    kind: 'fuel',
    name: 'Near',
    lat: 34.03,
    lon: -83.88,
    miles: 0.6,
  };
  const withSaved = createResourceSource({
    house,
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({ builtAt: 'b', rows: [savedRow] }),
      };
    },
  });
  const snapshot = await withSaved.getSnapshot();
  assert.equal(snapshot.saved, true);
  assert.equal(snapshot.rows[0].label, 'Fuel');
  assert.deepEqual(urls, ['/api/sandy-bank/feeds/resources']);
  assert.match(drawResources(snapshot).summary, /saved list/);
  const calls = [];
  const live = createResourceSource({
    house,
    wait: async () => {},
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('feeds')) return { ok: false, status: 502 };
      return { ok: true, status: 200, json: async () => ({ elements: [] }) };
    },
  });
  assert.equal((await live.getSnapshot()).saved, undefined);
  assert.deepEqual(calls, ['/api/sandy-bank/feeds/resources', '/api/overpass']);
});
