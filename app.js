// T1-01 phone test (prototype). Runs stretch S4 in CesiumJS (our own 3D Tiles) and MapLibre GL JS (terrain),
// three 25 s camera paths each, and measures fps, JS heap, MB through the service worker and time to first full view.
const KEY = 't1-01-results';
const params = new URLSearchParams(location.search);
const PATH_SECONDS = Number(params.get('secs')) || 25;
const FIRST_VIEW_TIMEOUT_S = 120;
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const ION_HOSTS = /(^|\.)(cesium\.com|ion\.cesium\.com|virtualearth\.net|bing\.com|googleapis\.com|google\.com)$/;

const $ = (id) => document.getElementById(id);

// ---------- storage (per-viewer convenience; the page still works without it) ----------
function loadResults() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return window.__t1mem || []; }
}
function saveResults(list) {
  window.__t1mem = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage blocked: kept in memory only */ }
}

// ---------- network counters (from the service worker) ----------
const net = { net: 0, cache: 0, failed: 0, netReqs: 0, cacheReqs: 0, hosts: {} };
new BroadcastChannel('t1-01-net').addEventListener('message', ({ data }) => {
  if (data.kind === 'net') { net.net += data.bytes; net.netReqs++; }
  if (data.kind === 'cache') { net.cache += data.bytes; net.cacheReqs++; }
  if (data.kind === 'failed') net.failed++;
  net.hosts[data.host] = (net.hosts[data.host] || 0) + 1;
});
const snap = () => ({ ...net });
const diff = (a, b) => ({
  mb_network: +((b.net - a.net) / 1e6).toFixed(3),
  mb_from_cache: +((b.cache - a.cache) / 1e6).toFixed(3),
  requests_network: b.netReqs - a.netReqs,
  requests_cache: b.cacheReqs - a.cacheReqs,
  requests_failed: b.failed - a.failed,
});

async function serviceWorkerReady() {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  try {
    await navigator.serviceWorker.register('sw.js');
    if (navigator.serviceWorker.controller) return 'controlling';
    await Promise.race([
      new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    return navigator.serviceWorker.controller ? 'controlling' : 'not controlling';
  } catch (e) { return 'error: ' + e.message; }
}

// ---------- device ----------
async function device() {
  const d = {
    userAgent: navigator.userAgent,
    screen: [screen.width, screen.height], viewport: [innerWidth, innerHeight],
    devicePixelRatio: devicePixelRatio, cores: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: navigator.deviceMemory ?? null, online: navigator.onLine,
  };
  try {
    if (navigator.userAgentData) d.uaData = await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']);
  } catch { /* not offered */ }
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    d.webgl2 = !!gl;
    d.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : null);
  } catch { d.webgl2 = false; }
  return d;
}

// ---------- geometry for the camera paths ----------
const R = 6371008.8;
const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
function dist(a, b) {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function dest(p, brg, m) {
  const d = m / R, b = rad(brg), la = rad(p[1]), lo = rad(p[0]);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [deg(lo2), deg(la2)];
}

function makePaths(line) {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i - 1], line[i]));
  const total = cum.at(-1);
  const at = (m) => {
    m = Math.max(0, Math.min(total, m));
    let i = cum.findIndex((c) => c >= m); if (i <= 0) return line[0];
    const f = (m - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [line[i - 1][0] + f * (line[i][0] - line[i - 1][0]), line[i - 1][1] + f * (line[i][1] - line[i - 1][1])];
  };
  const xs = line.map((p) => p[0]), ys = line.map((p) => p[1]);
  const centre = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const asu = line.at(-1), downstream = bearing(asu, at(total - 20000));
  // each path: t in [0,1] -> camera {lon, lat, alt (m above ellipsoid), heading (deg), pitch (deg, 0 = horizon, -90 = down)}
  return [
    { name: 'opening', label: 'Vista inicial', cam: (t) => {
      const heading = -10 + 20 * t, pitch = -55, alt = 260000;
      const p = dest(centre, heading + 180, alt / Math.tan(rad(-pitch)));
      return { lon: p[0], lat: p[1], alt, heading, pitch };
    } },
    { name: 'lowpass', label: 'Pasada baja', cam: (t) => {
      const m = 30000 * t, p = at(m);
      return { lon: p[0], lat: p[1], alt: 300, heading: bearing(p, at(m + 2000)), pitch: -15 };
    } },
    { name: 'horizon', label: 'Horizonte', cam: (t) => {
      const p = at(total - 1000);
      return { lon: p[0], lat: p[1], alt: 150, heading: downstream - 40 + 80 * t, pitch: -2 };
    } },
  ];
}

// ---------- measurement ----------
function percentile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}
const heapMB = () => (performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null);

function runPath(path, setCamera, hud) {
  return new Promise((resolve) => {
    const fps = [];
    let start = null, last = null, peak = heapMB(), lastHeap = 0, secondFrames = [];
    const before = snap();
    const step = (now) => {
      if (start === null) { start = now; last = now; }
      const t = (now - start) / 1000 / PATH_SECONDS;
      if (now > last) { fps.push(1000 / (now - last)); secondFrames.push(now); }
      last = now;
      if (now - lastHeap > 500) { const h = heapMB(); if (h !== null) peak = Math.max(peak ?? 0, h); lastHeap = now; }
      while (secondFrames.length && now - secondFrames[0] > 1000) secondFrames.shift();
      hud(`${path.label} ${Math.min(PATH_SECONDS, (now - start) / 1000).toFixed(0)}/${PATH_SECONDS} s · ${secondFrames.length} fps`);
      if (t >= 1) {
        const s = fps.slice().sort((a, b) => a - b);
        const n = diff(before, snap());
        resolve({
          path: path.name, seconds: +((now - start) / 1000).toFixed(2), frames: fps.length,
          fps_median: s.length ? +percentile(s, 0.5).toFixed(1) : null,
          fps_p5: s.length ? +percentile(s, 0.05).toFixed(1) : null,
          heap_peak_mb: peak === null ? 'not reported' : +peak.toFixed(1),
          ...n, mb_per_min: +(n.mb_network / ((now - start) / 60000)).toFixed(3),
        });
        return;
      }
      setCamera(path.cam(t));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = Object.assign(document.createElement('script'), { src, onload: ok, onerror: () => fail(new Error('load ' + src)) });
    document.head.append(s);
  });
}
const withTimeout = (p, s) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), s * 1000))]);

// ---------- engines ----------
async function startCesium(view, line, first) {
  window.CESIUM_BASE_URL = new URL('lib/cesium/', location.href).href;
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'lib/cesium/Widgets/widgets.css' }));
  await loadScript('lib/cesium/Cesium.js');
  const C = window.Cesium;
  C.Ion.defaultAccessToken = '';
  const widget = new C.CesiumWidget(view, { baseLayer: false, scene3DOnly: true, requestRenderMode: false });
  widget.scene.globe.baseColor = C.Color.fromCssColorString('#1d2730');
  const tileset = await C.Cesium3DTileset.fromUrl('tiles/tileset.json');
  widget.scene.primitives.add(tileset);
  window.__t1tileset = tileset;
  widget.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArray(line.flat()), width: 3, clampToGround: true,
    classificationType: C.ClassificationType.BOTH, material: C.Color.fromCssColorString('#1e90ff') } });
  const setCamera = (c) => widget.camera.setView({ destination: C.Cartesian3.fromDegrees(c.lon, c.lat, c.alt),
    orientation: { heading: rad(c.heading), pitch: rad(c.pitch), roll: 0 } });
  setCamera(first);
  // first full view: the first rendered frame after the opening view where the tileset has nothing left to load
  let frames = 0;
  const loaded = new Promise((r) => { const off = widget.scene.postRender.addEventListener(() => { if (++frames > 2 && tileset.tilesLoaded) { off(); r(); } }); });
  const ok = await withTimeout(loaded, FIRST_VIEW_TIMEOUT_S);
  const canvas = widget.canvas;
  return { setCamera, firstViewOk: ok, canvas: () => [canvas.width, canvas.height] };
}

async function startMapLibre(view, line, first) {
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'lib/maplibre/maplibre-gl.css' }));
  const ml = await import('./lib/maplibre/maplibre-gl.mjs');
  const dem = { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 12,
    attribution: 'Elevación: AWS Terrain Tiles (Mapzen/Tilezen; USGS SRTM, GMTED2010) · Río: Natural Earth' };
  const map = new ml.Map({
    container: view, maxPitch: 89, attributionControl: { compact: true },
    style: { version: 8,
      sources: { dem, hs: { ...dem }, river: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } } } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#1d2730' } },
        { id: 'hs', type: 'hillshade', source: 'hs', paint: { 'hillshade-exaggeration': 0.6 } },
        { id: 'river', type: 'line', source: 'river', paint: { 'line-color': '#1e90ff', 'line-width': 3 } },
      ],
      terrain: { source: 'dem', exaggeration: 1 },
      sky: { 'sky-color': '#9cc3e6', 'horizon-color': '#dfe9f2', 'sky-horizon-blend': 0.5 } },
    center: [first.lon, first.lat], zoom: 6,
  });
  const setCamera = (c) => map.jumpTo(map.calculateCameraOptionsFromCameraLngLatAltRotation([c.lon, c.lat], c.alt, c.heading, 90 + c.pitch));
  await new Promise((r) => map.once('load', r));
  setCamera(first);
  const ok = await withTimeout(new Promise((r) => map.once('idle', r)), FIRST_VIEW_TIMEOUT_S);
  const canvas = map.getCanvas();
  return { setCamera, firstViewOk: ok, canvas: () => [canvas.width, canvas.height] };
}

// ---------- run one mode ----------
async function runMode(mode, auto) {
  document.body.classList.add('running');
  const hudEl = $('hud');
  const hud = (s) => { hudEl.textContent = `${mode} · ${s}`; };
  hud('cargando…');
  const sw = await serviceWorkerReady();
  const s0 = snap();
  const line = (await (await fetch('data/s4.geojson')).json()).features[0].geometry.coordinates;
  const paths = makePaths(line);
  const first = paths[0].cam(0);
  const engine = await (mode === 'cesium' ? startCesium : startMapLibre)($('view'), line, first);
  const firstView = performance.now() / 1000;
  const load = diff(s0, snap());
  const results = [];
  for (const p of paths) results.push(await runPath(p, engine.setCamera, hud));
  const hosts = { ...net.hosts };
  const result = {
    test: 'T1-01', mode, offline: !navigator.onLine, served_from_cache_only: load.requests_network === 0 && load.requests_cache > 0,
    date: new Date().toISOString(), path_seconds: PATH_SECONDS, service_worker: sw,
    first_full_view_s: engine.firstViewOk ? +firstView.toFixed(2) : `timeout after ${FIRST_VIEW_TIMEOUT_S} s`,
    first_full_view_rule: mode === 'cesium' ? 'first frame after the opening view with tileset.tilesLoaded true, from navigation start' : 'first map idle after the opening view, from navigation start',
    load, paths: results, canvas_px: engine.canvas(), hosts,
    cesium_ion_or_google_requests: Object.entries(hosts).filter(([h]) => ION_HOSTS.test(h.split(':')[0])).reduce((a, [, n]) => a + n, 0),
    device: await device(),
  };
  const all = loadResults(); all.push(result); saveResults(all);
  window.__t1last = result;
  if (auto && mode === 'cesium') { location.replace('?mode=maplibre&auto=1' + (params.get('secs') ? '&secs=' + PATH_SECONDS : '')); return; }
  location.replace('./?done=1');
}

// ---------- results page ----------
function render() {
  const all = loadResults();
  const body = $('table').tBodies[0];
  body.replaceChildren(...all.flatMap((r) => r.paths.map((p) => {
    const tr = document.createElement('tr');
    const cells = [r.mode + (r.offline ? ' (sin red)' : ''), p.path, p.fps_median, p.fps_p5, p.heap_peak_mb, p.mb_network, p.mb_per_min, p.requests_failed];
    tr.append(...cells.map((c) => Object.assign(document.createElement('td'), { textContent: c ?? '—' })));
    return tr;
  })));
  $('firstview').textContent = all.map((r) => `${r.mode}${r.offline ? ' sin red' : ''}: primera vista completa ${r.first_full_view_s} s, carga ${r.load?.mb_network ?? '—'} MB`).join(' · ');
  $('json').textContent = all.length ? JSON.stringify(all) : '';
  window.__t1done = params.has('done');
}

async function copy(button) {
  const tip = button.parentElement.querySelector('.tip');
  const text = $('json').textContent;
  if (!text) { tip.textContent = 'Todavía no hay resultados'; return; }
  try { await navigator.clipboard.writeText(text); tip.textContent = 'Copiado'; button.dataset.copied = ''; }
  catch { tip.textContent = 'No se pudo copiar: seleccioná el texto de abajo'; button.dataset.failed = ''; }
  setTimeout(() => { tip.textContent = ''; delete button.dataset.copied; delete button.dataset.failed; }, 3000);
}
if ('CommandEvent' in window) {
  document.addEventListener('command', (e) => { if (e.command === '--copy') copy(e.source); }, true);
} else {
  $('copy').addEventListener('click', (e) => copy(e.currentTarget));
}

$('start').addEventListener('click', () => location.assign('?mode=cesium&auto=1'));
$('only-cesium').addEventListener('click', () => location.assign('?mode=cesium'));
$('only-maplibre').addEventListener('click', () => location.assign('?mode=maplibre'));
$('clear').addEventListener('click', () => { saveResults([]); render(); });

const mode = params.get('mode');
if (mode === 'cesium' || mode === 'maplibre') {
  runMode(mode, params.has('auto')).catch((e) => {
    const all = loadResults(); all.push({ test: 'T1-01', mode, error: String(e && e.stack || e), date: new Date().toISOString(), paths: [] }); saveResults(all);
    location.replace('./?done=1');
  });
} else {
  serviceWorkerReady();
  render();
}
