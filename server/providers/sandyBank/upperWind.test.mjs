import test from 'node:test';
import assert from 'node:assert/strict';
import {
  upperWindRanges,
  sampleGrid,
  vectorToWind,
  layerMeanWind,
  fetchUpperWind,
} from './upperWind.js';
import { parseGfsIdx } from '../wind/gfs.js';

const IDX = [
  '1:0:d=2026101018:UGRD:300 mb:8 hour fcst:',
  '2:100:d=2026101018:VGRD:300 mb:8 hour fcst:',
  '3:200:d=2026101018:UGRD:500 mb:8 hour fcst:',
  '4:300:d=2026101018:VGRD:500 mb:8 hour fcst:',
  '5:400:d=2026101018:UGRD:700 mb:8 hour fcst:',
  '6:500:d=2026101018:VGRD:700 mb:8 hour fcst:',
  '7:600:d=2026101018:UGRD:10 m above ground:8 hour fcst:',
  '8:700:d=2026101018:VGRD:10 m above ground:8 hour fcst:',
].join('\n');

test('upperWindRanges finds UGRD/VGRD at the fallout levels', () => {
  const ranges = upperWindRanges(parseGfsIdx(IDX));
  assert.deepEqual(
    ranges.map((r) => r.mb),
    [700, 500, 300],
  );
  assert.deepEqual(ranges[0].u, { start: 400, end: 499 });
  assert.deepEqual(ranges[2].v, { start: 100, end: 199 });
  assert.throws(
    () => upperWindRanges(parseGfsIdx(IDX), [{ mb: 850, label: '850 mb' }]),
    /missing/,
  );
});

function grid(fill) {
  const ni = 1440,
    nj = 721;
  const values = new Float64Array(ni * nj);
  for (let j = 0; j < nj; j++)
    for (let i = 0; i < ni; i++) values[j * ni + i] = fill(i, j);
  return { ni, nj, lo1: 0, la1: 90, di: 0.25, dj: 0.25, values };
}

test('sampleGrid picks the nearest 0.25° point, wrapping negative longitudes', () => {
  const g = grid((i, j) => j * 10000 + i);
  // 34.02 N, -83.88 E -> lon 276.12 -> i = 1104 ; lat row j = round((90-34.02)/0.25) = 224
  assert.equal(sampleGrid(g, 34.02, -83.88), 224 * 10000 + 1104);
  assert.equal(sampleGrid(g, 90, 0), 0);
  assert.equal(sampleGrid(g, -90, 359.9), 720 * 10000 + 0);
});

test('vectorToWind gives the direction the wind blows from', () => {
  assert.equal(vectorToWind(0, 10).dir, 180); // southerly
  assert.equal(vectorToWind(-10, 0).dir, 90); // easterly
  assert.equal(vectorToWind(10, 10).dir, 225); // south-westerly
  assert.ok(Math.abs(vectorToWind(10, 0).speedMph - 22.37) < 0.01);
});

test('layerMeanWind is the vector mean with crosswind shear', () => {
  const levels = [
    { mb: 700, feet: 10000, u: 10, v: 0 },
    { mb: 500, feet: 18000, u: 10, v: 0 },
    { mb: 300, feet: 30000, u: 10, v: 20 },
  ];
  const mean = layerMeanWind(levels);
  assert.ok(mean.dir > 230 && mean.dir < 245, String(mean.dir)); // mean vector (10, 6.7) m/s
  // 20 m/s crosswind change over 20 kft, projected on the mean direction
  assert.ok(
    mean.shearMphPerKft > 1.5 && mean.shearMphPerKft < 2.3,
    String(mean.shearMphPerKft),
  );
  const noShear = layerMeanWind(levels.map((l) => ({ ...l, v: 0 })));
  assert.equal(noShear.shearMphPerKft, 0);
});

test('fetchUpperWind composes the GFS object, index, ranges and samples', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), range: init.headers?.Range });
    if (String(url).endsWith('.idx')) return new Response(IDX, { status: 200 });
    const [start, end] = init.headers.Range.replace('bytes=', '')
      .split('-')
      .map(Number);
    return new Response(new Uint8Array(end - start + 1).fill(start / 100), {
      status: 206,
    });
  };
  const decodeImpl = async (buf) => {
    const tag = buf[0]; // 4,5 = 700 u,v ; 2,3 = 500 ; 0,1 = 300
    const u = { 4: 0.39, 2: 6.94, 0: 17.55 }[tag];
    const v = { 5: 26.64, 3: 30.07, 1: 31.7 }[tag];
    return grid(() => (u !== undefined ? u : v));
  };
  const result = await fetchUpperWind({
    lat: 34.02,
    lon: -83.88,
    fetchImpl,
    decodeImpl,
    now: () => Date.UTC(2026, 9, 11, 2),
  });
  assert.match(
    calls[0].url,
    /gfs\.20261010\/18\/atmos\/gfs\.t18z\.pgrb2\.0p25\.f008\.idx$/,
  );
  assert.equal(result.levels.length, 3);
  assert.equal(result.levels[0].mb, 700);
  assert.equal(result.levels[0].dir, 181);
  assert.equal(result.levels[2].dir, 209);
  assert.equal(result.layer.dir, 196);
  assert.ok(Math.abs(result.layer.speedMph - 68.5) < 0.2);
  assert.equal(result.cycle.forecastHour, 8);
});
