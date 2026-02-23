/**
 * ParkBro — Migrate Non-ASP Zone Geometry
 * 
 * For no_parking, no_standing, school, hydrant zones:
 * - Keeps original short length (NOT stretched to full block)
 * - Offsets line to correct SIDE of road (~4m from centerline)
 * - Matches to nearest OSM street to get road direction
 * 
 * REQUIRES: npm install proj4
 * 
 * Usage:
 *   node --max-old-space-size=4096 migrate-asp-geometry.js
 */

const proj4 = require('proj4');

const PARKBRO_API = process.env.PARKBRO_API || 'https://api.park-bro.com';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ParkBro2026AdminKey';

const OFFSET_METERS = 4; // How far from centerline to place the line

// Normalize street name for matching
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

// Distance between two [lng, lat] points in meters
function distMeters(a, b) {
  const R = 6371000;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLng = (b[0] - a[0]) * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(a[1]*Math.PI/180) * Math.cos(b[1]*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

// Center of a coordinate array
function centerOf(coords) {
  const n = coords.length;
  return [
    coords.reduce((s, c) => s + c[0], 0) / n,
    coords.reduce((s, c) => s + c[1], 0) / n
  ];
}

// ============================================================
// Find nearest segment on an OSM way to a point
// Returns: { segIdx, projection [lng,lat], distance, bearing }
// ============================================================
function nearestSegment(wayCoords, point) {
  let bestDist = Infinity;
  let bestSeg = 0;
  let bestProj = null;
  
  for (let i = 0; i < wayCoords.length - 1; i++) {
    const a = wayCoords[i];
    const b = wayCoords[i + 1];
    
    // Project point onto segment a→b
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;
    
    let t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    
    const proj = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.sqrt((point[0] - proj[0])**2 + (point[1] - proj[1])**2);
    
    if (d < bestDist) {
      bestDist = d;
      bestSeg = i;
      bestProj = proj;
    }
  }
  
  // Bearing of the road at this segment
  const a = wayCoords[bestSeg];
  const b = wayCoords[bestSeg + 1];
  const bearing = Math.atan2(b[0] - a[0], b[1] - a[1]); // radians, from north
  
  return { segIdx: bestSeg, projection: bestProj, distance: bestDist, bearing };
}

// ============================================================
// Offset a line [lng, lat] by meters perpendicular to road bearing
// side: 'left' or 'right' (relative to road direction)
// ============================================================
function offsetLine(coords, bearingRad, side, meters) {
  // Convert meters to approximate degrees
  const latCenter = coords[0][1];
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(latCenter * Math.PI / 180);
  
  // Perpendicular to bearing:
  // Road direction vector: (sin(bearing), cos(bearing)) in (lng, lat) space
  // Right perpendicular: rotate 90° CW = (cos(bearing), -sin(bearing))
  // Left perpendicular: rotate 90° CCW = (-cos(bearing), sin(bearing))
  
  let offsetLng, offsetLat;
  if (side === 'right') {
    offsetLng = Math.cos(bearingRad) * meters / mPerDegLng;
    offsetLat = -Math.sin(bearingRad) * meters / mPerDegLat;
  } else {
    // left
    offsetLng = -Math.cos(bearingRad) * meters / mPerDegLng;
    offsetLat = Math.sin(bearingRad) * meters / mPerDegLat;
  }
  
  return coords.map(([lng, lat]) => [lng + offsetLng, lat + offsetLat]);
}

// ============================================================
// Snap zone coordinates to follow road direction
// Keeps original length, but aligns to road and offsets to side
// ============================================================
function snapAndOffset(zoneCoords, wayCoords, side) {
  const zoneCenter = centerOf(zoneCoords);
  const nearest = nearestSegment(wayCoords, zoneCenter);
  
  // Calculate zone length in degrees
  let zoneLen = 0;
  for (let i = 1; i < zoneCoords.length; i++) {
    const dx = zoneCoords[i][0] - zoneCoords[i-1][0];
    const dy = zoneCoords[i][1] - zoneCoords[i-1][1];
    zoneLen += Math.sqrt(dx * dx + dy * dy);
  }
  
  // If zone is very short (single point expanded), use ~15m
  const latCenter = zoneCenter[1];
  const mPerDeg = 111320;
  const zoneLenMeters = zoneLen * mPerDeg;
  const useLen = Math.max(zoneLenMeters, 15); // at least 15m
  const halfLenDeg = (useLen / 2) / mPerDeg;
  
  // Road direction at nearest segment
  const seg = wayCoords[nearest.segIdx];
  const segNext = wayCoords[nearest.segIdx + 1];
  const dirLng = segNext[0] - seg[0];
  const dirLat = segNext[1] - seg[1];
  const dirLen = Math.sqrt(dirLng * dirLng + dirLat * dirLat);
  
  if (dirLen === 0) return null;
  
  const normLng = dirLng / dirLen;
  const normLat = dirLat / dirLen;
  
  // Create new line centered at projection point, aligned with road
  const proj = nearest.projection;
  const newCoords = [
    [proj[0] - normLng * halfLenDeg, proj[1] - normLat * halfLenDeg],
    [proj[0] + normLng * halfLenDeg, proj[1] + normLat * halfLenDeg]
  ];
  
  // Offset to correct side
  const effectiveSide = side || 'right';
  if (effectiveSide === 'both') {
    return newCoords; // keep on center
  }
  
  return offsetLine(newCoords, nearest.bearing, effectiveSide, OFFSET_METERS);
}

// ============================================================
// Fetch OSM street geometry
// ============================================================
async function fetchOSM() {
  console.log('📡 Fetching NYC street geometry from OpenStreetMap...');
  
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
      way["highway"~"^(residential|tertiary|secondary|primary|trunk)$"]["name"];
      out geom;
    `;
    
    let success = false;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      if (attempt > 0) {
        console.log(`   Retry ${attempt}/2 for ${area.name}...`);
        await new Promise(r => setTimeout(r, 10000));
      }
      
      try {
        const server = attempt < 2 ? 'https://overpass-api.de/api/interpreter' : 'https://overpass.kumi.systems/api/interpreter';
        const resp = await fetch(server, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        
        if (!resp.ok) {
          console.log(`   ⚠️ ${area.name}: ${resp.status}`);
          continue;
        }
        
        const data = await resp.json();
        for (const el of (data.elements || [])) {
          if (el.type !== 'way' || !el.geometry || !el.tags?.name) continue;
          const coords = el.geometry.map(p => [p.lon, p.lat]);
          if (coords.length < 2) continue;
          allWays.push({ coords, name: el.tags.name });
        }
        console.log(`   ✅ ${area.name}: +${data.elements?.length || 0} ways (total: ${allWays.length})`);
        success = true;
      } catch (e) {
        console.log(`   ❌ ${area.name}: ${e.message}`);
      }
    }
    
    if (!success) console.log(`   ⚠️ Skipping ${area.name} after 3 attempts`);
    await new Promise(r => setTimeout(r, 5000));
  }
  
  console.log(`\n   ✅ Total street ways: ${allWays.length}`);
  return allWays;
}

// ============================================================
// Build spatial index: street name → list of ways with coords
// ============================================================
function buildIndex(ways) {
  console.log('🗂️  Building street index...');
  const index = {};
  
  for (const way of ways) {
    const name = normalizeName(way.name);
    if (!name) continue;
    if (!index[name]) index[name] = [];
    index[name].push(way.coords);
  }
  
  console.log(`   ✅ ${Object.keys(index).length} unique streets`);
  return index;
}

// ============================================================
// Find best matching OSM way for a zone
// ============================================================
function findBestWay(zone, index) {
  const name = normalizeName(zone.streetName);
  const ways = index[name];
  if (!ways || ways.length === 0) return null;
  
  const zoneCenter = [zone.center.lng, zone.center.lat];
  
  let bestWay = null;
  let bestDist = Infinity;
  
  for (const wayCoords of ways) {
    const nearest = nearestSegment(wayCoords, zoneCenter);
    const distM = nearest.distance * 111320; // rough deg to m
    if (distM < bestDist) {
      bestDist = distM;
      bestWay = wayCoords;
    }
  }
  
  // Max 100m distance
  if (bestDist > 100) return null;
  
  return bestWay;
}

// ============================================================
// Fetch zones from ParkBro
// ============================================================
async function fetchZones() {
  console.log('📡 Fetching zones from ParkBro...');
  const resp = await fetch(`${PARKBRO_API}/api/admin/asp/all-zones`, {
    headers: { 'x-admin-secret': ADMIN_SECRET }
  });
  const data = await resp.json();
  if (!data.success) {
    console.error('   ❌', data.message);
    return [];
  }
  console.log(`   ✅ ${data.zones.length} total zones in DB`);
  
  // Only non-ASP zones
  const newZones = data.zones.filter(z => z.zoneType && z.zoneType !== 'asp');
  console.log(`   🔧 ${newZones.length} non-ASP zones to migrate (skipping ${data.zones.length - newZones.length} ASP zones)`);
  return newZones;
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('🗺️  ParkBro Zone Geometry Migration (non-ASP)');
  console.log(`   API: ${PARKBRO_API}`);
  console.log(`   Offset: ${OFFSET_METERS}m from road center`);
  console.log('');
  
  // Step 1: Fetch OSM streets
  const ways = await fetchOSM();
  if (ways.length === 0) return;
  
  // Step 2: Build index
  console.log('');
  const index = buildIndex(ways);
  
  // Step 3: Fetch zones
  console.log('');
  const zones = await fetchZones();
  if (zones.length === 0) return;
  
  // Step 4: Match, snap, offset
  console.log('');
  console.log('🔄 Matching zones to streets and offsetting...');
  
  let matched = 0, unmatched = 0;
  const updates = [];
  const sideStats = { left: 0, right: 0, both: 0 };
  
  for (const zone of zones) {
    const bestWay = findBestWay(zone, index);
    if (!bestWay) { unmatched++; continue; }
    
    const zoneCoords = zone.geometry?.coordinates;
    if (!zoneCoords || zoneCoords.length < 2) { unmatched++; continue; }
    
    const newCoords = snapAndOffset(zoneCoords, bestWay, zone.side);
    if (!newCoords || newCoords.length < 2) { unmatched++; continue; }
    
    matched++;
    sideStats[zone.side || 'both']++;
    
    const center = centerOf(newCoords);
    updates.push({
      zoneId: zone._id,
      geometry: { type: 'LineString', coordinates: newCoords },
      center: { lat: center[1], lng: center[0] }
    });
  }
  
  console.log(`   Matched: ${matched}, Unmatched: ${unmatched}`);
  console.log(`   Sides: left=${sideStats.left}, right=${sideStats.right}, both=${sideStats.both}`);
  
  // Step 5: Send updates
  console.log('');
  console.log(`📤 Updating ${updates.length} zones...`);
  
  const BATCH = 50;
  let updated = 0, errors = 0;
  
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    try {
      const resp = await fetch(`${PARKBRO_API}/api/admin/asp/update-geometries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
        body: JSON.stringify({ updates: batch })
      });
      const r = await resp.json();
      updated += r.updated || 0;
      errors += r.errors || 0;
      const pct = Math.round(Math.min(((i + BATCH) / updates.length) * 100, 100));
      process.stdout.write(`   Batch ${Math.floor(i/BATCH)+1}/${Math.ceil(updates.length/BATCH)}: +${r.updated} (${pct}%)\n`);
    } catch (e) {
      console.error(`   Batch error: ${e.message}`);
      errors += batch.length;
    }
  }
  
  console.log('');
  console.log('✅ Migration complete!');
  console.log(`   Updated: ${updated}`);
  console.log(`   Unmatched: ${unmatched}`);
  console.log(`   Errors: ${errors}`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
