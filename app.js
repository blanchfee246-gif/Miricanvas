(function () {
  'use strict';

  const STORAGE_KEY = 'travel-route-map:v1';
  const GEOCODE_URL = 'https://nominatim.openstreetmap.org/search';
  const PHOTON_URL = 'https://photon.komoot.io/api/';
  const GEOCODE_DELAY_MS = 1100; // Nominatim 이용 정책: 초당 1회 이하

  // ---------- 상태 ----------
  let places = loadPlaces();   // [{ id, name, address, lat, lng }]
  let loopRoute = false;
  try { loopRoute = localStorage.getItem(STORAGE_KEY + ':loop') === '1'; } catch (e) { /* noop */ }

  // ---------- 지도 ----------
  const map = L.map('map', { zoomControl: true }).setView([36.5, 127.8], 7);
  // 기본: OpenStreetMap 타일. 불러오지 못하면 Esri 지도로 자동 전환
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  let tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: OSM_ATTR
  }).addTo(map);
  let tileErrors = 0;
  let usingFallback = false;
  tiles.on('tileerror', () => {
    if (usingFallback || ++tileErrors < 3) return;
    usingFallback = true;
    map.removeLayer(tiles);
    tiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri'
    }).addTo(map);
    tiles.bringToBack();
  });

  const markerLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const arrowLayer = L.layerGroup().addTo(map);
  const markers = new Map(); // id -> marker

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const form = $('add-form');
  const input = $('place-input');
  const addBtn = $('add-btn');
  const statusEl = $('status');
  const listEl = $('place-list');
  const emptyEl = $('empty');
  const summaryEl = $('summary');
  const loopToggle = $('loop-toggle');
  const pendingEl = $('pending');
  const pendingList = $('pending-list');
  const pickBanner = $('pick-banner');
  const pickText = $('pick-text');
  const mapEl = $('map');
  let pending = [];        // 검색으로 찾지 못한 이름들
  let picking = null;      // 지도에서 위치를 찍는 중인 이름
  loopToggle.checked = loopRoute;

  // ---------- 저장 ----------
  function loadPlaces() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : [];
      return Array.isArray(data) ? data.filter(p => isFinite(p.lat) && isFinite(p.lng)) : [];
    } catch (e) {
      return [];
    }
  }
  function savePlaces() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(places));
      localStorage.setItem(STORAGE_KEY + ':loop', loopRoute ? '1' : '0');
    } catch (e) { /* 저장 불가 환경은 무시 */ }
  }

  // ---------- 유틸 ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function haversineKm(a, b) {
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function formatKm(km) {
    return km >= 100 ? Math.round(km).toLocaleString('ko-KR') : km.toFixed(1);
  }

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
  }

  function parseInput(text) {
    return text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  }

  // ---------- 지오코딩 ----------
  async function geocodeNominatim(query) {
    const url = GEOCODE_URL + '?' + new URLSearchParams({
      q: query, format: 'jsonv2', limit: '1', 'accept-language': 'ko'
    });
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.length) return null;
    const r = data[0];
    return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), address: r.display_name };
  }

  async function geocodePhoton(query) {
    const url = PHOTON_URL + '?' + new URLSearchParams({ q: query, limit: '1' });
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const f = data.features && data.features[0];
    if (!f) return null;
    const pr = f.properties || {};
    const address = [pr.name, pr.street, pr.district, pr.city, pr.state, pr.country]
      .filter((v, i, a) => v && a.indexOf(v) === i).join(', ');
    return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], address };
  }

  // Nominatim이 막히거나 결과가 없으면 Photon으로 한 번 더 검색
  // ---------- 카카오 장소 검색 (키가 있을 때만) ----------
  const KAKAO_KEY_STORAGE = STORAGE_KEY + ':kakao';
  let kakaoReady = null; // Promise<boolean>

  function getKakaoKey() {
    if (window.KAKAO_JS_KEY) return String(window.KAKAO_JS_KEY).trim();
    try { return (localStorage.getItem(KAKAO_KEY_STORAGE) || '').trim(); } catch (e) { return ''; }
  }

  function loadKakao() {
    const key = getKakaoKey();
    if (!key) return Promise.resolve(false);
    if (kakaoReady) return kakaoReady;
    kakaoReady = new Promise((resolve) => {
      const sc = document.createElement('script');
      sc.src = 'https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&libraries=services&appkey=' + encodeURIComponent(key);
      sc.onload = () => {
        try {
          kakao.maps.load(() => resolve(!!(kakao.maps.services && kakao.maps.services.Places)));
        } catch (e) { resolve(false); }
      };
      sc.onerror = () => resolve(false);
      document.head.appendChild(sc);
      setTimeout(() => resolve(false), 8000);
    });
    return kakaoReady;
  }

  function kakaoCall(fn) {
    return new Promise((resolve) => {
      try { fn((data, status) => resolve(status === kakao.maps.services.Status.OK && data.length ? data[0] : null)); }
      catch (e) { resolve(null); }
    });
  }

  async function geocodeKakao(query) {
    if (!(await loadKakao())) return null;
    const pl = await kakaoCall(cb => new kakao.maps.services.Places().keywordSearch(query, cb));
    if (pl) {
      return {
        lat: parseFloat(pl.y), lng: parseFloat(pl.x),
        address: [pl.place_name, pl.road_address_name || pl.address_name].filter(Boolean).join(' · ')
      };
    }
    const ad = await kakaoCall(cb => new kakao.maps.services.Geocoder().addressSearch(query, cb));
    if (ad) return { lat: parseFloat(ad.y), lng: parseFloat(ad.x), address: ad.address_name };
    return null;
  }

  let lastUsedFreeApi = false;

  async function geocode(query) {
    lastUsedFreeApi = false;
    const k = await geocodeKakao(query);
    if (k) return k;
    lastUsedFreeApi = true;
    let networkError = null;
    try {
      const r = await geocodeNominatim(query);
      if (r) return r;
    } catch (e) { networkError = e; }
    try {
      const r = await geocodePhoton(query);
      if (r) return r;
    } catch (e) { networkError = networkError || e; }
    if (networkError) throw networkError;
    return null;
  }

  async function addPlaces(names) {
    addBtn.disabled = true;
    const failed = [];
    let added = 0;
    let netFail = 0;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      setStatus(`검색 중… (${i + 1}/${names.length}) ${name}`);
      try {
        const r = await geocode(name);
        if (r) {
          places.push({ id: uid(), name, address: r.address, lat: r.lat, lng: r.lng });
          added++;
          savePlaces();
          render({ fit: true });
        } else {
          failed.push(name);
        }
      } catch (e) {
        failed.push(name);
        netFail++;
      }
      if (i < names.length - 1 && lastUsedFreeApi) await sleep(GEOCODE_DELAY_MS);
    }
    addBtn.disabled = false;
    input.value = '';
    failed.forEach(n => { if (!pending.includes(n)) pending.push(n); });
    renderPending();
    if (netFail && netFail === failed.length && !added) {
      setStatus('장소 검색 서버에 연결하지 못했어요. 인터넷 연결을 확인하거나, 아래 목록에서 지도에 직접 찍어 주세요.', true);
    } else if (failed.length) {
      setStatus(`${added ? added + '곳 추가 · ' : ''}${failed.length}곳은 검색되지 않았어요. 아래에서 "지도에서 찍기"를 눌러 직접 위치를 정해 주세요.`, true);
    } else {
      setStatus(added ? `${added}곳을 추가했어요.` : '');
    }
  }

  // ---------- 찾지 못한 곳: 지도에서 직접 찍기 ----------
  function renderPending() {
    pendingEl.hidden = pending.length === 0;
    pendingList.innerHTML = pending.map((n, i) => `
      <li>
        <span class="pn" title="${escapeHtml(n)}">${escapeHtml(n)}</span>
        <button type="button" class="btn small primary" data-pick="${i}">지도에서 찍기</button>
        <button type="button" class="icon-btn" data-drop="${i}" title="목록에서 빼기">✕</button>
      </li>`).join('');
  }

  pendingList.addEventListener('click', (e) => {
    const pickBtn = e.target.closest('[data-pick]');
    const dropBtn = e.target.closest('[data-drop]');
    if (pickBtn) startPicking(pending[Number(pickBtn.dataset.pick)]);
    if (dropBtn) {
      const name = pending[Number(dropBtn.dataset.drop)];
      pending.splice(Number(dropBtn.dataset.drop), 1);
      if (picking === name) stopPicking();
      renderPending();
    }
  });

  async function startPicking(name) {
    picking = name;
    mapEl.classList.add('picking');
    pickText.textContent = `"${name}" 위치를 지도에서 눌러 주세요`;
    pickBanner.hidden = false;
    // 이름 일부(예: "소노벨 청송" → "청송")로 대략적인 지역을 찾아 지도를 옮겨 줌
    const words = name.split(/\s+/).filter(w => w.length > 1);
    if (words.length > 1) {
      for (const w of words.slice().reverse()) {
        if (picking !== name) return;
        try {
          const r = await geocodeNominatim(w);
          if (r && picking === name) {
            map.setView([r.lat, r.lng], 12);
            pickText.textContent = `"${name}" — "${w}" 근처로 이동했어요. 정확한 위치를 눌러 주세요`;
            return;
          }
        } catch (e) { /* 무시 */ }
        await sleep(GEOCODE_DELAY_MS);
      }
    }
  }

  function stopPicking() {
    picking = null;
    mapEl.classList.remove('picking');
    pickBanner.hidden = true;
  }

  $('pick-cancel').addEventListener('click', stopPicking);

  map.on('click', (e) => {
    if (!picking) return;
    const name = picking;
    places.push({ id: uid(), name, address: '지도에서 직접 지정한 위치', lat: e.latlng.lat, lng: e.latlng.lng });
    pending = pending.filter(n => n !== name);
    stopPicking();
    savePlaces();
    renderPending();
    render();
    setStatus(`"${name}"을(를) 추가했어요. 핀을 길게 눌러 끌면 위치를 고칠 수 있어요.`);
  });

  // ---------- 렌더링 ----------
  const PIN = 24;          // 핀 크기(px)
  const PIN_GAP = 22;      // 이 거리(px)보다 가까운 핀끼리는 옆으로 벌려 배치

  // dx: 겹침을 피하려고 핀을 옆으로 옮기는 거리(px). 실제 위치는 작은 점으로 표시됨
  function pinIcon(num, kind, dx) {
    dx = dx || 0;
    return L.divIcon({
      className: 'pin-icon',
      html: `<div class="pin ${kind}${dx ? ' shifted' : ''}"><span>${num}</span></div>`,
      iconSize: [PIN, PIN],
      iconAnchor: [PIN / 2 - dx, PIN + 5],   // 회전된 핀 끝이 좌표를 가리키도록
      popupAnchor: [dx, -PIN - 2]
    });
  }

  // 화면에서 가까이 붙은 핀들을 묶어 가로로 나란히 펼침 (확대/축소할 때마다 다시 계산)
  function layoutPins() {
    const pts = places.map(p => map.latLngToLayerPoint([p.lat, p.lng]));
    const group = places.map((_, i) => i);
    const find = i => (group[i] === i ? i : (group[i] = find(group[i])));
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        // 핀은 세로로 길쭉하므로 위아래로는 더 넉넉하게 겹침을 판단
        if (Math.abs(pts[i].x - pts[j].x) < PIN_GAP && Math.abs(pts[i].y - pts[j].y) < PIN + 8) group[find(j)] = find(i);
      }
    }
    const members = new Map();
    places.forEach((_, i) => {
      const g = find(i);
      if (!members.has(g)) members.set(g, []);
      members.get(g).push(i);
    });
    members.forEach(list => {
      list.forEach((i, k) => {
        const m = markers.get(places[i].id);
        if (!m) return;
        const dx = list.length > 1 ? Math.round((k - (list.length - 1) / 2) * PIN_GAP) : 0;
        m.setIcon(pinIcon(i + 1, kindOf(i), dx));
      });
    });
  }

  function kindOf(i) {
    if (places.length < 2) return '';
    if (i === 0) return 'start';
    if (i === places.length - 1) return 'end';
    return '';
  }

  function legs() {
    const out = [];
    for (let i = 0; i < places.length - 1; i++) out.push([places[i], places[i + 1]]);
    if (loopRoute && places.length > 2) out.push([places[places.length - 1], places[0]]);
    return out;
  }

  function renderMap(fit) {
    markerLayer.clearLayers();
    routeLayer.clearLayers();
    markers.clear();

    places.forEach((p, i) => {
      const label = i === 0 && places.length > 1 ? ' (출발)' : (i === places.length - 1 && places.length > 1 ? ' (도착)' : '');
      const m = L.marker([p.lat, p.lng], { icon: pinIcon(i + 1, kindOf(i)), title: p.name, riseOnHover: true, draggable: true })
        .bindPopup(`<strong>${i + 1}. ${escapeHtml(p.name)}${label}</strong><br><small>${escapeHtml(p.address || '')}</small>`);
      m.on('dragend', () => {
        const ll = m.getLatLng();
        p.lat = ll.lat;
        p.lng = ll.lng;
        savePlaces();
        render();
      });
      m.addTo(markerLayer);
      markers.set(p.id, m);
      // 실제 위치를 가리키는 작은 점 (핀이 옆으로 밀려나도 정확한 위치를 알 수 있게)
      L.circleMarker([p.lat, p.lng], {
        radius: 3, color: '#fff', weight: 1.5, fillColor: '#1d2433', fillOpacity: 1, interactive: false
      }).addTo(markerLayer);
    });

    legs().forEach(([a, b], idx) => {
      const isReturn = loopRoute && idx === places.length - 1;
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
        color: '#fff', weight: 7, opacity: 0.9
      }).addTo(routeLayer);
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
        color: '#3867d6', weight: 4, opacity: 0.9, dashArray: isReturn ? '6 8' : null
      }).addTo(routeLayer);
    });

    renderArrows();
    layoutPins();

    if (fit) fitAll();
  }

  // 각 구간 가운데에 진행 방향 화살표 (화면 기준 각도라 확대/축소 시 다시 계산)
  function renderArrows() {
    arrowLayer.clearLayers();
    legs().forEach(([a, b]) => {
      const pa = map.latLngToLayerPoint([a.lat, a.lng]);
      const pb = map.latLngToLayerPoint([b.lat, b.lng]);
      if (pa.distanceTo(pb) < 40) return; // 너무 가까우면 생략
      const angle = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
      const mid = map.layerPointToLatLng(L.point((pa.x + pb.x) / 2, (pa.y + pb.y) / 2));
      L.marker(mid, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: '',
          html: `<div class="route-arrow" style="transform: rotate(${angle}deg)">▶</div>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        })
      }).addTo(arrowLayer);
    });
  }
  map.on('zoomend', () => { renderArrows(); layoutPins(); });

  function fitAll() {
    if (!places.length) return;
    if (places.length === 1) {
      map.setView([places[0].lat, places[0].lng], 13);
    } else {
      map.fitBounds(L.latLngBounds(places.map(p => [p.lat, p.lng])), { padding: [60, 60], maxZoom: 14 });
    }
  }

  function renderList() {
    listEl.innerHTML = '';
    emptyEl.hidden = places.length > 0;
    summaryEl.hidden = places.length === 0;

    let total = 0;
    const allLegs = legs();
    allLegs.forEach(([a, b]) => { total += haversineKm(a, b); });
    $('sum-count').textContent = places.length;
    $('sum-dist').textContent = formatKm(total);

    places.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'place';
      li.draggable = true;
      li.dataset.index = i;

      let legText = '';
      if (i < places.length - 1) {
        legText = `↓ 다음 장소까지 약 ${formatKm(haversineKm(p, places[i + 1]))}km`;
      } else if (loopRoute && places.length > 2) {
        legText = `↺ 출발지까지 약 ${formatKm(haversineKm(p, places[0]))}km`;
      }

      li.innerHTML = `
        <div class="place-num ${kindOf(i)}">${i + 1}</div>
        <div class="place-body">
          <div class="place-name">${escapeHtml(p.name)}</div>
          <div class="place-addr" title="${escapeHtml(p.address || '')}">${escapeHtml(p.address || '')}</div>
          ${legText ? `<div class="place-leg">${legText}</div>` : ''}
        </div>
        <div class="place-actions">
          <button type="button" class="icon-btn" data-act="up" title="위로" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" class="icon-btn" data-act="down" title="아래로" ${i === places.length - 1 ? 'disabled' : ''}>▼</button>
          <button type="button" class="icon-btn" data-act="del" title="삭제">✕</button>
        </div>`;
      listEl.appendChild(li);
    });
  }

  function render(opts) {
    renderList();
    renderMap(opts && opts.fit);
  }

  // ---------- 순서 변경 / 삭제 ----------
  function move(from, to) {
    if (to < 0 || to >= places.length || from === to) return;
    const [item] = places.splice(from, 1);
    places.splice(to, 0, item);
    savePlaces();
    render();
  }

  listEl.addEventListener('click', (e) => {
    const li = e.target.closest('.place');
    if (!li) return;
    const i = Number(li.dataset.index);
    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === 'up') move(i, i - 1);
      else if (act.dataset.act === 'down') move(i, i + 1);
      else if (act.dataset.act === 'del') {
        places.splice(i, 1);
        savePlaces();
        render();
      }
      return;
    }
    const p = places[i];
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), 13));
    const m = markers.get(p.id);
    if (m) m.openPopup();
  });

  // 드래그 앤 드롭으로 순서 변경
  let dragFrom = null;
  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.place');
    if (!li) return;
    dragFrom = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  listEl.addEventListener('dragover', (e) => {
    const li = e.target.closest('.place');
    if (!li || dragFrom === null) return;
    e.preventDefault();
    listEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    li.classList.add('drag-over');
  });
  listEl.addEventListener('drop', (e) => {
    const li = e.target.closest('.place');
    if (!li || dragFrom === null) return;
    e.preventDefault();
    move(dragFrom, Number(li.dataset.index));
  });
  listEl.addEventListener('dragend', () => {
    dragFrom = null;
    listEl.querySelectorAll('.dragging, .drag-over').forEach(el => el.classList.remove('dragging', 'drag-over'));
  });

  // ---------- 입력 ----------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (addBtn.disabled) return;
    const names = parseInput(input.value);
    if (!names.length) {
      setStatus('여행지를 입력해 주세요.', true);
      return;
    }
    addPlaces(names);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  loopToggle.addEventListener('change', () => {
    loopRoute = loopToggle.checked;
    savePlaces();
    render();
  });

  $('fit-btn').addEventListener('click', fitAll);
  $('clear-btn').addEventListener('click', () => {
    if (!places.length) return;
    if (!confirm('모든 여행지를 삭제할까요?')) return;
    places = [];
    savePlaces();
    setStatus('');
    render();
  });

  // ---------- 카카오 키 설정 UI ----------
  const kakaoInput = $('kakao-key');
  const kakaoState = $('kakao-state');
  const kakaoMsg = $('kakao-msg');

  function showKakaoState(ok) {
    kakaoState.textContent = ok ? '켜짐' : '꺼짐';
    kakaoState.classList.toggle('on', ok);
  }

  async function checkKakao(announce) {
    if (!getKakaoKey()) { showKakaoState(false); return; }
    const ok = await loadKakao();
    showKakaoState(ok);
    if (announce) {
      kakaoMsg.textContent = ok
        ? '카카오 검색이 켜졌어요.'
        : '키를 확인하지 못했어요. 키가 맞는지, 카카오 콘솔에 이 사이트 주소(' + location.origin + ')를 등록했는지, 카카오맵 사용을 켰는지 확인해 주세요.';
      kakaoMsg.classList.toggle('error', !ok);
    }
  }

  if (window.KAKAO_JS_KEY) {
    $('kakao-box').hidden = true; // config.js에 키가 있으면 설정 칸 숨김
  } else {
    try { kakaoInput.value = localStorage.getItem(KAKAO_KEY_STORAGE) || ''; } catch (e) { /* noop */ }
  }

  $('kakao-save').addEventListener('click', () => {
    const key = kakaoInput.value.trim();
    try { localStorage.setItem(KAKAO_KEY_STORAGE, key); } catch (e) { /* noop */ }
    // 이미 불러온 SDK는 교체할 수 없으므로 키를 바꾸면 새로고침
    if (kakaoReady) { location.reload(); return; }
    if (!key) { showKakaoState(false); kakaoMsg.textContent = ''; return; }
    kakaoMsg.textContent = '확인 중…';
    kakaoMsg.classList.remove('error');
    checkKakao(true);
  });

  checkKakao(false);

  // ---------- 시작 ----------
  render({ fit: true });
})();
