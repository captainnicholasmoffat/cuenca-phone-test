// T1-01 phone test (prototype). Runs stretch S4 in CesiumJS (our own 3D Tiles) and MapLibre GL JS (terrain),
// three 25 s camera paths each, and measures fps, JS heap, MB through the service worker and time to first full view.
const KEY = 't1-01-results';
const params = new URLSearchParams(location.search);
const PATH_SECONDS = Number(params.get('secs')) || 25;
const FIRST_VIEW_TIMEOUT_S = 120;
// T1-02: one render pixel ratio for every mode, so engines compare like with like (brief-check change 5a). Default 1 = CSS pixels.
const PIXEL_RATIO = Number(params.get('pr')) || 1;
// T1-02 "Google 3D": the key is read only from this page's address at run time. It is not put in the results or in
// localStorage, and the service worker does not cache addresses that carry it; it does stay in the browser's history.
const GOOGLE_KEY = params.get('gkey');
const MODES = ['cesium', 'maplibre', 'realista', 'google3d'];
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const FIRST_VIEW_RULE = {
  cesium: 'first frame after the opening view with tileset.tilesLoaded true, from navigation start',
  maplibre: 'first map idle after the opening view, from navigation start',
  realista: 'first frame after the opening view with globe.tilesLoaded true, from navigation start',
  google3d: 'first gmp-steadychange with isSteady true after the opening view, from navigation start (untested)',
};
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
  const widget = new C.CesiumWidget(view, { baseLayer: false, scene3DOnly: true, requestRenderMode: false, useBrowserRecommendedResolution: false });
  widget.resolutionScale = PIXEL_RATIO / devicePixelRatio;
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
    container: view, maxPitch: 89, attributionControl: { compact: true }, pixelRatio: PIXEL_RATIO,
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

// ---------- T1-02 realista: CesiumJS + open imagery on open terrain, our own water surface and convoy ----------
// Terrain: AWS terrarium tiles decoded in the page (the MapLibre mode's source). shortcut: tile edges are sampled
// independently, so neighbours can differ by one DEM pixel; Cesium's skirts hide the crack. Upgrade: a quantized-mesh build.
function terrariumProvider(C) {
  const N = 33, MAXZ = 12;
  const ctx = new OffscreenCanvas(256, 256).getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const tile = (z, x, y) => {
    const k = `${z}/${x}/${y}`;
    if (!cache.has(k)) cache.set(k, fetch(DEM_TILES.replace('{z}', z).replace('{x}', x).replace('{y}', y))
      .then((r) => { if (!r.ok) throw new Error(`terrain tile ${k}: HTTP ${r.status}`); return r.blob(); })
      .then(createImageBitmap).then((bmp) => { ctx.drawImage(bmp, 0, 0); return ctx.getImageData(0, 0, 256, 256).data; })
      .catch((e) => { cache.delete(k); throw e; })); // a failed tile is retried on the next request, not cached
    if (cache.size > 64) cache.delete(cache.keys().next().value); // cap: 64 × 256 KB decoded; Cesium keeps its own terrain cache
    return cache.get(k);
  };
  return new C.CustomHeightmapTerrainProvider({
    width: N, height: N, tilingScheme: new C.WebMercatorTilingScheme(),
    callback: async (x, y, level) => {
      const z = Math.min(level, MAXZ), f = 2 ** (level - z);
      const px = await tile(z, Math.floor(x / f), Math.floor(y / f));
      const ox = (x % f) * 256 / f, oy = (y % f) * 256 / f, span = 256 / f;
      const h = new Float32Array(N * N);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        // bilinear: nearest sampling made 1-pixel steps (walls) below zoom 12, seen in the first horizon screenshot
        const u = Math.min(254.999, ox + i * span / (N - 1)), v = Math.min(254.999, oy + j * span / (N - 1));
        const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0;
        const e = (uu, vv) => { const o = (vv * 256 + uu) * 4; return px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768; };
        const val = (e(u0, v0) * (1 - fu) + e(u0 + 1, v0) * fu) * (1 - fv) + (e(u0, v0 + 1) * (1 - fu) + e(u0 + 1, v0 + 1) * fu) * fv;
        h[j * N + i] = Math.max(0, val); // negative DEM spikes clipped to 0
      }
      return h;
    },
  });
}

const waterLevel = (lat) => 47 + (lat + 27.316) / (27.316 - 25.266) * 11 + 1;

async function startRealista(view, line, first) {
  window.CESIUM_BASE_URL = new URL('lib/cesium/', location.href).href;
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'lib/cesium/Widgets/widgets.css' }));
  await loadScript('lib/cesium/Cesium.js');
  const C = window.Cesium;
  C.Ion.defaultAccessToken = '';
  const widget = new C.CesiumWidget(view, { baseLayer: false, scene3DOnly: true, requestRenderMode: false, useBrowserRecommendedResolution: false,
    terrainProvider: terrariumProvider(C) });
  widget.resolutionScale = PIXEL_RATIO / devicePixelRatio;
  const scene = widget.scene;
  scene.globe.baseColor = C.Color.fromCssColorString('#4a5a3a');
  // draw only the S4 box that the imagery covers; outside it the single-tile layers smeared their edge pixels
  const box = await (await fetch('realista/img_base.json')).json();
  scene.globe.cartographicLimitRectangle = C.Rectangle.fromDegrees(box.west, box.south, box.east, box.north);
  const credit = '© ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0)';
  for (const name of ['img_base', 'img_lowpass', 'img_horizon']) {
    const m = await (await fetch(`realista/${name}.json`)).json();
    const rectangle = C.Rectangle.fromDegrees(m.west, m.south, m.east, m.north);
    // the layer's own rectangle stops Cesium from stretching the image's edge pixels across the globe (seen in the first screenshots)
    widget.imageryLayers.add(new C.ImageryLayer(await C.SingleTileImageryProvider.fromUrl(`realista/${name}.jpg`, {
      rectangle, credit: name === 'img_base' ? credit : undefined }), { rectangle }));
  }
  // water: river polygon traced from ESA WorldCover class 80, drawn with Cesium's animated water material on the terrain
  const water = await (await fetch('realista/water.geojson')).json();
  // A flat sheet at a water level that falls linearly from Asunción to Confluencia, 1 m over the DEM's own water surface.
  // A GroundPrimitive draped on the terrain drew a slab with a wall in the horizon view (first screenshots), so it was dropped.
  // shortcut: the level is a straight line between two DEM samples (58 m at Asunción, 47 m at Confluencia, terrarium z12);
  // upgrade to gauge levels (hydrometric stations) for a real twin.
  const ring = (r) => C.Cartesian3.fromDegreesArrayHeights(r.flatMap(([lon, lat]) => [lon, lat, waterLevel(lat)]));
  const instances = water.features.map((f) => new C.GeometryInstance({ geometry: new C.PolygonGeometry({ perPositionHeight: true,
    polygonHierarchy: new C.PolygonHierarchy(ring(f.geometry.coordinates[0]), f.geometry.coordinates.slice(1).map((r) => new C.PolygonHierarchy(ring(r)))) }) }));
  scene.primitives.add(new C.Primitive({ geometryInstances: instances, appearance: new C.MaterialAppearance({
    material: new C.Material({ fabric: { type: 'Water', uniforms: {
      baseWaterColor: C.Color.fromCssColorString('#6b6343').withAlpha(0.9), blendColor: C.Color.fromCssColorString('#7a7350'),
      normalMap: C.buildModuleUrl('Assets/Textures/waterNormals.jpg'), frequency: 2000, animationSpeed: 0.02, amplitude: 3, specularIntensity: 0.35 } } }) }) }));
  // one push convoy at real dimensions (3 x 3 barges of 60 x 11 m + 40 m pusher), in the low-pass view
  const cum = [0]; for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i - 1], line[i]));
  const along = (m) => { const i = cum.findIndex((c) => c >= m); const f = (m - cum[i - 1]) / (cum[i] - cum[i - 1]);
    return [line[i - 1][0] + f * (line[i][0] - line[i - 1][0]), line[i - 1][1] + f * (line[i][1] - line[i - 1][1])]; };
  // on the centreline 1.5 km ahead of the low pass's mid-point; the coarse line near Asunción runs over the city, not the river (rule-6 check)
  const at = along(16500), hdg = bearing(at, along(16800));
  const model = await C.Model.fromGltfAsync({ url: 'realista/convoy.glb',
    modelMatrix: C.Transforms.headingPitchRollToFixedFrame(C.Cartesian3.fromDegrees(at[0], at[1], waterLevel(at[1])), new C.HeadingPitchRoll(rad(hdg - 90), 0, 0)) });
  scene.primitives.add(model);
  window.__t1convoy = { lon: at[0], lat: at[1], heading: hdg };
  const setCamera = (c) => widget.camera.setView({ destination: C.Cartesian3.fromDegrees(c.lon, c.lat, c.alt),
    orientation: { heading: rad(c.heading), pitch: rad(c.pitch), roll: 0 } });
  setCamera(first);
  let frames = 0;
  const loaded = new Promise((r) => { const off = scene.postRender.addEventListener(() => { if (++frames > 2 && scene.globe.tilesLoaded) { off(); r(); } }); });
  const ok = await withTimeout(loaded, FIRST_VIEW_TIMEOUT_S);
  window.__t1scene = { widget, C };
  return { setCamera, firstViewOk: ok, canvas: () => [widget.canvas.width, widget.canvas.height] };
}

// ---------- T1-02 Google 3D (Maps JavaScript 3D Maps): runs only with a key given in the address ----------
async function startGoogle3d(view, line, first) {
  if (!GOOGLE_KEY) throw new Error('Google 3D needs a key in the address (?mode=google3d&gkey=...)');
  await new Promise((ok, fail) => {
    window.__t1g = ok;
    document.head.append(Object.assign(document.createElement('script'), { async: true, onerror: () => fail(new Error('Google Maps script failed to load')),
      src: `https://maps.googleapis.com/maps/api/js?loading=async&libraries=maps3d&callback=__t1g&key=${encodeURIComponent(GOOGLE_KEY)}` }));
  });
  const { Map3DElement } = await google.maps.importLibrary('maps3d');
  const cam = (c) => { // our camera (position + pitch) -> Google's look-at camera (ground centre, range, tilt)
    const pitch = Math.min(-1, c.pitch), ground = c.alt / Math.tan(rad(-pitch)), p = dest([c.lon, c.lat], c.heading, ground);
    return { center: { lat: p[1], lng: p[0], altitude: 0 }, range: Math.hypot(ground, c.alt), tilt: 90 + pitch, heading: c.heading };
  };
  const map = new Map3DElement({ ...cam(first), mode: 'SATELLITE' });
  view.append(map);
  const setCamera = (c) => Object.assign(map, cam(c));
  // first full view: Google's steady event if it fires (untested here: no key in this environment)
  const ok = await withTimeout(new Promise((r) => map.addEventListener('gmp-steadychange', (e) => { if (e.isSteady) r(); })), FIRST_VIEW_TIMEOUT_S);
  return { setCamera, firstViewOk: ok, canvas: () => 'not reported (inside the Google element)' };
}

// ---------- run one mode ----------
async function runMode(mode, auto) {
  document.body.classList.add('running', mode);
  const hudEl = $('hud');
  const hud = (s) => { hudEl.textContent = `${mode} · ${s}`; };
  hud('cargando…');
  const sw = await serviceWorkerReady();
  const s0 = snap();
  const line = (await (await fetch('data/s4.geojson')).json()).features[0].geometry.coordinates;
  const paths = makePaths(line);
  const first = paths[0].cam(0);
  const engine = await ({ cesium: startCesium, maplibre: startMapLibre, realista: startRealista, google3d: startGoogle3d })[mode]($('view'), line, first);
  const firstView = performance.now() / 1000;
  const load = diff(s0, snap());
  if (params.has('still')) { // screenshot mode (unmeasured): hold one path at its mid-point until the view has loaded
    const p = paths.find((x) => x.name === params.get('still'));
    engine.setCamera(p.cam(0.5)); hud(`${p.label} (vista fija)`);
    const sc = window.__t1scene?.widget.scene, ts = window.__t1tileset;
    for (let i = 0; i < 600 && !(sc ? sc.globe.tilesLoaded : ts ? ts.tilesLoaded : i > 20); i++) await new Promise((r) => setTimeout(r, 250));
    window.__t1still = true; return;
  }
  const results = [];
  for (const p of paths) results.push(await runPath(p, engine.setCamera, hud));
  const hosts = { ...net.hosts };
  const result = {
    test: mode === 'realista' || mode === 'google3d' ? 'T1-02' : 'T1-01', mode, offline: !navigator.onLine, served_from_cache_only: load.requests_network === 0 && load.requests_cache > 0,
    date: new Date().toISOString(), path_seconds: PATH_SECONDS, service_worker: sw,
    first_full_view_s: engine.firstViewOk ? +firstView.toFixed(2) : `timeout after ${FIRST_VIEW_TIMEOUT_S} s`,
    first_full_view_rule: FIRST_VIEW_RULE[mode],
    load, paths: results, canvas_px: engine.canvas(), pixel_ratio: mode === 'google3d' ? 'not set (Google element)' : PIXEL_RATIO, hosts,
    cesium_ion_or_google_requests: Object.entries(hosts).filter(([h]) => ION_HOSTS.test(h.split(':')[0])).reduce((a, [, n]) => a + n, 0),
    device: await device(),
  };
  if (mode === 'google3d') { // Google requests bypass the service worker, so its byte and request counts would read near 0
    for (const o of [result.load, ...result.paths]) for (const k of ['mb_network', 'mb_per_min', 'requests_network']) if (k in o) o[k] = 'not counted';
    Object.assign(result, { cesium_ion_or_google_requests: 'not counted', network_note: 'Google requests bypass the service worker: not counted' });
  }
  const all = loadResults(); all.push(result); saveResults(all);
  window.__t1last = result;
  const next = { cesium: 'maplibre', maplibre: 'realista' }[mode];
  const keep = ['secs', 'pr'].filter((k) => params.has(k)).map((k) => `&${k}=${params.get(k)}`).join('');
  if (auto && next) { location.replace(`?mode=${next}&auto=1${keep}`); return; }
  location.replace('./?done=1');
}

// ---------- results page ----------
function render() {
  const all = loadResults();
  const body = $('table').tBodies[0];
  body.replaceChildren(...all.flatMap((r) => r.paths.map((p) => {
    const tr = document.createElement('tr');
    const cells = [r.mode + (r.offline ? ' (sin red)' : ''), p.path, p.fps_median, p.fps_p5, p.heap_peak_mb, p.mb_network, p.mb_per_min, p.requests_failed, Array.isArray(r.canvas_px) ? r.canvas_px.join('×') : '—'];
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
$('only-realista').addEventListener('click', () => location.assign('?mode=realista'));
$('google3d').addEventListener('click', () => { // the key travels in the address only (not cached by sw.js, not in results); it stays in browser history
  if (GOOGLE_KEY) location.assign(`?mode=google3d&gkey=${encodeURIComponent(GOOGLE_KEY)}`);
  else $('google-tip').textContent = 'Falta la clave: abrí esta página con ?gkey=TU_CLAVE en la dirección.';
});
$('clear').addEventListener('click', () => { saveResults([]); render(); });

const mode = params.get('mode');
if (MODES.includes(mode)) {
  runMode(mode, params.has('auto')).catch((e) => {
    const all = loadResults(); all.push({ test: mode === 'realista' || mode === 'google3d' ? 'T1-02' : 'T1-01', mode, error: String(e && e.stack || e), date: new Date().toISOString(), paths: [] }); saveResults(all);
    location.replace('./?done=1');
  });
} else {
  serviceWorkerReady();
  render();
}
