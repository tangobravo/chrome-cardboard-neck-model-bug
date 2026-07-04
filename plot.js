import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Visualizes the JSON recorded by record.html. Two modes:
//  - point cloud: every sample as a sphere at its position (blue→red over time), optional viewing-
//    direction cylinders and a path line — the whole trajectory at once.
//  - sweep: a slider selects one sample, shown with an axes-helper + yellow forward (−Z) arrow at its
//    orientation, plus a trailing window of preceding points — step through to watch the motion.
// Everything is plotted in three.js's own right-handed, Y-up world with labelled axes, so it doubles as
// a handedness check: WebXR reference spaces are spec'd the same way, so anything mirrored is a signal.
//
// The "local_fixed" mode reconstructs the CORRECT neck model from the reported orientation, for direct
// comparison against Chrome's reported (buggy) positions. See README.md for the analysis.

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101015);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.001, 1000);
camera.position.set(1, 1, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2.5));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(1, 2, 1);
scene.add(dirLight);

scene.add(new THREE.GridHelper(4, 40, 0x444466, 0x222233));
scene.add(new THREE.AxesHelper(1)); // X red, Y green, Z blue (three.js default, along +axes)

// Text sprite labels for the axis ends, so +/− and which axis is which is unambiguous.
function makeLabel(text, color) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 32);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(0.15, 0.075, 1);
  return sprite;
}
function addLabel(text, color, pos) {
  const s = makeLabel(text, color);
  s.position.copy(pos);
  scene.add(s);
}
addLabel('+X', '#ff5555', new THREE.Vector3(1.1, 0, 0));
addLabel('-X', '#aa3333', new THREE.Vector3(-1.1, 0, 0));
addLabel('+Y', '#55ff55', new THREE.Vector3(0, 1.1, 0));
addLabel('+Z', '#6688ff', new THREE.Vector3(0, 0, 1.1));
addLabel('-Z', '#4455aa', new THREE.Vector3(0, 0, -1.1));

// A group we clear and rebuild on each render.
const plotGroup = new THREE.Group();
scene.add(plotGroup);

function clearGroup(g) {
  for (const child of [...g.children]) {
    g.remove(child);
    child.geometry?.dispose?.();
    const m = child.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
  }
}

const FWD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);
const status = document.getElementById('status');

// --- loaded state, shared across renders ---
let allSamples = []; // parsed once per file; re-derived (not re-read) on space change
let poses = [];
let points = [];
let sphereR = 0.01;
let arrowLen = 0.1;
let sweepIndex = 0; // canonical selected index; both sliders mirror it

const el = (id) => document.getElementById(id);
const currentSpace = () => document.querySelector('input[name="space"]:checked').value;

// Neck model: eye relative to the neck pivot in head-local coords (forward is −Z). These are the
// Cardboard SDK's own neck-model constants (0.075 m up, 0.08 m forward).
const NECK_TO_EYE = { x: 0, y: 0.075, z: -0.08 };
const NECK = new THREE.Vector3(NECK_TO_EYE.x, NECK_TO_EYE.y, NECK_TO_EYE.z);
// Fixed neck pivot: centred under the origin in x/z, dropped one eye-height in y so the pivot sits at
// neck level while the origin stays at eye level.
const PIVOT = new THREE.Vector3(0, -NECK_TO_EYE.y, 0);

// "local_fixed": ignore Chrome's (broken) reported position and reconstruct the eye purely from the
// reported orientation on the FIXED neck pivot — pos = R(q)·NECK + PIVOT. At identity the eye sits at
// [0, 0, NECK_TO_EYE.z] (eye level, forward of the neck); this is the clean spherical-cap trajectory
// the eye *should* trace for head rotation on a still neck.
function fixedPose(p) {
  const q = new THREE.Quaternion(p.quat[0], p.quat[1], p.quat[2], p.quat[3]);
  const eye = NECK.clone().applyQuaternion(q).add(PIVOT);
  return { pos: [eye.x, eye.y, eye.z], quat: p.quat };
}
const currentMode = () => document.querySelector('input[name="mode"]:checked').value;

function timeColor(t, lightness = 0.55) {
  return new THREE.Color().setHSL(0.66 * (1 - t), 0.85, lightness); // blue(start) → red(end)
}

function addSphere(pos, r, color) {
  const s = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 12), new THREE.MeshStandardMaterial({ color }));
  s.position.copy(pos);
  plotGroup.add(s);
}

// A thick forward arrow (shaft + cone) built along +Y, so it can be aimed with setFromUnitVectors.
function addForwardArrow(pos, fwd, len, color) {
  const g = new THREE.Group();
  const r = sphereR * 0.45;
  const headLen = len * 0.28, shaftLen = len - headLen;
  const mat = new THREE.MeshStandardMaterial({ color });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, shaftLen, 12), mat);
  shaft.position.y = shaftLen / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(r * 2, headLen, 12), mat);
  head.position.y = shaftLen + headLen / 2;
  g.add(shaft, head);
  g.quaternion.setFromUnitVectors(UP, fwd.clone().normalize());
  g.position.copy(pos);
  plotGroup.add(g);
}

function forwardOf(p) {
  const q = new THREE.Quaternion(p.quat[0], p.quat[1], p.quat[2], p.quat[3]);
  return FWD.clone().applyQuaternion(q).normalize();
}

// Two aligned monospace lines (leading space reserves the sign column so digits stay put).
function poseText(p) {
  const f = (n) => (n >= 0 ? ' ' : '') + n.toFixed(4);
  return `pos  ${p.pos.map(f).join(', ')}\nquat ${p.quat.map(f).join(', ')}`;
}

function renderCloud() {
  const showDirs = el('dirs').checked;
  const showPath = el('path').checked;
  const N = poses.length;
  poses.forEach((p, i) => {
    const color = timeColor(N > 1 ? i / (N - 1) : 0);
    addSphere(points[i], sphereR, color);
    if (showDirs) {
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(sphereR * 0.35, sphereR * 0.35, arrowLen * 0.7, 8),
        new THREE.MeshStandardMaterial({ color }),
      );
      const fwd = forwardOf(p);
      cyl.quaternion.setFromUnitVectors(UP, fwd);
      cyl.position.copy(points[i]).addScaledVector(fwd, arrowLen * 0.35);
      plotGroup.add(cyl);
    }
  });
  if (showPath && N > 1) {
    plotGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0x888888 }),
    ));
  }
}

function renderSweep() {
  const N = poses.length;
  const i = Math.min(sweepIndex, N - 1);
  const w = Math.max(parseInt(el('window').value, 10) || 0, 0);
  const lo = Math.max(0, i - w); // trailing tail only: the samples already passed

  // Trail: dimmer, faded by how far behind the selected index they are; keep the time hue.
  for (let j = lo; j < i; j++) {
    const t = N > 1 ? j / (N - 1) : 0;
    const fade = w > 0 ? 1 - (i - j) / w : 1; // 1 just behind selected → 0 at tail end
    const lightness = 0.12 + 0.18 * fade;
    addSphere(points[j], sphereR * 0.7, timeColor(t, lightness));
  }
  // Faint line through the trail so the motion path is visible.
  if (i > lo) {
    plotGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points.slice(lo, i + 1)),
      new THREE.LineBasicMaterial({ color: 0x556 }),
    ));
  }

  // Selected sample: bright sphere + axes-helper + forward arrow at its orientation.
  const p = poses[i];
  addSphere(points[i], sphereR * 1.15, timeColor(N > 1 ? i / (N - 1) : 0, 0.62));
  const axes = new THREE.AxesHelper(arrowLen * 1.4);
  const q = new THREE.Quaternion(p.quat[0], p.quat[1], p.quat[2], p.quat[3]);
  axes.quaternion.copy(q);
  axes.position.copy(points[i]);
  axes.material.depthTest = false;
  plotGroup.add(axes);
  addForwardArrow(points[i], forwardOf(p), arrowLen * 1.6, 0xffdd00);

  const label = `${i} / ${N - 1}`;
  el('idxLabel').textContent = label;
  el('idxLabel2').textContent = label;
  const readout = poseText(p);
  el('poseReadout').textContent = readout;
  el('poseReadout2').textContent = readout;
}

function render() {
  if (!poses.length) return;
  clearGroup(plotGroup);
  if (currentMode() === 'cloud') renderCloud(); else renderSweep();
}

async function loadFile(file) {
  status.textContent = `Reading ${file.name}…`;
  try {
    allSamples = JSON.parse(await file.text());
    if (!Array.isArray(allSamples)) throw new Error('not an array');
  } catch (e) {
    allSamples = [];
    status.textContent = 'Could not parse file: ' + e.message;
    return;
  }
  derive();
}

// Rebuild the plotted poses for the current space from the already-parsed samples (cheap; no re-read).
function derive() {
  if (!allSamples.length) return;
  const space = currentSpace();
  // `fixed` reconstructs from local orientation; local/floor use the reported position directly.
  const src = space === 'fixed' ? 'local' : space;
  poses = allSamples.map((s) => s[src]).filter((p) => !!p);
  if (space === 'fixed') poses = poses.map(fixedPose);

  // Optional experimental transforms. The bug is reported = −neck_model(q⁻¹) with a correct
  // orientation q. Negating the reported position recovers neck_model(q⁻¹) — a plausible neck-model
  // cap; conjugating the quaternion (x,y,z,w)→(−x,−y,−z,w) pairs it with the inverse rotation it was
  // actually built from. Tick both to watch a coherent neck model driven by the *wrong* rotations.
  const invPos = el('invPos').checked;
  const invQuat = el('invQuat').checked;
  if (invPos || invQuat) {
    poses = poses.map((p) => ({
      pos: invPos ? [-p.pos[0], -p.pos[1], -p.pos[2]] : p.pos,
      quat: invQuat ? [-p.quat[0], -p.quat[1], -p.quat[2], p.quat[3]] : p.quat,
    }));
  }

  if (!poses.length) {
    status.textContent = `No non-null "${space}" poses in ${allSamples.length} samples.`;
    return;
  }
  points = poses.map((p) => new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]));

  // Sizing + camera fit from the full data extent.
  const box = new THREE.Box3();
  points.forEach((v) => box.expandByPoint(v));
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const diag = Math.max(size.length(), 0.05);
  sphereR = Math.max(diag * 0.012, 0.004);
  arrowLen = diag * 0.1;

  const dist = Math.max(diag * 1.8, 0.3);
  const viewDir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(centre);
  camera.position.copy(centre).addScaledVector(viewDir, dist);
  controls.update();

  // Configure both sweep sliders for the new length, clamping the current index.
  if (sweepIndex > poses.length - 1) sweepIndex = 0;
  for (const id of ['idx', 'idx2']) {
    const s = el(id);
    s.max = String(poses.length - 1);
    s.value = String(sweepIndex);
  }
  updateSweepBar();

  status.textContent = `Loaded ${poses.length} "${space}" poses. `
    + `Span: x ${size.x.toFixed(3)}, y ${size.y.toFixed(3)}, z ${size.z.toFixed(3)} m.`;
  render();
}

// Set the selected index from either slider, mirror it to both, and re-render.
function setSweepIndex(i) {
  sweepIndex = Math.max(0, Math.min(i || 0, poses.length - 1));
  el('idx').value = String(sweepIndex);
  el('idx2').value = String(sweepIndex);
  render();
}

// The floating slider is visible only when the panel is hidden while in sweep mode with data loaded.
function updateSweepBar() {
  const hidden = panel.style.display === 'none';
  el('sweepBar').style.display = hidden && currentMode() === 'sweep' && poses.length ? 'flex' : 'none';
}

// --- wire up controls ---
el('file').addEventListener('change', (ev) => {
  const file = ev.target.files?.[0];
  if (file) loadFile(file);
});
document.querySelectorAll('input[name="space"]').forEach((e) => e.addEventListener('change', derive));
['invPos', 'invQuat'].forEach((id) => el(id).addEventListener('change', derive));

function syncModeUI() {
  const sweep = currentMode() === 'sweep';
  el('sweepControls').style.display = sweep ? 'block' : 'none';
  el('cloudControls').style.display = sweep ? 'none' : 'flex';
  el('cloudHide').style.display = sweep ? 'none' : 'flex';
  updateSweepBar();
  render();
}
document.querySelectorAll('input[name="mode"]').forEach((e) => e.addEventListener('change', syncModeUI));
['dirs', 'path', 'window'].forEach((id) => el(id).addEventListener('input', render));
el('idx').addEventListener('input', (e) => setSweepIndex(parseInt(e.target.value, 10)));
el('idx2').addEventListener('input', (e) => setSweepIndex(parseInt(e.target.value, 10)));

const panel = el('panel');
const toggle = el('toggle');
const hidePanel = () => { panel.style.display = 'none'; toggle.style.display = 'block'; updateSweepBar(); };
el('hide').addEventListener('click', hidePanel);
el('hide2').addEventListener('click', hidePanel);
toggle.addEventListener('click', () => { panel.style.display = 'block'; toggle.style.display = 'none'; updateSweepBar(); });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Auto-load the bundled sample trace if present, so the page shows something on first open.
fetch('./sample-trace.json')
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((data) => { allSamples = data; derive(); })
  .catch(() => { /* no bundled sample; wait for a file */ });

renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
