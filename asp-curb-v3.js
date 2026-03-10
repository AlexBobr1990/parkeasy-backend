/**
 * ParkBro — ASP Curb Alignment v3
 *
 * ПРАВИЛЬНЫЙ алгоритм геодезической точности:
 *
 * 1. Координаты знаков из asp-resync-v2 — это РЕАЛЬНЫЕ позиции знаков (NYC DOT survey)
 * 2. Проецируем КАЖДЫЙ знак на OSM дорогу → находим реальный диапазон зоны
 * 3. Извлекаем геометрию дороги МЕЖДУ первым и последним знаком (многоточечная, следует изгибам)
 * 4. Смещаем перпендикулярно в сторону знаков на реальное расстояние (= расстояние бордюра)
 *
 * В отличие от asp-snap-osm-v2:
 * - НЕ создаёт 2-точечную линию из центра зоны (причина залезания на перекрёстки)
 * - НЕ центрирует по центру блока (искажает реальную длину зоны)
 * - Сохраняет реальные изгибы дороги
 * - Ограничивает линию реальными позициями знаков → нет выхода на перекрёстки
 *
 * Usage:
 *   node --max-old-space-size=4096 asp-curb-v3.js
 *   node --max-old-space-size=4096 asp-curb-v3.js --dry-run
 */

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://parkingapp:wmoU4mDhWsRb4VaQ@eazypark.xhy0jyi.mongodb.net/parkingapp?retryWrites=true&w=majority';
const CURB_MIN_M = 2;    // минимум от центра дороги до линии (м)
const CURB_MAX_M = 12;   // максимум (защита от аномалий)
const CURB_DEFAULT_M = 5; // если измерение не удалось
const MIN_ZONE_LEN_M = 8; // минимальная длина зоны (м)
const MAX_SNAP_DIST_M = 80; // если знак дальше — не снапить
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

// ============ GEO CONSTANTS ============
const M_PER_DEG_LAT = 111320;

function mPerDegLng(lat) {
  return M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
}

// ============ STREET NAME NORMALIZATION ============
function normalizeName(name) {
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

// ============ GEO MATH ============

/**
 * Distance between two [lng, lat] points in meters
 */
function distM(a, b) {
  const midLat = (a[1] + b[1]) / 2;
  const dLat = (b[1] - a[1]) * M_PER_DEG_LAT;
  const dLng = (b[0] - a[0]) * mPerDegLng(midLat);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/**
 * Cumulative arc lengths (meters) for a polyline
 */
function cumulativeLengths(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + distM(coords[i - 1], coords[i]));
  }
  return cum;
}

/**
 * Project a [lng, lat] point onto a polyline.
 * Returns: { projection, arcLenM, distM, segIdx }
 * - arcLenM: position along polyline in meters from start
 * - distM: distance from point to polyline (meters)
 */
function projectOnPolyline(wayCoords, point) {
  const cumLen = cumulativeLengths(wayCoords);
  const midLat = point[1];
  const scaleX = mPerDegLng(midLat);
  const scaleY = M_PER_DEG_LAT;

  let bestDistM = Infinity;
  let bestArcLen = 0;
  let bestProj = null;
  let bestSegIdx = 0;

  for (let i = 0; i < wayCoords.length - 1; i++) {
    const a = wayCoords[i];
    const b = wayCoords[i + 1];

    // Work in meters space for correct projection
    const ax = a[0] * scaleX, ay = a[1] * scaleY;
    const bx = b[0] * scaleX, by = b[1] * scaleY;
    const px = point[0] * scaleX, py = point[1] * scaleY;

    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) continue;

    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const projLng = a[0] + t * (b[0] - a[0]);
    const projLat = a[1] + t * (b[1] - a[1]);
    const proj = [projLng, projLat];

    const d = distM(point, proj);

    if (d < bestDistM) {
      bestDistM = d;
      bestArcLen = cumLen[i] + t * (cumLen[i + 1] - cumLen[i]);
      bestProj = proj;
      bestSegIdx = i;
    }
  }

  return {
    projection: bestProj,
    arcLenM: bestArcLen,
    distM: bestDistM,
    segIdx: bestSegIdx
  };
}

/**
 * Extract a sub-polyline between two arc length values (meters).
 * Follows actual road geometry (curves, bends).
 */
function extractSubPolyline(wayCoords, arcStart, arcEnd) {
  if (arcStart > arcEnd) [arcStart, arcEnd] = [arcEnd, arcStart];

  const cumLen = cumulativeLengths(wayCoords);
  const totalLen = cumLen[cumLen.length - 1];

  // Clamp to polyline bounds
  arcStart = Math.max(0, arcStart);
  arcEnd = Math.min(totalLen, arcEnd);

  if (arcEnd - arcStart < 0.1) return null;

  const result = [];
  let started = false;

  for (let i = 0; i < wayCoords.length - 1; i++) {
    const segStart = cumLen[i];
    const segEnd = cumLen[i + 1];
    const segLenM = segEnd - segStart;

    if (segEnd < arcStart - 0.01) continue;
    if (segStart > arcEnd + 0.01) break;

    const a = wayCoords[i];
    const b = wayCoords[i + 1];

    // Interpolate start point of extracted section
    if (!started && arcStart >= segStart - 0.01) {
      const t = segLenM > 0.01 ? Math.max(0, Math.min(1, (arcStart - segStart) / segLenM)) : 0;
      result.push([
        parseFloat((a[0] + t * (b[0] - a[0])).toFixed(7)),
        parseFloat((a[1] + t * (b[1] - a[1])).toFixed(7))
      ]);
      started = true;
    }

    // Add interior vertex b if it falls within range
    if (started && segEnd <= arcEnd + 0.01 && segEnd >= arcStart - 0.01) {
      const last = result[result.length - 1];
      if (!last || distM(last, b) > 0.5) {
        result.push([parseFloat(b[0].toFixed(7)), parseFloat(b[1].toFixed(7))]);
      }
    }

    // Interpolate end point
    if (arcEnd >= segStart - 0.01 && arcEnd <= segEnd + 0.01) {
      const t = segLenM > 0.01 ? Math.max(0, Math.min(1, (arcEnd - segStart) / segLenM)) : 1;
      const endPt = [
        parseFloat((a[0] + t * (b[0] - a[0])).toFixed(7)),
        parseFloat((a[1] + t * (b[1] - a[1])).toFixed(7))
      ];
      const last = result[result.length - 1];
      if (!last || distM(last, endPt) > 0.5) {
        result.push(endPt);
      }
      break;
    }
  }

  return result.length >= 2 ? result : null;
}

/**
 * Offset a polyline in a given direction (unit vector in meter space).
 * direction: { x, y } in meters, normalized
 * meters: offset distance
 */
function offsetPolylineInDirection(coords, dirX, dirY, meters) {
  return coords.map(coord => {
    const scaleX = mPerDegLng(coord[1]);
    return [
      parseFloat((coord[0] + dirX * meters / scaleX).toFixed(7)),
      parseFloat((coord[1] + dirY * meters / M_PER_DEG_LAT).toFixed(7))
    ];
  });
}

/**
 * Main snap function.
 * 
 * Projects each sign onto the OSM road, finds zone extent,
 * extracts road sub-geometry, offsets to curb.
 * 
 * Returns new coordinates or null if failed.
 */
function snapZoneToCurb(zone, wayCoords) {
  const signCoords = zone.geometry?.coordinates;
  if (!signCoords || signCoords.length === 0) return null;

  // Project each sign onto OSM road
  const projections = signCoords.map(coord => projectOnPolyline(wayCoords, coord));

  // Filter: only signs within reasonable distance
  const valid = projections.filter(p => p.distM <= MAX_SNAP_DIST_M && p.projection !== null);
  if (valid.length === 0) return null;

  // --- Zone extent on the road (arc length range) ---
  const arcLens = valid.map(p => p.arcLenM);
  let arcMin = Math.min(...arcLens);
  let arcMax = Math.max(...arcLens);

  // Enforce minimum zone length
  if (arcMax - arcMin < MIN_ZONE_LEN_M) {
    const mid = (arcMin + arcMax) / 2;
    arcMin = mid - MIN_ZONE_LEN_M / 2;
    arcMax = mid + MIN_ZONE_LEN_M / 2;
  }

  // --- Extract road sub-geometry between sign extent ---
  const roadSeg = extractSubPolyline(wayCoords, arcMin, arcMax);
  if (!roadSeg || roadSeg.length < 2) return null;

  // --- Determine offset direction from sign positions ---
  // Instead of relying on stored 'left'/'right' (which depends on LineString direction),
  // compute direction FROM road projection TO sign = actual curb direction.
  let sumDirX = 0, sumDirY = 0;

  for (let i = 0; i < signCoords.length; i++) {
    const proj = projections[i];
    if (!proj.projection || proj.distM > MAX_SNAP_DIST_M) continue;

    const sign = signCoords[i];
    const midLat = (sign[1] + proj.projection[1]) / 2;
    const scaleX = mPerDegLng(midLat);

    const dx = (sign[0] - proj.projection[0]) * scaleX; // meters east
    const dy = (sign[1] - proj.projection[1]) * M_PER_DEG_LAT; // meters north
    const d = Math.sqrt(dx * dx + dy * dy);

    if (d > 0.5) { // ignore signs that are basically on the centerline
      sumDirX += dx / d;
      sumDirY += dy / d;
    }
  }

  // For 'both' side: no offset (draw on road centerline)
  if (zone.side === 'both' || (!zone.side)) {
    return roadSeg;
  }

  const dirLen = Math.sqrt(sumDirX * sumDirX + sumDirY * sumDirY);

  let offsetDir;
  if (dirLen > 0.1) {
    // Use measured direction from sign positions
    offsetDir = { x: sumDirX / dirLen, y: sumDirY / dirLen };
  } else {
    // Fallback: use stored side relative to road tangent at midpoint
    // Find tangent of road at midpoint
    const midIdx = Math.floor(roadSeg.length / 2);
    const a = roadSeg[Math.max(0, midIdx - 1)];
    const b = roadSeg[Math.min(roadSeg.length - 1, midIdx + 1)];
    const scaleX = mPerDegLng((a[1] + b[1]) / 2);
    const tx = (b[0] - a[0]) * scaleX;
    const ty = (b[1] - a[1]) * M_PER_DEG_LAT;
    const tLen = Math.sqrt(tx * tx + ty * ty);
    if (tLen < 0.01) return roadSeg;

    // Perpendicular
    if (zone.side === 'right') {
      offsetDir = { x: ty / tLen, y: -tx / tLen }; // CW rotation
    } else {
      offsetDir = { x: -ty / tLen, y: tx / tLen }; // CCW rotation
    }
  }

  // --- Measure average curb distance ---
  const avgDistM = valid.reduce((s, p) => s + p.distM, 0) / valid.length;
  const curbDistM = Math.max(CURB_MIN_M, Math.min(CURB_MAX_M,
    isFinite(avgDistM) && avgDistM > 0.5 ? avgDistM : CURB_DEFAULT_M
  ));

  // --- Offset road geometry toward curb ---
  return offsetPolylineInDirection(roadSeg, offsetDir.x, offsetDir.y, curbDistM);
}

// ============ OVERPASS API ============

async function fetchOSM() {
  console.log('📡 Загрузка уличной геометрии из OpenStreetMap...');

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
        console.log(`   Повтор ${attempt}/2 для ${area.name}...`);
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
          allWays.push({ coords, name: el.tags.name });
          count++;
        }
        console.log(`   ✅ ${area.name}: ${count} улиц (всего: ${allWays.length})`);
        success = true;
      } catch (e) {
        console.log(`   ❌ ${area.name}: ${e.message}`);
      }
    }

    if (!success) console.log(`   ⚠️ Пропускаю ${area.name}`);
    await new Promise(r => setTimeout(r, 8000));
  }

  console.log(`\n   ✅ Итого улиц из OSM: ${allWays.length}`);
  return allWays;
}

// ============ STREET INDEX ============

function buildIndex(ways) {
  console.log('\n🗂️  Построение индекса...');
  const index = {};
  for (const way of ways) {
    const name = normalizeName(way.name);
    if (!name) continue;
    if (!index[name]) index[name] = [];
    index[name].push(way.coords);
  }
  console.log(`   ✅ ${Object.keys(index).length} уникальных улиц`);
  return index;
}

function findBestWay(zone, index) {
  const name = normalizeName(zone.streetName);
  const ways = index[name];
  if (!ways || ways.length === 0) return null;

  const zoneCenter = [zone.center.lng, zone.center.lat];
  let bestWay = null;
  let bestDist = Infinity;

  for (const wayCoords of ways) {
    // Use center projection for initial matching (fast)
    const p = projectOnPolyline(wayCoords, zoneCenter);
    if (p.distM < bestDist) {
      bestDist = p.distM;
      bestWay = wayCoords;
    }
  }

  return bestDist <= MAX_SNAP_DIST_M ? bestWay : null;
}

// ============ MAIN ============

async function main() {
  console.log('🗺️  ParkBro ASP Curb Alignment v3');
  console.log('   Алгоритм: проекция каждого знака → реальный диапазон блока →');
  console.log('             геометрия дороги → смещение к бордюру');
  if (DRY_RUN) console.log('   ⚠️  DRY RUN — база не изменена');
  console.log('');

  const ways = await fetchOSM();
  if (ways.length === 0) { console.error('❌ Нет данных OSM'); return; }

  const index = buildIndex(ways);

  console.log('\n📡 Подключение к MongoDB...');
  await mongoose.connect(MONGODB_URI);
  const zones = await ASPZone.find({}).lean();
  console.log(`   ✅ Зон в базе: ${zones.length}`);

  console.log('\n🔄 Обработка зон...');

  let matched = 0, unmatched = 0, errors = 0;
  const typeStats = {};
  const sideStats = {};

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];

    try {
      const bestWay = findBestWay(zone, index);
      if (!bestWay) { unmatched++; continue; }

      const newCoords = snapZoneToCurb(zone, bestWay);
      if (!newCoords || newCoords.length < 2) { unmatched++; continue; }

      // Compute new center
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
      const zt = zone.zoneType || 'asp';
      const sd = zone.side || 'both';
      typeStats[zt] = (typeStats[zt] || 0) + 1;
      sideStats[sd] = (sideStats[sd] || 0) + 1;

    } catch (e) {
      errors++;
      if (errors <= 5) console.log(`   Ошибка zone ${zone._id}: ${e.message}`);
    }

    if ((i + 1) % 5000 === 0) {
      const pct = Math.round(((i + 1) / zones.length) * 100);
      console.log(`   ${i + 1}/${zones.length} (${pct}%) — matched: ${matched}, unmatched: ${unmatched}, errors: ${errors}`);
    }
  }

  console.log(`\n✅ Готово:`);
  console.log(`   Обработано: ${zones.length}`);
  console.log(`   Обновлено:  ${matched}`);
  console.log(`   Не найдено (нет OSM): ${unmatched}`);
  console.log(`   Ошибки:     ${errors}`);
  console.log(`   По типам:   ${JSON.stringify(typeStats)}`);
  console.log(`   По сторонам: ${JSON.stringify(sideStats)}`);

  await mongoose.disconnect();
  console.log('\n📡 Отключено от MongoDB');
  if (DRY_RUN) console.log('⚠️  DRY RUN — ничего не записано');
}

main().catch(e => {
  console.error('\n❌ Критическая ошибка:', e);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
