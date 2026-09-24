"""Vectorised signed distance functions (numpy). Points are (N,3) float arrays, Blender space.
Negative inside. Most primitives are exact; ellipsoid / scaled shapes are good bounds."""
from __future__ import annotations

import numpy as np


def _v(x):
    return np.asarray(x, dtype=np.float64)


def length(p):
    return np.sqrt((p * p).sum(-1))


# ------------------------------------------------------------------ primitives
def sphere(p, c, r):
    return length(p - _v(c)) - r


def ellipsoid(p, c, radii):
    """Inigo Quilez' ellipsoid bound (exact on the surface, good near it)."""
    r = _v(radii)
    q = p - _v(c)
    k0 = length(q / r)
    k1 = length(q / (r * r))
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-12)


def capsule(p, a, b, r):
    a = _v(a); b = _v(b)
    pa = p - a; ba = b - a
    h = np.clip((pa @ ba) / (ba @ ba), 0.0, 1.0)
    return length(pa - h[:, None] * ba) - r


def round_cone(p, a, b, ra, rb):
    """Sphere-swept cone between spheres (a, ra) and (b, rb) (IQ sdRoundCone)."""
    a = _v(a); b = _v(b)
    ba = b - a
    l2 = ba @ ba
    rr = ra - rb
    a2 = l2 - rr * rr
    il2 = 1.0 / l2
    pa = p - a
    y = pa @ ba
    z = y - l2
    x = pa * l2 - y[:, None] * ba
    x2 = (x * x).sum(-1)
    y2 = y * y * l2
    z2 = z * z * l2
    k = np.sign(rr) * rr * rr * x2
    out = np.empty(len(p))
    c1 = np.sign(z) * a2 * z2 > k
    c2 = np.sign(y) * a2 * y2 < k
    c3 = ~(c1 | c2)
    out[c1] = np.sqrt(x2[c1] + z2[c1]) * il2 - rb
    out[c2] = np.sqrt(x2[c2] + y2[c2]) * il2 - ra
    out[c3] = (np.sqrt(x2[c3] * a2 * il2) + y[c3] * rr) * il2 - ra
    return out


def round_box(p, c, half, r):
    q = np.abs(p - _v(c)) - (_v(half) - r)
    return length(np.maximum(q, 0.0)) + np.minimum(q.max(-1), 0.0) - r


def plane(p, n, d):
    """Half-space n.p + d <= 0 is inside (n normalised)."""
    return p @ _v(n) + d


# ------------------------------------------------------------------ operators
def smin(a, b, k):
    """Polynomial smooth min (union). k = blend radius."""
    if k <= 0:
        return np.minimum(a, b)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def smax(a, b, k):
    return -smin(-a, -b, k)


def ssub(a, b, k):
    """Smoothly subtract b from a."""
    return smax(a, -b, k)


def union(*ds, k=0.0):
    out = ds[0]
    for d in ds[1:]:
        out = smin(out, d, k)
    return out


# ------------------------------------------------------------------ transforms
def rot_to(z_from, z_to):
    """Rotation matrix mapping unit vector z_from onto z_to."""
    a = _v(z_from) / np.linalg.norm(z_from)
    b = _v(z_to) / np.linalg.norm(z_to)
    v = np.cross(a, b); s = np.linalg.norm(v); c = a @ b
    if s < 1e-10:
        return np.eye(3) if c > 0 else -np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / s ** 2)


def frame(origin, x_axis, y_axis):
    """Orthonormal frame (3x3 columns = local x,y,z in world) from two approximate axes."""
    x = _v(x_axis); x = x / np.linalg.norm(x)
    y = _v(y_axis); y = y - (y @ x) * x; y = y / np.linalg.norm(y)
    z = np.cross(x, y)
    return _v(origin), np.stack([x, y, z], 1)


def to_local(p, origin, R):
    """World points -> local coords of frame (origin, R with local axes as columns)."""
    return (p - origin) @ R


def mirror_x(p):
    """Evaluate bilateral parts with |x| so both sides are exactly symmetric."""
    q = p.copy()
    q[:, 0] = np.abs(q[:, 0])
    return q


# ------------------------------------------------------------------ utilities
def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def gradient(fn, p, h=5e-4):
    g = np.empty_like(p)
    for i in range(3):
        d = np.zeros(3); d[i] = h
        g[:, i] = (fn(p + d) - fn(p - d)) / (2 * h)
    return g


def normals(fn, p, h=5e-4):
    g = gradient(fn, p, h)
    return g / np.maximum(length(g)[:, None], 1e-12)


def project(fn, p, iters=4, h=5e-4):
    """Newton-project points onto the zero set of fn."""
    p = p.copy()
    for _ in range(iters):
        d = fn(p)
        g = gradient(fn, p, h)
        g2 = np.maximum((g * g).sum(-1), 1e-12)
        p -= (d / g2)[:, None] * g
    return p


def raycast(fn, origins, dirs, t_max=2.0, eps=1e-6, max_steps=256):
    """Sphere-trace fn along rays; returns hit points (N,3) and mask."""
    o = _v(origins); d = _v(dirs)
    d = d / length(d)[:, None]
    t = np.zeros(len(o))
    alive = np.ones(len(o), bool)
    for _ in range(max_steps):
        if not alive.any():
            break
        dist = fn(o[alive] + t[alive, None] * d[alive])
        t[alive] += np.maximum(dist, eps) * 0.9
        done = np.abs(dist) < 1e-5
        idx = np.nonzero(alive)[0]
        alive[idx[done]] = False
        alive &= t < t_max
    hit = t < t_max
    pts = o + t[:, None] * d
    return project(fn, pts, iters=2), hit
