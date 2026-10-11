import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSandyBankFeeds,
  gpsInterferenceCells,
  normalizeGdacs,
  normalizeKp,
  normalizeNwsAlerts,
  normalizeSafecast,
  normalizeSquawk,
  safecastMicroSv,
} from './feeds.js';
import { sandyBankProxy } from '../sandyBank.js';

const square = (lon, lat, d = 0.1) => [
  [lon, lat],
  [lon + d, lat],
  [lon + d, lat + d],
  [lon, lat + d],
  [lon, lat],
];

const nws = {
  type: 'FeatureCollection',
  features: [
    {
      id: 'urn:a',
      geometry: { type: 'Polygon', coordinates: [square(-84, 34)] },
      properties: {
        id: 'urn:a',
        event: 'Flood Advisory',
        severity: 'Minor',
        areaDesc: 'Gwinnett, GA',
        headline: 'Flood Advisory issued',
      },
    },
    {
      id: 'urn:b',
      geometry: null,
      properties: {
        id: 'urn:b',
        event: 'Shelter In Place Warning',
        severity: 'Extreme',
        areaDesc: 'Gwinnett, GA',
      },
    },
    { id: 'urn:c', geometry: null, properties: { severity: 'Minor' } },
  ],
};

test('NWS alerts rank act-now events first and keep polygon rings', () => {
  const rows = normalizeNwsAlerts(nws);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'Shelter In Place Warning');
  assert.equal(rows[0].critical, true);
  assert.equal(rows[0].center, null);
  assert.equal(rows[1].rings.length, 1);
  assert.deepEqual(rows[1].center, [-83.95, 34.05]);
  assert.throws(() => normalizeNwsAlerts({}), /NWS payload invalid/);
});

test('Kp maps to the NOAA G scale in both SWPC formats', () => {
  const objects = [
    { time_tag: '2026-10-10T12:00:00', Kp: 4.33 },
    { time_tag: '2026-10-10T15:00:00', Kp: 7.0 },
  ];
  const k = normalizeKp(objects);
  assert.equal(k.kp, 7);
  assert.equal(k.gScale, 3);
  assert.equal(k.maxKp24h, 7);
  assert.match(k.note, /power grid/);
  const arrays = [
    ['time_tag', 'Kp'],
    ['2026-10-10 15:00:00.000', '2.33'],
  ];
  assert.equal(normalizeKp(arrays).gScale, 0);
  assert.equal(normalizeKp([]), null);
});

test('GDACS events keep points, rank Red first and skip bad rows', () => {
  const rows = normalizeGdacs({
    features: [
      {
        geometry: { type: 'Point', coordinates: [120, 15] },
        properties: {
          eventtype: 'TC',
          eventid: 1,
          alertlevel: 'Orange',
          name: 'X',
        },
      },
      {
        geometry: { type: 'Point', coordinates: [30, 40] },
        properties: {
          eventtype: 'EQ',
          eventid: 2,
          alertlevel: 'Red',
          url: { report: 'https://r' },
        },
      },
      {
        geometry: { type: 'Polygon', coordinates: [] },
        properties: { eventtype: 'FL' },
      },
      {
        geometry: { type: 'Point', coordinates: [500, 0] },
        properties: { eventtype: 'FL' },
      },
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.typeName),
    ['Earthquake', 'Tropical cyclone'],
  );
  assert.equal(rows[0].link, 'https://r');
});

test('only emergency squawks become rows', () => {
  assert.equal(normalizeSquawk({ squawk: '1200', lat: 1, lon: 1 }), null);
  const row = normalizeSquawk({
    hex: 'abc',
    squawk: '7700',
    lat: 33,
    lon: -84,
    flight: 'DAL1 ',
  });
  assert.equal(row.meaning, 'General emergency');
  assert.equal(row.flight, 'DAL1');
});

test('GPS interference needs enough aircraft and a degraded share', () => {
  const ac = (hex, lat, lon, nac_p) => ({ hex, lat, lon, nac_p });
  const cells = gpsInterferenceCells([
    ac('a', 55.2, 21.2, 0),
    ac('b', 55.5, 21.5, 2),
    ac('c', 55.7, 21.1, 9),
    ac('c', 55.7, 21.1, 9), // duplicate from an overlapping sample circle
    ac('d', 34.1, -84.1, 0), // alone in its cell: not enough aircraft
    ac('e', 34.0, -83.0, 10),
    ac('f', 34.0, -83.0, 10),
    ac('g', 34.0, -83.0, 11),
  ]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].total, 3);
  assert.equal(cells[0].level, 'high');
  assert.deepEqual([cells[0].south, cells[0].west], [55, 21]);
});

test('Safecast readings convert cpm and keep the newest per place', () => {
  assert.equal(safecastMicroSv({ value: 334, unit: 'cpm' }), 1);
  assert.equal(safecastMicroSv({ value: 0.1, unit: 'usv' }), 0.1);
  assert.equal(safecastMicroSv({ value: 3, unit: 'status' }), null);
  const rows = normalizeSafecast([
    {
      id: 1,
      value: 33.4,
      unit: 'cpm',
      latitude: 34,
      longitude: -84,
      device_id: 7,
      captured_at: '2026-10-01',
    },
    {
      id: 2,
      value: 3340,
      unit: 'cpm',
      latitude: 34,
      longitude: -84,
      device_id: 7,
      captured_at: '2026-10-05',
    },
    {
      id: 3,
      value: 0.05,
      unit: 'usv',
      latitude: 35,
      longitude: -84,
      captured_at: '2026-10-02',
    },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].usvh, 10);
  assert.equal(rows[0].level, 'danger');
});

function reply(body, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body };
}

test('alert feed marks alerts at the house and survives a missing Kp', async () => {
  const feeds = createSandyBankFeeds();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ua: init.headers['User-Agent'] });
    if (url.includes('point=34.0205,-83.8805'))
      return reply({ features: [nws.features[1]] });
    if (url.includes('alerts/active')) return reply(nws);
    return reply(null, false);
  };
  const value = await feeds.alerts.load({ fetchImpl });
  assert.equal(value.rows.find((r) => r.id === 'urn:b').atHouse, true);
  assert.equal(value.rows.find((r) => r.id === 'urn:a').atHouse, false);
  assert.equal(value.space, null);
  assert.equal(value.notes.length, 1);
  assert.ok(calls.every((c) => /sandy-bank-watch/.test(c.ua)));
});

test('airspace feed queries squawks then sample centres, and fails only when all do', async () => {
  const feeds = createSandyBankFeeds();
  const urls = [];
  const value = await feeds.airspace.load({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith('/sqk/7700'))
        return reply({ ac: [{ hex: 'x', squawk: '7700', lat: 1, lon: 2 }] });
      if (url.includes('/point/34/-84/250'))
        return reply({ ac: [{ hex: 'y', lat: 34.2, lon: -83.5, nac_p: 10 }] });
      return reply(null, false);
    },
  });
  assert.equal(value.squawks.length, 1);
  assert.deepEqual(value.sampled, [{ name: 'Georgia (home)', aircraft: 1 }]);
  assert.equal(urls.length, 3 + 7);
  await assert.rejects(
    feeds.airspace.load({ fetchImpl: async () => reply(null, false) }),
    /adsb.lol unavailable/,
  );
});

test('radiation feed asks Safecast for 30 days within 200 km', async () => {
  const feeds = createSandyBankFeeds();
  let seen;
  const value = await feeds.radiation.load({
    now: () => Date.parse('2026-10-11T00:00:00Z'),
    fetchImpl: async (url) => {
      seen = new URL(url);
      return reply([]);
    },
  });
  assert.equal(seen.searchParams.get('distance'), '200000');
  assert.equal(seen.searchParams.get('captured_after'), '2026-09-11');
  assert.deepEqual(value.rows, []);
});

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

test('proxy serves feeds, caches them, and serves stale on failure', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const plugin = sandyBankProxy({
    now: () => clock,
    feeds: {
      demo: {
        ttlMs: 1000,
        async load() {
          calls += 1;
          if (fail) throw new Error('down');
          return { rows: [calls] };
        },
      },
    },
  });
  let handler;
  plugin.configureServer({ middlewares: { use: (_p, h) => (handler = h) } });
  const get = async (url) => {
    const res = fakeResponse();
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return res;
  };
  let res = await get('/feeds/demo');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).rows, [1]);
  res = await get('/feeds/demo');
  assert.equal(calls, 1);
  clock = 5000;
  fail = true;
  res = await get('/feeds/demo');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).stale, true);
  assert.equal((await get('/feeds/nope')).status, 404);
});
