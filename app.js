import * as THREE from "three";
import { MapControls } from "./vendor/MapControls.js";

// ===== 設定 =====
const API = "/api/progress";
const LEVELS = ["#fff09a", "#ffd166", "#ffab4c", "#ff7f66", "#ff6aa8", "#b58cff"]; // 1..6+
const UNLIT = "#9fbf86";
const TOWNS = { "馬公市": "#f0a95a", "湖西鄉": "#4fd08a", "白沙鄉": "#f39ad2", "西嶼鄉": "#e6d36a", "望安鄉": "#3fae5c", "七美鄉": "#c9cf1a" };
const ROOFS = ["#d9674e", "#3f8f93", "#e0a03a", "#6b6bb0", "#5a9a5a", "#c75b6b"];
const WALLS = ["#7c8794", "#8d8f80", "#7a7f8f", "#9a9486"];

const M = window.MAP;
const CX = M.w / 2, CZ = M.h / 2;
const byId = {};
M.villages.forEach(v => { v.key = v.town + "/" + v.name; byId[v.id] = v; });

// ===== 狀態 =====
let state = { visits: {} };
let mode = "remote", editKey = localStorage.getItem("sweepKey") || "", unlocked = false;
let selected = null, showLabels = true, night = false;
const count = v => (state.visits[v.key] || []).length;
const $ = s => document.querySelector(s);

// ===== Three.js 場景 =====
const stage = $("#stage");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY_DAY = new THREE.Color("#a9dde3"), SKY_NIGHT = new THREE.Color("#1a2744");
scene.background = SKY_DAY.clone();
scene.fog = new THREE.Fog(SKY_DAY.clone(), 220, 420);

const camera = new THREE.PerspectiveCamera(34, 1, 1, 1000);
// 像 Google Maps：拖曳平移、往游標/手指位置縮放、右鍵或雙指旋轉
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.zoomToCursor = true;
controls.zoomSpeed = 1.3;
controls.maxPolarAngle = 1.3;
controls.minDistance = 10;
controls.maxDistance = 380;
controls.screenSpacePanning = false;
controls.addEventListener("start", () => { fly = null; });
// 不讓鏡頭拖到太遠的海上
const LIMIT = { x: CX + 20, z: CZ + 20 };
function clampPan() {
  const t = controls.target, cx = Math.max(-LIMIT.x, Math.min(LIMIT.x, t.x)), cz = Math.max(-LIMIT.z, Math.min(LIMIT.z, t.z));
  if (cx !== t.x || cz !== t.z) { camera.position.x += cx - t.x; camera.position.z += cz - t.z; t.x = cx; t.z = cz; }
  t.y = 0;
}
const HOME = { pos: new THREE.Vector3(0, 200, 205), target: new THREE.Vector3(0, 0, 16) };
camera.position.copy(HOME.pos); controls.target.copy(HOME.target);

const hemi = new THREE.HemisphereLight("#eaf9ff", "#6d8f5e", 1.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight("#fff4e0", 2.4);
sun.position.set(-90, 160, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -130, right: 130, top: 130, bottom: -130, near: 10, far: 450 });
sun.shadow.bias = -0.0008;
scene.add(sun);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9, metalness: 0, ...extra });

// 海：低多邊形、會動
const seaGeo = new THREE.PlaneGeometry(700, 700, 90, 90);
seaGeo.rotateX(-Math.PI / 2);
const seaBase = Float32Array.from(seaGeo.attributes.position.array);
const seaMat = mat("#7ccfd6", { roughness: 0.55, transparent: true, opacity: 0.96 });
const sea = new THREE.Mesh(seaGeo, seaMat);
sea.position.y = 0.2; sea.receiveShadow = true;
scene.add(sea);

// 多邊形 -> 立體
function shapesFrom(polys) {
  return polys.map(p => {
    const toV = r => r.map(([x, y]) => new THREE.Vector2(x - CX, -(y - CZ)));
    const s = new THREE.Shape(toV(p[0]));
    p.slice(1).forEach(h => s.holes.push(new THREE.Path(toV(h))));
    return s;
  });
}
function extrude(polys, depth, bevel) {
  const g = new THREE.ExtrudeGeometry(shapesFrom(polys), {
    depth, bevelEnabled: !!bevel, bevelThickness: bevel?.t || 0, bevelSize: bevel?.s || 0, bevelSegments: 1, curveSegments: 1,
  });
  g.rotateX(-Math.PI / 2);
  return g;
}

const sand = new THREE.Mesh(extrude(M.sand, 0.8, { t: 0.9, s: 1.4 }), mat("#f0d79b"));
sand.position.y = -0.6; sand.receiveShadow = true; scene.add(sand);
const cliff = new THREE.Mesh(extrude(M.island, 1.5, { t: 0.4, s: 0.5 }), mat("#77a862"));
cliff.position.y = 0.2; cliff.receiveShadow = true; cliff.castShadow = true; scene.add(cliff);

// ===== 村里地塊 =====
const villageMeshes = [];
const BASE_H = 2.2;
M.villages.forEach(v => {
  const geo = extrude(v.poly, 1);
  const m = new THREE.Mesh(geo, mat(UNLIT));
  m.position.y = 0.2; m.castShadow = true; m.receiveShadow = true;
  m.userData.v = v; v.mesh = m; v.h = BASE_H; v.targetH = BASE_H;
  m.scale.y = BASE_H;
  v.decor = new THREE.Group(); scene.add(v.decor);
  scene.add(m); villageMeshes.push(m);
});

// 隨機但固定（每個村里每次長得一樣）
function rng(seed) { let s = 0; for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function inside(v, x, y) {
  for (const p of v.poly) {
    const hit = r => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
    if (hit(p[0]) && !p.slice(1).some(hit)) return true;
  }
  return false;
}
function spots(v, n, r, taken = []) {
  const R = rng(v.key + n), pts = [...taken];
  const xs = v.poly.flatMap(p => p[0].map(q => q[0])), ys = v.poly.flatMap(p => p[0].map(q => q[1]));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const out = [];
  for (let tries = 0; tries < 400 && out.length < n; tries++) {
    const x = x0 + R() * (x1 - x0), y = y0 + R() * (y1 - y0);
    if (!inside(v, x, y)) continue;
    if (!inside(v, x + 0.8, y) || !inside(v, x - 0.8, y) || !inside(v, x, y + 0.8) || !inside(v, x, y - 0.8)) continue;
    if (pts.some(p => (p[0] - x) ** 2 + (p[1] - y) ** 2 < r * r)) continue;
    pts.push([x, y]); out.push([x, y, R()]);
  }
  return out;
}

// 共用幾何
const G = {
  body: new THREE.BoxGeometry(1.5, 1.2, 1.5),
  roof: new THREE.ConeGeometry(1.35, 1, 4).rotateY(Math.PI / 4),
  win: new THREE.BoxGeometry(0.42, 0.42, 0.06),
  trunk: new THREE.CylinderGeometry(0.12, 0.2, 2.6, 5),
  leaf: new THREE.ConeGeometry(0.5, 2.0, 3).rotateX(Math.PI / 2).scale(1, 0.25, 1),
  bush: new THREE.IcosahedronGeometry(0.7, 0),
};
const M_TRUNK = mat("#7a5a3c"), M_LEAF = mat("#3f8a4a"), M_BUSH = mat("#4f8f4a"), M_DOOR = mat("#3b3530");
const M_WIN = new THREE.MeshStandardMaterial({ color: "#ffe9a0", emissive: "#ffcf5a", emissiveIntensity: 0.6 });
const roofMats = ROOFS.map(c => mat(c)), wallMats = WALLS.map(c => mat(c));

function palm(R) {
  const g = new THREE.Group();
  const t = new THREE.Mesh(G.trunk, M_TRUNK); t.position.y = 1.3; t.rotation.z = (R() - 0.5) * 0.3; g.add(t);
  for (let i = 0; i < 6; i++) {
    const l = new THREE.Mesh(G.leaf, M_LEAF);
    l.position.set(0, 2.6, 0); l.rotation.y = i / 6 * Math.PI * 2 + R();
    l.rotation.x = 0.35; l.translateZ(0.8); g.add(l);
  }
  g.traverse(o => { o.castShadow = true; });
  return g;
}
function house(R) {
  const g = new THREE.Group();
  const b = new THREE.Mesh(G.body, wallMats[Math.floor(R() * wallMats.length)]); b.position.y = 0.6; g.add(b);
  const r = new THREE.Mesh(G.roof, roofMats[Math.floor(R() * roofMats.length)]); r.position.y = 1.7; g.add(r);
  const w1 = new THREE.Mesh(G.win, M_WIN); w1.position.set(-0.35, 0.75, 0.76); g.add(w1);
  const w2 = new THREE.Mesh(G.win, M_WIN); w2.position.set(0.35, 0.75, 0.76); g.add(w2);
  const d = new THREE.Mesh(G.win, M_DOOR); d.scale.set(0.8, 1.4, 1); d.position.set(0, 0.3, 0.77); g.add(d);
  g.traverse(o => { o.castShadow = true; o.receiveShadow = true; });
  return g;
}

function rebuildDecor(v) {
  v.decor.clear();
  const n = count(v), y = 0.2 + v.targetH;
  const R = rng(v.key);
  const nHouse = Math.min(n * 2, 10, Math.max(1, Math.floor(v.area / 3)));
  const hs = spots(v, nHouse, 2.0);
  hs.forEach(([x, z, r]) => { const h = house(R); h.position.set(x - CX, y, z - CZ); h.rotation.y = Math.floor(r * 4) * Math.PI / 2 + (r - 0.5) * 0.4; h.scale.setScalar(0.85 + r * 0.3); v.decor.add(h); });
  const nPalm = Math.min(4, Math.max(v.area > 6 ? 1 : 0, Math.floor(v.area / 30)));
  spots(v, nPalm, 2.2, hs).forEach(([x, z, r]) => { const p = palm(R); p.position.set(x - CX, y, z - CZ); p.scale.setScalar(0.65 + r * 0.35); v.decor.add(p); });
  if (!n && v.area > 14) spots(v, 2, 2, hs).forEach(([x, z, r]) => { const b = new THREE.Mesh(G.bush, M_BUSH); b.position.set(x - CX, y + 0.4, z - CZ); b.scale.setScalar(0.7 + r * 0.6); b.castShadow = true; v.decor.add(b); });
  v.decor.userData.baseY = y;
  v.decor.traverse(o => { o.userData.v = v; });
}

// ===== 地標：中屯風車、外垵燈塔 =====
const spinners = [];
function turbine(v, dx, dz, s = 1) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.3, 9, 6), mat("#e8eef0")); pole.position.y = 4.5; g.add(pole);
  const hub = new THREE.Group(); hub.position.set(0, 9, 0.35);
  for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4, 0.08), mat("#ffffff")); b.position.y = 2; const a = new THREE.Group(); a.rotation.z = i * Math.PI * 2 / 3; a.add(b); hub.add(a); }
  g.add(hub); spinners.push(hub);
  g.position.set(v.cx - CX + dx, 2.4, v.cy - CZ + dz); g.scale.setScalar(s);
  g.traverse(o => { o.castShadow = true; }); scene.add(g);
}
let beam;
function lighthouse(v) {
  const g = new THREE.Group();
  for (let i = 0; i < 4; i++) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.75 - i * 0.08, 0.83 - i * 0.08, 1.4, 8), mat(i % 2 ? "#ffffff" : "#b23a32")); c.position.y = 0.7 + i * 1.4; g.add(c); }
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.9, 8), new THREE.MeshStandardMaterial({ color: "#fff3b0", emissive: "#ffd36a", emissiveIntensity: 1 }));
  lamp.position.y = 6.1; g.add(lamp);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.7, 0.8, 8), mat("#8b2e28")); cap.position.y = 6.95; g.add(cap);
  beam = new THREE.Mesh(new THREE.ConeGeometry(2.2, 22, 16, 1, true).rotateZ(Math.PI / 2).translate(11, 0, 0),
    new THREE.MeshBasicMaterial({ color: "#fff2b0", transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  beam.position.y = 6.1; g.add(beam);
  g.position.set(v.cx - CX - 3, 2.4, v.cy - CZ + 1);
  g.traverse(o => { if (o !== beam) o.castShadow = true; }); scene.add(g);
}
const vByName = n => M.villages.find(v => v.name === n);
turbine(vByName("中屯"), -2, -1); turbine(vByName("中屯"), 2.5, 1); turbine(vByName("北寮"), 1, 0, 0.9);
lighthouse(vByName("外垵"));

// 選取標記
const pin = new THREE.Group();
{ const m = mat("#ff5a6e", { emissive: "#ff5a6e", emissiveIntensity: 0.3 });
  const tip = new THREE.Mesh(new THREE.ConeGeometry(1, 2.4, 6).rotateX(Math.PI), m); tip.position.y = 1.2;
  const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 1), m); ball.position.y = 3;
  const dot = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), mat("#ffffff")); dot.position.set(0, 3, 1.0);
  pin.add(tip, ball, dot); pin.traverse(o => o.castShadow = true); pin.visible = false; scene.add(pin); }

// ===== 小魂魂 + 三隻貓 =====
function box(w, h, d, color, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color)); m.position.set(x, y, z); m.castShadow = true; return m; }
function makeHun() {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const leg = x => { const p = new THREE.Group(); p.position.set(x, 1.1, 0); p.add(box(0.42, 1.1, 0.45, "#1d3557", 0, -0.55, 0), box(0.46, 0.2, 0.6, "#3a2c2a", 0, -1.0, 0.06)); body.add(p); return p; };
  const legL = leg(-0.26), legR = leg(0.26); // 腿（可以擺動）
  body.add(box(1.35, 1.45, 0.8, "#4aa2da", 0, 1.8, 0));        // 藍外套
  body.add(box(0.5, 1.3, 0.05, "#1d3557", 0, 1.85, 0.41));      // 深藍襯衫
  body.add(box(0.16, 1.3, 0.06, "#d6d64c", -0.3, 1.85, 0.42), box(0.16, 1.3, 0.06, "#d6d64c", 0.3, 1.85, 0.42)); // 黃綠翻領
  body.add(box(0.3, 0.3, 0.06, "#d6d64c", 0.45, 1.75, 0.42));   // 口袋
  body.add(box(0.18, 0.18, 0.07, "#f0b04a", 0.38, 2.15, 0.43)); // 橘貓胸針
  const armL = box(0.34, 1.25, 0.4, "#4aa2da", 0, -0.55, 0); const shL = new THREE.Group(); shL.position.set(-0.85, 2.4, 0); shL.add(armL, box(0.3, 0.22, 0.36, "#e07aa8", 0, -1.25, 0), box(0.26, 0.26, 0.3, "#efc4b6", 0, -1.45, 0)); body.add(shL);
  const armR = box(0.34, 1.25, 0.4, "#4aa2da", 0, -0.55, 0); const shR = new THREE.Group(); shR.position.set(0.85, 2.4, 0); shR.add(armR, box(0.3, 0.22, 0.36, "#e07aa8", 0, -1.25, 0), box(0.26, 0.26, 0.3, "#efc4b6", 0, -1.45, 0)); body.add(shR);
  const head = new THREE.Group(); head.position.y = 3.25; body.add(head);
  head.add(box(1.05, 1.1, 1.0, "#efc4b6", 0, 0, 0));                         // 臉
  head.add(box(1.15, 0.4, 1.1, "#22301d", 0, 0.62, -0.02));                  // 頭髮
  head.add(box(1.15, 0.5, 0.35, "#22301d", 0, 0.42, -0.4));
  head.add(box(0.55, 0.28, 0.25, "#3c5a2c", -0.15, 0.55, 0.45));             // 瀏海（挑染）
  head.add(box(0.08, 0.35, 0.5, "#e07aa8", -0.57, 0.12, -0.05), box(0.08, 0.35, 0.5, "#e07aa8", 0.57, 0.12, -0.05)); // 粉紅鬢角
  head.add(box(0.16, 0.18, 0.04, "#2f6b3a", -0.24, 0.05, 0.51), box(0.16, 0.18, 0.04, "#2f6b3a", 0.24, 0.05, 0.51)); // 綠眼睛
  head.add(box(0.26, 0.05, 0.04, "#7a4a45", 0, -0.3, 0.51));                 // 微笑
  g.userData = { body, shL, shR, head, legL, legR };
  g.scale.setScalar(1.7);
  return g;
}
function makeCat(color, stripe) {
  const g = new THREE.Group();
  g.add(box(0.9, 0.5, 0.5, color, 0, 0.45, 0));
  const head = new THREE.Group(); head.position.set(0.55, 0.85, 0); g.add(head);
  head.add(box(0.55, 0.48, 0.55, color));
  const ear = x => { const e = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.25, 4), mat(color)); e.position.set(0, 0.33, x); e.castShadow = true; return e; };
  head.add(ear(-0.16), ear(0.16));
  head.add(box(0.04, 0.08, 0.08, "#ff8a1f", 0.28, 0.05, -0.12), box(0.04, 0.08, 0.08, "#ff8a1f", 0.28, 0.05, 0.12)); // 橘眼睛
  head.add(box(0.04, 0.06, 0.08, "#e07aa8", 0.29, -0.08, 0)); // 鼻
  [-0.25, 0.25].forEach(x => [-0.15, 0.15].forEach(z => g.add(box(0.14, 0.3, 0.14, color, x, 0.15, z))));
  const tail = box(0.12, 0.6, 0.12, stripe || color, -0.5, 0.75, 0); tail.rotation.z = 0.5; g.add(tail);
  if (stripe) g.add(box(0.12, 0.52, 0.52, stripe, 0.1, 0.46, 0));
  g.userData.tail = tail;
  return g;
}
const hun = makeHun(); scene.add(hun);
const cats = [makeCat("#f0b04a", "#d98a2a"), makeCat("#8a8a8f"), makeCat("#7993a5")];
cats.forEach((c, i) => { c.userData.phase = i * 2.1; c.scale.setScalar(1.3); scene.add(c); });
let hunAt = null, hunPos = new THREE.Vector3(), hunGoal = null, hunWait = 1, hunDir = 0, walkPhase = 0, swing = 0;
let hunJump = 0; const jumpFrom = new THREE.Vector3(), jumpTo = new THREE.Vector3();
cats.forEach(c => { c.userData.pos = new THREE.Vector3(); c.userData.dir = 0; c.userData.walk = 0; });
function latestVillage() {
  let best = null, bt = -1;
  M.villages.forEach(v => (state.visits[v.key] || []).forEach(x => { if ((x.t || 0) > bt) { bt = x.t || 0; best = v; } }));
  return best || vByName("市區");
}
function bbox(v) {
  if (!v.bb) { const xs = v.poly.flatMap(p => p[0].map(q => q[0])), ys = v.poly.flatMap(p => p[0].map(q => q[1])); v.bb = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]; }
  return v.bb;
}
// 在村里裡找一個走得到的點（直線上都在村里內）
function pickGoal(v) {
  const [x0, x1, y0, y1] = bbox(v);
  const sx = hunPos.x + CX, sy = hunPos.z + CZ;
  for (let i = 0; i < 40; i++) {
    const r = Math.min(12, Math.max(x1 - x0, y1 - y0) / 2) * (0.3 + Math.random() * 0.7), a = Math.random() * Math.PI * 2;
    const gx = sx + Math.cos(a) * r, gy = sy + Math.sin(a) * r;
    let ok = true;
    for (let k = 1; k <= 8 && ok; k++) { const t = k / 8, px = sx + (gx - sx) * t, py = sy + (gy - sy) * t; if (!inside(v, px, py) || !inside(v, px + 0.6, py) || !inside(v, px - 0.6, py) || !inside(v, px, py + 0.6) || !inside(v, px, py - 0.6)) ok = false; }
    if (ok) return new THREE.Vector3(gx - CX, 0, gy - CZ);
  }
  return null;
}
function moveHun(v, instant) {
  if (!v) return;
  const changed = hunAt !== v; hunAt = v; hunGoal = null;
  const home = new THREE.Vector3(v.cx - CX, 0, v.cy - CZ);
  if (instant) { hunPos.copy(home); cats.forEach((c, i) => c.userData.pos.set(home.x - 2 - i, 0, home.z + 1.5)); }
  else if (changed) { jumpFrom.copy(hunPos); jumpTo.copy(home); hunJump = 1; }
}

// 雲
const clouds = [];
for (let i = 0; i < 7; i++) {
  const c = new THREE.Group(), R = rng("cloud" + i);
  for (let k = 0; k < 4; k++) { const p = new THREE.Mesh(new THREE.IcosahedronGeometry(2 + R() * 2, 0), mat("#ffffff", { transparent: true, opacity: 0.92 })); p.position.set(k * 2.6 - 4, R(), R() * 2); c.add(p); }
  c.position.set((R() - 0.5) * 220, 36 + R() * 14, (R() - 0.5) * 240); c.userData.sp = 0.02 + R() * 0.03;
  scene.add(c); clouds.push(c);
}

// ===== 外觀更新 =====
function colorOf(v) { const n = count(v); return n ? LEVELS[Math.min(n, LEVELS.length) - 1] : UNLIT; }
function refreshVillage(v) {
  const n = count(v);
  v.mesh.material.color.set(colorOf(v));
  v.mesh.material.emissive.set(n ? colorOf(v) : "#000000");
  v.mesh.material.emissiveIntensity = night ? (n ? 0.45 : 0) : (v === selected ? 0.25 : 0);
  v.targetH = BASE_H + Math.min(n, 6) * 0.25 + (v === selected ? 0.8 : 0);
  rebuildDecor(v);
}
function refreshAll() { M.villages.forEach(refreshVillage); }

function setNight(on) {
  night = on;
  document.body.classList.toggle("night", on);
  $("#nightBtn").textContent = on ? "☀️" : "🌙";
  hemi.intensity = on ? 0.35 : 1.5;
  sun.intensity = on ? 0.35 : 2.4;
  sun.color.set(on ? "#9fb4ff" : "#fff4e0");
  seaMat.color.set(on ? "#24406a" : "#7ccfd6");
  M_WIN.emissiveIntensity = on ? 2.2 : 0.6;
  beam.material.opacity = on ? 0.22 : 0;
  refreshAll();
}

// ===== 標籤 =====
const labelsEl = $("#labels"), labelEls = new Map();
M.villages.forEach(v => { const s = document.createElement("span"); labelsEl.appendChild(s); labelEls.set(v, s); });
function renderLabels() {
  labelEls.forEach((s, v) => {
    const n = count(v);
    s.innerHTML = v.name + (n ? `<span class="n">${n}</span>` : "");
    s.classList.toggle("sel", v === selected);
    s._w = 0;
  });
}
const tmp = new THREE.Vector3();
function placeLabels() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const detail = camera.position.distanceTo(controls.target) < 150;
  const order = [...labelEls.keys()].sort((a, b) => (b === selected) - (a === selected) || count(b) - count(a) || b.area - a.area);
  const placed = [];
  for (const v of order) {
    const s = labelEls.get(v);
    const want = v === selected || (showLabels && (detail || count(v) > 0 || v.area > 120));
    tmp.set(v.cx - CX, 0.2 + v.h + (v === selected ? 9 : 2.6), v.cy - CZ).project(camera);
    if (!want || tmp.z > 1 || Math.abs(tmp.x) > 1.1 || Math.abs(tmp.y) > 1.1) { s.style.display = "none"; continue; }
    const x = (tmp.x * 0.5 + 0.5) * w, y = (-tmp.y * 0.5 + 0.5) * h;
    if (s.style.display === "none") s.style.display = "block";
    const bw = s._w || (s._w = s.offsetWidth), bh = s._h || (s._h = s.offsetHeight);
    const r = [x - bw / 2, y - bh, x + bw / 2, y];
    if (v !== selected && placed.some(p => r[0] < p[2] + 2 && r[2] > p[0] - 2 && r[1] < p[3] + 1 && r[3] > p[1] - 1)) { s.style.display = "none"; continue; }
    placed.push(r);
    s.style.transform = `translate(${x}px,${y}px) translate(-50%,-100%)`;
  }
}

// ===== 點選 =====
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let down = null;
renderer.domElement.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const objs = [...villageMeshes, ...M.villages.map(v => v.decor)];
  const hit = ray.intersectObjects(objs, true).find(h => h.object.userData.v);
  select(hit ? hit.object.userData.v : null, false);
});

let fly = null;
function flyTo(target, pos) { fly = { t: 0, from: [controls.target.clone(), camera.position.clone()], to: [target, pos] }; }
function focus(v) {
  const t = new THREE.Vector3(v.cx - CX, 2, v.cy - CZ);
  const off = camera.position.clone().sub(controls.target);
  const d = Math.min(off.length(), 90); off.setLength(d);
  flyTo(t, t.clone().add(off));
}
$("#resetView").onclick = () => flyTo(HOME.target.clone(), HOME.pos.clone());
$("#nightBtn").onclick = () => setNight(!night);
$("#labelToggle").onclick = () => { showLabels = !showLabels; };

// ===== 動畫迴圈 =====
const clock = new THREE.Clock();
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  camera.fov = w < h ? 46 : 34; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

function loop() {
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  // 海浪
  const p = seaGeo.attributes.position.array;
  for (let i = 0; i < p.length; i += 3) p[i + 1] = Math.sin(seaBase[i] * 0.09 + t * 0.9) * 0.35 + Math.cos(seaBase[i + 2] * 0.11 + t * 0.7) * 0.3;
  seaGeo.attributes.position.needsUpdate = true; seaGeo.computeVertexNormals();
  // 地塊長高動畫
  M.villages.forEach(v => {
    if (Math.abs(v.h - v.targetH) > 0.005) {
      v.h += (v.targetH - v.h) * Math.min(1, dt * 8);
      v.mesh.scale.y = v.h;
      v.decor.position.y = v.h + 0.2 - v.decor.userData.baseY;
    }
  });
  spinners.forEach((s, i) => s.rotation.z += dt * (1.6 + i * 0.2));
  if (beam) beam.rotation.y += dt * 0.8;
  if (selected) { pin.visible = true; pin.position.set(selected.cx - CX, 0.2 + selected.h + 3 + Math.abs(Math.sin(t * 3)) * 1.2, selected.cy - CZ); pin.rotation.y = t; } else pin.visible = false;
  if (hunAt) {
    const u = hun.userData, ground = 0.2 + hunAt.h;
    let moving = false, air = 0, wantDir = hunDir;
    if (hunJump > 0) { // 跳到新的村里
      hunJump = Math.max(0, hunJump - dt * 0.7);
      const k = 1 - hunJump;
      hunPos.lerpVectors(jumpFrom, jumpTo, k);
      air = Math.sin(k * Math.PI) * Math.min(10, 2 + jumpFrom.distanceTo(jumpTo) * 0.15);
      wantDir = Math.atan2(jumpTo.x - jumpFrom.x, jumpTo.z - jumpFrom.z);
      if (hunJump === 0) hunWait = 0.6;
    } else if (!hunGoal) {
      hunWait -= dt;
      if (hunWait <= 0) { hunGoal = pickGoal(hunAt); if (!hunGoal) hunWait = 1; }
    } else {
      const dx = hunGoal.x - hunPos.x, dz = hunGoal.z - hunPos.z, d = Math.hypot(dx, dz);
      if (d < 0.15) { hunGoal = null; hunWait = 1 + Math.random() * 3; }
      else { const step = Math.min(d, 2.4 * dt); hunPos.x += dx / d * step; hunPos.z += dz / d * step; wantDir = Math.atan2(dx, dz); moving = true; }
    }
    let dd = wantDir - hunDir; dd = Math.atan2(Math.sin(dd), Math.cos(dd)); hunDir += dd * Math.min(1, dt * 8);
    if (moving) walkPhase += dt * 9;
    swing += ((moving ? Math.sin(walkPhase) * 0.65 : 0) - swing) * Math.min(1, dt * 12);
    u.legL.rotation.x = swing; u.legR.rotation.x = -swing;
    u.shL.rotation.x = -swing * 0.9; u.shR.rotation.x = swing * 0.9;
    u.shL.rotation.z = -0.08; u.shR.rotation.z = hunJump > 0 ? 2.6 : 0.08; // 跳的時候舉手
    u.head.rotation.y = moving ? 0 : Math.sin(t * 0.8) * 0.4;
    const bob = moving ? Math.abs(Math.sin(walkPhase)) * 0.18 : Math.sin(t * 2) * 0.03;
    hun.position.set(hunPos.x, ground + bob + air, hunPos.z);
    hun.rotation.y = hunDir;
    // 貓咪跟在後面
    const fx = Math.sin(hunDir), fz = Math.cos(hunDir);
    cats.forEach((c, i) => {
      const cu = c.userData, side = (i - 1) * 1.3, back = 2.2 + i * 1.1;
      const tx = hunPos.x - fx * back + fz * side, tz = hunPos.z - fz * back - fx * side;
      const dx = tx - cu.pos.x, dz = tz - cu.pos.z, d = Math.hypot(dx, dz);
      let catMoving = false;
      if (d > 0.4) { const sp = Math.max(2.8, d * 2.2); const st = Math.min(d, sp * dt); cu.pos.x += dx / d * st; cu.pos.z += dz / d * st; catMoving = true;
        let cd = Math.atan2(dx, dz) - Math.PI / 2 - cu.dir; cd = Math.atan2(Math.sin(cd), Math.cos(cd)); cu.dir += cd * Math.min(1, dt * 10); }
      if (catMoving) cu.walk += dt * 14;
      const far = d > 6 ? Math.min(4, d * 0.3) : 0;
      c.position.set(cu.pos.x, ground + (catMoving ? Math.abs(Math.sin(cu.walk)) * 0.3 : 0) + far, cu.pos.z);
      c.rotation.y = cu.dir;
      cu.tail.rotation.x = Math.sin(t * 4 + i) * 0.4;
    });
  }
  clouds.forEach(c => { c.position.x += c.userData.sp; if (c.position.x > 140) c.position.x = -140; });
  // 鏡頭飛行
  if (fly) {
    fly.t = Math.min(1, fly.t + dt * 1.6); const k = 1 - Math.pow(1 - fly.t, 3);
    controls.target.lerpVectors(fly.from[0], fly.to[0], k); camera.position.lerpVectors(fly.from[1], fly.to[1], k);
    if (fly.t >= 1) fly = null;
  }
  // 日夜背景
  const sky = night ? SKY_NIGHT : SKY_DAY;
  scene.background.lerp(sky, 0.08); scene.fog.color.copy(scene.background);
  controls.update();
  clampPan();
  renderer.render(scene, camera);
  placeLabels();
  requestAnimationFrame(loop);
}

// ===== 面板 / 統計（跟之前一樣的邏輯） =====
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const canEdit = () => mode === "local" || unlocked;

function select(v, move = true) {
  const prev = selected; selected = v || null;
  if (prev) refreshVillage(prev);
  if (selected) { refreshVillage(selected); if (move) focus(selected); }
  renderPanel(); renderLabels();
  if (selected && move && innerWidth <= 900) $("#stage").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderPanel() {
  const el = $("#panel");
  if (!selected) { el.innerHTML = `<p class="hint">點島上的村里，或用下面搜尋。</p>`; return; }
  const v = selected, list = state.visits[v.key] || [], n = list.length;
  el.innerHTML = `
    <p class="vname">${v.name}</p><div class="vtown">${v.town}</div>
    <div class="counter">
      <button class="btn pink" id="minus" ${!canEdit() || !n ? "disabled" : ""}>－1</button>
      <div class="cnum" style="background:${colorOf(v)}">${n}</div>
      <button class="btn mint" id="plus" ${!canEdit() ? "disabled" : ""}>＋1</button>
    </div>
    <div class="dateRow">日期 <input type="date" id="vdate" value="${today()}" ${!canEdit() ? "disabled" : ""}></div>
    ${!canEdit() ? `<p class="locked-note">🔒 按右上「編輯」解鎖才能記錄</p>` : ""}
    <ul class="visits">${list.map((x, i) => ({ ...x, i })).reverse().map(x =>
      `<li><span>第 ${x.i + 1} 次・${x.d}</span>${canEdit() ? `<a href="#" data-del="${x.i}" title="刪除">✕</a>` : ""}</li>`).join("")}</ul>`;
  const plus = $("#plus"), minus = $("#minus");
  plus && (plus.onclick = () => act({ action: "add", key: v.key, date: $("#vdate").value || today() }));
  minus && (minus.onclick = () => act({ action: "remove", key: v.key, index: n - 1 }));
  el.querySelectorAll("[data-del]").forEach(a => a.onclick = e => {
    e.preventDefault(); if (confirm("刪除這筆紀錄？")) act({ action: "remove", key: v.key, index: +a.dataset.del });
  });
}

function renderStats() {
  const all = M.villages.length, lit = M.villages.filter(v => count(v) > 0).length;
  $("#litCount").textContent = lit; $("#allCount").textContent = all;
  $("#sweepCount").textContent = M.villages.reduce((s, v) => s + count(v), 0);
  $("#totalBar").style.width = (lit / all * 100) + "%";
  $("#towns").innerHTML = Object.keys(TOWNS).map(t => {
    const vs = M.villages.filter(v => v.town === t), l = vs.filter(v => count(v) > 0).length;
    return `<li><span>${t}</span><div class="tb"><div style="width:${l / vs.length * 100}%;--c:${TOWNS[t]}"></div></div><span class="num">${l}/${vs.length}</span></li>`;
  }).join("");
  const rec = [];
  M.villages.forEach(v => (state.visits[v.key] || []).forEach((x, i) => rec.push({ v, ...x, i })));
  rec.sort((a, b) => (b.t || 0) - (a.t || 0) || b.d.localeCompare(a.d));
  $("#recent").innerHTML = rec.length ? rec.slice(0, 40).map(r =>
    `<li data-k="${r.v.id}"><span>${r.v.name} <small>第${r.i + 1}次</small></span><small>${r.d}</small></li>`).join("")
    : `<li class="empty">還沒有紀錄，出發掃街吧！</li>`;
  $("#recent").querySelectorAll("[data-k]").forEach(li => li.onclick = () => select(byId[li.dataset.k]));
}
$("#legend").innerHTML = `<span><i style="background:${UNLIT}"></i>未掃</span>` +
  LEVELS.map((c, i) => `<span><i style="background:${c}"></i>${i + 1}${i === LEVELS.length - 1 ? "+" : ""}次</span>`).join("");

function renderAll() { refreshAll(); renderStats(); renderLabels(); renderPanel(); moveHun(latestVillage(), !hunAt); }

// 搜尋
const search = $("#search"), results = $("#results");
search.addEventListener("input", () => {
  const q = search.value.trim();
  if (!q) { results.innerHTML = ""; return; }
  const hits = M.villages.filter(v => v.name.includes(q) || v.town.includes(q)).slice(0, 30);
  results.innerHTML = hits.map(v => `<li tabindex="0" data-k="${v.id}"><span>${v.name}</span><small>${v.town}・${count(v)} 次</small></li>`).join("") || `<li><small>找不到</small></li>`;
  results.querySelectorAll("[data-k]").forEach(li => {
    li.onclick = () => { select(byId[li.dataset.k]); search.value = ""; results.innerHTML = ""; };
    li.onkeydown = e => e.key === "Enter" && li.click();
  });
});

// ===== 資料同步 =====
const syncEl = $("#syncState");
const setSync = (s, title) => { syncEl.className = "sync " + s; syncEl.title = title || ""; };
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1800); }

async function load() {
  setSync("busy", "讀取中");
  try {
    const r = await fetch(API, { cache: "no-store" });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error(r.status);
    state = await r.json(); state.visits ||= {};
    mode = "remote"; setSync("ok", "已連線雲端");
    if (editKey) await checkKey(editKey, true);
  } catch {
    mode = "local";
    state = JSON.parse(localStorage.getItem("sweepLocal") || '{"visits":{}}');
    setSync("err", "本機模式（沒有連到 Netlify 後端，資料只存在這台裝置）");
    $("#editBtn").textContent = "💾 本機";
  }
  renderAll();
}
function applyLocal(a) {
  const list = state.visits[a.key] ||= [];
  if (a.action === "add") list.push({ d: a.date, t: Date.now() });
  if (a.action === "remove" && a.index >= 0) list.splice(a.index, 1);
  if (!list.length) delete state.visits[a.key];
  localStorage.setItem("sweepLocal", JSON.stringify(state));
}
async function act(a) {
  const msg = a.action === "add" ? `💡 魂魂在${selected?.name || ""}點燈！` : "已移除";
  if (mode === "local") { applyLocal(a); renderAll(); toast(msg); return; }
  setSync("busy", "儲存中");
  try {
    const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json", "x-edit-key": editKey }, body: JSON.stringify(a) });
    if (r.status === 401) { unlocked = false; updateEditBtn(); toast("密碼失效，請重新解鎖"); setSync("err"); renderPanel(); return; }
    if (!r.ok) throw new Error(r.status);
    state = await r.json(); state.visits ||= {};
    setSync("ok", "已儲存"); renderAll(); toast(msg);
  } catch { setSync("err", "儲存失敗"); toast("儲存失敗，請檢查網路"); }
}
async function checkKey(key, silent) {
  try {
    const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json", "x-edit-key": key }, body: JSON.stringify({ action: "check" }) });
    unlocked = r.ok;
  } catch { unlocked = false; }
  if (unlocked) { editKey = key; localStorage.setItem("sweepKey", key); }
  else if (!silent) localStorage.removeItem("sweepKey");
  updateEditBtn(); return unlocked;
}
function updateEditBtn() {
  if (mode === "local") return;
  const b = $("#editBtn"); b.textContent = unlocked ? "🔓 編輯中" : "🔒 編輯"; b.classList.toggle("unlocked", unlocked);
}
const dlg = $("#pwDialog");
$("#editBtn").onclick = () => {
  if (mode === "local") { toast("本機模式：資料只存在這台裝置"); return; }
  if (unlocked) { unlocked = false; editKey = ""; localStorage.removeItem("sweepKey"); updateEditBtn(); renderPanel(); toast("已上鎖"); return; }
  $("#pwErr").textContent = ""; $("#pwInput").value = ""; dlg.showModal(); $("#pwInput").focus();
};
$("#pwOk").onclick = async e => {
  e.preventDefault();
  if (await checkKey($("#pwInput").value)) { dlg.close(); renderPanel(); toast("🔓 已解鎖"); } else $("#pwErr").textContent = "密碼不對喔";
};

// 開始
load().then(() => { $("#loading").classList.add("done"); });
loop();
