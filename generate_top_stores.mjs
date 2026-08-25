import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_COUNT = 2000;
const PUBLIC_SIGNAL_BASE_WEIGHT = 12;
const PUBLIC_SIGNAL_MIN_WEIGHT = 3;
const PUBLIC_SIGNAL_MAX_WEIGHT = 18;
const PUBLIC_SIGNAL_STORE_BENCHMARK = 2500;
const PUBLIC_SIGNAL_RECENCY_DAYS = 365;
const PUBLIC_SIGNAL_MIN_RECENCY = 0.5;
const OP_WEIGHTS = { op14: 15, op15: 30, op16: 50 };
const SOURCE_URL = 'https://dose.run/7fami11';
const REQUEST_HEADERS = {
  Referer: SOURCE_URL,
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0'
};

async function fetchText(url) {
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) throw new Error(`Fetch failed (${response.status}): ${url}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) throw new Error(`Fetch failed (${response.status}): ${url}`);
  return response.json();
}

function compactDateToDate(value) {
  return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00+08:00`);
}

function publicSignalWeight(product, asOf) {
  const ageDays = (asOf.getTime() - compactDateToDate(product.releaseDate).getTime()) / 86400000;
  const recencyFactor = Math.max(PUBLIC_SIGNAL_MIN_RECENCY, 1 - ageDays / PUBLIC_SIGNAL_RECENCY_DAYS);
  const selectivityFactor = Math.sqrt(PUBLIC_SIGNAL_STORE_BENCHMARK / product.storeCount);
  return Math.max(
    PUBLIC_SIGNAL_MIN_WEIGHT,
    Math.min(PUBLIC_SIGNAL_MAX_WEIGHT, PUBLIC_SIGNAL_BASE_WEIGHT * recencyFactor * selectivityFactor)
  );
}

async function run() {
  const generatedAt = new Date();
  const existingStores = JSON.parse(readFileSync(join(__dirname, 'data', 'stores.json'), 'utf8'));
  const opById = new Map(existingStores.map(store => [String(store.id), new Set(store.products)]));
  const cityNames = [...new Set(existingStores.map(store => store.city))].sort();

  console.log('🔎 Loading the current public store and card-allocation data...');
  const homeHtml = await fetchText(SOURCE_URL);
  const dataBase = homeHtml.match(/\\"base\\":\\"([^"\\]+)\\"/)?.[1];
  if (!dataBase) throw new Error('Could not resolve the current public data version.');
  const publicDataRoot = `${SOURCE_URL}${dataBase}`;

  const products = await fetchJson(`${publicDataRoot}/products.json`);
  const cardProducts = products
    .filter(product => product.brand === '711' && product.section === '肖像卡牌')
    .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));

  const publicSignals = await Promise.all(cardProducts.map(async product => {
    const payload = await fetchJson(`${publicDataRoot}/products/${encodeURIComponent(product.id)}.json`);
    if (payload.storeIds.length !== product.storeCount) {
      throw new Error(`Store-count mismatch for public signal: ${product.id}`);
    }
    return {
      product,
      ids: new Set(payload.storeIds.map(String)),
      weight: publicSignalWeight(product, generatedAt)
    };
  }));

  const cityStoreGroups = await Promise.all(cityNames.map(async city => {
    const stores = await fetchJson(`${publicDataRoot}/stores/${encodeURIComponent(city)}.json`);
    return stores.filter(store => store.brand === '711');
  }));
  const currentStoreMap = new Map();
  cityStoreGroups.flat().forEach(store => currentStoreMap.set(String(store.storeId), store));

  const ranked = [...currentStoreMap.values()].map(store => {
    const id = String(store.storeId);
    const productsAtStore = opById.get(id) || new Set();
    const op14 = productsAtStore.has('op14') ? 1 : 0;
    const op15 = productsAtStore.has('op15') ? 1 : 0;
    const op16 = productsAtStore.has('op16') ? 1 : 0;
    const publicFlags = publicSignals.map(signal => signal.ids.has(id) ? 1 : 0);
    const publicHits = publicFlags.reduce((sum, value) => sum + value, 0);
    const opCount = op14 + op15 + op16;
    const signalCount = opCount + publicHits;
    const opScore = op14 * OP_WEIGHTS.op14 + op15 * OP_WEIGHTS.op15 + op16 * OP_WEIGHTS.op16;
    const publicScore = publicFlags.reduce(
      (sum, flag, index) => sum + flag * publicSignals[index].weight,
      0
    );
    const latestPublicSignal = publicSignals
      .filter((_, index) => publicFlags[index])
      .map(signal => signal.product.releaseDate)
      .sort()
      .at(-1) || '';
    const confidence = signalCount >= 6 && opCount >= 1 ? 'high' : signalCount >= 3 ? 'medium' : 'low';

    return {
      id,
      name: store.name,
      city: store.city,
      address: store.address,
      phone: store.phone || '',
      lat: Number(store.lat),
      lng: Number(store.lng),
      score: opScore + publicScore,
      confidence,
      op14,
      op15,
      op16,
      publicHits,
      signalCount,
      latestPublicSignal
    };
  });

  ranked.sort((a, b) =>
    b.score - a.score
    || b.op16 - a.op16
    || b.op15 - a.op15
    || b.op14 - a.op14
    || b.publicHits - a.publicHits
    || b.latestPublicSignal.localeCompare(a.latestPublicSignal)
    || a.id.localeCompare(b.id)
  );

  const topStores = ranked.slice(0, TARGET_COUNT).map((store, index) => ({
    id: store.id,
    name: store.name,
    city: store.city,
    address: store.address,
    phone: store.phone,
    lat: store.lat,
    lng: store.lng,
    rank: index + 1,
    score: Number(store.score.toFixed(2)),
    confidence: store.confidence,
    signals: {
      op14: Boolean(store.op14),
      op15: Boolean(store.op15),
      op16: Boolean(store.op16),
      publicCardAllocations: store.publicHits,
      total: store.signalCount
    }
  }));

  if (topStores.length !== TARGET_COUNT || new Set(topStores.map(store => store.id)).size !== TARGET_COUNT) {
    throw new Error('TOP 2,000 output integrity check failed.');
  }

  const output = {
    meta: {
      label: '推估卡牌強店 TOP 2,000',
      generatedAt: generatedAt.toISOString(),
      sourceDataVersion: dataBase,
      sourceUrl: SOURCE_URL,
      modelVersion: 1,
      type: 'estimated',
      disclaimer: '依 OP-14～16 與近期公開卡牌配貨訊號推估，並非 7-ELEVEN 官方或實際 POS 業績排名。',
      storeCount: topStores.length,
      publicSignalCount: publicSignals.length
    },
    stores: topStores
  };

  const outputPath = join(__dirname, 'data', 'estimated_top2000.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
  const topOnlyCount = topStores.filter(store => !opById.has(store.id)).length;
  console.log(`✅ Written ${topStores.length} estimated strong stores to ${outputPath}`);
  console.log(`➕ ${topOnlyCount} stores are new to the existing OP map dataset`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
