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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  stores: [],
  filteredStores: [],
  activeFilter: 'all',    // 'all' | 'op15' | 'op16'
  activeCity: 'all',
  selectedStore: null,
  searchQuery: '',
  map: null,
  markerCluster: null,
  popup: null,
  cities: [],
  debounceTimer: null,
  userMarker: null,
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
  storePanel: $('#store-panel'),
  panelClose: $('#panel-close'),
  panelName: $('#panel-name'),
  panelTags: $('#panel-tags'),
  panelAddress: $('#panel-address'),
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

// ---------------------------------------------------------------------------
// Data Loading
// ---------------------------------------------------------------------------
async function loadStores() {
  try {
    const res = await fetch('/data/stores.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const raw = Array.isArray(data) ? data : (data.stores || []);

    state.stores = raw
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
      }));

    state.cities = [...new Set(state.stores.map(s => s.city).filter(Boolean))].sort();
    populateCityFilter();

    state.filteredStores = [...state.stores];
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
  return p.map(x => {
    const s = String(x).toUpperCase().replace(/[\s-_]/g, '');
    if (s.includes('OP15') || s.includes('15')) return 'OP-15';
    if (s.includes('OP16') || s.includes('16')) return 'OP-16';
    return String(x);
  }).filter(Boolean);
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

  // CartoDB Dark Matter tiles
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(state.map);

  // Controls
  L.control.zoom({ position: 'topright' }).addTo(state.map);
  L.control.attribution({ position: 'bottomright' }).addTo(state.map);

  // Map Click (Close Panel/Popup)
  state.map.on('click', () => {
    closeStorePanel();
  });

  return true;
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
      let hasOP15 = false;
      let hasOP16 = false;
      
      markers.forEach(m => {
        const store = m.storeData;
        if (store.products.includes('OP-15')) hasOP15 = true;
        if (store.products.includes('OP-16')) hasOP16 = true;
      });
      
      let clusterClass = 'cluster-both';
      if (hasOP15 && !hasOP16) clusterClass = 'cluster-op15';
      else if (!hasOP15 && hasOP16) clusterClass = 'cluster-op16';
      
      const count = markers.length;
      return L.divIcon({
        html: '<div><span>' + count + '</span></div>',
        className: 'marker-cluster ' + clusterClass,
        iconSize: L.point(40, 40)
      });
    }
  });

  // Add individual markers
  state.filteredStores.forEach(store => {
    let ptClass = 'point-both';
    if (store.products.includes('OP-15') && !store.products.includes('OP-16')) ptClass = 'point-op15';
    else if (!store.products.includes('OP-15') && store.products.includes('OP-16')) ptClass = 'point-op16';

    const icon = L.divIcon({
      className: 'custom-point ' + ptClass,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      popupAnchor: [0, -10]
    });

    const marker = L.marker([store.lat, store.lng], { icon });
    marker.storeData = store;
    
    // Popup creation
    const tags = store.products.map(p => {
      const cls = p === 'OP-15' ? 'tag-op15' : 'tag-op16';
      return `<span class="tag ${cls}">${escapeHtml(p)}</span>`;
    }).join('');

    const phoneHtml = store.phone
      ? `<a class="popup-phone" href="tel:${escapeHtml(store.phone)}">${escapeHtml(store.phone)}</a>`
      : '';

    const popupHtml = `
      <div class="store-popup">
        <h3 class="popup-name">${escapeHtml(store.name)}</h3>
        <p class="popup-address">${escapeHtml(store.address)}</p>
        ${phoneHtml}
        <div class="popup-tags">${tags}</div>
      </div>
    `;

    // Only bind popup on desktop
    if (window.innerWidth > 768) {
      marker.bindPopup(popupHtml, {
        closeButton: true,
        autoPanPadding: [20, 20]
      });
    }
    
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

  // Phone
  if (store.phone) {
    dom.panelPhone.textContent = store.phone;
    dom.panelPhone.href = `tel:${store.phone}`;
    dom.panelPhone.parentElement.style.display = '';
  } else {
    dom.panelPhone.parentElement.style.display = 'none';
  }

  // Tags
  dom.panelTags.innerHTML = store.products
    .map(p => {
      const cls = p === 'OP-15' ? 'tag-op15' : 'tag-op16';
      return `<span class="tag ${cls}">${escapeHtml(p)}</span>`;
    })
    .join('');

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
      const tags = s.products
        .map(p => {
          const cls = p === 'OP-15' ? 'tag-op15' : 'tag-op16';
          return `<span class="tag ${cls}">${escapeHtml(p)}</span>`;
        })
        .join('');

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
        
        // Find marker in cluster and open popup
        const layers = state.markerCluster.getLayers();
        const targetLayer = layers.find(l => String(l.storeData.id) === String(store.id));
        
        flyToStore(store);
        
        if (targetLayer && window.innerWidth > 768) {
          state.markerCluster.zoomToShowLayer(targetLayer, () => {
            targetLayer.openPopup();
          });
        }
        
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

function setupFilters() {
  dom.filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      if (pill.dataset.filter === 'near') {
        if (!navigator.geolocation) {
          alert('您的瀏覽器不支援定位功能');
          return;
        }
        
        pill.classList.add('locating');
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            pill.classList.remove('locating');
            state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            addUserLocationMarker(pos.coords.latitude, pos.coords.longitude);
            state.map.flyTo([pos.coords.latitude, pos.coords.longitude], 14, { duration: 1.2 });
            
            dom.filterPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            state.activeFilter = pill.dataset.filter;
            applyFilters();
          },
          (err) => {
            pill.classList.remove('locating');
            if (err.code === err.PERMISSION_DENIED) {
              alert('定位權限已被拒絕，請在瀏覽器設定中啟用');
            } else {
              alert('無法取得位置資訊，請再試一次');
            }
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
        );
        return;
      }

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
  let filtered = [...state.stores];

  if (state.activeFilter === 'op15') {
    filtered = filtered.filter(s => s.products.includes('OP-15'));
  } else if (state.activeFilter === 'op16') {
    filtered = filtered.filter(s => s.products.includes('OP-16'));
  } else if (state.activeFilter === 'near' && state.userLocation) {
    filtered.forEach(s => {
      s.distance = getDistance(state.userLocation.lat, state.userLocation.lng, s.lat, s.lng);
    });
    // Filter within 20km and take top 50
    filtered = filtered.filter(s => s.distance <= 20).sort((a, b) => a.distance - b.distance).slice(0, 50);
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
  dom.statsTotal.textContent = state.stores.length.toLocaleString();
}

// ---------------------------------------------------------------------------
// Geolocation
// ---------------------------------------------------------------------------
function setupGeolocation() {
  dom.geolocateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert('您的瀏覽器不支援定位功能');
      return;
    }

    dom.geolocateBtn.classList.add('locating');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        dom.geolocateBtn.classList.remove('locating');
        const { latitude, longitude } = pos.coords;
        state.map.flyTo([latitude, longitude], 14, { duration: 1.2 });
        addUserLocationMarker(latitude, longitude);
      },
      (err) => {
        dom.geolocateBtn.classList.remove('locating');
        if (err.code === err.PERMISSION_DENIED) {
          alert('定位權限已被拒絕，請在瀏覽器設定中啟用');
        } else {
          alert('無法取得位置資訊，請再試一次');
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      }
    );
  });
}

function addUserLocationMarker(lat, lng) {
  if (state.userMarker) {
    state.map.removeLayer(state.userMarker);
  }

  const icon = L.divIcon({
    className: 'custom-user-marker',
    html: '<div style="width: 20px; height: 20px; background: #3b82f6; border: 3px solid white; border-radius: 50%; box-shadow: 0 0 12px rgba(59, 130, 246, 0.6), 0 0 30px rgba(59, 130, 246, 0.3);"></div>',
    iconSize: [26, 26],
    iconAnchor: [13, 13]
  });

  state.userMarker = L.marker([lat, lng], { icon }).addTo(state.map);
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
