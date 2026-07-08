#!/usr/bin/env node
/**
 * Generates the Spanish postal-code ⇄ municipality dataset from the INE
 * (Instituto Nacional de Estadística) open datasets:
 *
 *   - Callejero del Censo Electoral (https://www.ine.es/prodyser/callejero/):
 *     the national street directory. Its fixed-width TRAM file lists every
 *     street segment with the INE municipality code (chars 0-5) and the
 *     postal code that serves it (chars 42-47). Published twice a year
 *     (caj_esp_01YYYY / caj_esp_07YYYY, reference dates 31 Dec / 30 Jun).
 *   - Relación de municipios y sus códigos (diccionarioYY.xlsx): the official
 *     municipality dictionary, used for display names ("Gineta, La") that the
 *     callejero itself only carries in uppercase ("GINETA (LA)").
 *
 * Zero dependencies: requires only Node.js >= 20. Run from the repo root:
 *
 *   node scripts/generate.mjs
 *
 * Outputs (deterministic for a given pair of INE editions, so a re-run with
 * unchanged sources produces no git diff):
 *
 *   data/codigos_postales_municipios.csv  flat (cp, municipio, nombre) rows —
 *                                         drop-in compatible with
 *                                         inigoflores/ds-codigos-postales-ine-es
 *   data/municipios.json                  municipio → { nombre, codigos_postales }
 *   data/codigos_postales.json            cp → [municipio ids] (reverse index)
 *   data/metadata.json                    INE editions and counts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

const CALLEJERO_URL = (edition) =>
  `https://www.ine.es/prodyser/callejero/caj_esp/caj_esp_${edition}.zip`;
const DICTIONARY_URL = (yy) =>
  `https://www.ine.es/daco/daco42/codmun/diccionario${yy}.xlsx`;

const CODE_RE = /^\d{5}$/;

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------

async function exists(url) {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  return res.ok;
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Probes for the newest published edition of the twice-a-year (01/07)
 * callejero. Editions appear a couple of months after their reference date,
 * so the current period usually 404s and the previous one is the latest.
 */
async function findLatestCallejeroEdition() {
  const year = new Date().getFullYear();
  for (let y = year; y >= year - 2; y -= 1) {
    for (const month of ['07', '01']) {
      const edition = `${month}${y}`;
      if (await exists(CALLEJERO_URL(edition))) return edition;
    }
  }
  throw new Error('No published callejero edition found on ine.es');
}

async function findLatestDictionaryYear() {
  const year = new Date().getFullYear();
  for (let y = year; y >= year - 2; y -= 1) {
    const yy = String(y % 100).padStart(2, '0');
    if (await exists(DICTIONARY_URL(yy))) return yy;
  }
  throw new Error('No published municipality dictionary found on ine.es');
}

// --------------------------------------------------------------------------
// Minimal ZIP reader (central directory + raw deflate). Both INE files are
// plain zip32 with deflate/store entries; anything else fails loudly.
// --------------------------------------------------------------------------

function readZipEntries(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const scanEnd = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= scanEnd; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a zip file (no end-of-central-directory)');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('zip64 archives are not supported');
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('Corrupt zip: bad central-directory entry signature');
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('zip64 entries are not supported');
    }
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractZipEntry(buf, entry) {
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) {
    throw new Error('Corrupt zip: bad local-header signature');
  }
  // The local header repeats the name/extra fields with its own lengths.
  const nameLength = buf.readUInt16LE(p + 26);
  const extraLength = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLength + extraLength;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported zip compression method ${entry.method}`);
}

function extractByName(buf, entries, pattern) {
  for (const [name, entry] of entries) {
    if (pattern.test(name)) return extractZipEntry(buf, entry);
  }
  throw new Error(`No zip entry matches ${pattern}`);
}

// --------------------------------------------------------------------------
// Callejero TRAM file: municipality INE code at chars 0-5, postal code at
// chars 42-47. Both are plain ASCII digits, so the buffer is scanned without
// charset decoding. Rows with a malformed code or a province outside the
// 01–52 range are dropped.
// --------------------------------------------------------------------------

function buildMunicipalities(tram) {
  const municipalities = new Map();

  const digits = (start, end) => {
    for (let i = start; i < end; i += 1) {
      if (tram[i] < 0x30 || tram[i] > 0x39) return null;
    }
    return tram.toString('latin1', start, end);
  };

  for (let start = 0; start < tram.length; ) {
    let end = tram.indexOf(0x0a, start);
    if (end === -1) end = tram.length;

    if (end - start >= 47) {
      const municipality = digits(start, start + 5);
      const postalCode = digits(start + 42, start + 47);
      if (municipality && postalCode) {
        const municipalityProvince = municipality.slice(0, 2);
        const postalProvince = postalCode.slice(0, 2);
        if (
          municipalityProvince >= '01' &&
          municipalityProvince <= '52' &&
          postalProvince >= '01' &&
          postalProvince <= '52'
        ) {
          let set = municipalities.get(municipality);
          if (!set) {
            set = new Set();
            municipalities.set(municipality, set);
          }
          set.add(postalCode);
        }
      }
    }
    start = end + 1;
  }

  return municipalities;
}

// --------------------------------------------------------------------------
// Municipality dictionary workbook (columns CODAUTO, CPRO, CMUN, DC, NOMBRE —
// located by header text, not position, in case INE reorders them).
// --------------------------------------------------------------------------

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si>(.*?)<\/si>/gs)].map(([, si]) =>
    decodeXmlEntities(
      [...si.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(([, t]) => t).join('')
    )
  );
}

function parseRow(row, sharedStrings) {
  const cells = new Map();
  for (const [, column, attrs, body] of row.matchAll(
    /<c r="([A-Z]+)\d+"([^>]*)>(.*?)<\/c>/gs
  )) {
    const value = body.match(/<v>(.*?)<\/v>/s)?.[1];
    if (value === undefined) continue;
    cells.set(
      column,
      /t="s"/.test(attrs)
        ? (sharedStrings[Number(value)] ?? '')
        : decodeXmlEntities(value)
    );
  }
  return cells;
}

function buildMunicipalityNames(xlsx) {
  const entries = readZipEntries(xlsx);
  const read = (path) => {
    const entry = entries.get(path);
    if (!entry) throw new Error(`Municipality dictionary is missing ${path}`);
    return extractZipEntry(xlsx, entry).toString('utf8');
  };

  const sharedStrings = parseSharedStrings(read('xl/sharedStrings.xml'));
  const rows = [...read('xl/worksheets/sheet1.xml').matchAll(
    /<row[^>]*>(.*?)<\/row>/gs
  )].map(([, row]) => parseRow(row, sharedStrings));

  const headerIndex = rows.findIndex((cells) =>
    [...cells.values()].includes('CPRO')
  );
  if (headerIndex === -1) {
    throw new Error('Municipality dictionary has no CPRO header row');
  }
  const columnOf = new Map(
    [...rows[headerIndex]].map(([column, value]) => [value, column])
  );
  const provinceColumn = columnOf.get('CPRO');
  const municipalityColumn = columnOf.get('CMUN');
  const nameColumn = columnOf.get('NOMBRE');
  if (!provinceColumn || !municipalityColumn || !nameColumn) {
    throw new Error('Municipality dictionary is missing CPRO/CMUN/NOMBRE');
  }

  const names = new Map();
  for (const cells of rows.slice(headerIndex + 1)) {
    const province = cells.get(provinceColumn)?.padStart(2, '0');
    const municipality = cells.get(municipalityColumn)?.padStart(3, '0');
    const name = cells.get(nameColumn)?.trim();
    if (!province || !municipality || !name) continue;
    const code = `${province}${municipality}`;
    if (CODE_RE.test(code)) names.set(code, name);
  }
  return names;
}

// --------------------------------------------------------------------------
// Writers. JSON maps are emitted one entry per line, keys sorted, so refresh
// diffs stay readable and key order survives (JS objects would reorder
// numeric-looking keys like "10001" ahead of "01001").
// --------------------------------------------------------------------------

function csvField(value) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function jsonMap(entries) {
  const lines = entries.map(
    ([key, value]) => `  ${JSON.stringify(key)}: ${value}`
  );
  return `{\n${lines.join(',\n')}\n}\n`;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
  const edition = await findLatestCallejeroEdition();
  console.log(`Using callejero edition ${edition}`);
  const callejero = await fetchBuffer(CALLEJERO_URL(edition));
  const tram = extractByName(
    callejero,
    readZipEntries(callejero),
    /(^|\/)TRAM/
  );
  const municipalities = buildMunicipalities(tram);
  if (municipalities.size === 0) {
    throw new Error('No valid rows parsed from the INE callejero');
  }

  const dictionaryYear = await findLatestDictionaryYear();
  console.log(`Using municipality dictionary diccionario${dictionaryYear}`);
  const names = buildMunicipalityNames(
    await fetchBuffer(DICTIONARY_URL(dictionaryYear))
  );

  // Both datasets carry the full municipality set, so a code without a name
  // means the editions are out of sync (e.g. a merger the dictionary doesn't
  // know yet) — fail loudly rather than silently drop the municipality.
  const unnamed = [...municipalities.keys()].filter((ine) => !names.has(ine));
  if (unnamed.length > 0) {
    throw new Error(
      `Callejero municipalities missing from the dictionary: ${unnamed.join(', ')}`
    );
  }

  const municipalityCodes = [...municipalities.keys()].sort();

  // Flat (cp, municipio, nombre) pairs, drop-in compatible with
  // inigoflores/ds-codigos-postales-ine-es (same path, header and quoting).
  const pairs = [];
  for (const ine of municipalityCodes) {
    for (const cp of municipalities.get(ine)) pairs.push([cp, ine]);
  }
  pairs.sort(([cpA, ineA], [cpB, ineB]) =>
    cpA === cpB ? ineA.localeCompare(ineB) : cpA.localeCompare(cpB)
  );
  const csv = [
    'codigo_postal,municipio_id,municipio_nombre',
    ...pairs.map(([cp, ine]) => `${cp},${ine},${csvField(names.get(ine))}`),
  ].join('\n');

  const municipiosJson = jsonMap(
    municipalityCodes.map((ine) => [
      ine,
      JSON.stringify({
        nombre: names.get(ine),
        codigos_postales: [...municipalities.get(ine)].sort(),
      }),
    ])
  );

  const reverse = new Map();
  for (const [cp, ine] of pairs) {
    let list = reverse.get(cp);
    if (!list) {
      list = [];
      reverse.set(cp, list);
    }
    list.push(ine);
  }
  const codigosPostalesJson = jsonMap(
    [...reverse.keys()].sort().map((cp) => [cp, JSON.stringify(reverse.get(cp))])
  );

  const metadata = {
    fuentes: {
      callejero: CALLEJERO_URL(edition),
      diccionario: DICTIONARY_URL(dictionaryYear),
    },
    edicion_callejero: `${edition.slice(2)}-${edition.slice(0, 2)}`,
    edicion_diccionario: `20${dictionaryYear}`,
    municipios: municipalityCodes.length,
    codigos_postales: reverse.size,
    pares: pairs.length,
  };

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'codigos_postales_municipios.csv'), `${csv}\n`);
  writeFileSync(join(DATA_DIR, 'municipios.json'), municipiosJson);
  writeFileSync(join(DATA_DIR, 'codigos_postales.json'), codigosPostalesJson);
  writeFileSync(
    join(DATA_DIR, 'metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`
  );

  console.log(
    `Generated: ${metadata.municipios} municipios, ${metadata.codigos_postales} códigos postales, ${metadata.pares} pares`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
