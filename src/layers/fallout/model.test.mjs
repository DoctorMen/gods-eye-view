import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rateH1,
  arrivalTimeH,
  doseR,
  doseContour,
  downwindCrosswind,
  offsetLatLon,
  receptorDose,
  gamma,
  erf,
} from './model.js';

// Values produced by simulations/research/wseg10_checked.py (numpy/scipy).
const FIXTURES = [
  {
    Y: 0.1,
    ff: 0.5,
    wind: 40,
    shear: 0.1,
    dx: 37,
    dy: 0,
    r1: 129.29620132712392,
    ta: 0.8882029304331152,
  },
  {
    Y: 0.25,
    ff: 0.5,
    wind: 60,
    shear: 0.08,
    dx: 37,
    dy: 0,
    r1: 163.23719813723494,
    ta: 0.5806908376853147,
  },
  {
    Y: 0.5,
    ff: 0.5,
    wind: 61,
    shear: 0.1,
    dx: 37,
    dy: 3,
    r1: 40.8673217894793,
    ta: 0.5602770132902509,
  },
  {
    Y: 0.8,
    ff: 0.5,
    wind: 55,
    shear: 0.15,
    dx: 60,
    dy: 5,
    r1: 48.217104860529915,
    ta: 1.0297384059342878,
  },
  {
    Y: 0.5,
    ff: 0.5,
    wind: 30,
    shear: 0.1,
    dx: 10,
    dy: 0,
    r1: 526.9424626347904,
    ta: 0.5,
  },
  {
    Y: 0.1,
    ff: 0.5,
    wind: 61,
    shear: 0.1,
    dx: -1,
    dy: 0,
    r1: 0.00019567450406402043,
    ta: 0.5,
  },
  {
    Y: 0.5,
    ff: 0.5,
    wind: 61,
    shear: 0.1,
    dx: 200,
    dy: 10,
    r1: 1.9661188251131716,
    ta: 3.2324081608312345,
  },
  {
    Y: 1.0,
    ff: 0.5,
    wind: 15,
    shear: 0.1,
    dx: 20,
    dy: 2,
    r1: 758.2281501959411,
    ta: 1.089900124564567,
  },
];

test('special functions match reference values', () => {
  assert.ok(Math.abs(gamma(0.5) - Math.sqrt(Math.PI)) < 1e-9);
  assert.ok(Math.abs(gamma(5) - 24) < 1e-9);
  assert.ok(Math.abs(erf(1) - 0.8427007929) < 2e-7);
});

test('rateH1 and arrivalTimeH reproduce the Python reference within 1e-5', () => {
  for (const f of FIXTURES) {
    const r1 = rateH1(f.Y, f.ff, f.wind, f.shear, f.dx, f.dy);
    // The upwind tail (dx < 0) rests on erf far out, where the A&S series is
    // only good to 1.5e-7 absolute; allow 0.3 % there.
    assert.ok(
      Math.abs(r1 - f.r1) / f.r1 < (f.dx > 0 ? 1e-5 : 3e-3),
      `rate ${JSON.stringify(f)} got ${r1}`,
    );
    const ta = arrivalTimeH(f.Y, f.wind, f.dx);
    assert.ok(
      Math.abs(ta - f.ta) < 1e-6,
      `arrival ${JSON.stringify(f)} got ${ta}`,
    );
  }
});

test('dose integral follows the 7:10 rule shape', () => {
  // Two-week outdoor dose from a 100 R/h H+1 field arriving at 1 h is 5*100*(1 - 336^-0.2)
  const d = doseR(100, 1, 336);
  assert.ok(Math.abs(d - 5 * 100 * (1 - Math.pow(336, -0.2))) < 1e-9);
  assert.equal(doseR(100, 5, 5), 0);
  assert.equal(doseR(100, 5, 2), 0);
});

test('geometry helpers invert each other', () => {
  const target = { lat: 33.75, lon: -84.39 }; // Atlanta
  const point = { lat: 34.0205, lon: -83.8805 }; // the house
  const { dx, dy } = downwindCrosswind(target, point, 240);
  const back = offsetLatLon(target, 240, dx, dy);
  assert.ok(Math.abs(back.lat - point.lat) < 0.02);
  assert.ok(Math.abs(back.lon - point.lon) < 0.02);
});

test('house dose from Atlanta on a WSW wind is dangerous outdoors and survivable at PF 10', () => {
  const dose = receptorDose({
    target: { lat: 33.75, lon: -84.39 },
    point: { lat: 34.0205, lon: -83.8805 },
    windFromDeg: 240,
    windMph: 60,
    yieldMt: 0.5,
    hours: 336,
    pf: 10,
  });
  assert.ok(dose.dx > 30 && dose.dx < 45, `dx ${dose.dx}`);
  assert.ok(dose.outdoorR > 300, `outdoor ${dose.outdoorR}`);
  assert.ok(dose.shelterR < 150, `shelter ${dose.shelterR}`);
  assert.ok(dose.arrivalH >= 0.5 && dose.arrivalH < 1);
});

test('dose contours are closed, shrink with threshold and vanish when unreachable', () => {
  const base = { yieldMt: 0.5, windMph: 60, hours: 336 };
  const c100 = doseContour({ ...base, thresholdR: 100 });
  const c1000 = doseContour({ ...base, thresholdR: 1000 });
  assert.ok(c100.length > 20);
  assert.equal(c100.length % 2, 0);
  const reach = (c) => Math.max(...c.map((p) => p[0]));
  assert.ok(reach(c100) > reach(c1000));
  assert.deepEqual(doseContour({ ...base, thresholdR: 1e9 }), []);
});
