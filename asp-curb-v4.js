/**
 * ParkBro — ASP Block-Accurate Curb Lines v4
 *
 * ПРИНЦИП: знаки NYC не используются для геометрии — только OSM.
 *
 * Алгоритм:
 * 1. Для каждой зоны: on_street, from_street, to_street
 * 2. В OSM находим where from_street ПЕРЕСЕКАЕТ on_street → точка A
 * 3. В OSM находим where to_street ПЕРЕСЕКАЕТ on_street → точка B
 * 4. Берём геометрию on_street между A и B (следует изгибам дороги)
 * 5. Смещаем перпендикулярно на CURB_OFFSET метров в нужную сторону
 *
 * Результат: линии идеально по блокам, нет выхода на перекрёстки,
 * следуют реальным изгибам улиц NYC.
 *
 * Usage:
 *   node --max-old-space-size=4096 asp-curb-v4.js
 *   node --max-old-space-size=4096 asp-curb-v4.js --dry-run
 */

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://parkingapp:wmoU4mDhWsRb4VaQ@eazypark.xhy0jyi.mongodb.net/parkingapp?retryWrites=true&w=majority';

// Offset вычисляется автоматически из ширины дороги OSM (тег width или lanes).
// Fallback по типу дороги если тегов нет.
// Offset = (road_width / 2) — половина ширины дороги до бордюра.

// Ширина полосы в NYC (метры) по типу дороги
const LANE_WIDTH_BY_TYPE = {
  'motorway':      3.7,
  'trunk':         3.7,
  'primary':       3.5,
  'secondary':     3.3,
  'tertiary':      3.0,
  'residential':   2.8,
  'unclassified':  2.8,
  'living_street': 2.5,
};

// Fallback ширина дороги (полная, от бордюра до бордюра) если нет тегов
const DEFAULT_WIDTH_BY_TYPE = {
  'motorway':      22,
  'trunk':         18,
  'primary':       14,
  'secondary':     11,
  'tertiary':       9,
  'residential':    8,
  'unclassified':   8,
  'living_street':  6,
};

const CURB_OFFSET_MIN = 2.5;  // никогда меньше
const CURB_OFFSET_MAX = 10.0; // никогда больше (защита от аномалий)

/**
 * Вычислить offset от центра дороги до бордюра (метры).
 * @param {object} wayMeta - { width, lanes, highway }
 */
function calcCurbOffset(wayMeta) {
  const { width, lanes, highway } = wayMeta;

  // 1. Приоритет: явный тег width (реальная ширина дороги в OSM)
  if (width && parseFloat(width) > 0) {
    const w = parseFloat(width);
    if (w > 2 && w < 60) {
      return Math.max(CURB_OFFSET_MIN, Math.min(CURB_OFFSET_MAX, w / 2));
    }
  }

  // 2. lanes × ширина полосы
  if (lanes && parseInt(lanes) > 0) {
    const n = parseInt(lanes);
    const lw = LANE_WIDTH_BY_TYPE[highway] || 3.0;
    const roadW = n * lw;
    return Math.max(CURB_OFFSET_MIN, Math.min(CURB_OFFSET_MAX, roadW / 2));
  }

  // 3. Fallback по типу дороги
  const defaultW = DEFAULT_WIDTH_BY_TYPE[highway] || 8;
  return Math.max(CURB_OFFSET_MIN, Math.min(CURB_OFFSET_MAX, defaultW / 2));
}

// Допуск для матчинга пересечений: если улицы подходят ближе чем X метров — считаем что пересекаются
const INTERSECTION_TOLERANCE_M = 25;

// Максимальное расстояние от центра зоны до найденной дороги (м)
const MAX_STREET_DIST_M = 120;

// Минимальная длина сегмента (м) — для одиночных знаков (гидранты и т.д.)
const MIN_SEGMENT_M = 6;

const DRY_RUN = process.argv.includes('--dry-run');

// ============ SCHEMA ============
const aspZoneSchema = new mongoose.Schema({
  geometry: { type: { type: String }, coordinates: { type: [[Number]] } },
  streetName: String, fromStreet: String, toStreet: String,
  borough: String, side: String, zoneType: String,
  rules: [mongoose.Schema.Types.Mixed],
  center: { lat: Number, lng: Number },
  sourceId: String
});
aspZoneSchema.index({ geometry: '2dsphere' });
const ASPZone = mongoose.model('ASPZone', aspZoneSchema);

// ============ GEO MATH ============
const M_PER_LAT = 111320;

function mPerLng(lat) {
  return M_PER_LAT * Math.cos(lat * Math.PI / 180);
}

/** Distance in meters between [lng,lat] points */
function distM(a, b) {
  const midLat = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * mPerLng(midLat);
  const dy = (b[1] - a[1]) * M_PER_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Cumulative arc lengths (meters) for a polyline [[lng,lat],...] */
function cumulativeLengths(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + distM(coords[i - 1], coords[i]));
  }
  return cum;
}

/**
 * Project [lng,lat] point onto polyline.
 * Returns { projection:[lng,lat], arcLenM, distM }
 */
function projectOnPolyline(wayCoords, point) {
  const cum = cumulativeLengths(wayCoords);
  const midLat = point[1];
  const sx = mPerLng(midLat);
  const sy = M_PER_LAT;

  let bestDist = Infinity, bestArc = 0, bestProj = null;

  for (let i = 0; i < wayCoords.length - 1; i++) {
    const a = wayCoords[i], b = wayCoords[i + 1];
    const ax = a[0] * sx, ay = a[1] * sy;
    const bx = b[0] * sx, by = b[1] * sy;
    const px = point[0] * sx, py = point[1] * sy;

    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) continue;

    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const projLng = a[0] + t * (b[0] - a[0]);
    const projLat = a[1] + t * (b[1] - a[1]);
    const proj = [projLng, projLat];
    const d = distM(point, proj);

    if (d < bestDist) {
      bestDist = d;
      bestArc = cum[i] + t * (cum[i + 1] - cum[i]);
      bestProj = proj;
    }
  }

  return { projection: bestProj, arcLenM: bestArc, distM: bestDist };
}

/**
 * Find closest point of approach between two polylines.
 * Returns { arcA, arcB, distM } — arc positions on each polyline
 * at the point of closest approach (intersection or nearest point).
 */
function findIntersectionArc(wayA, wayB) {
  const cumA = cumulativeLengths(wayA);
  const cumB = cumulativeLengths(wayB);

  let bestDist = Infinity;
  let bestArcA = 0;
  let bestArcB = 0;

  // Check vertices of B projected onto A, and vice versa
  // For efficiency, sample at segment midpoints + vertices
  const sampleB = [];
  for (let i = 0; i < wayB.length; i++) {
    sampleB.push({ pt: wayB[i], arc: cumB[i] });
  }
  for (let i = 0; i < wayB.length - 1; i++) {
    sampleB.push({
      pt: [(wayB[i][0] + wayB[i + 1][0]) / 2, (wayB[i][1] + wayB[i + 1][1]) / 2],
      arc: (cumB[i] + cumB[i + 1]) / 2
    });
  }

  for (const { pt, arc: arcB } of sampleB) {
    const { distM: d, arcLenM: arcA } = projectOnPolyline(wayA, pt);
    if (d < bestDist) {
      bestDist = d;
      bestArcA = arcA;
      bestArcB = arcB;
    }
  }

  // Also sample A onto B
  const sampleA = [];
  for (let i = 0; i < wayA.length; i++) {
    sampleA.push({ pt: wayA[i], arc: cumA[i] });
  }

  for (const { pt } of sampleA) {
    const { distM: d, arcLenM: arcB } = projectOnPolyline(wayB, pt);
    const { arcLenM: arcA } = projectOnPolyline(wayA, pt);
    if (d < bestDist) {
      bestDist = d;
      bestArcA = arcA;
      bestArcB = arcB;
    }
  }

  return { arcA: bestArcA, arcB: bestArcB, distM: bestDist };
}

/**
 * Extract sub-polyline between arcStart and arcEnd (meters).
 * Preserves all intermediate vertices (road curves).
 */
function extractSubPolyline(wayCoords, arcStart, arcEnd) {
  if (arcStart > arcEnd) [arcStart, arcEnd] = [arcEnd, arcStart];

  const cum = cumulativeLengths(wayCoords);
  const totalLen = cum[cum.length - 1];

  arcStart = Math.max(0, arcStart);
  arcEnd = Math.min(totalLen, arcEnd);

  if (arcEnd - arcStart < 0.1) return null;

  const result = [];

  for (let i = 0; i < wayCoords.length - 1; i++) {
    const s0 = cum[i], s1 = cum[i + 1];
    const segLen = s1 - s0;

    if (s1 < arcStart - 0.01) continue;
    if (s0 > arcEnd + 0.01) break;

    const a = wayCoords[i], b = wayCoords[i + 1];

    // Add interpolated start point
    if (result.length === 0 && arcStart >= s0 - 0.01 && arcStart <= s1 + 0.01) {
      const t = segLen > 0.01 ? Math.max(0, Math.min(1, (arcStart - s0) / segLen)) : 0;
      result.push([
        parseFloat((a[0] + t * (b[0] - a[0])).toFixed(7)),
        parseFloat((a[1] + t * (b[1] - a[1])).toFixed(7))
      ]);
    }

    // Add vertex b if it's within range (not past end)
    if (result.length > 0 && s1 <= arcEnd + 0.01) {
      const last = result[result.length - 1];
      const bRound = [parseFloat(b[0].toFixed(7)), parseFloat(b[1].toFixed(7))];
      if (distM(last, bRound) > 0.3) result.push(bRound);
    }

    // Add interpolated end point
    if (arcEnd >= s0 - 0.01 && arcEnd <= s1 + 0.01) {
      const t = segLen > 0.01 ? Math.max(0, Math.min(1, (arcEnd - s0) / segLen)) : 1;
      const endPt = [
        parseFloat((a[0] + t * (b[0] - a[0])).toFixed(7)),
        parseFloat((a[1] + t * (b[1] - a[1])).toFixed(7))
      ];
      const last = result[result.length - 1];
      if (!last || distM(last, endPt) > 0.3) result.push(endPt);
      break;
    }
  }

  return result.length >= 2 ? result : null;
}

/**
 * Offset a polyline perpendicularly.
 * side: 'left' | 'right' relative to LineString direction.
 */
function offsetPolyline(coords, side, meters) {
  return coords.map((pt, i) => {
    // Tangent direction at this point
    const prev = coords[Math.max(0, i - 1)];
    const next = coords[Math.min(coords.length - 1, i + 1)];

    const midLat = pt[1];
    const sx = mPerLng(midLat);
    const sy = M_PER_LAT;

    const tx = (next[0] - prev[0]) * sx;
    const ty = (next[1] - prev[1]) * sy;
    const tLen = Math.sqrt(tx * tx + ty * ty);
    if (tLen < 0.01) return pt;

    // Perpendicular: left = CCW, right = CW
    let nx, ny;
    if (side === 'left') {
      nx = -ty / tLen;
      ny = tx / tLen;
    } else {
      nx = ty / tLen;
      ny = -tx / tLen;
    }

    return [
      parseFloat((pt[0] + nx * meters / sx).toFixed(7)),
      parseFloat((pt[1] + ny * meters / sy).toFixed(7))
    ];
  });
}

// ============ STREET NAME NORMALIZATION ============
function norm(name) {
  if (!name) return '';
  return name.toUpperCase().trim()
    .replace(/\b(\d+)\s*(?:ST|ND|RD|TH)\b/g, '$1')
    .replace(/\bSAINT\b/g, 'ST')
    .replace(/\bSTREET\b/g, 'ST')
    .replace(/\bAVENUE\b/g, 'AVE')
    .replace(/\bBOULEVARD\b/g, 'BLVD')
    .replace(/\bDRIVE\b/g, 'DR')
    .replace(/\bPLACE\b/g, 'PL')
    .replace(/\bROAD\b/g, 'RD')
    .replace(/\bCOURT\b/g, 'CT')
    .replace(/\bLANE\b/g, 'LN')
    .replace(/\bPARKWAY\b/g, 'PKWY')
    .replace(/\bTERRACE\b/g, 'TER')
    .replace(/\bWEST\b/g, 'W')
    .replace(/\bEAST\b/g, 'E')
    .replace(/\bNORTH\b/g, 'N')
    .replace(/\bSOUTH\b/g, 'S')
    .replace(/\bEXPRESSWAY\b/g, 'EXPY')
    .replace(/\bTURNPIKE\b/g, 'TPKE')
    .replace(/\bHIGHWAY\b/g, 'HWY')
    .replace(/\bCIRCLE\b/g, 'CIR')
    .replace(/\bCRESCENT\b/g, 'CRES')
    .replace(/\s+/g, ' ');
}

// ============ OVERPASS FETCH ============
async function fetchOSM() {
  console.log('📡 Загрузка улиц из OpenStreetMap...');

  const areas = [
    { name: 'Brooklyn',      bbox: '40.57,-74.05,40.74,-73.83' },
    { name: 'Queens',        bbox: '40.54,-73.96,40.80,-73.70' },
    { name: 'Manhattan',     bbox: '40.70,-74.02,40.88,-73.90' },
    { name: 'Bronx',         bbox: '40.79,-73.94,40.92,-73.75' },
    { name: 'Staten Island', bbox: '40.49,-74.26,40.65,-74.05' },
  ];

  const allWays = [];

  for (const area of areas) {
    console.log(`   ${area.name}...`);

    const query = `
      [out:json][timeout:180][bbox:${area.bbox}];
      way["highway"~"^(residential|tertiary|secondary|primary|trunk|unclassified|living_street)$"]["name"];
      out geom;
    `;

    let success = false;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      if (attempt > 0) {
        console.log(`   Повтор ${attempt}/2...`);
        await new Promise(r => setTimeout(r, 15000));
      }
      try {
        const server = attempt < 2
          ? 'https://overpass-api.de/api/interpreter'
          : 'https://overpass.kumi.systems/api/interpreter';

        const resp = await fetch(server, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(180000)
        });
        if (!resp.ok) { console.log(`   ⚠️ HTTP ${resp.status}`); continue; }

        const data = await resp.json();
        let count = 0;
        for (const el of (data.elements || [])) {
          if (el.type !== 'way' || !el.geometry || !el.tags?.name) continue;
          const coords = el.geometry.map(p => [p.lon, p.lat]);
          if (coords.length < 2) continue;
          allWays.push({
            coords,
            name: el.tags.name,
            // OSM width/lanes/highway for curb offset calculation
            width:   el.tags.width   || null,
            lanes:   el.tags.lanes   || null,
            highway: el.tags.highway || 'residential',
          });
          count++;
        }
        console.log(`   ✅ ${area.name}: ${count} улиц`);
        success = true;
      } catch (e) {
        console.log(`   ❌ ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 8000));
  }

  console.log(`\n   ✅ Итого: ${allWays.length} улиц из OSM`);
  return allWays;
}

// ============ BUILD INDEX ============
function buildIndex(ways) {
  console.log('\n🗂️  Построение индекса...');
  const index = {}; // normalized name → [{ coords, width, lanes, highway }, ...]
  for (const way of ways) {
    const name = norm(way.name);
    if (!name) continue;
    if (!index[name]) index[name] = [];
    index[name].push({
      coords:  way.coords,
      width:   way.width,
      lanes:   way.lanes,
      highway: way.highway,
    });
  }
  console.log(`   ✅ ${Object.keys(index).length} уникальных улиц`);
  return index;
}

// ============ FIND BEST WAY FOR A ZONE ============
function findBestWay(zoneName, zoneCenter, index) {
  const name = norm(zoneName);
  const ways = index[name];
  if (!ways || ways.length === 0) return null;

  let best = null, bestDist = Infinity;
  for (const wayMeta of ways) {
    const { distM: d } = projectOnPolyline(wayMeta.coords, [zoneCenter.lng, zoneCenter.lat]);
    if (d < bestDist) { bestDist = d; best = wayMeta; }
  }
  return bestDist <= MAX_STREET_DIST_M ? best : null;
}

// ============ MAIN ZONE PROCESSING ============

/**
 * Build a geodetically accurate curb line for one zone.
 *
 * Strategy:
 * A) Find OSM way for on_street near zone center → mainWay
 * B) Find OSM ways for from_street and to_street → fromWays, toWays
 * C) Find intersection points of from/to with mainWay (closest approach)
 * D) Extract mainWay sub-geometry between those two arc positions
 * E) Offset to curb side
 *
 * Fallback if intersection not found:
 * - Project zone center onto mainWay
 * - Use zone's stored coordinates to estimate block length
 * - Extract that length centered on projection
 */
function buildCurbLine(zone, index) {
  const zoneCenter = { lng: zone.center.lng, lat: zone.center.lat };

  // A) Main street
  const mainMeta = findBestWay(zone.streetName, zoneCenter, index);
  if (!mainMeta) return null;

  const mainWay = mainMeta.coords;

  // Compute curb offset from actual OSM road width
  const curbOffset = calcCurbOffset(mainMeta);

  const cumMain = cumulativeLengths(mainWay);
  const totalMainLen = cumMain[cumMain.length - 1];

  // B) Intersecting streets — get coords arrays from index
  const fromEntries = index[norm(zone.fromStreet)] || [];
  const toEntries   = index[norm(zone.toStreet)]   || [];
  const fromWays = fromEntries.map(e => e.coords);
  const toWays   = toEntries.map(e => e.coords);

  // C) Find arc positions where from/to cross main street
  let arcFrom = null, arcTo = null;

  // Find from_street intersection
  if (fromWays.length > 0) {
    let bestDist = Infinity;
    for (const fromWay of fromWays) {
      const result = findIntersectionArc(mainWay, fromWay);
      if (result.distM < bestDist && result.distM <= INTERSECTION_TOLERANCE_M) {
        bestDist = result.distM;
        arcFrom = result.arcA;
      }
    }
  }

  // Find to_street intersection
  if (toWays.length > 0) {
    let bestDist = Infinity;
    for (const toWay of toWays) {
      const result = findIntersectionArc(mainWay, toWay);
      if (result.distM < bestDist && result.distM <= INTERSECTION_TOLERANCE_M) {
        bestDist = result.distM;
        arcTo = result.arcA;
      }
    }
  }

  // D) Determine arc range for the sub-segment
  let arcStart, arcEnd;

  if (arcFrom !== null && arcTo !== null) {
    // ✅ Best case: both intersections found
    arcStart = Math.min(arcFrom, arcTo);
    arcEnd = Math.max(arcFrom, arcTo);

    // Sanity: block shouldn't be longer than 400m or shorter than MIN_SEGMENT_M
    const blockLen = arcEnd - arcStart;
    if (blockLen < MIN_SEGMENT_M || blockLen > 400) {
      // Fall through to fallback
      arcFrom = null; arcTo = null;
    }
  }

  if (arcFrom === null || arcTo === null) {
    // Fallback: use zone center + estimate length from stored sign coords
    const centerProj = projectOnPolyline(mainWay, [zoneCenter.lng, zoneCenter.lat]);
    if (!centerProj.projection) return null;

    const centerArc = centerProj.arcLenM;

    // Estimate half-length from stored coordinates bounding box
    const coords = zone.geometry?.coordinates || [];
    let halfLen = 30; // default 30m half-block

    if (coords.length >= 2) {
      // Use the span of original sign positions as approximate block length
      const lats = coords.map(c => c[1]);
      const lngs = coords.map(c => c[0]);
      const midLat = (Math.max(...lats) + Math.min(...lats)) / 2;
      const spanLat = (Math.max(...lats) - Math.min(...lats)) * M_PER_LAT;
      const spanLng = (Math.max(...lngs) - Math.min(...lngs)) * mPerLng(midLat);
      const span = Math.max(spanLat, spanLng);
      if (span > MIN_SEGMENT_M && span < 250) halfLen = span / 2;
    }

    arcStart = Math.max(0, centerArc - halfLen);
    arcEnd = Math.min(totalMainLen, centerArc + halfLen);
  }

  // Enforce minimum segment length
  if (arcEnd - arcStart < MIN_SEGMENT_M) {
    const mid = (arcStart + arcEnd) / 2;
    arcStart = mid - MIN_SEGMENT_M / 2;
    arcEnd = mid + MIN_SEGMENT_M / 2;
  }

  // D) Extract road sub-geometry
  const roadSeg = extractSubPolyline(mainWay, arcStart, arcEnd);
  if (!roadSeg || roadSeg.length < 2) return null;

  // E) Offset to curb
  if (!zone.side || zone.side === 'both') {
    return roadSeg; // No offset: draw on centerline
  }

  return offsetPolyline(roadSeg, zone.side, curbOffset);
}

// ============ MAIN ============
async function main() {
  console.log('🗺️  ParkBro ASP Block-Accurate Curb Lines v4');
  console.log('   Offset к бордюру: автоматически из ширины дороги OSM (width/lanes/highway)');
  console.log('   Геометрия: from_street/to_street пересечения → OSM сегмент');
  if (DRY_RUN) console.log('   ⚠️  DRY RUN');
  console.log('');

  const ways = await fetchOSM();
  if (!ways.length) { console.error('❌ Нет данных OSM'); return; }

  const index = buildIndex(ways);

  console.log('\n📡 Подключение к MongoDB...');
  await mongoose.connect(MONGODB_URI);
  const zones = await ASPZone.find({}).lean();
  console.log(`   ✅ Зон: ${zones.length}`);

  console.log('\n🔄 Обработка зон...');

  let matched = 0, fallback = 0, unmatched = 0, errors = 0;
  const typeStats = {}, sideStats = {};

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    try {
      const newCoords = buildCurbLine(zone, index);
      if (!newCoords || newCoords.length < 2) { unmatched++; continue; }

      const centerLng = newCoords.reduce((s, c) => s + c[0], 0) / newCoords.length;
      const centerLat = newCoords.reduce((s, c) => s + c[1], 0) / newCoords.length;

      if (!DRY_RUN) {
        await ASPZone.updateOne({ _id: zone._id }, {
          $set: {
            'geometry.coordinates': newCoords,
            'center.lat': parseFloat(centerLat.toFixed(7)),
            'center.lng': parseFloat(centerLng.toFixed(7))
          }
        });
      }

      matched++;
      typeStats[zone.zoneType || 'asp'] = (typeStats[zone.zoneType || 'asp'] || 0) + 1;
      sideStats[zone.side || 'both'] = (sideStats[zone.side || 'both'] || 0) + 1;

    } catch (e) {
      errors++;
      if (errors <= 5) console.log(`   ⚠️ zone ${zone._id}: ${e.message}`);
    }

    if ((i + 1) % 5000 === 0) {
      const pct = Math.round(((i + 1) / zones.length) * 100);
      console.log(`   ${i + 1}/${zones.length} (${pct}%) matched:${matched} unmatched:${unmatched} errors:${errors}`);
    }
  }

  console.log(`\n✅ Результат:`);
  console.log(`   Обновлено:     ${matched}`);
  console.log(`   Не найдено:    ${unmatched}`);
  console.log(`   Ошибки:        ${errors}`);
  console.log(`   По типам:      ${JSON.stringify(typeStats)}`);
  console.log(`   По сторонам:   ${JSON.stringify(sideStats)}`);

  await mongoose.disconnect();
  if (DRY_RUN) console.log('\n⚠️  DRY RUN — база не изменена');
  else console.log('\n✅ Готово!');
}

main().catch(e => {
  console.error('\n❌', e);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
