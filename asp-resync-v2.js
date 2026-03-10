#!/usr/bin/env node
/**
 * ParkBro ASP Data Resync Script
 * 
 * Загружает ВСЕ знаки парковочных ограничений из NYC Open Data (nfid-uabd),
 * парсит описания знаков, конвертирует координаты, группирует по блокам,
 * и полностью обновляет коллекцию ASPZone в MongoDB.
 * 
 * Использование:
 *   cd ~/Downloads/parking-app/backend
 *   npm install proj4
 *   node asp-resync.js
 * 
 * Или dry-run (без записи в базу):
 *   node asp-resync.js --dry-run
 */

const https = require('https');
const mongoose = require('mongoose');
const proj4 = require('proj4');

// ============ CONFIG ============
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://parkingapp:wmoU4mDhWsRb4VaQ@eazypark.xhy0jyi.mongodb.net/parkingapp?retryWrites=true&w=majority';
const NYC_API = 'https://data.cityofnewyork.us/resource/nfid-uabd.json';
const PAGE_SIZE = 50000;
const DRY_RUN = process.argv.includes('--dry-run');

// EPSG:2263 — NAD83 / New York Long Island (US Survey Feet)
proj4.defs('EPSG:2263', '+proj=lcc +lat_1=41.03333333333333 +lat_2=40.66666666666666 +lat_0=40.16666666666666 +lon_0=-74 +x_0=300000.0000000001 +y_0=0 +ellps=GRS80 +datum=NAD83 +to_meter=0.3048006096012192 +no_defs');

// ============ MONGOOSE SCHEMA (копия из server.js) ============
const aspZoneSchema = new mongoose.Schema({
  geometry: {
    type: { type: String, enum: ['LineString'], required: true },
    coordinates: { type: [[Number]], required: true }
  },
  streetName: { type: String, index: true },
  fromStreet: String,
  toStreet: String,
  borough: String,
  side: { type: String, enum: ['left', 'right', 'both'] },
  zoneType: { type: String, enum: ['asp', 'no_parking', 'no_standing', 'school', 'hydrant'], default: 'asp', index: true },
  rules: [{
    days: [{ type: Number }],
    startTime: String,
    endTime: String,
    label: String
  }],
  center: { lat: Number, lng: Number },
  sourceId: { type: String, unique: true, sparse: true },
  createdAt: { type: Date, default: Date.now }
});
aspZoneSchema.index({ geometry: '2dsphere' });
aspZoneSchema.index({ 'center.lat': 1, 'center.lng': 1 });
const ASPZone = mongoose.model('ASPZone', aspZoneSchema);

// ============ КООРДИНАТЫ: State Plane → WGS84 ============
function toLatLng(x, y) {
  const xf = parseFloat(x);
  const yf = parseFloat(y);
  if (isNaN(xf) || isNaN(yf) || xf === 0 || yf === 0) return null;
  try {
    const [lng, lat] = proj4('EPSG:2263', 'WGS84', [xf, yf]);
    // Проверка что результат в пределах NYC
    if (lat < 40.4 || lat > 41.0 || lng < -74.3 || lng > -73.6) return null;
    return { lat: Math.round(lat * 1e7) / 1e7, lng: Math.round(lng * 1e7) / 1e7 };
  } catch (e) { return null; }
}

// ============ ПАРСЕР ОПИСАНИЙ ЗНАКОВ ============

const DAY_NAMES = {
  'MONDAY': 1, 'MON': 1,
  'TUESDAY': 2, 'TUE': 2, 'TUES': 2,
  'WEDNESDAY': 3, 'WED': 3,
  'THURSDAY': 4, 'THU': 4, 'THUR': 4, 'THURS': 4,
  'FRIDAY': 5, 'FRI': 5,
  'SATURDAY': 6, 'SAT': 6,
  'SUNDAY': 0, 'SUN': 0
};

function parseTimeStr(s) {
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = m[2] ? parseInt(m[2]) : 0;
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseTimeRange(desc) {
  const m = desc.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\s*-\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i);
  if (!m) return null;
  const s = parseTimeStr(m[1]);
  const e = parseTimeStr(m[2]);
  if (!s || !e) return null;
  return { startTime: s, endTime: e };
}

function parseDays(desc) {
  const u = desc.toUpperCase();
  
  if (u.includes('ANYTIME')) return [0, 1, 2, 3, 4, 5, 6];

  // "EXCEPT SUNDAY" / "EXCEPT SUN"
  if (/EXCEPT\s+SUN(?:DAY)?/.test(u)) return [1, 2, 3, 4, 5, 6];
  // "EXCEPT SATURDAY" / "EXCEPT SAT"  
  if (/EXCEPT\s+SAT(?:URDAY)?/.test(u)) return [0, 1, 2, 3, 4, 5];
  // "EXCEPT SAT & SUN" / "EXCEPT SATURDAY & SUNDAY"
  if (/EXCEPT\s+SAT(?:URDAY)?\s*(?:&|AND)\s*SUN(?:DAY)?/.test(u)) return [1, 2, 3, 4, 5];

  // "MONDAY THRU FRIDAY" / "MON THRU FRI" / "MONDAY-FRIDAY" / "MONDAY THROUGH FRIDAY"
  const thruRx = new RegExp(
    '(' + Object.keys(DAY_NAMES).join('|') + ')' +
    '\\s*(?:THRU|THROUGH|-)\\s*' +
    '(' + Object.keys(DAY_NAMES).join('|') + ')', 'i'
  );
  const thruMatch = u.match(thruRx);
  if (thruMatch) {
    const d1 = DAY_NAMES[thruMatch[1].toUpperCase()];
    const d2 = DAY_NAMES[thruMatch[2].toUpperCase()];
    if (d1 !== undefined && d2 !== undefined) {
      const days = [];
      if (d1 <= d2) { for (let i = d1; i <= d2; i++) days.push(i); }
      else { for (let i = d1; i <= 6; i++) days.push(i); for (let i = 0; i <= d2; i++) days.push(i); }
      if (days.length > 0) return days.sort((a, b) => a - b);
    }
  }

  // Отдельные названия дней: "MONDAY THURSDAY", "TUE FRI"
  // Убираем всё лишнее, потом ищем дни
  let cleaned = u
    .replace(/\(SANITATION BROOM SYMBOL\)/g, '')
    .replace(/NO PARKING/g, '').replace(/NO STANDING/g, '')
    .replace(/\(SUPERSEDES[^)]*\)/g, '').replace(/SUPERSEDES.*/g, '')
    .replace(/\d{1,2}(?::\d{2})?\s*(?:AM|PM)/gi, '')
    .replace(/[<>\-→←]{2,}/g, '').replace(/\([^)]*\)/g, '')
    .replace(/SCHOOL DAYS?/g, '').replace(/EXCEPT/g, '');

  const found = [];
  // Ищем длинные имена первыми
  const sortedNames = Object.keys(DAY_NAMES).sort((a, b) => b.length - a.length);
  for (const name of sortedNames) {
    const rx = new RegExp('\\b' + name + '\\b', 'i');
    if (rx.test(cleaned)) {
      const d = DAY_NAMES[name];
      if (!found.includes(d)) found.push(d);
      cleaned = cleaned.replace(rx, '');
    }
  }

  if (found.length > 0) return found.sort((a, b) => a - b);
  
  // Дни не указаны — для ASP по умолчанию Mon-Sat
  return [1, 2, 3, 4, 5, 6];
}

function classifySign(desc) {
  const u = (desc || '').toUpperCase();
  if (u.includes('BROOM') || u.includes('SANITATION')) return 'asp';
  if (u.includes('FIRE HYDRANT') || (u.includes('HYDRANT') && !u.includes('NO'))) return 'hydrant';
  if (u.includes('NO STANDING')) return 'no_standing';
  if (u.includes('NO PARKING')) return 'no_parking';
  return null;
}

function parseSign(desc) {
  const zoneType = classifySign(desc);
  if (!zoneType) return null;

  const u = (desc || '').toUpperCase();

  // Гидрант: 24/7
  if (zoneType === 'hydrant') {
    return { zoneType, rules: [{ days: [0,1,2,3,4,5,6], startTime: '00:00', endTime: '23:59', label: desc }] };
  }

  // ANYTIME
  if (u.includes('ANYTIME')) {
    return { zoneType, rules: [{ days: [0,1,2,3,4,5,6], startTime: '00:00', endTime: '23:59', label: desc }] };
  }

  const time = parseTimeRange(desc);
  if (!time) return null; // Нет времени — не можем создать правило

  const days = parseDays(desc);
  return { zoneType, rules: [{ days, ...time, label: desc }] };
}

// ============ HTTP FETCH ============

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.message || 'API error'));
          else resolve(parsed);
        } catch (e) {
          reject(new Error(`JSON parse: ${e.message} | first 200 chars: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function fetchSigns(filter, label) {
  const all = [];
  let offset = 0;
  console.log(`\n📥 Загружаю ${label}...`);

  while (true) {
    // URL: record_type=Current + sign_description LIKE filter
    const where = encodeURIComponent(`record_type='Current' AND sign_description like '${filter}'`);
    const url = `${NYC_API}?$limit=${PAGE_SIZE}&$offset=${offset}&$where=${where}&$order=order_number`;
    
    try {
      const data = await fetchJSON(url);
      if (!Array.isArray(data) || data.length === 0) break;
      all.push(...data);
      console.log(`   offset=${offset} → ${data.length} записей (итого ${all.length})`);
      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    } catch (e) {
      console.error(`   ❌ Ошибка на offset ${offset}: ${e.message}`);
      // Пробуем без сложного $where — простой фильтр по query params
      if (offset === 0) {
        console.log('   Пробую альтернативный запрос...');
        try {
          const altUrl = `${NYC_API}?$limit=${PAGE_SIZE}&$offset=0&record_type=Current&$q=${encodeURIComponent(filter.replace(/%/g, ''))}`;
          const data = await fetchJSON(altUrl);
          if (Array.isArray(data)) {
            all.push(...data);
            console.log(`   Альтернативный: ${data.length} записей`);
          }
        } catch (e2) {
          console.error(`   ❌ Альтернативный тоже не сработал: ${e2.message}`);
        }
      }
      break;
    }
  }
  
  console.log(`   ✅ ${label}: ${all.length} знаков`);
  return all;
}

// ============ ОПРЕДЕЛЕНИЕ СТОРОНЫ (N/S/E/W → left/right) ============

function calcBearing(lat1, lng1, lat2, lng2) {
  const toRad = Math.PI / 180;
  const dLng = (lng2 - lng1) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
            Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function compassToSide(compassDir, coords) {
  if (!compassDir) return 'both';
  
  let bearing = 90; // default E-W
  if (coords.length >= 2) {
    const first = coords[0];
    const last = coords[coords.length - 1];
    bearing = calcBearing(first[1], first[0], last[1], last[0]);
  }
  
  // Нормализуем: 0-180 (улица не имеет "направления", только ориентацию)
  const orient = bearing % 180;
  
  // orient ~0 или ~180 = N-S, orient ~90 = E-W
  // В Brooklyn сетка повёрнута ~29° — учитываем
  const isEW = (orient >= 30 && orient < 150); // 30-150° = E-W
  
  const d = compassDir.toUpperCase();
  if (isEW) {
    // Улица E-W: N=left, S=right
    if (d === 'N') return 'left';
    if (d === 'S') return 'right';
  } else {
    // Улица N-S: W=left, E=right
    if (d === 'W') return 'left';
    if (d === 'E') return 'right';
  }
  
  // Fallback
  if (d === 'N' || d === 'W') return 'left';
  if (d === 'S' || d === 'E') return 'right';
  return 'both';
}

// ============ НОРМАЛИЗАЦИЯ СТРОК ============

function normStr(s) {
  return (s || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

// ============ MAIN ============

async function main() {
  console.log('🅿️  ParkBro ASP Data Resync');
  console.log('='.repeat(60));
  if (DRY_RUN) console.log('⚠️  DRY RUN — база не будет изменена\n');

  // 1. Подключаемся к MongoDB
  console.log('📡 Подключение к MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Подключено');

  const oldCount = await ASPZone.countDocuments();
  console.log(`   Текущих зон в базе: ${oldCount}`);

  // 2. Загружаем знаки из NYC Open Data
  const broomSigns = await fetchSigns('%BROOM%', 'ASP (метёлка/уборка)');
  const noParkSigns = await fetchSigns('%NO PARKING%', 'NO PARKING');
  const noStandSigns = await fetchSigns('%NO STANDING%', 'NO STANDING');

  // Объединяем, убираем дубли по order_number + sign_x + sign_y + sign_description
  const dedupKey = (s) => `${s.order_number}|${s.sign_x_coord}|${s.sign_y_coord}|${s.sign_description}`;
  const seen = new Set();
  const allSigns = [];
  for (const s of [...broomSigns, ...noParkSigns, ...noStandSigns]) {
    const k = dedupKey(s);
    if (!seen.has(k)) { seen.add(k); allSigns.push(s); }
  }
  console.log(`\n📊 Всего уникальных знаков: ${allSigns.length}`);

  // 3. Парсим и группируем по блокам
  console.log('\n🔧 Парсинг описаний знаков...');
  
  const blocks = new Map();
  let parsedOk = 0, parsedSkip = 0, noCoord = 0;

  for (const sign of allSigns) {
    const parsed = parseSign(sign.sign_description);
    if (!parsed) { parsedSkip++; continue; }
    
    const coord = toLatLng(sign.sign_x_coord, sign.sign_y_coord);
    if (!coord) { noCoord++; continue; }

    const key = [
      normStr(sign.borough),
      normStr(sign.on_street),
      normStr(sign.from_street),
      normStr(sign.to_street),
      (sign.side_of_street || '').toUpperCase(),
      parsed.zoneType
    ].join('|');

    if (!blocks.has(key)) {
      blocks.set(key, {
        borough: (sign.borough || '').trim(),
        streetName: normStr(sign.on_street),
        fromStreet: normStr(sign.from_street),
        toStreet: normStr(sign.to_street),
        compassSide: (sign.side_of_street || '').toUpperCase(),
        zoneType: parsed.zoneType,
        coords: [],
        rules: []
      });
    }

    const blk = blocks.get(key);
    blk.coords.push([coord.lng, coord.lat]);
    blk.rules.push(...parsed.rules);
    parsedOk++;
  }

  console.log(`   ✅ Распарсено: ${parsedOk}`);
  console.log(`   ⏩ Пропущено (не парковочный знак): ${parsedSkip}`);
  console.log(`   ⚠️  Нет координат: ${noCoord}`);
  console.log(`   📦 Уникальных блоков: ${blocks.size}`);

  // 4. Строим зоны
  console.log('\n🏗️  Построение зон...');
  const zones = [];
  let singlePt = 0, multiPt = 0;

  for (const [key, blk] of blocks) {
    // Дедупликация координат
    const uniqCoords = [];
    const coordSeen = new Set();
    for (const c of blk.coords) {
      const ck = `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
      if (!coordSeen.has(ck)) { coordSeen.add(ck); uniqCoords.push(c); }
    }

    // Сортировка по основному направлению улицы
    if (uniqCoords.length >= 2) {
      const lngSpread = Math.max(...uniqCoords.map(c => c[0])) - Math.min(...uniqCoords.map(c => c[0]));
      const latSpread = Math.max(...uniqCoords.map(c => c[1])) - Math.min(...uniqCoords.map(c => c[1]));
      if (lngSpread >= latSpread) {
        uniqCoords.sort((a, b) => a[0] - b[0]); // по lng
      } else {
        uniqCoords.sort((a, b) => a[1] - b[1]); // по lat
      }
    }

    // Geometry
    let geomCoords;
    if (uniqCoords.length >= 2) {
      geomCoords = uniqCoords;
      multiPt++;
    } else {
      // Одна точка — делаем мини-линию ~30м
      singlePt++;
      const c = uniqCoords[0];
      const offset = 0.00015; // ~15м в каждую сторону
      geomCoords = [[c[0] - offset, c[1]], [c[0] + offset, c[1]]];
    }

    // Центр
    const centerLng = geomCoords.reduce((s, c) => s + c[0], 0) / geomCoords.length;
    const centerLat = geomCoords.reduce((s, c) => s + c[1], 0) / geomCoords.length;

    // Side: компас → left/right
    const side = compassToSide(blk.compassSide, geomCoords);

    // Тип зоны — напрямую из группировки
    const zoneType = blk.zoneType;

    // Мерж правил: объединяем одинаковые startTime+endTime
    const ruleMap = new Map();
    for (const r of blk.rules) {
      const rk = `${r.startTime}|${r.endTime}`;
      if (!ruleMap.has(rk)) {
        ruleMap.set(rk, { days: [...r.days], startTime: r.startTime, endTime: r.endTime, label: r.label });
      } else {
        const ex = ruleMap.get(rk);
        for (const d of r.days) { if (!ex.days.includes(d)) ex.days.push(d); }
      }
    }
    const mergedRules = Array.from(ruleMap.values()).map(r => ({
      ...r, days: [...new Set(r.days)].sort((a, b) => a - b)
    }));

    // sourceId для дедупликации
    const srcParts = [blk.borough, blk.streetName, blk.fromStreet, blk.toStreet, blk.compassSide, zoneType];
    const sourceId = 'nyc_' + srcParts.join('_').replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 195);

    zones.push({
      geometry: { type: 'LineString', coordinates: geomCoords },
      streetName: blk.streetName,
      fromStreet: blk.fromStreet,
      toStreet: blk.toStreet,
      borough: blk.borough,
      side,
      zoneType,
      rules: mergedRules,
      center: { lat: Math.round(centerLat * 1e7) / 1e7, lng: Math.round(centerLng * 1e7) / 1e7 },
      sourceId
    });
  }

  console.log(`   ✅ Создано зон: ${zones.length}`);
  console.log(`   📍 С несколькими точками: ${multiPt}`);
  console.log(`   📌 С одной точкой (мини-линия): ${singlePt}`);

  // Статистика по типам
  const byType = {};
  zones.forEach(z => byType[z.zoneType] = (byType[z.zoneType] || 0) + 1);
  console.log(`   По типу: ${JSON.stringify(byType)}`);

  // Статистика по районам
  const byBoro = {};
  zones.forEach(z => byBoro[z.borough || 'unknown'] = (byBoro[z.borough || 'unknown'] || 0) + 1);
  console.log(`   По районам: ${JSON.stringify(byBoro)}`);

  // Статистика по сторонам
  const bySide = {};
  zones.forEach(z => bySide[z.side] = (bySide[z.side] || 0) + 1);
  console.log(`   По сторонам: ${JSON.stringify(bySide)}`);

  // Примеры
  console.log('\n📋 Примеры (первые 3 ASP зоны):');
  const examples = zones.filter(z => z.zoneType === 'asp').slice(0, 3);
  for (const z of examples) {
    console.log(`   ${z.streetName} (${z.fromStreet} → ${z.toStreet}) [${z.side}]`);
    for (const r of z.rules) {
      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      console.log(`     ${r.days.map(d => dayNames[d]).join(',')} ${r.startTime}-${r.endTime}`);
    }
  }

  // 5. Импорт в MongoDB
  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN — пропускаю запись в базу');
    console.log(`   Было бы удалено: ${oldCount} зон`);
    console.log(`   Было бы создано: ${zones.length} зон`);
  } else {
    console.log('\n💾 Импорт в MongoDB...');
    
    // Удаляем старые
    console.log(`   Удаление ${oldCount} старых зон...`);
    await ASPZone.deleteMany({});

    // Вставляем батчами
    const BATCH = 500;
    let inserted = 0, errors = 0;
    for (let i = 0; i < zones.length; i += BATCH) {
      const batch = zones.slice(i, i + BATCH);
      try {
        await ASPZone.insertMany(batch, { ordered: false });
        inserted += batch.length;
      } catch (e) {
        // Часть могла вставиться
        const ok = e.insertedDocs ? e.insertedDocs.length : (e.result?.nInserted || 0);
        inserted += ok;
        errors += batch.length - ok;
      }
      if (inserted % 5000 === 0 || i + BATCH >= zones.length) {
        console.log(`   Вставлено: ${inserted}/${zones.length}${errors > 0 ? ` (ошибок: ${errors})` : ''}`);
      }
    }

    // Индексы
    console.log('   Создание индексов...');
    try {
      await ASPZone.collection.createIndex({ geometry: '2dsphere' });
      await ASPZone.collection.createIndex({ 'center.lat': 1, 'center.lng': 1 });
      await ASPZone.collection.createIndex({ streetName: 1 });
      await ASPZone.collection.createIndex({ zoneType: 1 });
    } catch (e) {
      console.log(`   ⚠️ Индекс: ${e.message}`);
    }

    console.log(`\n✅ Готово! Импортировано ${inserted} зон (было ${oldCount})`);
  }

  await mongoose.disconnect();
  console.log('📡 Отключено от MongoDB');
}

main().catch(e => {
  console.error('\n❌ Критическая ошибка:', e);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
