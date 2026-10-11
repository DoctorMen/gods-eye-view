import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  selectTargets,
  applyParams,
  defaultParams,
  DOSE_BANDS,
} from './bands.js';
import { createFalloutWindSource } from './source.js';

const data = JSON.parse(
  readFileSync(
    new URL(
      '../../data/local_data/sandy_bank/sandy_bank.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

test('bundled data has the house and the target list', () => {
  assert.ok(Math.abs(data.house.lat - 34.0205) < 0.001);
  assert.ok(data.targets.length >= 40);
  assert.ok(data.winds.DJF_layer.sw > 70);
});

test('target sets are nested sensibly', () => {
  const likely = selectTargets(data.targets, 'likely');
  const atlanta = selectTargets(data.targets, 'atlanta');
  const all = selectTargets(data.targets, 'all');
  assert.ok(likely.length > 0 && likely.length < all.length);
  assert.ok(atlanta.length >= 2, atlanta.map((t) => t.name).join(','));
  assert.ok(
    selectTargets(data.targets, 'military').every((t) => t.cls === 'mil'),
  );
});

test('params only accept listed values', () => {
  const p = defaultParams();
  assert.equal(applyParams(p, { yieldKt: 123 }), false);
  assert.equal(applyParams(p, { yieldKt: 800, pf: 40 }), true);
  assert.equal(p.yieldKt, 800);
  assert.equal(applyParams(p, { windMode: 'guess' }), false);
  assert.equal(applyParams(p, { manualDir: 400 }), false);
  assert.equal(applyParams(p, { manualDir: 90, windMode: 'manual' }), true);
});

test('dose bands run from the most to the least severe', () => {
  for (let i = 1; i < DOSE_BANDS.length; i++)
    assert.ok(DOSE_BANDS[i - 1].r > DOSE_BANDS[i].r);
});

test('wind source: climatology and live payloads', async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /^\/api\/sandy-bank\/upper-wind\?lat=34\.02/);
    return {
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        cycle: {
          date: '20261010',
          hour: 18,
          forecastHour: 8,
          validIso: '2026-10-11T02:00:00.000Z',
        },
        levels: [],
        layer: { dir: 196, speedMph: 68.5, shearMphPerKft: 0.9 },
      }),
    };
  };
  const source = createFalloutWindSource({ fetchImpl, data });
  const clim = source.climatology(new Date('2026-01-15T00:00:00Z'));
  assert.equal(clim.mode, 'climate');
  assert.equal(clim.dir, 264);
  assert.ok(clim.speedMph > 50 && clim.speedMph < 70);
  const live = await source.live();
  assert.equal(live.mode, 'live');
  assert.equal(live.dir, 196);
  assert.equal(live.shearMphPerKft, 0.5, 'shear is clamped to the model prior');
  assert.match(live.detail, /GFS 20261010 18Z \+8 h/);
  const failing = createFalloutWindSource({
    fetchImpl: async () => ({ ok: false, status: 502 }),
    data,
  });
  await assert.rejects(failing.live(), /502/);
});
