const cors = require('cors');
const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const PORT = Number(process.env.PORT || 3001);
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(__dirname, 'cache');
const DEFAULT_GRIB_FILE = process.env.GRIB_FILE || path.join(DATA_DIR, 'precip.grib2');
const GRIB_MATCHES = String(
  process.env.GRIB_MATCHES || process.env.GRIB_MATCH || ':RPRATE:,:PRATE:,:APCP:',
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_VAR = String(process.env.DEFAULT_VAR || 'RPRATE').trim().toUpperCase();
const DATA_PALETTE = process.env.PALETTE_FILE || path.join(DATA_DIR, 'palette.txt');
const WGRIB2_EXE =
  process.env.WGRIB2_EXE || path.join(__dirname, '..', 'wgrib2', 'wgrib2.exe');
const GDALWARP_EXE = process.env.GDALWARP_EXE || 'gdalwarp';
const GDALDEM_EXE = process.env.GDALDEM_EXE || 'gdaldem';
const GDALINFO_EXE = process.env.GDALINFO_EXE || 'gdalinfo';
const FRANCE_BOUNDS = [
  [41.0, -5.5],
  [51.5, 9.8],
];

function normalizeHourParam(hour) {
  if (hour === undefined || hour === null || hour === '') return null;
  const s = String(hour).trim().toUpperCase().replace(/H$/, '');
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 8 || n > 15) return null;
  return String(n).padStart(2, '0');
}

function normalizeVarParam(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toUpperCase();
  const allowed = new Set(['CAPE', 'RPRATE', 'SPRATE', 'GPRATE', 'LCDC', 'PRES']);
  if (!allowed.has(s)) return null;
  return s;
}

function matchExprsForVar(v) {
  switch (v) {
    case 'CAPE':
      return [':CAPE:'];
    case 'RPRATE':
      return [':RPRATE:', ':PRATE:', ':APCP:'];
    case 'SPRATE':
      return [':SPRATE:'];
    case 'GPRATE':
      return [':GPRATE:'];
    case 'LCDC':
      return [':LCDC:'];
    case 'PRES':
      return [':PRES:'];
    default:
      return GRIB_MATCHES;
  }
}

function buildGribPathForHour(hh) {
  return path.join(DATA_DIR, `${hh}H.grib2`);
}

function safeKey(key) {
  return String(key).replace(/[^a-z0-9_-]/gi, '');
}

function getPathsForVarAndKey(varKey, key) {
  const v = safeKey(String(varKey || 'var').toLowerCase());
  const k = safeKey(key);
  return {
    capeNc: path.join(CACHE_DIR, `${v}_${k}.nc`),
    capeTif: path.join(CACHE_DIR, `${v}_${k}_3857.tif`),
    overlayPng: path.join(CACHE_DIR, `${v}_${k}_color.png`),
    overlayTmpPng: path.join(CACHE_DIR, `${v}_${k}_color.tmp.png`),
  };
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function hasCmd(cmd) {
  try {
    if (typeof cmd === 'string' && (cmd.includes('\\') || cmd.includes('/'))) {
      return fsSync.existsSync(cmd);
    }
    await runCmd('where.exe', [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function getFileMtimeMs(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readPngWithRetry(pngPath) {
  const attempts = Number(process.env.PNG_READ_RETRIES || 5);
  const delayMs = Number(process.env.PNG_READ_RETRY_DELAY_MS || 80);

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const s1 = await fs.stat(pngPath);
      if (!s1.size) throw new Error('PNG vide');
      await sleep(25);
      const s2 = await fs.stat(pngPath);
      if (s1.size !== s2.size) {
        await sleep(delayMs);
        continue;
      }

      const buf = await fs.readFile(pngPath);
      return PNG.sync.read(buf);
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      if (msg.includes('unrecognised content at end of stream') || msg.includes('PNG vide')) {
        await sleep(delayMs);
        continue;
      }
      throw e;
    }
  }

  throw lastErr || new Error('Lecture PNG impossible');
}

async function atomicReplaceFile(tmpPath, finalPath) {
  try {
    await fs.unlink(finalPath);
  } catch {}
  await fs.rename(tmpPath, finalPath);
}

async function ensureNonEmptyFile(filePath, minBytes, label) {
  const s = await fs.stat(filePath).catch(() => null);
  if (!s || !s.size || s.size < minBytes) {
    throw new Error(`${label} vide ou manquant: ${filePath}`);
  }
}

async function writeSyntheticPng(outPath, seed) {
  const size = 512;
  const png = new PNG({ width: size, height: size });

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (size * y + x) << 2;

      const nx = x / (size - 1);
      const ny = y / (size - 1);

      const v = clamp(
        1.2 * Math.exp(-((nx - 0.55) ** 2 + (ny - 0.45) ** 2) / 0.02) +
          0.8 * Math.exp(-((nx - 0.25) ** 2 + (ny - 0.7) ** 2) / 0.015) +
          0.6 * Math.exp(-((nx - 0.8) ** 2 + (ny - 0.2) ** 2) / 0.01),
        0,
        1,
      );

      const wave = 0.15 * Math.sin(10 * nx + seed * 0.001) * Math.cos(8 * ny - seed * 0.001);
      const intensity = clamp(v + wave, 0, 1);

      const r = Math.round(255 * clamp(intensity * 1.2, 0, 1));
      const g = Math.round(255 * clamp(Math.max(0, intensity - 0.25) * 1.3, 0, 1));
      const b = Math.round(255 * clamp(Math.max(0, intensity - 0.55) * 1.5, 0, 1));

      png.data[i + 0] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = Math.round(220 * intensity);
    }
  }

  await fs.writeFile(outPath, PNG.sync.write(png));
}

async function makeDominantBorderColorTransparent(pngPath) {
  const png = await readPngWithRetry(pngPath);

  const { width, height, data } = png;
  if (!width || !height) return;

  const counts = new Map();
  const samplePixel = (x, y) => {
    const i = (width * y + x) << 2;
    const a = data[i + 3];
    if (a === 0) return;
    const r = data[i + 0];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) || 0) + 1);
  };

  for (let x = 0; x < width; x++) {
    samplePixel(x, 0);
    samplePixel(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    samplePixel(0, y);
    samplePixel(width - 1, y);
  }

  let bgKey = null;
  let bgCount = -1;
  for (const [k, c] of counts.entries()) {
    if (c > bgCount) {
      bgKey = k;
      bgCount = c;
    }
  }
  if (bgKey === null) return;

  const bgR = (bgKey >> 16) & 255;
  const bgG = (bgKey >> 8) & 255;
  const bgB = bgKey & 255;
  const tol = Number(process.env.BORDER_COLOR_TOLERANCE || 10);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const a = data[i + 3];
      if (a === 0) continue;
      const r = data[i + 0];
      const g = data[i + 1];
      const b = data[i + 2];
      const dr = r - bgR;
      const dg = g - bgG;
      const db = b - bgB;
      if (Math.abs(dr) <= tol && Math.abs(dg) <= tol && Math.abs(db) <= tol) {
        data[i + 3] = 0;
      }
    }
  }

  await fs.writeFile(pngPath, PNG.sync.write(png));
}

function mercatorToLonLat(x, y) {
  const R = 6378137;
  const lon = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return { lon, lat };
}

function geotransformLooksGeographic(gt) {
  // Heuristic: lon/lat grids typically have origin in degrees and pixel sizes in ~[1e-4..1]
  // whereas EPSG:3857 uses meters and coordinates around millions.
  const x0 = gt[0];
  const y0 = gt[3];
  const pxW = gt[1];
  const pxH = gt[5];
  return (
    Math.abs(x0) <= 360 &&
    Math.abs(y0) <= 180 &&
    Math.abs(pxW) > 0 &&
    Math.abs(pxW) <= 5 &&
    Math.abs(pxH) > 0 &&
    Math.abs(pxH) <= 5
  );
}

async function cropPngToNonTransparent(pngPath) {
  const png = await readPngWithRetry(pngPath);
  const { width, height, data } = png;
  const alphaThreshold = Number(process.env.CROP_ALPHA_THRESHOLD || 1);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const a = data[i + 3];
      if (a >= alphaThreshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  if (cropW === width && cropH === height) {
    return { minX, minY, maxX, maxY, width, height };
  }

  const out = new PNG({ width: cropW, height: cropH });
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcI = (width * (minY + y) + (minX + x)) << 2;
      const dstI = (cropW * y + x) << 2;
      out.data[dstI + 0] = data[srcI + 0];
      out.data[dstI + 1] = data[srcI + 1];
      out.data[dstI + 2] = data[srcI + 2];
      out.data[dstI + 3] = data[srcI + 3];
    }
  }

  await fs.writeFile(pngPath, PNG.sync.write(out));
  return { minX, minY, maxX, maxY, width, height };
}

function boundsFromWgs84Extent(wgs84Extent) {
  if (!wgs84Extent || !Array.isArray(wgs84Extent.coordinates) || !wgs84Extent.coordinates[0]) {
    return null;
  }

  const ring = wgs84Extent.coordinates[0];
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const p of ring) {
    const lon = p[0];
    const lat = p[1];
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }

  if (!isFinite(minLon) || !isFinite(minLat) || !isFinite(maxLon) || !isFinite(maxLat)) {
    return null;
  }

  return [
    [minLat, minLon],
    [maxLat, maxLon],
  ];
}

async function convertGribToPngViaPipeline(gribPath, matchExprs, paths) {
  if (!fsSync.existsSync(DATA_PALETTE)) {
    throw new Error(`Palette manquante: ${DATA_PALETTE}`);
  }

  const matches = Array.isArray(matchExprs) && matchExprs.length ? matchExprs : GRIB_MATCHES;
  let lastErr = null;
  for (const matchExpr of matches) {
    try {
      try {
        await fs.unlink(paths.capeNc);
      } catch {}

      await runCmd(WGRIB2_EXE, [gribPath, '-match', matchExpr, '-netcdf', paths.capeNc]);
      await ensureNonEmptyFile(paths.capeNc, 200, `wgrib2 (${matchExpr}) netcdf`);

      await runCmd(GDALWARP_EXE, ['-overwrite', '-t_srs', 'EPSG:3857', paths.capeNc, paths.capeTif]);
      await runCmd(GDALDEM_EXE, ['color-relief', paths.capeTif, DATA_PALETTE, paths.overlayTmpPng, '-alpha']);
      await makeDominantBorderColorTransparent(paths.overlayTmpPng);

      const info = await runCmd(GDALINFO_EXE, ['-json', paths.capeTif]);
      const parsed = JSON.parse(info.stdout);
      const gt = parsed.geoTransform;
      if (!Array.isArray(gt) || gt.length < 6) {
        throw new Error('gdalinfo: geoTransform manquant');
      }
      const x0 = gt[0];
      const pxW = gt[1];
      const y0 = gt[3];
      const pxH = gt[5];

      const crop = await cropPngToNonTransparent(paths.overlayTmpPng);
      if (!crop) {
        await atomicReplaceFile(paths.overlayTmpPng, paths.overlayPng);
        return { bounds: FRANCE_BOUNDS, matchExpr };
      }

      const minCol = crop.minX;
      const maxCol = crop.maxX;
      const minRow = crop.minY;
      const maxRow = crop.maxY;

      const minX = x0 + minCol * pxW;
      const maxX = x0 + (maxCol + 1) * pxW;
      const maxY = y0 + minRow * pxH;
      const minY = y0 + (maxRow + 1) * pxH;

      let bounds;
      if (geotransformLooksGeographic(gt)) {
        bounds = [
          [Math.min(minY, maxY), Math.min(minX, maxX)],
          [Math.max(minY, maxY), Math.max(minX, maxX)],
        ];
      } else {
        const ll = mercatorToLonLat(minX, minY);
        const ur = mercatorToLonLat(maxX, maxY);
        bounds = [
          [Math.min(ll.lat, ur.lat), Math.min(ll.lon, ur.lon)],
          [Math.max(ll.lat, ur.lat), Math.max(ll.lon, ur.lon)],
        ];
      }

      await atomicReplaceFile(paths.overlayTmpPng, paths.overlayPng);

      return {
        bounds,
        matchExpr,
      };
    } catch (e) {
      lastErr = e;
    }
  }

  const tried = matches.join(', ');
  const lastDetails = String(
    (lastErr && (lastErr.stderr || lastErr.stdout || lastErr.message)) || lastErr || 'Erreur inconnue',
  )
    .replace(/\s+/g, ' ')
    .slice(0, 600);
  throw new Error(`Aucun champ trouvé via -match. Tentés: ${tried}. Dernière erreur: ${lastDetails}`);
}

function makeEmptyCache() {
  return {
    updatedAt: 0,
    bounds: FRANCE_BOUNDS,
    source: 'synthetic',
    message: 'synthetic',
    gribMtimeMs: null,
    pipelineAvailable: null,
    lastErrorAt: 0,
  };
}

const caches = new Map();
const conversionsInFlight = new Map();

function getCacheForKey(key) {
  const k = safeKey(key || 'default');
  if (!caches.has(k)) caches.set(k, makeEmptyCache());
  return caches.get(k);
}

async function ensureOverlayUpToDate(key, gribPath, paths, matchExprs, varKey) {
  const now = Date.now();
  const cache = getCacheForKey(key);
  const gribMtimeMs = await getFileMtimeMs(gribPath);

  const prevPipelineAvailable = cache.pipelineAvailable;

  const missingTools = [];
  const hasWgrib2 = await hasCmd(WGRIB2_EXE);
  const hasGdalwarp = await hasCmd(GDALWARP_EXE);
  const hasGdaldem = await hasCmd(GDALDEM_EXE);
  if (!hasWgrib2) missingTools.push('wgrib2');
  if (!hasGdalwarp) missingTools.push('gdalwarp');
  if (!hasGdaldem) missingTools.push('gdaldem');
  cache.pipelineAvailable = missingTools.length === 0;
  const pipelineJustBecameAvailable = cache.pipelineAvailable && prevPipelineAvailable === false;

  const shouldRefreshSynthetic = now - cache.updatedAt > 30_000;

  const retryIntervalMs = Number(process.env.RETRY_INTERVAL_MS || 15_000);
  const shouldRetryAfterError =
    gribMtimeMs &&
    cache.pipelineAvailable &&
    cache.source !== 'wgrib2' &&
    cache.lastErrorAt &&
    now - cache.lastErrorAt >= retryIntervalMs;

  if (
    gribMtimeMs &&
    cache.pipelineAvailable &&
    (cache.gribMtimeMs !== gribMtimeMs || shouldRetryAfterError || pipelineJustBecameAvailable)
  ) {
    const inflight = conversionsInFlight.get(key);
    if (inflight) {
      await inflight;
      return;
    }

    try {
      const p = convertGribToPngViaPipeline(gribPath, matchExprs, paths);
      conversionsInFlight.set(key, p);
      const res = await p;
      Object.assign(cache, {
        updatedAt: Date.now(),
        bounds: res.bounds,
        source: 'wgrib2',
        message: `OK: ${varKey || ''} wgrib2 (${res.matchExpr || (Array.isArray(matchExprs) ? matchExprs.join(',') : '')}) -> gdalwarp EPSG:3857 -> gdaldem color-relief`,
        gribMtimeMs,
        lastErrorAt: 0,
      });
      return;
    } catch (e) {
      const details = String(
        (e && (e.stderr || e.stdout || e.message)) || e || 'Erreur inconnue',
      )
        .replace(/\s+/g, ' ')
        .slice(0, 600);
      Object.assign(cache, {
        updatedAt: Date.now(),
        bounds: FRANCE_BOUNDS,
        source: 'synthetic',
        message: `Erreur pipeline: ${details}`,
        gribMtimeMs,
        lastErrorAt: Date.now(),
      });
      await writeSyntheticPng(paths.overlayTmpPng, cache.updatedAt);
      await atomicReplaceFile(paths.overlayTmpPng, paths.overlayPng);
      return;
    } finally {
      conversionsInFlight.delete(key);
    }
  }

  if (
    !gribMtimeMs &&
    (cache.updatedAt === 0 || shouldRefreshSynthetic || !fsSync.existsSync(paths.overlayPng))
  ) {
    Object.assign(cache, {
      updatedAt: Date.now(),
      bounds: FRANCE_BOUNDS,
      source: 'synthetic',
      message: `GRIB manquant: place un fichier en ${gribPath}`,
      gribMtimeMs: null,
    });
    await writeSyntheticPng(paths.overlayPng, cache.updatedAt);
    return;
  }

  if (
    gribMtimeMs &&
    !cache.pipelineAvailable &&
    (cache.updatedAt === 0 || shouldRefreshSynthetic || !fsSync.existsSync(paths.overlayPng))
  ) {
    Object.assign(cache, {
      updatedAt: Date.now(),
      bounds: FRANCE_BOUNDS,
      source: 'synthetic',
      message: `GRIB détecté mais outils indisponibles (${missingTools.join(', ')}). Fallback synthétique.`,
      gribMtimeMs,
    });
    await writeSyntheticPng(paths.overlayPng, cache.updatedAt);
  }
}

const app = express();
app.use(cors());

app.get('/api/precip/meta', async (req, res) => {
  try {
    const hour = normalizeHourParam(req.query.hour);
    const varKey = normalizeVarParam(req.query.var) || DEFAULT_VAR;
    const timeKey = hour ? `${hour}H` : 'default';
    const key = `${varKey}_${timeKey}`;
    const gribPath = hour ? buildGribPathForHour(hour) : DEFAULT_GRIB_FILE;
    const paths = getPathsForVarAndKey(varKey, timeKey);
    await ensureOverlayUpToDate(key, gribPath, paths, matchExprsForVar(varKey), varKey);
    const cache = getCacheForKey(key);
    res.json({
      hour,
      var: varKey,
      gribFile: path.basename(gribPath),
      updatedAt: cache.updatedAt,
      bounds: cache.bounds,
      source: cache.source,
      message: cache.message,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/precip/overlay.png', async (req, res) => {
  try {
    const hour = normalizeHourParam(req.query.hour);
    const varKey = normalizeVarParam(req.query.var) || DEFAULT_VAR;
    const timeKey = hour ? `${hour}H` : 'default';
    const key = `${varKey}_${timeKey}`;
    const gribPath = hour ? buildGribPathForHour(hour) : DEFAULT_GRIB_FILE;
    const paths = getPathsForVarAndKey(varKey, timeKey);
    await ensureOverlayUpToDate(key, gribPath, paths, matchExprsForVar(varKey), varKey);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(paths.overlayPng);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`DEFAULT_GRIB_FILE=${DEFAULT_GRIB_FILE}`);
});
