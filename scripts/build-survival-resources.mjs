#!/usr/bin/env node
/**
 * Build the saved offline list for the Survival Resources layer.
 *
 * Downloads the Geofabrik OpenStreetMap shapefile extract for one US state
 * once (Georgia by default), reads the places layers, keeps hospitals,
 * clinics, pharmacies, fire and police stations, shelters, water points,
 * supermarkets, fuel and hardware stores within 40 km of the house, and writes
 * src/data/local_data/survival_resources/survival_resources.json. After that the
 * layer needs no Overpass server and no internet.
 *
 *   node scripts/build-survival-resources.mjs
 *   node scripts/build-survival-resources.mjs --region new-jersey
 *   node scripts/build-survival-resources.mjs --zip path/to/georgia-latest-free.shp.zip
 *   node scripts/build-survival-resources.mjs --refresh   (download again)
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { readShapefilePlaces } from '../server/providers/sandyBank/shapefile.js';
import {
  placesToResources,
  RESOURCE_RADIUS_M,
} from '../src/layers/warnings/resources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(
  ROOT,
  'src/data/local_data/survival_resources/survival_resources.json',
);
const CACHE = path.join(ROOT, '.cache', 'osm');
const LAYERS = [
  'gis_osm_pois_free_1',
  'gis_osm_pois_a_free_1',
  'gis_osm_traffic_free_1',
  'gis_osm_traffic_a_free_1',
  'gis_osm_natural_free_1',
  'gis_osm_natural_a_free_1',
];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? null : (process.argv[i + 1] ?? '');
}

async function download(url, file) {
  console.log(`Downloading ${url}`);
  console.log(
    'This is a large file (several hundred MB); it is only needed once.',
  );
  const response = await fetch(url, {
    headers: { 'User-Agent': 'sandy-bank-watch (gods-eye-view fork)' },
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const partial = `${file}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const { renameSync } = await import('node:fs');
  renameSync(partial, file);
}

function extract(zip, dir) {
  // One layer at a time: an extract may lack a layer, and both tools fail the
  // whole call on a name that is not in the archive. Windows 10+ and macOS ship
  // bsdtar, which reads zip files; Linux usually has unzip.
  for (const layer of LAYERS) {
    const names = [`${layer}.shp`, `${layer}.dbf`];
    const tar = spawnSync('tar', ['-xf', zip, '-C', dir, ...names], {
      stdio: 'ignore',
    });
    if (tar.status === 0) continue;
    spawnSync('unzip', ['-o', '-qq', zip, ...names, '-d', dir], {
      stdio: 'ignore',
    });
  }
}

async function main() {
  const region = arg('region') || 'georgia';
  const data = JSON.parse(
    readFileSync(
      path.join(ROOT, 'src/data/local_data/sandy_bank/sandy_bank.json'),
      'utf8',
    ),
  );
  const house = { lat: data.house.lat, lon: data.house.lon };
  mkdirSync(CACHE, { recursive: true });
  const url = `https://download.geofabrik.de/north-america/us/${region}-latest-free.shp.zip`;
  const zip = arg('zip') || path.join(CACHE, `${region}-latest-free.shp.zip`);
  if (!arg('zip') && (process.argv.includes('--refresh') || !existsSync(zip)))
    await download(url, zip);
  console.log(`Using ${zip} (${Math.round(statSync(zip).size / 1e6)} MB)`);
  const dir = path.join(CACHE, region);
  mkdirSync(dir, { recursive: true });
  extract(zip, dir);
  const places = [];
  for (const layer of LAYERS) {
    const shp = path.join(dir, `${layer}.shp`);
    const dbf = path.join(dir, `${layer}.dbf`);
    if (!existsSync(shp) || !existsSync(dbf)) {
      console.warn(`Skipping ${layer}: not in this extract`);
      continue;
    }
    const rows = readShapefilePlaces(readFileSync(shp), readFileSync(dbf));
    console.log(`${layer}: ${rows.length} places`);
    places.push(...rows);
  }
  const rows = placesToResources(places, house, RESOURCE_RADIUS_M);
  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        source: `OpenStreetMap contributors (ODbL), Geofabrik extract ${region}`,
        house,
        radiusM: RESOURCE_RADIUS_M,
        counts,
        rows,
      },
      null,
      1,
    )}\n`,
  );
  console.log(`Saved ${rows.length} places to ${path.relative(ROOT, OUT)}`);
  console.log(counts);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
