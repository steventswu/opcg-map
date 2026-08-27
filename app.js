/* ============================================
   7-11 ONE PIECE Store Locator — App Logic (Leaflet)
   ============================================ */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const TAIWAN_CENTER = [23.6978, 120.9605]; // Lat, Lng for Leaflet
const TAIWAN_ZOOM = 7;
const CLUSTER_MAX_ZOOM = 16;
const CLUSTER_RADIUS = 50;
const SEARCH_DEBOUNCE_MS = 300;
const FLY_TO_ZOOM = 16;
const LOCATION_ZOOM = 15;
const LOCATION_FILTER_UPDATE_MS = 2000;
const NEARBY_RADIUS_KM = 20;
const NEARBY_STORE_LIMIT = 50;
const OPENFREEMAP_DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const PRODUCT_META = {
  'OP-14': { filter: 'op14', tagClass: 'tag-op14' },
  'OP-15': { filter: 'op15', tagClass: 'tag-op15' },
  'OP-16': { filter: 'op16', tagClass: 'tag-op16' },
};
const ESTIMATED_FILTER = 'estimated';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  stores: [],
  filteredStores: [],
  activeFilter: 'all',    // 'all' | 'op14' | 'op15' | 'op16' | 'estimated' | 'near'
  activeCity: 'all',
  selectedStore: null,
  searchQuery: '',
  map: null,
  markerCluster: null,
  cities: [],
  debounceTimer: null,
  userMarker: null,
  userAccuracyCircle: null,
  userLocation: null,
  locationWatchId: null,
  isTrackingLocation: false,
  hasLocationFix: false,
  lastNearbyUpdateAt: 0,
  originalStoreCount: 0,
  estimatedStoreCount: 0,
  estimatedMeta: null,
};

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  map: $('#map'),
  loadingOverlay: $('#loading-overlay'),
  errorOverlay: $('#error-overlay'),
  errorMessage: $('#error-message'),
  searchInput: $('#search-input'),
  searchClear: $('#search-clear'),
  searchResults: $('#search-results'),
  filterPills: $$('.filter-pill'),
  cityFilter: $('#city-filter'),
  geolocateBtn: $('#geolocate-btn'),
  geolocateLabel: $('#geolocate-label'),
  locationStatus: $('#location-status'),
  locationStatusText: $('#location-status-text'),
  storePanel: $('#store-panel'),
  panelClose: $('#panel-close'),
  panelName: $('#panel-name'),
  panelTags: $('#panel-tags'),
  panelEstimated: $('#panel-estimated'),
  panelEstimatedRank: $('#panel-estimated-rank'),
  panelEstimatedMeta: $('#panel-estimated-meta'),
  panelEstimatedNote: $('#panel-estimated-note'),
  panelAddress: $('#panel-address'),
  panelDistanceRow: $('#panel-distance-row'),
  panelDistance: $('#panel-distance'),
  panelPhone: $('#panel-phone'),
  panelNavigate: $('#panel-navigate'),
  statsCount: $('#stats-count'),
  statsTotal: $('#stats-total'),
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function debounce(fn, ms) {
  return (...args) => {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => fn(...args), ms);
  };
}

function animateNumber(el, to) {
  el.classList.remove('animating');
  void el.offsetWidth; // trigger reflow
  el.textContent = to.toLocaleString();
  el.classList.add('animating');
}

function hideOverlay(el) {
  if (!el || el.style.display === 'none') return;
  el.classList.add('hiding');
  el.addEventListener('animationend', () => {
    el.style.display = 'none';
    el.classList.remove('hiding');
  }, { once: true });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderProductTags(products) {
  return products.map(product => {
    const cls = PRODUCT_META[product]?.tagClass || '';
    return `<span class="tag ${cls}">${escapeHtml(product)}</span>`;
  }).join('');
}

function renderEstimatedTag(store) {
  if (!store.estimatedRank) return '';
  return `<span class="tag tag-estimated" title="公開配貨訊號推估，非官方業績">★ 推估 #${store.estimatedRank.toLocaleString()}</span>`;
}

function renderStoreTags(store) {
  return renderProductTags(store.products) + renderEstimatedTag(store);
}

function getProductVariant(products, prefix) {
  const knownProducts = [...new Set(products.filter(product => PRODUCT_META[product]))];
  if (knownProducts.length === 0) return `${prefix}-unlisted`;
  if (knownProducts.length > 1) return `${prefix}-both`;
  return `${prefix}-${PRODUCT_META[knownProducts[0]].filter}`;
}

// ---------------------------------------------------------------------------
// Data Loading
// ---------------------------------------------------------------------------
async function loadStores() {
  try {
    const [storeResponse, estimatedResponse] = await Promise.all([
      fetch('/data/stores.json'),
      fetch('/data/estimated_top2000.json'),
    ]);
    if (!storeResponse.ok) throw new Error(`HTTP ${storeResponse.status}`);
    const data = await storeResponse.json();
    let estimatedData = { meta: null, stores: [] };
    if (estimatedResponse.ok) {
      estimatedData = await estimatedResponse.json();
    } else {
      console.warn(`Estimated store data unavailable: HTTP ${estimatedResponse.status}`);
    }

    const raw = Array.isArray(data) ? data : (data.stores || []);
    const estimatedRaw = Array.isArray(estimatedData) ? estimatedData : (estimatedData.stores || []);
    const estimatedById = new Map(estimatedRaw.map(store => [String(store.id), store]));
    const mergedById = new Map();

    raw.forEach(store => {
      const estimated = estimatedById.get(String(store.id));
      mergedById.set(String(store.id), {
        ...store,
        isOriginal: true,
        estimatedRank: estimated?.rank || null,
        estimatedScore: estimated?.score ?? null,
        estimatedConfidence: estimated?.confidence || '',
      });
    });

    estimatedRaw.forEach(store => {
      if (mergedById.has(String(store.id))) return;
      mergedById.set(String(store.id), {
        ...store,
        products: [],
        isOriginal: false,
        estimatedRank: store.rank,
        estimatedScore: store.score,
        estimatedConfidence: store.confidence,
      });
    });

    state.stores = [...mergedById.values()]
      .filter(s => s.name && s.lat != null && s.lng != null)
      .map((s, i) => ({
        id: s.id || i,
        name: s.name,
        address: s.address || '',
        city: s.city || extractCity(s.address || ''),
        phone: s.phone || '',
        lat: Number(s.lat),
        lng: Number(s.lng),
        products: normalizeProducts(s.products || s.product || []),
        isOriginal: s.isOriginal !== false,
        estimatedRank: s.estimatedRank ? Number(s.estimatedRank) : null,
        estimatedScore: s.estimatedScore == null ? null : Number(s.estimatedScore),
        estimatedConfidence: s.estimatedConfidence || '',
      }));

    state.originalStoreCount = state.stores.filter(store => store.isOriginal).length;
    state.estimatedStoreCount = state.stores.filter(store => store.estimatedRank).length;
    state.estimatedMeta = estimatedData.meta || null;

    state.cities = [...new Set(state.stores.map(s => s.city).filter(Boolean))].sort();
    populateCityFilter();

    state.filteredStores = state.stores.filter(store => store.isOriginal);
    return true;
  } catch (err) {
    console.error('Failed to load stores:', err);
    return false;
  }
}

function extractCity(address) {
  const match = address.match(/^(.{2,3}[市縣])/);
  return match ? match[1] : '';
}

function normalizeProducts(p) {
  if (typeof p === 'string') p = [p];
  if (!Array.isArray(p)) return [];
  return [...new Set(p.map(x => {
    const s = String(x).toUpperCase().replace(/[\s_-]/g, '');
    if (s.includes('OP14') || s === '14') return 'OP-14';
    if (s.includes('OP15') || s.includes('15')) return 'OP-15';
    if (s.includes('OP16') || s.includes('16')) return 'OP-16';
    return String(x);
  }).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Map Initialization
// ---------------------------------------------------------------------------
function initMap() {
  // Initialize Leaflet Map
  state.map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    maxZoom: 18,
    minZoom: 6,
    worldCopyJump: true,
  }).setView(TAIWAN_CENTER, TAIWAN_ZOOM);

  // Controls
  L.control.zoom({ position: 'topright' }).addTo(state.map);
  L.control.attribution({ position: 'bottomleft' }).addTo(state.map);

  addBaseMapLayer(state.map);

  // Map Click (Close Panel/Popup)
  state.map.on('click', () => {
    closeStorePanel();
  });

  return true;
}

function addBaseMapLayer(map) {
  const supportsVectorMap = typeof L.maplibreGL === 'function'
    && typeof globalThis.maplibregl !== 'undefined'
    && supportsWebGL2();

  if (supportsVectorMap) {
    // OpenFreeMap's keyless Dark style is a maintained fork of the
    // OpenMapTiles Dark Matter GL style. Leaflet continues to own all
    // interactions, markers, clusters and GPS layers.
    try {
      const vectorLayer = L.maplibreGL({
        style: OPENFREEMAP_DARK_STYLE,
        interactive: false,
      }).addTo(map);
      registerDarkMatterImages(vectorLayer.getMaplibreMap());
      return;
    } catch (err) {
      console.warn('Vector basemap initialization failed; using the raster fallback.', err);
    }
  }

  console.warn('WebGL unavailable; using the keyless OpenStreetMap raster fallback.');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    className: 'osm-dark-tiles',
    maxZoom: 19,
  }).addTo(map);
}

function registerDarkMatterImages(glMap) {
  glMap.on('styleimagemissing', (event) => {
    if (glMap.hasImage(event.id)) return;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;

    if (event.id === 'circle-11') {
      canvas.width = 22;
      canvas.height = 22;
      context.fillStyle = 'rgba(148, 163, 184, 0.82)';
      context.beginPath();
      context.arc(11, 11, 7, 0, Math.PI * 2);
      context.fill();
    } else if (event.id === 'wood-pattern') {
      canvas.width = 16;
      canvas.height = 16;
      context.fillStyle = 'rgba(20, 24, 31, 0.55)';
      context.fillRect(0, 0, 16, 16);
      context.strokeStyle = 'rgba(71, 85, 105, 0.42)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(-4, 16);
      context.lineTo(16, -4);
      context.moveTo(4, 20);
      context.lineTo(20, 4);
      context.stroke();
    } else {
      return;
    }

    glMap.addImage(event.id, context.getImageData(0, 0, canvas.width, canvas.height), {
      pixelRatio: 2,
    });
  });
}

function supportsWebGL2() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Map Layers & Markers
// ---------------------------------------------------------------------------
function addMapLayers() {
  const map = state.map;

  if (state.markerCluster) {
    map.removeLayer(state.markerCluster);
  }

  // Create new marker cluster group
  state.markerCluster = L.markerClusterGroup({
    maxClusterRadius: CLUSTER_RADIUS,
    disableClusteringAtZoom: CLUSTER_MAX_ZOOM,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: function (cluster) {
      const markers = cluster.getAllChildMarkers();
      const products = new Set();
      let hasEstimatedStore = false;
      
      markers.forEach(m => {
        m.storeData.products.forEach(product => products.add(product));
        if (m.storeData.estimatedRank) hasEstimatedStore = true;
      });
      
      const clusterClass = getProductVariant([...products], 'cluster');
      const estimatedClass = hasEstimatedStore ? ' cluster-estimated' : '';
      
      const count = markers.length;
      return L.divIcon({
        html: '<div><span>' + count + '</span></div>',
        className: 'marker-cluster ' + clusterClass + estimatedClass,
        iconSize: L.point(40, 40)
      });
    }
  });

  // Add individual markers
  state.filteredStores.forEach(store => {
    const ptClass = getProductVariant(store.products, 'point');
    const estimatedClass = store.estimatedRank ? ' estimated-strong' : '';

    const icon = L.divIcon({
      className: 'custom-point ' + ptClass + estimatedClass,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      popupAnchor: [0, -10]
    });

    const marker = L.marker([store.lat, store.lng], { icon });
    marker.storeData = store;
    
    marker.on('click', () => {
      showStorePanel(store);
      flyToStore(store);
    });
    
    state.markerCluster.addLayer(marker);
  });
  
  map.addLayer(state.markerCluster);
}

// ---------------------------------------------------------------------------
// Map Interactions
// ---------------------------------------------------------------------------
function flyToStore(store) {
  state.map.flyTo([store.lat, store.lng], Math.max(state.map.getZoom(), FLY_TO_ZOOM), {
    duration: 0.8,
    easeLinearity: 0.25
  });
}

// ---------------------------------------------------------------------------
// Store Panel
// ---------------------------------------------------------------------------
function showStorePanel(store) {
  state.selectedStore = store;

  dom.panelName.textContent = store.name;
  dom.panelAddress.textContent = store.address;
  updatePanelDistance(store);

  // Phone
  if (store.phone) {
    dom.panelPhone.textContent = store.phone;
    dom.panelPhone.href = `tel:${store.phone}`;
    dom.panelPhone.parentElement.style.display = '';
  } else {
    dom.panelPhone.parentElement.style.display = 'none';
  }

  // Tags
  dom.panelTags.innerHTML = renderProductTags(store.products);

  if (store.estimatedRank) {
    const confidenceLabels = { high: '高信心', medium: '中信心', low: '低信心' };
    dom.panelEstimatedRank.textContent = `#${store.estimatedRank.toLocaleString()}`;
    dom.panelEstimatedMeta.textContent = confidenceLabels[store.estimatedConfidence] || '推估名單';
    dom.panelEstimatedNote.textContent = store.isOriginal
      ? '依公開配貨訊號推估，非 7-ELEVEN 官方或實際 POS 業績。'
      : '依公開配貨訊號推估；此店未列入目前 OP-14～16 名單。';
    dom.panelEstimated.style.display = '';
  } else {
    dom.panelEstimated.style.display = 'none';
  }

  // Navigate link
  dom.panelNavigate.href = `https://www.google.com/maps/dir/?api=1&destination=${store.lat},${store.lng}`;

  // Show
  dom.storePanel.classList.remove('closing');
  dom.storePanel.style.display = '';
}

function closeStorePanel() {
  if (dom.storePanel.style.display === 'none') return;
  state.selectedStore = null;
  dom.storePanel.classList.add('closing');
  dom.storePanel.addEventListener('animationend', () => {
    dom.storePanel.style.display = 'none';
    dom.storePanel.classList.remove('closing');
  }, { once: true });
}

function updatePanelDistance(store) {
  if (!store || !state.userLocation) {
    dom.panelDistanceRow.style.display = 'none';
    return;
  }

  const distance = getDistance(
    state.userLocation.lat,
    state.userLocation.lng,
    store.lat,
    store.lng
  );
  dom.panelDistance.textContent = `距離目前位置約 ${formatStoreDistance(distance)}`;
  dom.panelDistanceRow.style.display = '';
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function setupSearch() {
  dom.searchInput.addEventListener('input', debounce(handleSearch, SEARCH_DEBOUNCE_MS));

  dom.searchInput.addEventListener('focus', () => {
    if (dom.searchInput.value.trim().length > 0) {
      handleSearch();
    }
  });

  dom.searchClear.addEventListener('click', () => {
    dom.searchInput.value = '';
    dom.searchClear.style.display = 'none';
    dom.searchResults.style.display = 'none';
    state.searchQuery = '';
  });

  // Close results on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-container')) {
      dom.searchResults.style.display = 'none';
    }
  });
}

function handleSearch() {
  const q = dom.searchInput.value.trim().toLowerCase();
  state.searchQuery = q;
  dom.searchClear.style.display = q ? '' : 'none';

  if (!q) {
    dom.searchResults.style.display = 'none';
    return;
  }

  const results = state.filteredStores
    .filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.address.toLowerCase().includes(q)
    )
    .slice(0, 20);

  if (results.length === 0) {
    dom.searchResults.innerHTML = '<div class="search-no-results">找不到符合的門市</div>';
    dom.searchResults.style.display = '';
    return;
  }

  dom.searchResults.innerHTML = results
    .map(s => {
      const tags = renderStoreTags(s);

      return `
        <div class="search-result-item" data-store-id="${s.id}">
          <span class="result-name">${escapeHtml(s.name)}</span>
          <span class="result-address">${escapeHtml(s.address)}</span>
          <div class="result-tags">${tags}</div>
        </div>
      `;
    })
    .join('');

  dom.searchResults.style.display = '';

  // Click handler for results
  dom.searchResults.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('click', () => {
      const storeId = el.dataset.storeId;
      const store = state.stores.find(s => String(s.id) === String(storeId));
      if (store) {
        dom.searchResults.style.display = 'none';
        dom.searchInput.blur();
        
        flyToStore(store);
        showStorePanel(store);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in km
}

function formatStoreDistance(distanceKm) {
  if (distanceKm < 1) {
    return `${Math.max(1, Math.round(distanceKm * 1000))} 公尺`;
  }
  return `${distanceKm.toFixed(distanceKm < 10 ? 1 : 0)} 公里`;
}

function formatAccuracy(accuracyMeters) {
  if (accuracyMeters >= 1000) {
    return `${(accuracyMeters / 1000).toFixed(1)} 公里`;
  }
  return `${Math.max(1, Math.round(accuracyMeters))} 公尺`;
}

function setupFilters() {
  dom.filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      dom.filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.activeFilter = pill.dataset.filter;
      applyFilters();
    });
  });

  dom.cityFilter.addEventListener('change', () => {
    state.activeCity = dom.cityFilter.value;
    applyFilters();
  });
}

function populateCityFilter() {
  dom.cityFilter.innerHTML = '<option value="all">所有縣市</option>';
  state.cities.forEach(city => {
    const opt = document.createElement('option');
    opt.value = city;
    opt.textContent = city;
    dom.cityFilter.appendChild(opt);
  });
}

function applyFilters() {
  let filtered = state.activeFilter === ESTIMATED_FILTER
    ? state.stores.filter(store => store.estimatedRank)
    : state.stores.filter(store => store.isOriginal);

  const activeProduct = Object.entries(PRODUCT_META)
    .find(([, meta]) => meta.filter === state.activeFilter)?.[0];

  if (state.activeFilter === ESTIMATED_FILTER) {
    // The initial collection already contains only estimated TOP 2,000 stores.
  } else if (activeProduct) {
    filtered = filtered.filter(s => s.products.includes(activeProduct));
  } else if (state.activeFilter === 'near' && state.userLocation) {
    filtered.forEach(s => {
      s.distance = getDistance(state.userLocation.lat, state.userLocation.lng, s.lat, s.lng);
    });
    filtered = filtered
      .filter(s => s.distance <= NEARBY_RADIUS_KM)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, NEARBY_STORE_LIMIT);
  }

  if (state.activeCity !== 'all') {
    filtered = filtered.filter(s => s.city === state.activeCity);
  }

  state.filteredStores = filtered;
  updateMapData();
  updateStats();

  if (state.selectedStore) {
    const stillVisible = filtered.some(s => s.id === state.selectedStore.id);
    if (!stillVisible) {
      closeStorePanel();
    }
  }
}

function updateMapData() {
  addMapLayers();
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function updateStats() {
  animateNumber(dom.statsCount, state.filteredStores.length);
  const total = state.activeFilter === ESTIMATED_FILTER
    ? state.estimatedStoreCount
    : state.originalStoreCount;
  dom.statsTotal.textContent = total.toLocaleString();
}

// ---------------------------------------------------------------------------
// Geolocation
// ---------------------------------------------------------------------------
function setupGeolocation() {
  dom.geolocateBtn.addEventListener('click', () => {
    if (state.isTrackingLocation) {
      stopLocationTracking();
    } else {
      startLocationTracking();
    }
  });

  window.addEventListener('pagehide', () => {
    stopLocationTracking({ silent: true });
  });
}

function setLocationUi(mode, message = '') {
  const isLocating = mode === 'locating';
  const isTracking = mode === 'tracking';

  dom.geolocateBtn.classList.toggle('locating', isLocating);
  dom.geolocateBtn.classList.toggle('tracking', isTracking);
  dom.geolocateBtn.setAttribute('aria-pressed', String(state.isTrackingLocation));
  dom.geolocateBtn.setAttribute(
    'aria-label',
    state.isTrackingLocation ? '停止即時定位' : '開始即時定位'
  );
  dom.geolocateBtn.title = state.isTrackingLocation ? '停止即時定位' : '即時定位附近門市';

  if (isLocating) dom.geolocateLabel.textContent = '定位中…';
  else if (isTracking) dom.geolocateLabel.textContent = '停止追蹤';
  else dom.geolocateLabel.textContent = '即時定位';

  dom.locationStatus.dataset.state = mode;
  dom.locationStatusText.textContent = message;
  dom.locationStatus.hidden = !message;
}

function startLocationTracking() {
  if (!navigator.geolocation) {
    setLocationUi('error', '此瀏覽器不支援 GPS 定位');
    alert('您的瀏覽器不支援定位功能');
    return;
  }

  state.isTrackingLocation = true;
  state.hasLocationFix = false;
  state.lastNearbyUpdateAt = 0;
  setLocationUi('locating', '正在取得高精確度 GPS 位置…');

  try {
    state.locationWatchId = navigator.geolocation.watchPosition(
      handleLocationUpdate,
      handleLocationError,
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 1000,
      }
    );
  } catch (err) {
    state.isTrackingLocation = false;
    state.locationWatchId = null;
    setLocationUi('error', '無法啟動定位，請確認瀏覽器權限');
    console.error('Failed to start location tracking:', err);
  }
}

function stopLocationTracking({ silent = false } = {}) {
  if (state.locationWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.locationWatchId);
  }

  state.locationWatchId = null;
  state.isTrackingLocation = false;
  state.hasLocationFix = false;
  setUserMarkerTrackingState(false);

  if (!silent) {
    const lastAccuracy = state.userLocation?.accuracy;
    const message = lastAccuracy
      ? `定位已停止 · 上次精度約 ±${formatAccuracy(lastAccuracy)}`
      : '定位已停止';
    setLocationUi('paused', message);
  }
}

function handleLocationUpdate(position) {
  if (!state.isTrackingLocation) return;

  const { latitude, longitude, accuracy, heading, speed } = position.coords;
  if (![latitude, longitude].every(Number.isFinite)) return;

  const isFirstFix = !state.hasLocationFix;
  const timestamp = position.timestamp || Date.now();
  const normalizedAccuracy = Number.isFinite(accuracy) ? Math.max(accuracy, 1) : 1;

  state.hasLocationFix = true;
  state.userLocation = {
    lat: latitude,
    lng: longitude,
    accuracy: normalizedAccuracy,
    heading: Number.isFinite(heading) ? heading : null,
    speed: Number.isFinite(speed) ? speed : null,
    timestamp,
  };

  updatePanelDistance(state.selectedStore);
  addOrUpdateUserLocationMarker(latitude, longitude, normalizedAccuracy);

  const speedText = Number.isFinite(speed) && speed >= 1
    ? ` · ${Math.round(speed * 3.6)} km/h`
    : '';
  setLocationUi(
    'tracking',
    `即時追蹤中 · 精度約 ±${formatAccuracy(normalizedAccuracy)}${speedText}`
  );

  if (isFirstFix) {
    dom.filterPills.forEach(p => p.classList.remove('active'));
    dom.cityFilter.value = 'all';
    state.activeCity = 'all';
    state.activeFilter = 'near';
    state.lastNearbyUpdateAt = timestamp;
    applyFilters();
    state.map.flyTo([latitude, longitude], LOCATION_ZOOM, { duration: 1.2 });
    return;
  }

  if (
    state.activeFilter === 'near'
    && timestamp - state.lastNearbyUpdateAt >= LOCATION_FILTER_UPDATE_MS
  ) {
    state.lastNearbyUpdateAt = timestamp;
    applyFilters();
  }

  const innerBounds = state.map.getBounds().pad(-0.2);
  if (!innerBounds.contains([latitude, longitude])) {
    state.map.panTo([latitude, longitude], { animate: true, duration: 0.6 });
  }
}

function handleLocationError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    stopLocationTracking({ silent: true });
    setLocationUi('error', '定位權限遭拒，請至瀏覽器設定開啟');
    alert('定位權限已被拒絕，請在瀏覽器設定中啟用');
    return;
  }

  const message = err.code === err.TIMEOUT
    ? 'GPS 回應較慢，正在持續重試…'
    : '暫時無法取得位置，正在持續重試…';
  setLocationUi('locating', message);
}

function addOrUpdateUserLocationMarker(lat, lng, accuracy) {
  const latLng = [lat, lng];
  const accuracyText = `你的位置 · 精度約 ±${formatAccuracy(accuracy)}`;

  if (state.userMarker) {
    state.userMarker.setLatLng(latLng);
    state.userMarker.setTooltipContent(accuracyText);
  } else {
    const icon = L.divIcon({
      className: 'custom-user-marker',
      html: `
        <div class="user-location-marker tracking">
          <span class="user-location-pulse"></span>
          <span class="user-location-dot"></span>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });

    state.userMarker = L.marker(latLng, { icon, zIndexOffset: 1000 })
      .bindTooltip(accuracyText, { direction: 'top', offset: [0, -14], opacity: 0.95 })
      .addTo(state.map);
  }

  if (state.userAccuracyCircle) {
    state.userAccuracyCircle.setLatLng(latLng);
    state.userAccuracyCircle.setRadius(accuracy);
  } else {
    state.userAccuracyCircle = L.circle(latLng, {
      radius: accuracy,
      color: '#60a5fa',
      weight: 1,
      opacity: 0.75,
      fillColor: '#3b82f6',
      fillOpacity: 0.1,
      interactive: false,
      className: 'user-accuracy-circle',
    }).addTo(state.map);
    state.userAccuracyCircle.bringToBack();
  }

  setUserMarkerTrackingState(true);
}

function setUserMarkerTrackingState(isTracking) {
  const markerElement = state.userMarker?.getElement();
  markerElement
    ?.querySelector('.user-location-marker')
    ?.classList.toggle('tracking', isTracking);
}

// ---------------------------------------------------------------------------
// Panel Controls
// ---------------------------------------------------------------------------
function setupPanelControls() {
  dom.panelClose.addEventListener('click', () => {
    closeStorePanel();
  });

  let startY = 0;
  const panel = dom.storePanel;

  panel.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
  }, { passive: true });

  panel.addEventListener('touchend', (e) => {
    const endY = e.changedTouches[0].clientY;
    if (endY - startY > 60) {
      closeStorePanel();
    }
  }, { passive: true });
}

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------
function showEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `
    <div class="empty-state-icon">🏴‍☠️</div>
    <div class="empty-state-text">
      尚未載入門市資料<br>
      <span style="font-size:0.85rem;color:var(--text-muted);">
        請確認 /data/stores.json 是否存在
      </span>
    </div>
  `;
  document.getElementById('app').appendChild(div);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  initMap();

  const dataLoaded = await loadStores();

  if (!dataLoaded || state.stores.length === 0) {
    hideOverlay(dom.loadingOverlay);
    if (!dataLoaded) {
      dom.errorOverlay.style.display = 'flex';
    } else {
      showEmptyState();
      updateStats();
    }
    return;
  }

  addMapLayers();
  setupSearch();
  setupFilters();
  setupGeolocation();
  setupPanelControls();
  updateStats();
  
  hideOverlay(dom.loadingOverlay);
}

boot();
