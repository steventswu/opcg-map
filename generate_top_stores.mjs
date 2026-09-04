import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_COUNT = 2500;
const PUBLIC_SIGNAL_BASE_WEIGHT = 12;
const PUBLIC_SIGNAL_MIN_WEIGHT = 3;
const PUBLIC_SIGNAL_MAX_WEIGHT = 18;
const PUBLIC_SIGNAL_STORE_BENCHMARK = 2500;
const PUBLIC_SIGNAL_RECENCY_DAYS = 365;
const PUBLIC_SIGNAL_MIN_RECENCY = 0.5;
const PUBLIC_SIGNAL_CUTOFF_EXCLUSIVE = '20260829';
const MODEL_AS_OF = new Date('2026-08-28T23:59:59+08:00');
const OP_WEIGHTS = { op14: 15, op15: 30, op16: 50 };
const SOURCE_URL = 'https://dose.run/7fami11';
const REQUEST_HEADERS = {
  Referer: SOURCE_URL,
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0'
};
const TAIWAN_ADMIN_AREAS = [
  '台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市',
  '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣',
  '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣',
  '台東縣', '澎湖縣', '金門縣', '連江縣'
];

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

function normalizeIdentityPart(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/臺/g, '台')
    .replace(/[\s,，.。．、-]/g, '')
    .toLowerCase();
}

function storeIdentityKey(store) {
  const city = normalizeIdentityPart(store.city);
  const address = normalizeIdentityPart(store.address);
  const addressHasAdminArea = TAIWAN_ADMIN_AREAS
    .map(normalizeIdentityPart)
    .some(area => address.startsWith(area));
  const location = addressHasAdminArea ? address : `${city}${address}`;
  const phone = String(store.phone || '').replace(/\D/g, '');
  if (!location || !phone) return '';
  return `${location}|${phone}`;
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
  const scoredProducts = new Set(Object.keys(OP_WEIGHTS));
  const opById = new Map(existingStores.map(store => [
    String(store.id),
    new Set(store.products.filter(product => scoredProducts.has(product)))
  ]));
  const opByIdentity = new Map();
  existingStores.forEach(store => {
    const products = new Set(store.products.filter(product => scoredProducts.has(product)));
    const identityKey = storeIdentityKey(store);
    if (!identityKey || products.size === 0) return;
    const identity = opByIdentity.get(identityKey) || { products: new Set(), storeIds: new Set() };
    products.forEach(product => identity.products.add(product));
    identity.storeIds.add(String(store.id));
    opByIdentity.set(identityKey, identity);
  });
  const existingStoreIds = new Set(existingStores.map(store => String(store.id)));
  const existingIdentityKeys = new Set(existingStores.map(storeIdentityKey).filter(Boolean));
  const cityNames = [...new Set(existingStores.map(store => store.city))].sort();

  console.log('🔎 Loading the current public store and card-allocation data...');
  const homeHtml = await fetchText(SOURCE_URL);
  const dataBase = homeHtml.match(/\\"base\\":\\"([^"\\]+)\\"/)?.[1];
  if (!dataBase) throw new Error('Could not resolve the current public data version.');
  const publicDataRoot = `${SOURCE_URL}${dataBase}`;

  const products = await fetchJson(`${publicDataRoot}/products.json`);
  const cardProducts = products
    .filter(product =>
      product.brand === '711'
      && product.section === '肖像卡牌'
      && product.releaseDate < PUBLIC_SIGNAL_CUTOFF_EXCLUSIVE
    )
    .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));

  const publicSignals = await Promise.all(cardProducts.map(async product => {
    const payload = await fetchJson(`${publicDataRoot}/products/${encodeURIComponent(product.id)}.json`);
    if (payload.storeIds.length !== product.storeCount) {
      throw new Error(`Store-count mismatch for public signal: ${product.id}`);
    }
    return {
      product,
      ids: new Set(payload.storeIds.map(String)),
      weight: publicSignalWeight(product, MODEL_AS_OF)
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
    const directProducts = opById.get(id) || new Set();
    const identityHistory = opByIdentity.get(storeIdentityKey(store));
    const productsAtStore = directProducts.size > 0
      ? directProducts
      : (identityHistory?.products || new Set());
    const historyMatch = directProducts.size > 0
      ? 'storeId'
      : (identityHistory?.products.size > 0 ? 'identity' : 'none');
    const op14 = productsAtStore.has('op14') ? 1 : 0;
    const op15 = productsAtStore.has('op15') ? 1 : 0;
    const op16 = productsAtStore.has('op16') ? 1 : 0;
    const publicFlags = publicSignals.map(signal => signal.ids.has(id) ? 1 : 0);
    const publicHits = publicFlags.reduce((sum, value) => sum + value, 0);
    const opCount = op14 + op15 + op16;
    const signalCount = opCount + publicHits;
    const opScore = op14 * OP_WEIGHTS.op14
      + op15 * OP_WEIGHTS.op15
      + op16 * OP_WEIGHTS.op16;
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
      latestPublicSignal,
      historyMatch,
      historyStoreIds: historyMatch === 'identity' ? [...identityHistory.storeIds].sort() : []
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

  const seenCandidateIdentities = new Set();
  const uniqueRanked = ranked.filter(store => {
    const identityKey = storeIdentityKey(store) || `id:${store.id}`;
    if (seenCandidateIdentities.has(identityKey)) return false;
    seenCandidateIdentities.add(identityKey);
    return true;
  });

  const topStores = uniqueRanked.slice(0, TARGET_COUNT).map((store, index) => ({
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
      total: store.signalCount,
      historyMatch: store.historyMatch,
      historyStoreIds: store.historyStoreIds
    }
  }));

  if (
    topStores.length !== TARGET_COUNT
    || new Set(topStores.map(store => store.id)).size !== TARGET_COUNT
    || new Set(topStores.map(storeIdentityKey)).size !== TARGET_COUNT
  ) {
    throw new Error(`TOP ${TARGET_COUNT.toLocaleString()} output integrity check failed.`);
  }

  const cutoffScore = topStores.at(-1).score;
  const scoreAt = store => Number(store.score.toFixed(2));
  const selectedAtCutoffScore = topStores.filter(store => store.score === cutoffScore).length;
  const candidatesAtCutoffScore = uniqueRanked.filter(store => scoreAt(store) === cutoffScore).length;

  const output = {
    meta: {
      label: '推估卡牌強店 TOP 2,500',
      generatedAt: generatedAt.toISOString(),
      sourceDataVersion: dataBase,
      sourceUrl: SOURCE_URL,
      modelVersion: 3,
      type: 'estimated',
      scoringAsOf: MODEL_AS_OF.toISOString(),
      disclaimer: '依 OP-14～16 與 OP-17 發售前的公開卡牌配貨訊號推估；OP-17 完全排除於評分之外，並非 7-ELEVEN 官方或實際 POS 業績排名。',
      storeCount: topStores.length,
      candidateStoreCount: uniqueRanked.length,
      duplicateCandidateCount: ranked.length - uniqueRanked.length,
      publicSignalCount: publicSignals.length,
      cutoff: {
        selectedScore: cutoffScore,
        nextUnselectedScore: uniqueRanked[TARGET_COUNT] ? scoreAt(uniqueRanked[TARGET_COUNT]) : null,
        selectedAtCutoffScore,
        candidatesAtCutoffScore,
        tieBreakers: ['op16', 'op15', 'op14', 'publicHits', 'latestPublicSignal', 'storeId']
      },
      validationBenchmark: {
        name: 'OP-17',
        releaseDate: PUBLIC_SIGNAL_CUTOFF_EXCLUSIVE,
        excludedFromScoring: true
      },
      methodology: {
        opWeights: OP_WEIGHTS,
        publicSignalCutoffExclusive: PUBLIC_SIGNAL_CUTOFF_EXCLUSIVE,
        publicSignalBaseWeight: PUBLIC_SIGNAL_BASE_WEIGHT,
        publicSignalMinWeight: PUBLIC_SIGNAL_MIN_WEIGHT,
        publicSignalMaxWeight: PUBLIC_SIGNAL_MAX_WEIGHT,
        publicSignalStoreBenchmark: PUBLIC_SIGNAL_STORE_BENCHMARK,
        publicSignalRecencyDays: PUBLIC_SIGNAL_RECENCY_DAYS,
        publicSignalMinRecency: PUBLIC_SIGNAL_MIN_RECENCY,
        identityFallback: '標準化縣市＋地址＋電話；僅繼承 OP-14～16 歷史'
      },
      publicSignals: publicSignals.map(signal => ({
        id: signal.product.id,
        name: signal.product.name,
        releaseDate: signal.product.releaseDate,
        storeCount: signal.product.storeCount,
        weight: Number(signal.weight.toFixed(4)),
        sourceUrl: signal.product.sourceUrl || signal.product.dmUrls?.[0] || SOURCE_URL
      }))
    },
    stores: topStores
  };

  const outputPath = join(__dirname, 'data', 'estimated_top2500.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
  const topOnlyCount = topStores.filter(store =>
    !existingStoreIds.has(store.id)
    && !existingIdentityKeys.has(storeIdentityKey(store))
  ).length;
  console.log(`✅ Written ${topStores.length} estimated strong stores to ${outputPath}`);
  console.log(`➕ ${topOnlyCount} stores are new to the existing OP map dataset`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
