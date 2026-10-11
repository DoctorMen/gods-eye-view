/**
 * Minimal reader for the Geofabrik OpenStreetMap shapefiles, enough to pull
 * named places (points, and polygons reduced to their bounding-box centre)
 * with their `fclass` out of a .shp/.dbf pair. No dependencies.
 *
 * Geofabrik layout: .dbf fields osm_id, code, fclass, name (UTF-8);
 * .shp shape type 1 (Point) or 5 (Polygon), longitude/latitude in WGS84.
 */

/** Parse a dBASE III table into plain row objects (trimmed strings). */
export function readDbf(buffer) {
  const count = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  let offset = 1; // the deletion flag comes first in each record
  for (let p = 32; p < headerLength - 1 && buffer[p] !== 0x0d; p += 32) {
    const raw = buffer.subarray(p, p + 11);
    const end = raw.indexOf(0);
    const name = raw.subarray(0, end < 0 ? 11 : end).toString('latin1');
    const length = buffer[p + 16];
    fields.push({ name, offset, length });
    offset += length;
  }
  const rows = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = headerLength + i * recordLength;
    const row = { deleted: buffer[base] === 0x2a };
    for (const f of fields)
      row[f.name] = buffer
        .subarray(base + f.offset, base + f.offset + f.length)
        .toString('utf8')
        .trim();
    rows[i] = row;
  }
  return rows;
}

/**
 * Read one representative [lon, lat] per shape record: the point itself, or
 * the centre of a polygon's bounding box. Null shapes give null.
 */
export function readShpPoints(buffer) {
  const points = [];
  let p = 100;
  while (p + 8 <= buffer.length) {
    const contentBytes = buffer.readInt32BE(p + 4) * 2;
    const c = p + 8;
    const type = buffer.readInt32LE(c);
    if (type === 1 || type === 11 || type === 21) {
      points.push([buffer.readDoubleLE(c + 4), buffer.readDoubleLE(c + 12)]);
    } else if (type === 5 || type === 15 || type === 25 || type === 3) {
      const xmin = buffer.readDoubleLE(c + 4);
      const ymin = buffer.readDoubleLE(c + 12);
      const xmax = buffer.readDoubleLE(c + 20);
      const ymax = buffer.readDoubleLE(c + 28);
      points.push([(xmin + xmax) / 2, (ymin + ymax) / 2]);
    } else {
      points.push(null);
    }
    p = c + contentBytes;
  }
  return points;
}

/** Join a .shp and .dbf pair into { osmId, fclass, name, lon, lat } rows. */
export function readShapefilePlaces(shp, dbf) {
  const points = readShpPoints(shp);
  const rows = readDbf(dbf);
  if (points.length !== rows.length)
    throw new Error(
      `shapefile mismatch: ${points.length} shapes vs ${rows.length} rows`,
    );
  const out = [];
  rows.forEach((row, i) => {
    const point = points[i];
    if (!point || row.deleted) return;
    out.push({
      osmId: row.osm_id || null,
      fclass: row.fclass || null,
      name: row.name || null,
      lon: point[0],
      lat: point[1],
    });
  });
  return out;
}
