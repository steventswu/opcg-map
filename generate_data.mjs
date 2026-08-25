import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Fetch Real Coordinates from 7-11 API ───
async function fetchStoreCoords(id, retries = 3) {
  return new Promise((resolve) => {
    const postData = `commandid=SearchStore&ID=${id}`;
    const options = {
      hostname: 'emap.pcsc.com.tw',
      port: 443,
      path: '/EMapSDK.aspx',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const xMatch = data.match(/<X>([\d.]+)<\/X>/);
        const yMatch = data.match(/<Y>([\d.]+)<\/Y>/);
        if (xMatch && yMatch) {
          resolve({
            lng: Number(xMatch[1]) / 1000000,
            lat: Number(yMatch[1]) / 1000000
          });
        } else {
          resolve(null);
        }
      });
    });

    req.on('error', () => {
      if (retries > 0) {
        setTimeout(() => fetchStoreCoords(id, retries - 1).then(resolve), 500);
      } else {
        resolve(null);
      }
    });
    
    req.write(postData);
    req.end();
  });
}

// ─── Basic Fallback Geocoder (City-level Jitter) ───
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}
const CITY_COORDS = {
  '基隆市': [25.1276, 121.7392], '台北市': [25.0330, 121.5654], '新北市': [25.0169, 121.4628],
  '桃園市': [24.9936, 121.3010], '新竹市': [24.8138, 120.9675], '新竹縣': [24.8390, 121.0042],
  '苗栗縣': [24.5602, 120.8214], '台中市': [24.1477, 120.6736], '彰化縣': [24.0518, 120.5161],
  '南投縣': [23.9611, 120.9718], '雲林縣': [23.7092, 120.4313], '嘉義市': [23.4800, 120.4491],
  '嘉義縣': [23.4518, 120.2555], '台南市': [22.9998, 120.2270], '高雄市': [22.6273, 120.3014],
  '屏東縣': [22.5519, 120.5487], '宜蘭縣': [24.7570, 121.7533], '花蓮縣': [23.9910, 121.6011],
  '台東縣': [22.7583, 121.1444], '澎湖縣': [23.5711, 119.5793], '金門縣': [24.4493, 118.3763],
  '連江縣': [26.1505, 119.9499]
};
function getFallbackCoords(city, id) {
  const base = CITY_COORDS[city] || [23.6978, 120.9605];
  const h = simpleHash(id);
  return {
    lat: base[0] + (seededRandom(h) - 0.5) * 0.05,
    lng: base[1] + (seededRandom(h + 7) - 0.5) * 0.05
  };
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }

  values.push(value.trim());
  return values;
}

function normalizeHeader(value) {
  return value.replace(/^\uFEFF/, '').replace(/\s/g, '').replace(/巿/g, '市');
}

function extractCity(address) {
  return Object.keys(CITY_COORDS).find(city => address.startsWith(city)) || '';
}

// ─── Main Processing ───
async function run() {
  console.log('🗺️  Loading store lists...');
  const storesMap = new Map();
  let totalSkipped = 0;
  const outputPath = join(__dirname, 'data', 'stores.json');
  const cachedCoordinates = new Map();

  if (process.env.REFRESH_COORDS !== '1') {
    try {
      const existingData = JSON.parse(readFileSync(outputPath, 'utf-8'));
      const existingStores = Array.isArray(existingData) ? existingData : (existingData.stores || []);
      existingStores.forEach(store => {
        if (store.id && Number.isFinite(store.lat) && Number.isFinite(store.lng)) {
          const fallback = getFallbackCoords(store.city, String(store.id));
          const isFallback = Math.abs(store.lat - fallback.lat) < 1e-10
            && Math.abs(store.lng - fallback.lng) < 1e-10;
          if (isFallback) return;
          cachedCoordinates.set(String(store.id), { lat: store.lat, lng: store.lng });
        }
      });
    } catch {
      // No existing output yet; all stores will be geocoded below.
    }
  }

  function processCsv(filename, productTag) {
    const csvPath = join(__dirname, 'data', filename);
    let csvContent;
    try {
      csvContent = readFileSync(csvPath, 'utf-8');
    } catch (err) {
      console.log(`⚠️  Could not read ${filename}: ${err.message}`);
      return;
    }

    const lines = csvContent.split('\n').map(l => l.replace(/\r/g, '').trim()).filter(l => l.length > 0);
    if (lines.length === 0) return;

    const headers = parseCsvLine(lines[0]).map(normalizeHeader);
    const idIndex = headers.indexOf('店號');
    const nameIndex = headers.indexOf('店名');
    const phoneIndex = headers.indexOf('電話');
    const addressIndex = headers.indexOf('地址');
    const cityIndex = headers.indexOf('縣市');

    if ([idIndex, nameIndex, phoneIndex, addressIndex].some(index => index === -1)) {
      console.log(`⚠️  Skipping ${filename}: unsupported CSV headers (${headers.join(', ')})`);
      return;
    }
    
    let processed = 0;
    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]);
      const id = parts[idIndex]?.trim() || '';
      const name = parts[nameIndex]?.trim() || '';
      const phone = parts[phoneIndex]?.trim() || '';
      let address = parts[addressIndex]?.trim() || '';
      const city = cityIndex >= 0
        ? (parts[cityIndex]?.trim() || '')
        : extractCity(address);

      if (city && address.startsWith(city)) {
        address = address.slice(city.length);
      }

      if (!id || !name || !city) { totalSkipped++; continue; }
      
      if (storesMap.has(id)) {
        const store = storesMap.get(id);
        if (!store.products.includes(productTag)) {
          store.products.push(productTag);
          store.products.sort();
        }
      } else {
        storesMap.set(id, { id, name, city, address, phone, products: [productTag] });
      }
      processed++;
    }
    console.log(`✅ Processed ${processed} stores from ${filename}`);
  }

  processCsv('op14.csv', 'op14');
  processCsv('op15.csv', 'op15');
  processCsv('op16.csv', 'op16');
  
  const stores = Array.from(storesMap.values());
  const storesToGeocode = stores.filter(store => {
    const cached = cachedCoordinates.get(store.id);
    if (!cached) return true;
    store.lat = cached.lat;
    store.lng = cached.lng;
    return false;
  });
  console.log(`\n✅ Total unique stores: ${stores.length}`);
  console.log(`♻️  Reused coordinates: ${stores.length - storesToGeocode.length}`);

  // Fetch coordinates concurrently (Chunk size = 20)
  console.log(`\n🚀 Fetching coordinates for ${storesToGeocode.length} uncached stores from 7-11 e-map API...`);
  const CHUNK_SIZE = 20;
  let successCount = 0;
  let fallbackCount = 0;

  for (let i = 0; i < storesToGeocode.length; i += CHUNK_SIZE) {
    const chunk = storesToGeocode.slice(i, i + CHUNK_SIZE);
    
    // Show progress
    process.stdout.write(`\r⏳ Processing ${i + 1} to ${Math.min(i + CHUNK_SIZE, storesToGeocode.length)} of ${storesToGeocode.length}...`);
    
    const promises = chunk.map(async (store) => {
      const coords = await fetchStoreCoords(store.id);
      if (coords) {
        store.lat = coords.lat;
        store.lng = coords.lng;
        successCount++;
      } else {
        // Fallback if API fails or store not found
        const fallback = getFallbackCoords(store.city, store.id);
        store.lat = fallback.lat;
        store.lng = fallback.lng;
        fallbackCount++;
      }
    });

    await Promise.all(promises);
    
    // Small delay between chunks to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n\n🎯 Geocoding Complete!`);
  console.log(`✅ Exact Coordinates: ${successCount}`);
  if (fallbackCount > 0) console.log(`⚠️ Fallback Coordinates: ${fallbackCount}`);

  // Write output
  writeFileSync(outputPath, JSON.stringify(stores, null, 2), 'utf-8');
  console.log(`\n🎉 Written ${stores.length} stores to ${outputPath}`);
  if (totalSkipped > 0) console.log(`⚠️ Skipped ${totalSkipped} invalid rows`);
}

run().catch(console.error);
