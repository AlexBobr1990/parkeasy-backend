/**
 * ParkBro — Snap & Offset ALL ASP Zones to OSM Streets
 * 
 * 1. Fetches real street geometry from OpenStreetMap (Overpass API)
 * 2. Matches each zone to nearest OSM street by name + proximity
 * 3. Snaps zone line to follow road direction
 * 4. Offsets left/right sides ~4m from road centerline
 * 
 * REQUIRES: npm install proj4 mongoose
 * 
 * Usage:
 *   node --max-old-space-size=4096 asp-snap-osm.js
 *   node --max-old-space-size=4096 asp-snap-osm.js --dry-run
 */

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://parkingapp:wmoU4mDhWsRb4VaQ@eazypark.xhy0jyi.mongodb.net/parkingapp?retryWrites=true&w=majority';
const OFFSET_METERS = 4;
const DRY_RUN = process.argv.includes('--dry-run');

// ============ MONGOOSE SCHEMA ============
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

function centerOf(coords) {
  const n = coords.length;
  return [
    coords.reduce((s, c) => s + c[0], 0) / n,
    coords.reduce((s, c) => s + c[1], 0) / n
  ];
}

function nearestSegment(wayCoords, point) {
  let bestDist = Infinity;
  let bestSeg = 0;
  let bestProj = null;

  for (let i = 0; i < wayCoords.length - 1; i++) {
    const a = wayCoords[i];
    const b = wayCoords[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;

    let t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const proj = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.sqrt((point[0] - proj[0]) ** 2 + (point[1] - proj[1]) ** 2);

    if (d < bestDist) {
      bestDist = d;
      bestSeg = i;
      bestProj = proj;
    }
  }

  const a = wayCoords[bestSeg];
  const b = wayCoords[Math.min(bestSeg + 1, wayCoords.length - 1)];
  const bearing = Math.atan2(b[0] - a[0], b[1] - a[1]);

  return { segIdx: bestSeg, projection: bestProj, distance: bestDist, bearing };
}

function offsetLine(coords, bearingRad, side, meters) {
  const latCenter = coords[0][1];
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(latCenter * Math.PI / 180);

  let offsetLng, offsetLat;
  if (side === 'right') {
    offsetLng = Math.cos(bearingRad) * meters / mPerDegLng;
    offsetLat = -Math.sin(bearingRad) * meters / mPerDegLat;
  } else {
    offsetLng = -Math.cos(bearingRad) * meters / mPerDegLng;
    offsetLat = Math.sin(bearingRad) * meters / mPerDegLat;
  }

  return coords.map(([lng, lat]) => [
    Math.round((lng + offsetLng) * 1e7) / 1e7,
    Math.round((lat + offsetLat) * 1e7) / 1e7
  ]);
}

// Snap zone to OSM way: align direction, keep length, offset to side
function snapAndOffset(zoneCoords, wayCoords, side) {
  const zoneCenter = centerOf(zoneCoords);
  const nearest = nearestSegment(wayCoords, zoneCenter);

  // Zone length in degrees
  let zoneLen = 0;
  for (let i = 1; i < zoneCoords.length; i++) {
    const dx = zoneCoords[i][0] - zoneCoords[i - 1][0];
    const dy = zoneCoords[i][1] - zoneCoords[i - 1][1];
    zoneLen += Math.sqrt(dx * dx + dy * dy);
  }

  const mPerDeg = 111320;
  const zoneLenMeters = zoneLen * mPerDeg;
  const useLen = Math.max(zoneLenMeters, 15);
  const halfLenDeg = (useLen / 2) / mPerDeg;

  // Road direction at nearest segment
  const seg = wayCoords[nearest.segIdx];
  const segNext = wayCoords[Math.min(nearest.segIdx + 1, wayCoords.length - 1)];
  const dirLng = segNext[0] - seg[0];
  const dirLat = segNext[1] - seg[1];
  const dirLen = Math.sqrt(dirLng * dirLng + dirLat * dirLat);
  if (dirLen === 0) return null;

  const normLng = dirLng / dirLen;
  const normLat = dirLat / dirLen;

  // New line centered at projection, aligned with road
  const proj = nearest.projection;
  const newCoords = [
    [proj[0] - normLng * halfLenDeg, proj[1] - normLat * halfLenDeg],
    [proj[0] + normLng * halfLenDeg, proj[1] + normLat * halfLenDeg]
  ];

  if (!side || side === 'both') return newCoords;
  return offsetLine(newCoords, nearest.bearing, side, OFFSET_METERS);
}

// ============ OVERPASS API — FETCH OSM STREETS ============

async function fetchOSM() {
  console.log('📡 Загрузка уличной геометрии из OpenStreetMap...');

  const areas = [
    { name: 'Brooklyn', bbox: '40.57,-74.05,40.74,-73.83' },
    { name: 'Queens', bbox: '40.54,-73.96,40.80,-73.70' },
    { name: 'Manhattan', bbox: '40.70,-74.02,40.88,-73.90' },
    { name: 'Bronx', bbox: '40.79,-73.94,40.92,-73.75' },
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

        if (!resp.ok) {
          console.log(`   ⚠️ ${area.name}: HTTP ${resp.status}`);
          continue;
        }

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

    if (!success) console.log(`   ⚠️ Пропускаю ${area.name} после 3 попыток`);
    // Пауза между запросами — Overpass rate limit
    await new Promise(r => setTimeout(r, 8000));
  }

  console.log(`\n   ✅ Итого улиц из OSM: ${allWays.length}`);
  return allWays;
}

// ============ BUILD STREET INDEX ============

function buildIndex(ways) {
  console.log('\n🗂️  Построение индекса улиц...');
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

// ============ FIND BEST WAY ============

function findBestWay(zone, index) {
  const name = normalizeName(zone.streetName);
  const ways = index[name];
  if (!ways || ways.length === 0) return null;

  const zoneCenter = [zone.center.lng, zone.center.lat];

  let bestWay = null;
  let bestDist = Infinity;

  for (const wayCoords of ways) {
    const nearest = nearestSegment(wayCoords, zoneCenter);
    const distM = nearest.distance * 111320;
    if (distM < bestDist) {
      bestDist = distM;
      bestWay = wayCoords;
    }
  }

  // Max 100m distance
  if (bestDist > 100) return null;
  return bestWay;
}

// ============ MAIN ============

async function main() {
  console.log('🗺️  ParkBro ASP Snap & Offset (ALL zones via OSM)');
  console.log(`   Offset: ${OFFSET_METERS}m от центра дороги`);
  if (DRY_RUN) console.log('   ⚠️ DRY RUN — база не будет изменена');
  console.log('');

  // 1. OSM streets
  const ways = await fetchOSM();
  if (ways.length === 0) { console.error('❌ Нет данных OSM'); return; }

  // 2. Index
  const index = buildIndex(ways);

  // 3. MongoDB
  console.log('\n📡 Подключение к MongoDB...');
  await mongoose.connect(MONGODB_URI);
  const zones = await ASPZone.find({}).lean();
  console.log(`   ✅ Зон в базе: ${zones.length}`);

  // 4. Match, snap, offset
  console.log('\n🔄 Matching + snapping + offsetting...');

  let matched = 0, unmatched = 0, errors = 0;
  const sideStats = { left: 0, right: 0, both: 0 };
  const typeStats = { asp: 0, no_parking: 0, no_standing: 0, hydrant: 0, school: 0 };

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];

    try {
      const bestWay = findBestWay(zone, index);
      if (!bestWay) { unmatched++; continue; }

      const zoneCoords = zone.geometry?.coordinates;
      if (!zoneCoords || zoneCoords.length < 2) { unmatched++; continue; }

      const newCoords = snapAndOffset(zoneCoords, bestWay, zone.side);
      if (!newCoords || newCoords.length < 2) { unmatched++; continue; }

      const center = centerOf(newCoords);

      if (!DRY_RUN) {
        await ASPZone.updateOne({ _id: zone._id }, {
          $set: {
            'geometry.coordinates': newCoords,
            'center.lat': Math.round(center[1] * 1e7) / 1e7,
            'center.lng': Math.round(center[0] * 1e7) / 1e7
          }
        });
      }

      matched++;
      sideStats[zone.side || 'both'] = (sideStats[zone.side || 'both'] || 0) + 1;
      typeStats[zone.zoneType || 'asp'] = (typeStats[zone.zoneType || 'asp'] || 0) + 1;
    } catch (e) {
      errors++;
    }

    if ((i + 1) % 5000 === 0) {
      const pct = Math.round(((i + 1) / zones.length) * 100);
      console.log(`   ${i + 1}/${zones.length} (${pct}%) — matched: ${matched}, unmatched: ${unmatched}`);
    }
  }

  console.log(`\n   ✅ Обработано: ${zones.length}`);
  console.log(`   Matched & updated: ${matched}`);
  console.log(`   Unmatched (no OSM street): ${unmatched}`);
  console.log(`   Errors: ${errors}`);
  console.log(`   По сторонам: ${JSON.stringify(sideStats)}`);
  console.log(`   По типам: ${JSON.stringify(typeStats)}`);

  await mongoose.disconnect();
  console.log('\n📡 Отключено от MongoDB');
  console.log(DRY_RUN ? '⚠️ DRY RUN — ничего не записано' : '✅ Готово!');
}

main().catch(e => {
  console.error('\n❌ Критическая ошибка:', e);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
