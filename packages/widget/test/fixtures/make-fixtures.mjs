// Generates binary fixtures from points.csv:
//   - points.parquet  (via @loaders.gl/parquet ParquetEncoder)
//   - points.xlsx     (via JSZip — minimal valid xlsx)
//   - points.shp.zip  (via hand-written SHP/SHX/DBF for the 5 points)
//
// Run from this directory:
//   node make-fixtures.mjs
//
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Use CJS bundle to dodge a packaging bug in @loaders.gl/parquet 4.4 ESM (missing .js suffix on a buffer-polyfill.node import).
const { ParquetSchema, ParquetEncoder } = require('@loaders.gl/parquet');
import JSZip from 'jszip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const csv = fs.readFileSync(path.join(__dirname, 'points.csv'), 'utf8').trim();
const lines = csv.split(/\r?\n/);
const headers = lines.shift().split(',');
const rows = lines.map((line) => {
  const cells = line.split(',');
  const r = {};
  headers.forEach((h, i) => {
    const raw = cells[i];
    const num = Number(raw);
    r[h] = Number.isFinite(num) && raw !== '' ? num : raw;
  });
  return r;
});
console.log(`Loaded ${rows.length} rows from points.csv`);

// ---------------------------------------------------------------- parquet
async function writeParquet() {
  const schema = new ParquetSchema({
    id: { type: 'INT64' },
    name: { type: 'UTF8' },
    latitude: { type: 'DOUBLE' },
    longitude: { type: 'DOUBLE' },
    population: { type: 'INT64' },
  });
  const chunks = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  // ParquetEncoder.close() calls `os.close(cb)` (fs-style), but Writable uses `end()`. Shim it.
  out.close = (cb) => out.end(cb);
  const writer = await ParquetEncoder.openStream(schema, out, { rowGroupSize: 10000 });
  // Workaround for @loaders.gl/parquet 4.4 bug: rowBuffer defaults to {} but
  // shredRecord expects { rowCount, columnData } from schema.rowGroup().
  writer.rowBuffer = schema.rowGroup();
  for (const r of rows) {
    await writer.appendRow({
      id: BigInt(r.id),
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      population: BigInt(r.population),
    });
  }
  // Workaround: ParquetEncoder.close() discards the buffered rows instead of flushing.
  // Manually flush the row buffer first.
  if (writer.rowBuffer.rowCount > 0) {
    await writer.envelopeWriter.writeRowGroup(writer.rowBuffer);
    writer.rowBuffer = schema.rowGroup();
  }
  await writer.close();
  // give the underlying stream a tick to flush
  await new Promise((res) => setImmediate(res));
  const buf = Buffer.concat(chunks);
  fs.writeFileSync(path.join(__dirname, 'points.parquet'), buf);
  console.log(`Wrote points.parquet (${buf.byteLength} bytes)`);
}

// ---------------------------------------------------------------- xlsx
function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[c]);
}

async function writeXlsx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `</Types>`);
  zip.file('_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`);
  zip.file('xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`);
  zip.file('xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`);

  // Build sharedStrings from headers + string values
  const stringTable = [];
  const stringIdx = new Map();
  function s(v) {
    if (!stringIdx.has(v)) {
      stringIdx.set(v, stringTable.length);
      stringTable.push(v);
    }
    return stringIdx.get(v);
  }

  // Build sheet rows
  const sheetRows = [];
  // header row
  sheetRows.push(headers.map((h, i) => ({ col: i, type: 's', value: s(h) })));
  // data rows
  for (const r of rows) {
    sheetRows.push(headers.map((h, i) => {
      const v = r[h];
      if (typeof v === 'number') return { col: i, type: 'n', value: v };
      return { col: i, type: 's', value: s(String(v)) };
    }));
  }

  function colLetter(i) {
    let s = '';
    let n = i;
    while (true) {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
      if (n < 0) break;
    }
    return s;
  }

  let sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
  sheetRows.forEach((cells, rIdx) => {
    sheetXml += `<row r="${rIdx + 1}">`;
    cells.forEach((c) => {
      const ref = `${colLetter(c.col)}${rIdx + 1}`;
      if (c.type === 's') {
        sheetXml += `<c r="${ref}" t="s"><v>${c.value}</v></c>`;
      } else {
        sheetXml += `<c r="${ref}"><v>${c.value}</v></c>`;
      }
    });
    sheetXml += `</row>`;
  });
  sheetXml += `</sheetData></worksheet>`;
  zip.file('xl/worksheets/sheet1.xml', sheetXml);

  let ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${stringTable.length}" uniqueCount="${stringTable.length}">`;
  for (const v of stringTable) ssXml += `<si><t>${xmlEscape(v)}</t></si>`;
  ssXml += `</sst>`;
  zip.file('xl/sharedStrings.xml', ssXml);

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(path.join(__dirname, 'points.xlsx'), buf);
  console.log(`Wrote points.xlsx (${buf.byteLength} bytes)`);
}

// ---------------------------------------------------------------- shapefile
// Minimal shapefile point writer per ESRI Shapefile Technical Description.
// We write SHP, SHX, DBF, and PRJ (WGS84) and zip them.
async function writeShapefileZip() {
  const points = rows.map((r) => ({
    x: r.longitude,
    y: r.latitude,
    name: r.name,
    population: r.population,
    id: r.id,
  }));

  // ----- SHP -----
  // Header is 100 bytes, each Point record has 8 bytes record header + 20 bytes content.
  const recordContentLen = 20; // 4 (shapeType) + 8 (x) + 8 (y)
  const fileLength16bit =
    50 /* header in 16-bit words */ +
    points.length * (4 + recordContentLen / 2); /* each record: 4 hdr words + content words */

  const shpSize = 100 + points.length * (8 + recordContentLen);
  const shpBuf = Buffer.alloc(shpSize);
  // File code (big endian) 9994
  shpBuf.writeInt32BE(9994, 0);
  // unused 5 ints @4..23
  shpBuf.writeInt32BE(fileLength16bit, 24); // length in 16-bit words BE
  shpBuf.writeInt32LE(1000, 28); // version
  shpBuf.writeInt32LE(1, 32); // shape type = Point
  // bbox xmin..ymax (8 doubles), then zmin/zmax/mmin/mmax (4 doubles)
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const p of points) {
    if (p.x < xmin) xmin = p.x;
    if (p.x > xmax) xmax = p.x;
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }
  shpBuf.writeDoubleLE(xmin, 36);
  shpBuf.writeDoubleLE(ymin, 44);
  shpBuf.writeDoubleLE(xmax, 52);
  shpBuf.writeDoubleLE(ymax, 60);
  shpBuf.writeDoubleLE(0, 68);
  shpBuf.writeDoubleLE(0, 76);
  shpBuf.writeDoubleLE(0, 84);
  shpBuf.writeDoubleLE(0, 92);

  let off = 100;
  // SHX header is similar to SHP but smaller; entries are 8 bytes each
  const shxSize = 100 + points.length * 8;
  const shxBuf = Buffer.alloc(shxSize);
  shpBuf.copy(shxBuf, 0, 0, 100);
  shxBuf.writeInt32BE(50 + points.length * 4, 24); // shx length (16-bit words)

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const recordOffset16 = off / 2;
    // record header: record number (BE), content length (BE) in 16-bit words = 10
    shpBuf.writeInt32BE(i + 1, off);
    shpBuf.writeInt32BE(recordContentLen / 2, off + 4);
    // record content
    shpBuf.writeInt32LE(1, off + 8); // shape type = Point
    shpBuf.writeDoubleLE(p.x, off + 12);
    shpBuf.writeDoubleLE(p.y, off + 20);
    // SHX entry
    shxBuf.writeInt32BE(recordOffset16, 100 + i * 8);
    shxBuf.writeInt32BE(recordContentLen / 2, 100 + i * 8 + 4);
    off += 8 + recordContentLen;
  }

  // ----- DBF -----
  // dBASE III file with fixed-width fields for: id (N 10), name (C 32), population (N 12)
  const fields = [
    { name: 'id', type: 'N', length: 10, decimals: 0 },
    { name: 'name', type: 'C', length: 32, decimals: 0 },
    { name: 'population', type: 'N', length: 12, decimals: 0 },
  ];
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((a, f) => a + f.length, 0);
  const dbfSize = headerLen + points.length * recordLen + 1; // +1 for EOF byte 0x1A
  const dbfBuf = Buffer.alloc(dbfSize);
  dbfBuf.writeUInt8(0x03, 0); // version
  // last update YYMMDD
  const now = new Date();
  dbfBuf.writeUInt8(now.getFullYear() - 1900, 1);
  dbfBuf.writeUInt8(now.getMonth() + 1, 2);
  dbfBuf.writeUInt8(now.getDate(), 3);
  dbfBuf.writeUInt32LE(points.length, 4);
  dbfBuf.writeUInt16LE(headerLen, 8);
  dbfBuf.writeUInt16LE(recordLen, 10);
  // field descriptors
  let fOff = 32;
  for (const f of fields) {
    const nameBuf = Buffer.alloc(11);
    nameBuf.write(f.name.slice(0, 10), 0, 'ascii');
    nameBuf.copy(dbfBuf, fOff);
    dbfBuf.write(f.type, fOff + 11, 1, 'ascii');
    dbfBuf.writeUInt8(f.length, fOff + 16);
    dbfBuf.writeUInt8(f.decimals, fOff + 17);
    fOff += 32;
  }
  dbfBuf.writeUInt8(0x0d, fOff); // header terminator
  let rOff = headerLen;
  for (const p of points) {
    dbfBuf.writeUInt8(0x20, rOff); // not deleted
    let cOff = rOff + 1;
    function writeField(val, len, type) {
      const padded = type === 'N'
        ? String(val).padStart(len, ' ')
        : String(val).padEnd(len, ' ');
      const slice = padded.slice(0, len);
      dbfBuf.write(slice, cOff, len, 'latin1');
      cOff += len;
    }
    writeField(p.id, 10, 'N');
    writeField(p.name, 32, 'C');
    writeField(p.population, 12, 'N');
    rOff += recordLen;
  }
  dbfBuf.writeUInt8(0x1a, dbfSize - 1); // EOF marker

  const prj = `GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]`;

  const zip = new JSZip();
  zip.file('points.shp', shpBuf);
  zip.file('points.shx', shxBuf);
  zip.file('points.dbf', dbfBuf);
  zip.file('points.prj', prj);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(path.join(__dirname, 'points.shp.zip'), buf);
  console.log(`Wrote points.shp.zip (${buf.byteLength} bytes)`);
}

await writeParquet();
await writeXlsx();
await writeShapefileZip();
console.log('done');
