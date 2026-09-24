// Live2D-style puppet renderer: every art layer (layers.json) is a textured grid mesh whose
// vertices are deformed on the CPU each frame (rig.js writes `layer.pos`). Orthographic camera
// in model units (x right = fox's left, y up, feet at y = 0), gamma-space premultiplied-alpha
// compositing like a 2D paint program / the Cubism renderer, background gradient + soft ground
// shadows drawn in the same canvas.
import * as THREE from 'three';

const CELL_PX = 10; // texture px per grid cell at 1x
const MAX_CELLS = 40;
const ALPHA_DOWN = 4; // hit-test alpha maps are stored at 1/4 resolution
const MARGIN_PX = 16;

// Content kept in view (model units): the fox with some tail swing room + the logo on its right.
export const CONTENT_BOX = { x0: -0.84, x1: 0.46, y0: -0.07, y1: 1.05 };

// ---- shaders --------------------------------------------------------------------------------

const LAYER_VERT = /* glsl */ `
attribute float aLower;
varying vec2 vUv;
varying float vLower;
void main() {
  vUv = uv;
  vLower = aLower;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Texels are premultiplied on upload (texture.premultiplyAlpha) and blended with
// ONE / ONE_MINUS_SRC_ALPHA, so mip levels and filtered edges never pick up dark fringes.
// uPart: 0 = whole layer, 1 = only where aLower < 0.5, 2 = only where aLower >= 0.5 (arms are
// split at the elbow so the forearm can change draw order, like a Live2D draw-order parameter).
const LAYER_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float opacity;
uniform float uPart;
uniform vec3 uAdd;
varying vec2 vUv;
varying float vLower;
void main() {
  if (uPart > 0.5) {
    float lower = step(0.5, vLower);
    if (uPart < 1.5 ? lower > 0.5 : lower < 0.5) discard;
  }
  vec4 c = texture2D(map, vUv);
  c.rgb += uAdd * c.a;
  gl_FragColor = c * opacity;
}`;

// Same radial gradient as the 3D page's CSS background (style.css), computed in sRGB like CSS,
// with a little dither against banding.
const BG_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BG_FRAG = /* glsl */ `
uniform vec2 uRes;
vec3 srgb(float r, float g, float b) { return vec3(r, g, b) / 255.0; }
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float yCss = 1.0 - uv.y;
  float d = length(vec2((uv.x - 0.5) / 0.85, (yCss - 0.42) / 0.75));
  vec3 c0 = srgb(246.0, 244.0, 243.0);
  vec3 c1 = srgb(236.0, 234.0, 233.0);
  vec3 c2 = srgb(227.0, 224.0, 222.0);
  vec3 c = d < 0.62 ? mix(c0, c1, d / 0.62) : mix(c1, c2, clamp((d - 0.62) / 0.38, 0.0, 1.0));
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`;

// Soft elliptical contact shadow (unit quad, gaussian falloff reaching 0 at the rim).
const SHADOW_FRAG = /* glsl */ `
uniform float opacity;
uniform vec3 color;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  float a = r2 >= 1.0 ? 0.0 : exp(-3.2 * r2) * (1.0 - r2);
  a *= opacity;
  gl_FragColor = vec4(color * a, a);
}`;
const SHADOW_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const PREMUL_BLEND = {
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

export function makeLayerMaterial(map, part = 0) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      opacity: { value: 1 },
      uPart: { value: part },
      uAdd: { value: new THREE.Vector3() },
    },
    vertexShader: LAYER_VERT,
    fragmentShader: LAYER_FRAG,
    ...PREMUL_BLEND,
  });
}

/** Textured unit quad (centred) for sprites: logo pieces, heart, Z, keyboard. */
export function makeSprite(texture, { w = 1, h = 1, order = 0, name = 'sprite' } = {}) {
  const geo = new THREE.PlaneGeometry(w, h);
  geo.setAttribute('aLower', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
  const mesh = new THREE.Mesh(geo, makeLayerMaterial(texture));
  mesh.renderOrder = order;
  mesh.frustumCulled = false;
  mesh.name = name;
  return mesh;
}

function makeShadow(rgb = [0x4a, 0x3a, 0x33], opacity = 0.2) {
  // gamma-space pipeline: the colour is used as raw sRGB values
  const mat = new THREE.ShaderMaterial({
    uniforms: { opacity: { value: opacity }, color: { value: new THREE.Vector3(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255) } },
    vertexShader: SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    ...PREMUL_BLEND,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;
  mesh.userData.baseOpacity = opacity;
  return mesh;
}

/** Texture from a canvas/image, premultiplied, gamma-space, mipmapped. */
export function makeTexture(image, anisotropy = 4) {
  const tex = new THREE.Texture(image);
  tex.colorSpace = THREE.NoColorSpace; // gamma-space pipeline: raw sRGB values in, raw out
  tex.premultiplyAlpha = true;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  return res.json();
}

function alphaMapOf(img) {
  const w = Math.max(1, Math.ceil(img.naturalWidth / ALPHA_DOWN));
  const h = Math.max(1, Math.ceil(img.naturalHeight / ALPHA_DOWN));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = data[i * 4 + 3];
  return { w, h, a };
}

/** Grid geometry covering the layer rectangle; cells with no opaque texel are left out. */
function buildGrid(def, alpha) {
  const [pw, ph] = def.px;
  const nx = Math.max(2, Math.min(MAX_CELLS, Math.round(pw / CELL_PX)));
  const ny = Math.max(2, Math.min(MAX_CELLS, Math.round(ph / CELL_PX)));
  const nv = (nx + 1) * (ny + 1);
  const rest = new Float32Array(nv * 2);
  const pos = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const k = j * (nx + 1) + i;
      const u = i / nx;
      const v = j / ny;
      uv[k * 2] = u;
      uv[k * 2 + 1] = v;
      rest[k * 2] = def.x0 + def.w * u;
      rest[k * 2 + 1] = def.y0 + def.h * v;
      pos[k * 3] = rest[k * 2];
      pos[k * 3 + 1] = rest[k * 2 + 1];
    }
  }
  const idx = [];
  const { w: aw, h: ah, a } = alpha;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      // alpha-map rect of the cell (image rows run top -> bottom), dilated by one texel
      const ax0 = Math.max(0, Math.floor((i / nx) * aw) - 1);
      const ax1 = Math.min(aw - 1, Math.ceil(((i + 1) / nx) * aw) + 1);
      const ay0 = Math.max(0, Math.floor((1 - (j + 1) / ny) * ah) - 1);
      const ay1 = Math.min(ah - 1, Math.ceil((1 - j / ny) * ah) + 1);
      let used = false;
      for (let y = ay0; y <= ay1 && !used; y++) for (let x = ax0; x <= ax1; x++) if (a[y * aw + x] > 1) { used = true; break; }
      if (!used) continue;
      const k = j * (nx + 1) + i;
      idx.push(k, k + 1, k + nx + 1, k + 1, k + nx + 2, k + nx + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aLower', new THREE.BufferAttribute(new Float32Array(nv), 1));
  geo.setIndex(idx);
  return { geo, rest, pos, nx, ny, cells: Uint32Array.from(idx) };
}

export class Puppet {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container
   * @param {string} [o.base]  URL prefix of layers.json / rig.json
   * @param {boolean} [o.background]  draw the gradient background (false = transparent canvas)
   * @param {number} [o.insetBottom]  CSS px covered by a toolbar
   */
  constructor({ container, base = './live2d/', background = true, insetBottom = 0, preserveDrawingBuffer = false }) {
    this.container = container;
    this.base = base.endsWith('/') ? base : base + '/';
    this.insetBottom = insetBottom;
    this.box = { ...CONTENT_BOX };
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'live2d-stage';
    Object.assign(this.canvas.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', display: 'block', touchAction: 'none', outline: 'none',
    });
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: false, alpha: !background, premultipliedAlpha: true, preserveDrawingBuffer,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0xeceae9, background ? 1 : 0);
    this.renderer.sortObjects = true;
    this.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
    this.camera.position.set(0, 0, 5);
    this.view = { left: -1, right: 1, top: 1, bottom: -1, scale: 1, w: 1, h: 1 };
    this.disposables = new Set();

    if (background) {
      const bgGeo = new THREE.BufferGeometry();
      bgGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      const bgMat = new THREE.ShaderMaterial({
        uniforms: { uRes: { value: new THREE.Vector2(1, 1) } },
        vertexShader: BG_VERT,
        fragmentShader: BG_FRAG,
        depthTest: false,
        depthWrite: false,
      });
      this.bg = new THREE.Mesh(bgGeo, bgMat);
      this.bg.frustumCulled = false;
      this.bg.renderOrder = -1000;
      this.scene.add(this.bg);
      this.track(bgGeo, bgMat);
    }

    this.shadow = makeShadow(undefined, 0.26);
    this.shadow.renderOrder = -900;
    this.logoShadow = makeShadow(undefined, 0.12);
    this.logoShadow.renderOrder = -899;
    this.scene.add(this.shadow, this.logoShadow);
    this.track(this.shadow.geometry, this.shadow.material, this.logoShadow.geometry, this.logoShadow.material);

    this.root = new THREE.Group(); // fox layers (vertex positions are already in model space)
    this.scene.add(this.root);
    this.layers = [];
    this.byName = {};
  }

  track(...objs) {
    for (const o of objs) this.disposables.add(o);
  }

  async load() {
    const [meta, rig] = await Promise.all([fetchJSON(this.base + 'layers.json'), fetchJSON(this.base + 'rig.json')]);
    this.meta = meta;
    this.rig = rig;
    const order = rig.order && rig.order.length ? rig.order : meta.layers.map((l) => l.name);
    const defs = Object.fromEntries(meta.layers.map((l) => [l.name, l]));
    const names = [...order.filter((n) => defs[n]), ...meta.layers.map((l) => l.name).filter((n) => !order.includes(n))];
    const images = await Promise.all(names.map((n) => loadImage(this.base + defs[n].file)));
    names.forEach((name, i) => {
      const def = defs[name];
      const img = images[i];
      const alpha = alphaMapOf(img);
      const grid = buildGrid(def, alpha);
      const tex = makeTexture(img, this.anisotropy);
      const mat = makeLayerMaterial(tex);
      const mesh = new THREE.Mesh(grid.geo, mat);
      mesh.name = name;
      mesh.frustumCulled = false;
      const baseOrder = 100 + i * 10;
      mesh.renderOrder = baseOrder;
      this.root.add(mesh);
      this.track(grid.geo, mat, tex);
      const layer = {
        name, def, mesh, meshes: [mesh], tex, alpha,
        rest: grid.rest, pos: grid.pos, nx: grid.nx, ny: grid.ny, cells: grid.cells,
        baseOrder, opacity: 1, visible: true, sig: null, bounds: [0, 0, 0, 0],
      };
      this.layers.push(layer);
      this.byName[name] = layer;
    });
    this.updateBounds();
    return this;
  }

  /** Split a layer in two draw calls at aLower = 0.5 (weights from the rig). Returns the lower mesh. */
  splitLayer(name, lowerWeights) {
    const L = this.byName[name];
    if (!L || L.lower) return L?.lower;
    const attr = L.mesh.geometry.attributes.aLower;
    attr.array.set(lowerWeights);
    attr.needsUpdate = true;
    L.mesh.material.uniforms.uPart.value = 1;
    const mat = makeLayerMaterial(L.tex, 2);
    const lower = new THREE.Mesh(L.mesh.geometry, mat);
    lower.name = name + '_lower';
    lower.frustumCulled = false;
    lower.renderOrder = L.baseOrder + 1;
    this.root.add(lower);
    this.track(mat);
    L.lower = lower;
    L.meshes.push(lower);
    return lower;
  }

  setOpacity(L, o) {
    L.opacity = o;
    const vis = o > 0.002;
    L.visible = vis;
    for (const m of L.meshes) {
      m.visible = vis;
      m.material.uniforms.opacity.value = o;
    }
  }

  /** Mark a layer's deformed positions as uploaded-dirty and refresh its bounds. */
  commit(L) {
    L.mesh.geometry.attributes.position.needsUpdate = true;
    const p = L.pos;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i];
      const y = p[i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    L.bounds[0] = x0; L.bounds[1] = y0; L.bounds[2] = x1; L.bounds[3] = y1;
  }

  updateBounds() {
    for (const L of this.layers) this.commit(L);
  }

  // ---- view -----------------------------------------------------------------------------------

  size() {
    const r = this.container.getBoundingClientRect();
    return { w: Math.max(1, Math.round(r.width || window.innerWidth)), h: Math.max(1, Math.round(r.height || window.innerHeight)) };
  }

  setInsetBottom(px) {
    this.insetBottom = Math.max(0, px || 0);
    this.resize();
  }

  /** Fit the content box into the canvas (16 px margin, above the bottom inset). */
  resize() {
    const { w, h } = this.size();
    this.renderer.setSize(w, h, false);
    const b = this.box;
    const bw = b.x1 - b.x0;
    const bh = b.y1 - b.y0;
    const availW = Math.max(40, w - 2 * MARGIN_PX);
    const availH = Math.max(40, h - 2 * MARGIN_PX - this.insetBottom);
    const s = Math.min(availW / bw, availH / bh); // CSS px per model unit
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const cyPx = MARGIN_PX + availH / 2; // centre of the usable band, from the top
    const left = cx - w / 2 / s;
    const top = cy + cyPx / s;
    Object.assign(this.view, { left, right: left + w / s, top, bottom: top - h / s, scale: s, w, h });
    Object.assign(this.camera, { left, right: left + w / s, top, bottom: top - h / s });
    this.camera.updateProjectionMatrix();
    if (this.bg) {
      const pr = this.renderer.getPixelRatio();
      this.bg.material.uniforms.uRes.value.set(w * pr, h * pr);
    }
  }

  /** Client px -> model units. */
  toModel(clientX, clientY, out = { x: 0, y: 0 }) {
    const r = this.canvas.getBoundingClientRect();
    const v = this.view;
    out.x = v.left + ((clientX - r.left) / Math.max(1, r.width)) * (v.right - v.left);
    out.y = v.top - ((clientY - r.top) / Math.max(1, r.height)) * (v.top - v.bottom);
    return out;
  }

  /** Model units -> client px. */
  toClient(x, y, out = { x: 0, y: 0 }) {
    const r = this.canvas.getBoundingClientRect();
    const v = this.view;
    out.x = r.left + ((x - v.left) / (v.right - v.left)) * r.width;
    out.y = r.top + ((v.top - y) / (v.top - v.bottom)) * r.height;
    return out;
  }

  // ---- hit testing ------------------------------------------------------------------------

  /** Alpha (0..255) of layer L at model point (x, y) in its current deformed state, or 0. */
  alphaAt(L, x, y) {
    const b = L.bounds;
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return 0;
    const p = L.pos;
    const uv = L.mesh.geometry.attributes.uv.array;
    const c = L.cells;
    for (let t = 0; t < c.length; t += 3) {
      const i0 = c[t], i1 = c[t + 1], i2 = c[t + 2];
      const ax = p[i0 * 3], ay = p[i0 * 3 + 1];
      const bx = p[i1 * 3], by = p[i1 * 3 + 1];
      const cx = p[i2 * 3], cy = p[i2 * 3 + 1];
      if ((x < ax && x < bx && x < cx) || (x > ax && x > bx && x > cx)) continue;
      if ((y < ay && y < by && y < cy) || (y > ay && y > by && y > cy)) continue;
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-12) continue;
      const l0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
      const l1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const u = l0 * uv[i0 * 2] + l1 * uv[i1 * 2] + l2 * uv[i2 * 2];
      const v = l0 * uv[i0 * 2 + 1] + l1 * uv[i1 * 2 + 1] + l2 * uv[i2 * 2 + 1];
      const A = L.alpha;
      const px = Math.min(A.w - 1, Math.max(0, Math.floor(u * A.w)));
      const py = Math.min(A.h - 1, Math.max(0, Math.floor((1 - v) * A.h)));
      return A.a[py * A.w + px];
    }
    return 0;
  }

  /** Top-most layer (by current draw order) whose texel at (x, y) is opaque enough. */
  pickLayer(x, y, threshold = 110) {
    let best = null;
    let bestOrder = -Infinity;
    for (const L of this.layers) {
      if (!L.visible || L.opacity < 0.3 || !L.pickable) continue;
      const order = Math.max(...L.meshes.map((m) => m.renderOrder));
      if (order <= bestOrder) continue;
      if (this.alphaAt(L, x, y) >= threshold) {
        best = L;
        bestOrder = order;
      }
    }
    return best;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    for (const o of this.disposables) o.dispose?.();
    this.disposables.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}
