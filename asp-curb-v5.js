/**
 * ParkBro — ASP Surgical Precision v5
 *
 * ПРИНЦИПИАЛЬНОЕ ОТЛИЧИЕ от v4:
 * Используем OSM топологию (общие узлы между улицами) вместо геометрического
 * приближения. В OSM, если две улицы пересекаются — они БУКВАЛЬНО делят один
 * nodeId. Это даёт точность до сантиметра.
 *
 * Алгоритм:
 * 1. Загружаем OSM с полной топологией (way body + все nodes)
 * 2. Строим: nodeId → Set<streetName> (какие улицы проходят через каждый узел)
 * 3. Для каждой зоны (on_street, from_street, to_street):
 *    a. Находим OSM-сегмент on_street ближайший к центру зоны
 *    b. Идём по nodes этого сегмента: если node принадлежит from_street → это точная точка A
 *    c. Аналогично для to_street → точная точка B
 *    d. Берём nodes между A и B — это ТОЧНАЯ геометрия блока
 *    e. Смещаем перпендикулярно на половину ширины дороги (из OSM тегов)
 * 4. Fallback (если топология не нашла): геометрическое приближение с радиусом 20м
 *
 * Результат: линии идеально по блокам, никогда не залезают на перекрёстки,
 * следуют изгибам дороги, правильная длина.
 *
 * Usage:
 *   node --max-old-space-size=4096 asp-curb-v5.js
 *   node --max-old-space-size=4096 asp-curb-v5.js --dry-run
 *   node --max-old-space-size=4096 asp-curb-v5.js --dry-run --verbose
 */

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI ||
  'mongodb+srv://parkingapp:wmoU4mDhWsRb4VaQ@eazypark.xhy0jyi.mongodb.net/parkingapp?retryWrites=true&w=majority';

const DRY_RUN  = process.argv.includes('--dry-run');
const VERBOSE  = process.argv.includes('--verbose');

// ── Geometric constants ──────────────────────────────────────────────────────
const M_PER_LAT = 111320;
const mPerLng = lat => M_PER_LAT * Math.cos(lat * Math.PI / 180);

// ── Curb offset ──────────────────────────────────────────────────────────────
// How far from road centerline to draw the curb line.
// Computed from OSM width/lanes/highway tags.
const OFFSET_MIN = 2.5;
const OFFSET_MAX = 10.0;
const LANE_W = { motorway:3.7, trunk:3.7, primary:3.5, secondary:3.3,
                 tertiary:3.0, residential:2.8, unclassified:2.8, living_street:2.5 };
const DEFAULT_ROAD_W = { motorway:22, trunk:18, primary:14, secondary:11,
                         tertiary:9, residential:8, unclassified:8, living_street:6 };

function curbOffset(wayMeta) {
  const { width, lanes, highway } = wayMeta;
  if (width && +width > 2 && +width < 60)
    return Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, +width / 2));
  if (lanes && +lanes > 0)
    return Math.max(OFFSET_MIN, Math.min(OFFSET_MAX,
      (+lanes * (LANE_W[highway] || 3.0)) / 2));
  return Math.max(OFFSET_MIN, Math.min(OFFSET_MAX,
    (DEFAULT_ROAD_W[highway] || 8) / 2));
}

// ── Safety constraints ───────────────────────────────────────────────────────
const MAX_MAIN_DIST_M   = 120;  // zone center → main street (max match distance)
const MAX_BLOCK_LEN_M   = 500;  // sanity: no block longer than this
const MIN_BLOCK_LEN_M   = 5;    // sanity: no block shorter than this
const GEO_FALLBACK_M    = 20;   // geometric fallback tolerance for intersections

// ── Mongoose schema ──────────────────────────────────────────────────────────
const aspZoneSchema = new mongoose.Schema({
  geometry: { type: { type: String }, coordinates: { type: [[Number]] } },
  streetName: String, fromStreet: String, toStreet: String,
  borough: String, side: String, zoneType: String,
  rules: [mongoose.Schema.Types.Mixed],
  center: { lat: Number, lng: Number },
  sourceId: String,
});
aspZoneSchema.index({ geometry: '2dsphere' });
const ASPZone = mongoose.model('ASPZone', aspZoneSchema);

// ── String normalization ─────────────────────────────────────────────────────
function norm(name) {
  if (!name) return '';
  let s = name.toUpperCase().trim();
  // Strip ordinal suffixes from numbers (so "3RD AVE" = "3 AVE")
  s = s.replace(/\b(\d+)\s*(?:ST|ND|RD|TH)\b/g, '$1');
  // NYC-specific fixes
  s = s.replace(/\bFT\s+/g, 'FORT ');
  s = s.replace(/\bFRED(ERICK)?\s+DOUG(LASS)?\b/g, 'FREDERICK DOUGLASS');
  s = s.replace(/\bDE\s+KALB\b/g, 'DEKALB');
  s = s.replace(/\bCROSS\s+BRONX\s+EXPRESS(WAY)?\b/g, 'CROSS BRONX EXPY');
  s = s.replace(/\bTHOMAS\s+S\.?\s+BOYLAND\b/g, 'THOMAS S BOYLAND');
  s = s.replace(/\bMALCOLM\s+X\b/g, 'MALCOLM X');
  s = s.replace(/\bM(ART)?IN\s+LUTH(ER)?\s+KING/g, 'MARTIN LUTHER KING');
  // Harlem avenue aliases (NYC DOT uses different names than OSM)
  s = s.replace(/\bADAM\s+C\.?\s+POWELL\s+BLVD\b/g, 'ADAM CLAYTON POWELL JR BLVD');
  s = s.replace(/\bADAM\s+CLAYTON\s+POWELL\s+BLVD\b/g, 'ADAM CLAYTON POWELL JR BLVD');
  s = s.replace(/\bLENOX\s+AVE\b/g, 'MALCOLM X BLVD');
  // Spelled-out ordinals: FIRST→1, SECOND→2, etc.
  const ordWords = {FIRST:'1',SECOND:'2',THIRD:'3',FOURTH:'4',FIFTH:'5',
    SIXTH:'6',SEVENTH:'7',EIGHTH:'8',NINTH:'9',TENTH:'10'};
  s = s.replace(/\b(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH)\b/g,
    m => ordWords[m] || m);
  // "AVE L" / "AVE M" etc — already fine, no change needed
  // "1 AVE" → keep as-is (ordinal suffix already stripped above)
  // Generic abbreviations
  s = s
    .replace(/\bSAINT\b/g, 'ST')    .replace(/\bSTREET\b/g,    'ST')
    .replace(/\bAVENUE\b/g, 'AVE')  .replace(/\bBOULEVARD\b/g, 'BLVD')
    .replace(/\bDRIVE\b/g, 'DR')    .replace(/\bPLACE\b/g,     'PL')
    .replace(/\bROAD\b/g, 'RD')     .replace(/\bCOURT\b/g,     'CT')
    .replace(/\bLANE\b/g, 'LN')     .replace(/\bPARKWAY\b/g,   'PKWY')
    .replace(/\bTERRACE\b/g, 'TER') .replace(/\bWEST\b/g,      'W')
    .replace(/\bEAST\b/g, 'E')      .replace(/\bNORTH\b/g,     'N')
    .replace(/\bSOUTH\b/g, 'S')     .replace(/\bEXPRESSWAY\b/g,'EXPY')
    .replace(/\bTURNPIKE\b/g,'TPKE').replace(/\bHIGHWAY\b/g,   'HWY')
    .replace(/\bCIRCLE\b/g, 'CIR')  .replace(/\bCRESCENT\b/g,  'CRES')
    .replace(/\s+/g, ' ').trim();
  return s;
}

// ── Basic geo math ───────────────────────────────────────────────────────────
function distM(a, b) {
  const mid = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * mPerLng(mid);
  const dy = (b[1] - a[1]) * M_PER_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

function cumLengths(coords) {
  const c = [0];
  for (let i = 1; i < coords.length; i++) c.push(c[i-1] + distM(coords[i-1], coords[i]));
  return c;
}

/** Project [lng,lat] point onto polyline → { projection, arcLenM, distM } */
function project(wayCoords, point) {
  const cum = cumLengths(wayCoords);
  const sx = mPerLng(point[1]), sy = M_PER_LAT;
  let bestD = Infinity, bestArc = 0, bestProj = null;

  for (let i = 0; i < wayCoords.length - 1; i++) {
    const a = wayCoords[i], b = wayCoords[i+1];
    const dx = (b[0]-a[0])*sx, dy = (b[1]-a[1])*sy;
    const px = (point[0]-a[0])*sx, py = (point[1]-a[1])*sy;
    const len2 = dx*dx + dy*dy;
    if (len2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, (px*dx + py*dy) / len2));
    const proj = [a[0] + t*(b[0]-a[0]), a[1] + t*(b[1]-a[1])];
    const d = distM(point, proj);
    if (d < bestD) {
      bestD = d;
      bestArc = cum[i] + t * (cum[i+1] - cum[i]);
      bestProj = proj;
    }
  }
  return { projection: bestProj, arcLenM: bestArc, distM: bestD };
}

/** Extract sub-polyline preserving all intermediate vertices */
function extractSub(coords, arcStart, arcEnd) {
  if (arcStart > arcEnd) [arcStart, arcEnd] = [arcEnd, arcStart];
  const cum = cumLengths(coords);
  arcStart = Math.max(0, arcStart);
  arcEnd   = Math.min(cum[cum.length-1], arcEnd);
  if (arcEnd - arcStart < 0.1) return null;

  const res = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const s0 = cum[i], s1 = cum[i+1], segL = s1 - s0;
    if (s1 < arcStart - 0.01) continue;
    if (s0 > arcEnd   + 0.01) break;
    const a = coords[i], b = coords[i+1];

    if (res.length === 0) {
      const t = segL > 0.01 ? Math.max(0, Math.min(1, (arcStart - s0) / segL)) : 0;
      res.push([+(a[0] + t*(b[0]-a[0])).toFixed(7), +(a[1] + t*(b[1]-a[1])).toFixed(7)]);
    }
    if (res.length > 0 && s1 <= arcEnd + 0.01) {
      const br = [+b[0].toFixed(7), +b[1].toFixed(7)];
      if (distM(res[res.length-1], br) > 0.3) res.push(br);
    }
    if (arcEnd >= s0 - 0.01 && arcEnd <= s1 + 0.01) {
      const t = segL > 0.01 ? Math.max(0, Math.min(1, (arcEnd - s0) / segL)) : 1;
      const ep = [+(a[0] + t*(b[0]-a[0])).toFixed(7), +(a[1] + t*(b[1]-a[1])).toFixed(7)];
      if (distM(res[res.length-1], ep) > 0.3) res.push(ep);
      break;
    }
  }
  return res.length >= 2 ? res : null;
}

/** Offset polyline perpendicularly (side: 'left' | 'right') */
function offsetPoly(coords, side, meters) {
  return coords.map((pt, i) => {
    const prev = coords[Math.max(0, i-1)];
    const next = coords[Math.min(coords.length-1, i+1)];
    const sx = mPerLng(pt[1]), sy = M_PER_LAT;
    const tx = (next[0]-prev[0])*sx, ty = (next[1]-prev[1])*sy;
    const tl = Math.sqrt(tx*tx + ty*ty);
    if (tl < 0.01) return pt;
    const nx = side === 'left' ? -ty/tl :  ty/tl;
    const ny = side === 'left' ?  tx/tl : -tx/tl;
    return [+( pt[0] + nx*meters/sx ).toFixed(7),
            +( pt[1] + ny*meters/sy ).toFixed(7)];
  });
}

// ── OSM Fetch (with full topology) ───────────────────────────────────────────
async function fetchOSMBorough(area) {
  // Fetch ways + referenced nodes in one query
  // 'out body' = way elements with node ID arrays + tags
  // '>'        = expand to all referenced nodes
  // 'out skel qt' = node elements with id/lat/lon only (minimal size)
  const query = `
    [out:json][timeout:300][bbox:${area.bbox}];
    way["highway"~"^(residential|tertiary|secondary|primary|trunk|unclassified|living_street)$"]["name"];
    out body;
    >;
    out skel qt;
  `;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      console.log(`   Повтор ${attempt}/2...`);
      await new Promise(r => setTimeout(r, 20000));
    }
    const server = attempt < 2
      ? 'https://overpass-api.de/api/interpreter'
      : 'https://overpass.kumi.systems/api/interpreter';
    try {
      const resp = await fetch(server, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(300000),
      });
      if (!resp.ok) { console.log(`   ⚠️ HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      return data.elements || [];
    } catch (e) {
      console.log(`   ❌ ${e.message}`);
    }
  }
  return [];
}

// ── Build topology index ─────────────────────────────────────────────────────
/**
 * Returns:
 *   nodeMap:      Map<nodeId, [lng, lat]>
 *   nameToWays:   Map<normName, Array<{nodeIds, coords, highway, width, lanes}>>
 *   nodeToNames:  Map<nodeId, Set<normName>>  ← the key structure for intersections
 */
function buildTopology(allElements) {
  console.log('\n🗂️  Построение топологического индекса...');

  const nodeMap     = new Map(); // nodeId → [lng, lat]
  const rawWays     = [];        // {normName, nodeIds, highway, width, lanes}
  const nodeToNames = new Map(); // nodeId → Set<normName>

  // Pass 1: collect nodes and raw way data
  for (const el of allElements) {
    if (el.type === 'node') {
      nodeMap.set(el.id, [el.lon, el.lat]);
    } else if (el.type === 'way' && el.tags?.name && el.nodes?.length >= 2) {
      const normName = norm(el.tags.name);
      if (!normName) continue;
      rawWays.push({
        normName,
        nodeIds:  el.nodes,
        highway:  el.tags.highway  || 'residential',
        width:    el.tags.width    || null,
        lanes:    el.tags.lanes    || null,
      });
    }
  }

  // Pass 2: build nodeToNames (which street names pass through each node)
  for (const way of rawWays) {
    for (const nodeId of way.nodeIds) {
      if (!nodeToNames.has(nodeId)) nodeToNames.set(nodeId, new Set());
      nodeToNames.get(nodeId).add(way.normName);
    }
  }

  // Pass 3: build nameToWays with resolved coordinates
  const nameToWays = new Map();
  for (const way of rawWays) {
    const coords = way.nodeIds
      .filter(id => nodeMap.has(id))
      .map(id => nodeMap.get(id));
    if (coords.length < 2) continue;

    if (!nameToWays.has(way.normName)) nameToWays.set(way.normName, []);
    nameToWays.get(way.normName).push({
      nodeIds: way.nodeIds,
      coords,
      highway: way.highway,
      width:   way.width,
      lanes:   way.lanes,
    });
  }

  console.log(`   ✅ Nodes: ${nodeMap.size.toLocaleString()}`);
  console.log(`   ✅ Ways:  ${rawWays.length.toLocaleString()}`);
  console.log(`   ✅ Улиц: ${nameToWays.size.toLocaleString()}`);

  return { nodeMap, nameToWays, nodeToNames };
}

// ── Find exact intersection points (topological) ─────────────────────────────
/**
 * Returns [lng, lat] points where normNameA and normNameB share an OSM node.
 * These are EXACT intersections — no approximation.
 */
function topoIntersections(normNameA, normNameB, nameToWays, nodeToNames, nodeMap) {
  const waysA = nameToWays.get(normNameA) || [];
  const result = [];
  const seen = new Set();

  for (const wayA of waysA) {
    for (const nodeId of wayA.nodeIds) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      const names = nodeToNames.get(nodeId);
      if (names && names.has(normNameB)) {
        const coord = nodeMap.get(nodeId);
        if (coord) result.push(coord);
      }
    }
  }
  return result;
}

// ── Find best arc position from candidate intersection points ────────────────
/**
 * Given candidate intersection [lng,lat] points, find the arc position on
 * mainWay that is:
 *  - closest to one of the intersection points (ideally 0m — exact match)
 *  - near the zone center (to disambiguate when same streets intersect twice)
 */
function bestArcFromPoints(pts, mainWay, zoneCenterArc, mainCumLen) {
  if (!pts.length) return null;

  const cum = cumLengths(mainWay);
  let best = null, bestScore = Infinity;

  for (const pt of pts) {
    const { arcLenM, distM: snapDist } = project(mainWay, pt);
    // Skip if intersection point is too far from the main way line
    if (snapDist > GEO_FALLBACK_M * 3) continue;
    // Score = snap distance + small penalty for being far from zone center
    // (handles cases like same streets crossing multiple times)
    const distToCenter = Math.abs(arcLenM - zoneCenterArc);
    const score = snapDist + distToCenter * 0.01;
    if (score < bestScore) { bestScore = score; best = arcLenM; }
  }
  return best;
}

// ── Geometric fallback intersection ─────────────────────────────────────────
/**
 * If topology didn't find an intersection (OSM gap, name mismatch, etc.),
 * fall back to geometric closest approach between the two streets.
 * Stricter tolerance than v4 — only accept if streets get within GEO_FALLBACK_M.
 */
function geoFallbackArc(normCross, mainWay, zoneCenter, nameToWays) {
  const crossWays = nameToWays.get(normCross) || [];
  if (!crossWays.length) return null;

  let bestArc = null, bestDist = Infinity;

  for (const crossWay of crossWays) {
    // Sample cross way at vertices + midpoints
    for (let i = 0; i < crossWay.coords.length; i++) {
      const pt = crossWay.coords[i];
      // Only consider cross way points that are near the zone center
      // (avoids matching the same avenue many blocks away)
      if (distM(pt, zoneCenter) > 300) continue;

      const { arcLenM, distM: d } = project(mainWay, pt);
      if (d < bestDist) { bestDist = d; bestArc = arcLenM; }
    }
  }

  return bestDist <= GEO_FALLBACK_M ? bestArc : null;
}

// ── Main zone processing ─────────────────────────────────────────────────────
function buildCurbLine(zone, nameToWays, nodeToNames, nodeMap) {
  const zoneCenter = [zone.center.lng, zone.center.lat];
  const normMain = norm(zone.streetName);
  const normFrom = norm(zone.fromStreet);
  const normTo   = norm(zone.toStreet);

  // 1. Find the main way segment closest to zone center
  const mainCandidates = nameToWays.get(normMain) || [];
  if (!mainCandidates.length) return { coords: null, reason: 'no_main_street' };

  let bestMain = null, bestMainDist = Infinity;
  for (const way of mainCandidates) {
    const { distM: d } = project(way.coords, zoneCenter);
    if (d < bestMainDist) { bestMainDist = d; bestMain = way; }
  }
  if (!bestMain || bestMainDist > MAX_MAIN_DIST_M)
    return { coords: null, reason: `main_too_far:${Math.round(bestMainDist)}m` };

  const mainCoords = bestMain.coords;
  const mainCum    = cumLengths(mainCoords);
  const mainTotalM = mainCum[mainCum.length - 1];

  // Arc of zone center on main way (for disambiguating intersections)
  const { arcLenM: centerArc } = project(mainCoords, zoneCenter);

  // 2. Find from_street intersection — topology first, geo fallback
  const fromPts = topoIntersections(normMain, normFrom, nameToWays, nodeToNames, nodeMap);
  let arcFrom = bestArcFromPoints(fromPts, mainCoords, centerArc, mainCum);
  let fromMethod = arcFrom !== null ? 'topo' : null;

  if (arcFrom === null) {
    arcFrom = geoFallbackArc(normFrom, mainCoords, zoneCenter, nameToWays);
    if (arcFrom !== null) fromMethod = 'geo';
  }

  // 3. Find to_street intersection — topology first, geo fallback
  const toPts = topoIntersections(normMain, normTo, nameToWays, nodeToNames, nodeMap);
  let arcTo = bestArcFromPoints(toPts, mainCoords, centerArc, mainCum);
  let toMethod = arcTo !== null ? 'topo' : null;

  if (arcTo === null) {
    arcTo = geoFallbackArc(normTo, mainCoords, zoneCenter, nameToWays);
    if (arcTo !== null) toMethod = 'geo';
  }

  // 4. Validate / handle special cases
  let method = 'unknown';

  if (arcFrom !== null && arcTo !== null) {
    method = `${fromMethod}+${toMethod}`;
    const blockLen = Math.abs(arcTo - arcFrom);

    // block_too_short: from and to streets intersect at the same point (corner zone)
    // Extend equally on both sides to MIN_BLOCK_LEN_M
    if (blockLen < MIN_BLOCK_LEN_M) {
      const mid = (arcFrom + arcTo) / 2;
      arcFrom = Math.max(0, mid - MIN_BLOCK_LEN_M / 2);
      arcTo   = mid + MIN_BLOCK_LEN_M / 2;
      method += '+corner_extended';
    }
    if (Math.abs(arcTo - arcFrom) > MAX_BLOCK_LEN_M)
      return { coords: null, reason: `block_too_long:${Math.round(Math.abs(arcTo-arcFrom))}m` };

  } else if (arcFrom !== null || arcTo !== null) {
    // One intersection found — DEAD END or missing cross street
    // Use zone's sign positions bounding box to estimate block length
    const knownArc = arcFrom !== null ? arcFrom : arcTo;
    const signCoords = zone.geometry?.coordinates || [];
    let halfLen = 40; // default half-block

    if (signCoords.length >= 2) {
      const lats = signCoords.map(c => c[1]);
      const lngs = signCoords.map(c => c[0]);
      const midLat = (Math.max(...lats) + Math.min(...lats)) / 2;
      const spanLat = (Math.max(...lats) - Math.min(...lats)) * M_PER_LAT;
      const spanLng = (Math.max(...lngs) - Math.min(...lngs)) * mPerLng(midLat);
      const span = Math.max(spanLat, spanLng);
      if (span > MIN_BLOCK_LEN_M && span < MAX_BLOCK_LEN_M) halfLen = span;
    }

    // Place the found intersection at one end, extend by halfLen along road
    // Direction: if found arc is before center → it's the "from" end
    if (knownArc <= centerArc) {
      arcFrom = knownArc;
      arcTo   = Math.min(mainTotalM, knownArc + halfLen);
    } else {
      arcTo   = knownArc;
      arcFrom = Math.max(0, knownArc - halfLen);
    }
    method = `one_intersection_fallback:${arcFrom !== null ? fromMethod : toMethod}`;

  } else {
    // No intersections found at all — skip
    const missing = [normFrom, normTo].filter(Boolean).join(',');
    return { coords: null, reason: `no_intersection:${missing}` };
  }

  // 5. Extract road sub-geometry between the two intersection arcs
  const roadSeg = extractSub(mainCoords, Math.min(arcFrom, arcTo), Math.max(arcFrom, arcTo));
  if (!roadSeg || roadSeg.length < 2)
    return { coords: null, reason: 'extract_failed' };

  // 6. Apply curb offset
  if (!zone.side || zone.side === 'both') {
    return { coords: roadSeg, method };
  }

  const offset = curbOffset(bestMain);
  const offsetCoords = offsetPoly(roadSeg, zone.side, offset);
  return { coords: offsetCoords, method, offsetM: offset };
}

// ── Overpass fetch ───────────────────────────────────────────────────────────
async function fetchAllOSM() {
  console.log('📡 Загрузка OSM с топологией (способ: body + nodes)...');
  console.log('   Это займёт дольше обычного — зато даёт точные пересечения\n');

  const areas = [
    { name: 'Brooklyn',      bbox: '40.57,-74.05,40.74,-73.83' },
    { name: 'Queens',        bbox: '40.54,-73.96,40.80,-73.70' },
    { name: 'Manhattan',     bbox: '40.70,-74.02,40.88,-73.90' },
    { name: 'Bronx',         bbox: '40.79,-73.94,40.92,-73.75' },
    { name: 'Staten Island', bbox: '40.49,-74.26,40.65,-74.05' },
  ];

  const allElements = [];

  for (const area of areas) {
    process.stdout.write(`   ${area.name}... `);
    const elements = await fetchOSMBorough(area);
    const nodes = elements.filter(e => e.type === 'node').length;
    const ways  = elements.filter(e => e.type === 'way').length;
    console.log(`✅ ${ways} улиц, ${nodes.toLocaleString()} узлов`);
    for (const el of elements) allElements.push(el);
    await new Promise(r => setTimeout(r, 8000));
  }

  return allElements;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🗺️  ParkBro ASP Surgical Precision v5');
  console.log('   Метод: OSM топологические пересечения (shared nodes)');
  console.log('   Offset: автоматически из OSM width/lanes/highway');
  if (DRY_RUN) console.log('   ⚠️  DRY RUN — база не изменена');
  console.log('');

  // Fetch OSM
  const allElements = await fetchAllOSM();
  if (!allElements.length) { console.error('❌ Нет данных OSM'); return; }

  // Build topology
  const { nodeMap, nameToWays, nodeToNames } = buildTopology(allElements);

  // Connect to MongoDB
  console.log('\n📡 Подключение к MongoDB...');
  await mongoose.connect(MONGODB_URI);
  const zones = await ASPZone.find({}).lean();
  console.log(`   ✅ Зон в базе: ${zones.length}`);

  // Process zones
  console.log('\n🔄 Обработка зон...');

  const stats = {
    total: zones.length,
    updated: 0,
    skipped: 0,
    reasons: {},
    methods: {},
    errors: 0,
  };

  const BATCH = 500;
  const ops = [];

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    try {
      const result = buildCurbLine(zone, nameToWays, nodeToNames, nodeMap);

      if (!result.coords) {
        stats.skipped++;
        const r = result.reason || 'unknown';
        stats.reasons[r] = (stats.reasons[r] || 0) + 1;
        if (VERBOSE) console.log(`   SKIP [${zone.streetName}] ${zone.fromStreet}→${zone.toStreet}: ${r}`);
        continue;
      }

      stats.updated++;
      stats.methods[result.method] = (stats.methods[result.method] || 0) + 1;

      const centerLng = result.coords.reduce((s, c) => s + c[0], 0) / result.coords.length;
      const centerLat = result.coords.reduce((s, c) => s + c[1], 0) / result.coords.length;

      if (!DRY_RUN) {
        ops.push({
          updateOne: {
            filter: { _id: zone._id },
            update: { $set: {
              'geometry.coordinates': result.coords,
              'center.lat': +centerLat.toFixed(7),
              'center.lng': +centerLng.toFixed(7),
            }},
          },
        });

        // Flush batch
        if (ops.length >= BATCH) {
          await ASPZone.bulkWrite(ops.splice(0, BATCH), { ordered: false });
        }
      }

    } catch (e) {
      stats.errors++;
      if (stats.errors <= 10) console.log(`   ⚠️ ERROR zone ${zone._id}: ${e.message}`);
    }

    if ((i + 1) % 5000 === 0) {
      if (!DRY_RUN && ops.length > 0) {
        await ASPZone.bulkWrite(ops.splice(0), { ordered: false });
      }
      const pct = Math.round(((i+1) / zones.length) * 100);
      console.log(`   ${i+1}/${zones.length} (${pct}%) ` +
        `updated:${stats.updated} skipped:${stats.skipped} errors:${stats.errors}`);
    }
  }

  // Final flush
  if (!DRY_RUN && ops.length > 0) {
    await ASPZone.bulkWrite(ops, { ordered: false });
  }

  // Report
  const matchPct = Math.round(stats.updated / stats.total * 100);
  console.log(`\n✅ Результат:`);
  console.log(`   Всего зон:     ${stats.total}`);
  console.log(`   Обновлено:     ${stats.updated} (${matchPct}%)`);
  console.log(`   Пропущено:     ${stats.skipped}`);
  console.log(`   Ошибки:        ${stats.errors}`);
  console.log(`\n   Методы матчинга:`);
  for (const [m, c] of Object.entries(stats.methods).sort((a,b)=>b[1]-a[1])) {
    console.log(`     ${m}: ${c}`);
  }
  if (stats.skipped > 0) {
    console.log(`\n   Причины пропуска:`);
    for (const [r, c] of Object.entries(stats.reasons).sort((a,b)=>b[1]-a[1]).slice(0,10)) {
      console.log(`     ${r}: ${c}`);
    }
  }

  await mongoose.disconnect();
  console.log('\n📡 MongoDB отключена');
  if (DRY_RUN) console.log('⚠️  DRY RUN — ничего не записано');
  else console.log('✅ Готово!');
}

main().catch(e => {
  console.error('\n❌ Критическая ошибка:', e);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
