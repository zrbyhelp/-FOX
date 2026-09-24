// 2D props drawn procedurally to canvas textures: the brand logo (4 cream rounded cubes + an
// orange 4-point star, "2.5D" shading), the 比心 heart pop, the doze Z's and the typing keyboard.
// Everything is a textured quad in model units, rendered with the puppet's premultiplied shader.
import { makeSprite, makeTexture } from './puppet.js';
import { clamp, easeOutBack, easeInOut, smooth, lerp } from './math2d.js';

const TAU = Math.PI * 2;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function roundedPoly(g, pts, r) {
  // polygon with rounded corners (arcTo between edge midpoints)
  const n = pts.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  g.beginPath();
  const m0 = mid(pts[n - 1], pts[0]);
  g.moveTo(m0[0], m0[1]);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = mid(p, pts[(i + 1) % n]);
    g.arcTo(p[0], p[1], q[0], q[1], r);
  }
  g.closePath();
}

// ---- textures -------------------------------------------------------------------------------

/** Rounded cube seen a little from above and from the right, soft velvet-plastic shading. */
function drawCube(size = 256) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const s = size / 256;
  g.scale(s, s);
  const F = [[46, 92], [184, 92], [184, 226], [46, 226]]; // front face
  const d = [30, -30]; // depth offset (up-right)
  const T = [F[0], F[1], [F[1][0] + d[0], F[1][1] + d[1]], [F[0][0] + d[0], F[0][1] + d[1]]];
  const R = [F[1], [F[1][0] + d[0], F[1][1] + d[1]], [F[2][0] + d[0], F[2][1] + d[1]], F[2]];
  const hull = [F[3], F[0], T[3], T[2], R[2], F[2]];
  // soft drop shadow
  g.save();
  g.shadowColor = 'rgba(110, 72, 40, 0.18)';
  g.shadowBlur = 16;
  g.shadowOffsetY = 6;
  roundedPoly(g, hull, 26);
  g.fillStyle = '#EFDCC6';
  g.fill();
  g.restore();
  g.save();
  roundedPoly(g, hull, 26);
  g.clip();
  // faces
  const face = (pts, fill) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(...p) : g.moveTo(...p))); g.closePath(); g.fillStyle = fill; g.fill(); };
  let gr = g.createLinearGradient(0, 60, 0, 100);
  gr.addColorStop(0, '#FFF9F2');
  gr.addColorStop(1, '#FBEEDF');
  face([[T[0][0] - 20, T[0][1] + 6], T[1], T[2], [T[3][0] - 20, T[3][1] - 20]], gr);
  gr = g.createLinearGradient(184, 0, 216, 0);
  gr.addColorStop(0, '#E9D3BC');
  gr.addColorStop(1, '#DDC4AA');
  face([R[0], [R[1][0] + 20, R[1][1]], [R[2][0] + 20, R[2][1] + 20], R[3]], gr);
  gr = g.createLinearGradient(46, 92, 170, 226);
  gr.addColorStop(0, '#FAEBDA');
  gr.addColorStop(0.55, '#F4E2CE');
  gr.addColorStop(1, '#EAD4BD');
  face([[F[0][0] - 20, F[0][1]], F[1], F[2], [F[3][0] - 20, F[3][1] + 20]], gr);
  // soften the edges between faces (rounded bevels)
  if ('filter' in g) {
    g.filter = 'blur(7px)';
    g.strokeStyle = 'rgba(255, 252, 247, 0.85)';
    g.lineWidth = 9;
    g.beginPath();
    g.moveTo(F[0][0] + 10, F[0][1]);
    g.lineTo(F[1][0] - 6, F[1][1]);
    g.stroke();
    g.strokeStyle = 'rgba(214, 190, 164, 0.55)';
    g.beginPath();
    g.moveTo(F[1][0] + 2, F[1][1] + 8);
    g.lineTo(F[2][0] + 2, F[2][1] - 12);
    g.stroke();
    g.filter = 'none';
  }
  // velvet sheen at the rim + bottom occlusion
  gr = g.createRadialGradient(95, 140, 20, 115, 150, 130);
  gr.addColorStop(0, 'rgba(255,255,255,0.0)');
  gr.addColorStop(0.75, 'rgba(255,255,255,0.0)');
  gr.addColorStop(1, 'rgba(255,255,255,0.35)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 256);
  gr = g.createLinearGradient(0, 190, 0, 232);
  gr.addColorStop(0, 'rgba(160, 120, 90, 0)');
  gr.addColorStop(1, 'rgba(160, 120, 90, 0.12)');
  g.fillStyle = gr;
  g.fillRect(0, 150, 256, 106);
  g.restore();
  return c;
}

function starPath(g, cx, cy, r, inner) {
  const tips = [[0, -r], [r, 0], [0, r], [-r, 0]];
  g.beginPath();
  g.moveTo(cx + tips[0][0], cy + tips[0][1]);
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = tips[i];
    const [bx, by] = tips[(i + 1) % 4];
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const k = inner / Math.hypot(mx, my);
    g.quadraticCurveTo(cx + mx * k, cy + my * k, cx + bx, cy + by);
  }
  g.closePath();
}

/** Glossy orange concave 4-point star with a little extrusion. */
function drawStar(size = 256) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const s = size / 256;
  g.scale(s, s);
  const cx = 124;
  const cy = 122;
  const r = 104;
  const inner = 24;
  g.save();
  g.shadowColor = 'rgba(150, 70, 20, 0.22)';
  g.shadowBlur = 14;
  g.shadowOffsetY = 6;
  starPath(g, cx + 5, cy + 7, r, inner);
  g.fillStyle = '#D9662C';
  g.fill();
  g.restore();
  // side (extrusion)
  for (let i = 5; i >= 1; i--) {
    starPath(g, cx + i, cy + i * 1.4, r, inner);
    g.fillStyle = i > 3 ? '#D46128' : '#E0703A';
    g.fill();
  }
  starPath(g, cx, cy, r, inner);
  const gr = g.createRadialGradient(cx - 30, cy - 34, 4, cx, cy, r);
  gr.addColorStop(0, '#FFC08E');
  gr.addColorStop(0.35, '#F99A5C');
  gr.addColorStop(0.8, '#F2833F');
  gr.addColorStop(1, '#EC7736');
  g.fillStyle = gr;
  g.fill();
  // specular highlight
  g.save();
  starPath(g, cx, cy, r, inner);
  g.clip();
  if ('filter' in g) g.filter = 'blur(6px)';
  g.fillStyle = 'rgba(255, 244, 232, 0.75)';
  g.beginPath();
  g.ellipse(cx - 18, cy - 30, 9, 26, 0.35, 0, TAU);
  g.fill();
  g.beginPath();
  g.ellipse(cx - 34, cy - 12, 20, 6, 0.3, 0, TAU);
  g.fill();
  g.restore();
  return c;
}

/** Soft warm glow disc (hover / activation halo). */
function drawGlow(size = 128) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, 'rgba(255, 226, 190, 0.9)');
  gr.addColorStop(0.45, 'rgba(255, 214, 170, 0.45)');
  gr.addColorStop(1, 'rgba(255, 214, 170, 0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  return c;
}

function heartPath(g, cx, cy, w) {
  // plump heart, width w, tip at the bottom (canvas y down)
  const k = w / 1;
  const P = (x, y) => [cx + x * k, cy - y * k];
  g.beginPath();
  g.moveTo(...P(0, -0.42));
  g.bezierCurveTo(...P(0.14, -0.3), ...P(0.5, -0.1), ...P(0.5, 0.15));
  g.bezierCurveTo(...P(0.5, 0.4), ...P(0.24, 0.5), ...P(0, 0.27));
  g.bezierCurveTo(...P(-0.24, 0.5), ...P(-0.5, 0.4), ...P(-0.5, 0.15));
  g.bezierCurveTo(...P(-0.5, -0.1), ...P(-0.14, -0.3), ...P(0, -0.42));
  g.closePath();
}

function drawHeart(size = 192) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const cx = size / 2;
  const cy = size * 0.5;
  const w = size * 0.86;
  g.save();
  g.shadowColor = 'rgba(200, 60, 90, 0.25)';
  g.shadowBlur = size * 0.06;
  g.shadowOffsetY = size * 0.03;
  heartPath(g, cx, cy, w);
  g.fillStyle = '#FF6F8E';
  g.fill();
  g.restore();
  heartPath(g, cx, cy, w);
  const gr = g.createRadialGradient(cx - w * 0.16, cy - w * 0.2, w * 0.03, cx, cy, w * 0.62);
  gr.addColorStop(0, '#FFC6D3');
  gr.addColorStop(0.45, '#FF93AB');
  gr.addColorStop(1, '#F76587');
  g.fillStyle = gr;
  g.fill();
  g.save();
  heartPath(g, cx, cy, w);
  g.clip();
  if ('filter' in g) g.filter = `blur(${Math.round(size * 0.02)}px)`;
  g.fillStyle = 'rgba(255, 250, 252, 0.8)';
  g.beginPath();
  g.ellipse(cx - w * 0.22, cy - w * 0.2, w * 0.1, w * 0.055, -0.6, 0, TAU);
  g.fill();
  g.restore();
  return c;
}

function drawZ(size = 96) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  g.font = `700 ${Math.round(size * 0.78)}px "Baloo 2", "Arial Rounded MT Bold", "PingFang SC", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = size * 0.12;
  g.strokeStyle = '#ffffff';
  g.strokeText('Z', size / 2, size * 0.53);
  g.fillStyle = '#e8743c';
  g.fillText('Z', size / 2, size * 0.53);
  return c;
}

// ---- logo ---------------------------------------------------------------------------------------

export const LOGO_POS = [-0.6, 0.56];
export const LOGO_POS_PORTRAIT = [-0.34, 1.14];
const GAP = 0.086; // diamond centre -> cube centre
const CUBE_W = 0.1; // sprite size (includes the side faces)
const STAR_HOME = [0.104, 0.104];
const STAR_W = 0.13;
const ORBIT_R = 0.15;
const T_IN = 0.7;
const T_HOLD = 2.6;
const T_OUT = 1.0;

export class Logo2D {
  constructor(puppet, { pieces = ['Cube_Top', 'Cube_Left', 'Cube_Right', 'Cube_Bottom', 'Star'] } = {}) {
    this.puppet = puppet;
    const ani = puppet.anisotropy;
    this.textures = [makeTexture(drawCube(), ani), makeTexture(drawStar(), ani), makeTexture(drawGlow(), ani)];
    const [cubeTex, starTex, glowTex] = this.textures;
    this.glow = makeSprite(glowTex, { w: 0.46, h: 0.46, order: 50, name: 'LogoGlow' });
    puppet.scene.add(this.glow);
    const layout = { Cube_Top: [0, GAP], Cube_Left: [-GAP, 0], Cube_Right: [GAP, 0], Cube_Bottom: [0, -GAP] };
    this.pieces = {};
    let i = 0;
    for (const name of pieces) {
      const star = name === 'Star';
      const home = star ? STAR_HOME : layout[name];
      if (!home) continue;
      const mesh = makeSprite(star ? starTex : cubeTex, { w: star ? STAR_W : CUBE_W, h: star ? STAR_W : CUBE_W, order: star ? 56 : 51 + i, name });
      puppet.scene.add(mesh);
      this.pieces[name] = { mesh, home, angle: Math.atan2(home[1], home[0]), phase: i * 1.37, star, tilt: star ? 0 : [0.05, -0.08, 0.1, -0.04][i % 4] };
      i++;
    }
    this.pos = [...LOGO_POS];
    this.time = 0;
    this.hover = 0;
    this.hoverTarget = 0;
    this.phase = 0;
    this.mode = 'idle'; // idle | activating | active | settling
    this.modeT = 0;
    this.act = 0;
    this.pop = 1;
    this.lift = 0;
    this.center = [...LOGO_POS];
  }

  get state() { return this.mode; }
  get isActive() { return this.mode !== 'idle'; }
  setHover(on) { this.hoverTarget = on ? 1 : 0; }

  activate() {
    if (this.mode === 'active') this.modeT = 0;
    else if (this.mode !== 'activating') {
      this.mode = 'activating';
      this.modeT = this.act * T_IN;
    }
  }

  startPop(delay = 0) { this.pop = -delay / 0.6; }

  /** Star position (look-at target) in model units. */
  starPosition(out = [0, 0]) {
    const p = this.pieces.Star;
    if (!p) { out[0] = this.center[0]; out[1] = this.center[1]; return out; }
    out[0] = p.mesh.position.x;
    out[1] = p.mesh.position.y;
    return out;
  }

  /** Generous circular hit area (like the 3D pick proxy). */
  hit(x, y) {
    return Math.hypot(x - this.center[0], y - this.center[1]) < 0.17 * Math.max(0.3, this.scale || 1);
  }

  pose(state = 'idle') {
    this.time = 0;
    this.hover = this.hoverTarget = 0;
    this.pop = 1;
    this.mode = state === 'active' ? 'active' : 'idle';
    this.modeT = 0;
    this.act = state === 'active' ? 1 : 0;
    this.phase = state === 'active' ? 0.35 : 0;
    this.layout();
  }

  update(dt) {
    this.time += dt;
    this.modeT += dt;
    this.pop = Math.min(1, this.pop + dt / 0.6);
    this.hover += (this.hoverTarget - this.hover) * (1 - Math.exp(-dt * 10));
    switch (this.mode) {
      case 'activating':
        this.act = smooth(Math.min(1, this.modeT / T_IN));
        this.phase += dt * 2.4 * this.act;
        if (this.modeT >= T_IN) { this.mode = 'active'; this.modeT = 0; }
        break;
      case 'active':
        this.act = 1;
        this.phase += dt * 2.4;
        if (this.modeT >= T_HOLD) {
          this.mode = 'settling';
          this.modeT = 0;
          this.settleFrom = this.phase;
          this.settleTo = Math.ceil(this.phase / TAU + 0.15) * TAU;
        }
        break;
      case 'settling': {
        const s = Math.min(1, this.modeT / T_OUT);
        this.act = 1 - easeInOut(s);
        this.phase = this.settleFrom + (this.settleTo - this.settleFrom) * easeInOut(s);
        if (s >= 1) { this.mode = 'idle'; this.phase = 0; this.act = 0; }
        break;
      }
      default:
        this.act = 0;
    }
    this.layout();
  }

  layout() {
    const t = this.time;
    const a = this.act;
    const h = this.hover;
    const popS = this.pop <= 0 ? 0.001 : Math.max(0.001, easeOutBack(this.pop, 1.9));
    const lift = 0.012 * Math.sin(t * 1.1) + 0.022 * h;
    const sway = 0.05 * Math.sin(t * 0.35);
    const S = popS * (1 + 0.06 * h + 0.08 * a);
    this.scale = S;
    this.lift = lift;
    const cx = this.pos[0];
    const cy = this.pos[1] + lift;
    this.center[0] = cx;
    this.center[1] = cy;
    const cs = Math.cos(sway);
    const sn = Math.sin(sway);
    const place = (mesh, x, y, rot, sx, sy) => {
      mesh.position.set(cx + (x * cs - y * sn) * S, cy + (x * sn + y * cs) * S, 0);
      mesh.rotation.z = rot + sway;
      mesh.scale.set(sx * S, sy * S, 1);
      mesh.visible = popS > 0.01;
    };
    for (const p of Object.values(this.pieces)) {
      const bob = 0.006 * Math.sin(t * 1.7 + p.phase) * (1 - a);
      if (p.star) {
        const k = 1 - a;
        const sc = 1 + 0.25 * a + 0.03 * Math.sin(t * 2.3);
        place(p.mesh, p.home[0] * k, p.home[1] * k + bob, 0.15 * Math.sin(t * 0.6) + this.phase * 0.5 * a, sc, sc);
      } else {
        const r0 = Math.hypot(p.home[0], p.home[1]);
        const r = r0 + (ORBIT_R - r0) * a;
        const ang = p.angle + this.phase * a + 0.25 * a;
        const tumble = a * (0.6 + this.phase * 0.8);
        // fake a 3D tumble: in-plane spin + a gentle squash across the spin axis
        const squash = 1 - 0.14 * a * Math.abs(Math.sin(tumble * 1.3 + p.phase));
        place(p.mesh, Math.cos(ang) * r, Math.sin(ang) * r + bob,
          p.tilt + 0.08 * Math.sin(t * 0.9 + p.phase) * (1 - a) + tumble * 0.6 * Math.cos(p.phase), squash, 1);
      }
    }
    // glow behind the logo on hover / activation
    const glow = 0.5 * h + 0.55 * a;
    this.glow.material.uniforms.opacity.value = glow * Math.min(1, popS);
    this.glow.visible = glow > 0.003 && popS > 0.01;
    this.glow.position.set(cx, cy, 0);
    this.glow.scale.setScalar(S * (0.9 + 0.2 * a));
    // brighten the pieces a touch
    const add = 0.05 * h + 0.06 * a;
    for (const p of Object.values(this.pieces)) p.mesh.material.uniforms.uAdd.value.set(add, add * 0.8, add * 0.6);
    // ground shadow: lighter and wider when lifted
    const sh = this.puppet.logoShadow;
    const high = this.pos[1] > 0.8; // portrait layout: floating above the head, no ground shadow
    sh.visible = !high;
    sh.position.set(cx, 0.0, 0);
    const k = (1 + lift * 2 + 0.2 * a) * Math.min(1, popS);
    sh.scale.set(0.34 * k, 0.05 * k, 1);
    sh.material.uniforms.opacity.value = sh.userData.baseOpacity * (1 - lift * 3) * Math.min(1, popS);
  }

  dispose() {
    for (const t of this.textures) t.dispose();
    for (const m of [this.glow, ...Object.values(this.pieces).map((p) => p.mesh)]) {
      m.geometry.dispose();
      m.material.dispose();
      m.removeFromParent();
    }
  }
}

// ---- effects ------------------------------------------------------------------------------------

/** Pool of short-lived sprites (hearts, Z's). */
class Particles {
  constructor(puppet, tex, count, order, name) {
    this.pool = [];
    for (let i = 0; i < count; i++) {
      const m = makeSprite(tex, { order: order + i * 0.01, name });
      m.visible = false;
      puppet.scene.add(m);
      this.pool.push({ mesh: m, life: -1, x: 0, y: 0, kind: 0, seed: i });
    }
  }

  spawn(x, y, kind = 0, seed = Math.random()) {
    const p = this.pool.find((q) => q.life < 0) || this.pool.reduce((a, b) => (a.life > b.life ? a : b));
    Object.assign(p, { life: 0, x, y, kind, seed });
    p.mesh.visible = true;
    return p;
  }

  clear() {
    for (const p of this.pool) { p.life = -1; p.mesh.visible = false; }
  }

  get active() { return this.pool.some((p) => p.life >= 0); }

  dispose() {
    for (const p of this.pool) {
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      p.mesh.removeFromParent();
    }
  }
}

export class HeartFx extends Particles {
  constructor(puppet) {
    const tex = makeTexture(drawHeart(), puppet.anisotropy);
    super(puppet, tex, 6, 400, 'Heart');
    this.tex = tex;
    this.shown = 0;
  }

  /** Big heart between the paws + a few little ones floating up. */
  pop(x, y, rng = Math.random) {
    this.shown++;
    this.spawn(x, y, 0);
    for (let i = 0; i < 3; i++) this.spawn(x + (rng() - 0.5) * 0.16, y + 0.02, 1 + i, rng());
  }

  update(dt) {
    for (const p of this.pool) {
      if (p.life < 0) continue;
      const m = p.mesh;
      if (p.kind === 0) {
        const dur = 1.9;
        p.life += dt / dur;
        if (p.life >= 1) { p.life = -1; m.visible = false; continue; }
        const t = p.life * dur;
        const popIn = easeOutBack(clamp(t / 0.32, 0, 1), 2.4);
        const out = clamp((t - (dur - 0.3)) / 0.3, 0, 1);
        const s = 0.12 * popIn * (1 + 0.35 * out) * (1 + 0.04 * Math.sin(t * 9) * (1 - out));
        m.position.set(p.x + 0.012 * Math.sin(t * 3), p.y + 0.1 * smooth(clamp(t / 1.4, 0, 1)), 0);
        m.scale.set(s, s, 1);
        m.rotation.z = 0.12 * Math.sin(t * 2.4);
        m.material.uniforms.opacity.value = 1 - out;
      } else {
        const dur = 1.4 + 0.3 * p.seed;
        const delay = 0.15 * p.kind;
        p.life += dt / (dur + delay);
        if (p.life >= 1) { p.life = -1; m.visible = false; continue; }
        const t = p.life * (dur + delay) - delay;
        if (t < 0) { m.scale.set(0.001, 0.001, 1); continue; }
        const u = t / dur;
        const s = 0.04 * (0.6 + 0.4 * p.seed) * easeOutBack(clamp(t / 0.25, 0, 1));
        m.position.set(p.x + 0.03 * Math.sin(t * 4 + p.seed * 6), p.y + 0.22 * u, 0);
        m.scale.set(s, s, 1);
        m.rotation.z = 0.3 * Math.sin(t * 3 + p.seed * 5);
        m.material.uniforms.opacity.value = Math.min(1, t * 6) * (1 - u);
      }
    }
  }

  dispose() {
    super.dispose();
    this.tex.dispose();
  }
}

export class DozeFx extends Particles {
  constructor(puppet) {
    const tex = makeTexture(drawZ(), puppet.anisotropy);
    super(puppet, tex, 4, 410, 'DozeZ');
    this.tex = tex;
    this.timer = 0;
    this.activeFx = false;
  }

  setActive(on) {
    if (on && !this.activeFx) this.timer = 0.4;
    this.activeFx = on;
  }

  update(dt, head) {
    if (this.activeFx) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = 1.1;
        this.spawn(head[0] + 0.2, head[1] - 0.04);
      }
    }
    for (const p of this.pool) {
      if (p.life < 0) continue;
      p.life += dt / 2.6;
      if (p.life >= 1) { p.life = -1; p.mesh.visible = false; continue; }
      const L = p.life;
      p.mesh.position.set(p.x + 0.1 * L + 0.02 * Math.sin(L * 7), p.y + 0.17 * L, 0);
      const s = 0.05 + 0.065 * L;
      p.mesh.scale.set(s, s, 1);
      p.mesh.rotation.z = -0.15 + 0.1 * Math.sin(L * 5);
      p.mesh.material.uniforms.opacity.value = Math.min(1, L * 6) * (1 - L) * 1.1;
    }
  }

  dispose() {
    super.dispose();
    this.tex.dispose();
  }
}

// ---- keyboard ------------------------------------------------------------------------------------

// Same layout family as the 3D keyboard (keyboard.js), seen from the viewer.
const ROWS = [
  [['Digit1', 'Backquote', 'Escape'], 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal',
    { codes: ['Backspace', 'Delete', 'Insert'], w: 1.5, accent: true }],
  [{ codes: ['Tab'], w: 1.5 }, 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', ['BracketRight', 'Backslash']],
  [{ codes: ['CapsLock'], w: 1.5 }, 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', ['Semicolon', 'Quote'],
    { codes: ['Enter', 'NumpadEnter'], w: 2, accent: true }],
  [{ codes: ['ShiftLeft'], w: 1.5 }, 'KeyZ', 'KeyX', 'KeyC', 'KeyV', { codes: ['Space'], w: 4 }, 'KeyB', 'KeyN', ['KeyM', 'Comma', 'Period', 'Slash'],
    { codes: ['ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], w: 1, accent: true }],
];
const UNITS = 13.5;
const KB_W = 0.46; // model units
const KB_H = 0.164;
const KB_PX = [640, 228];

export class Keyboard2D {
  constructor(puppet, { order }) {
    this.puppet = puppet;
    this.cv = canvas(...KB_PX);
    this.g = this.cv.getContext('2d');
    this.keys = [];
    this.byCode = new Map();
    ROWS.forEach((row, r) => {
      let u = 0;
      const total = row.reduce((s, it) => s + (it.w || 1), 0);
      const pad = (UNITS - total) / 2;
      for (const item of row) {
        const key = typeof item === 'string' ? { codes: [item] } : Array.isArray(item) ? { codes: item } : { ...item };
        key.w = key.w || 1;
        key.row = r;
        key.u = pad + u;
        key.press = 0;
        u += key.w;
        this.keys.push(key);
        for (const c of key.codes) this.byCode.set(c, key);
      }
    });
    this.tex = makeTexture(this.cv, puppet.anisotropy);
    this.mesh = makeSprite(this.tex, { w: KB_W, h: KB_H, order, name: 'Keyboard' });
    this.mesh.visible = false;
    puppet.scene.add(this.mesh);
    this.mode = 'hidden'; // hidden | in | shown | out
    this.t = 0;
    this.scale = 0;
    this.dirty = true;
    this.pressedCount = 0;
    this.draw();
  }

  keyFor(code) {
    const k = this.byCode.get(code);
    if (k) return k;
    let h = 0;
    for (const ch of String(code)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return this.keys[h % this.keys.length];
  }

  /** Light a key; returns the paw that would hit it ('L' = fox's left = screen right). */
  press(code) {
    const k = this.keyFor(code);
    k.press = 1;
    this.dirty = true;
    this.pressedCount++;
    return k.u + k.w / 2 > UNITS / 2 ? 'L' : 'R';
  }

  show() {
    if (this.mode === 'shown' || this.mode === 'in') return;
    this.mode = 'in';
    this.t = this.scale > 0 ? this.scale * 0.42 : 0;
  }

  hide() {
    if (this.mode === 'hidden' || this.mode === 'out') return;
    this.mode = 'out';
    this.t = 0;
    this.from = this.scale;
  }

  get visible() { return this.mode !== 'hidden'; }

  draw() {
    const g = this.g;
    const [W, H] = KB_PX;
    g.clearRect(0, 0, W, H);
    const inset = 44; // perspective: the far edge is narrower
    const top = 18;
    const bottom = 176;
    const thick = 30;
    const lerpX = (y, side) => (side < 0 ? lerp(inset, 16, (y - top) / (bottom - top)) : lerp(W - inset, W - 16, (y - top) / (bottom - top)));
    // shadow + slab
    g.save();
    g.shadowColor = 'rgba(110, 72, 40, 0.22)';
    g.shadowBlur = 18;
    g.shadowOffsetY = 8;
    roundedPoly(g, [[inset, top], [W - inset, top], [W - 16, bottom], [W - 16, bottom + thick], [16, bottom + thick], [16, bottom]], 20);
    g.fillStyle = '#E2C6AA';
    g.fill();
    g.restore();
    roundedPoly(g, [[inset, top], [W - inset, top], [W - 16, bottom], [16, bottom]], 20);
    const gr = g.createLinearGradient(0, top, 0, bottom);
    gr.addColorStop(0, '#F7E4CF');
    gr.addColorStop(1, '#EFD5BA');
    g.fillStyle = gr;
    g.fill();
    // keys
    const rows = ROWS.length;
    const y0 = top + 14;
    const y1 = bottom - 12;
    const rh = (y1 - y0) / rows;
    for (const k of this.keys) {
      const ya = y0 + k.row * rh + 3;
      const yb = ya + rh - 7;
      const xl = (y, u) => {
        const l = lerpX(y, -1) + 12;
        const r = lerpX(y, 1) - 12;
        return l + ((r - l) * u) / UNITS;
      };
      const pts = [[xl(ya, k.u) + 2, ya], [xl(ya, k.u + k.w) - 2, ya], [xl(yb, k.u + k.w) - 2, yb], [xl(yb, k.u) + 2, yb]];
      const pr = k.press;
      const base = k.accent ? [245, 141, 78] : [255, 247, 238];
      const hot = k.accent ? [255, 186, 130] : [255, 196, 154];
      const col = base.map((c, i) => Math.round(c + (hot[i] - c) * pr));
      // key side (depth) then cap
      roundedPoly(g, pts.map(([x, y]) => [x, y + 4]), 6);
      g.fillStyle = k.accent ? '#D9672E' : '#D9BB9C';
      g.fill();
      roundedPoly(g, pts.map(([x, y]) => [x, y + 2.5 * pr]), 6);
      g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      g.fill();
    }
    this.tex.needsUpdate = true;
    this.dirty = false;
  }

  update(dt, anchor) {
    // key lights fade
    let any = false;
    for (const k of this.keys) {
      if (k.press > 0) {
        k.press = Math.max(0, k.press - dt / 0.18);
        any = true;
      }
    }
    if (any) this.dirty = true;
    this.t += dt;
    switch (this.mode) {
      case 'in':
        this.scale = easeOutBack(Math.min(1, this.t / 0.42), 1.9);
        if (this.t >= 0.42) { this.mode = 'shown'; this.scale = 1; }
        break;
      case 'out':
        this.scale = (this.from ?? 1) * (1 - smooth(Math.min(1, this.t / 0.3)));
        if (this.t >= 0.3) { this.mode = 'hidden'; this.scale = 0; }
        break;
      default:
    }
    const vis = this.mode !== 'hidden' && this.scale > 0.005;
    this.mesh.visible = vis;
    if (!vis) return;
    if (this.dirty) this.draw();
    this.mesh.position.set(anchor[0], anchor[1] + 0.012 * Math.sin(this.t * 2.2), 0);
    this.mesh.scale.set(this.scale, this.scale, 1);
    this.mesh.rotation.z = anchor[2] || 0;
  }

  dispose() {
    this.tex.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}
