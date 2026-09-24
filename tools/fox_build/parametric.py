"""Parametric meshes: swept tubes (tail, scarf ring, scarf flap), ellipsoids, flat patches."""
from __future__ import annotations

import functools

import numpy as np

from . import config as C
from . import sdf as S
from . import shapes as SH
from .spline import Spline

P = C.P


# ------------------------------------------------------------------ generic helpers
def vertex_normals(V, F):
    n = np.zeros_like(V)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    for i in range(3):
        np.add.at(n, F[:, i], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def transport_frames(T, n0):
    """Parallel-transport frames along unit tangents T (K,3) starting with normal n0."""
    N = np.zeros_like(T); B = np.zeros_like(T)
    n = n0 - (n0 @ T[0]) * T[0]; n /= np.linalg.norm(n)
    for i in range(len(T)):
        if i:
            v = np.cross(T[i - 1], T[i]); s = np.linalg.norm(v)
            if s > 1e-9:
                R = S.rot_to(T[i - 1], T[i])
                n = R @ n
            n = n - (n @ T[i]) * T[i]; n /= np.linalg.norm(n)
        N[i] = n; B[i] = np.cross(T[i], n)
    return N, B


def grid_faces(n_rings, n_seg, closed=True):
    F = []
    for i in range(n_rings - 1):
        for j in range(n_seg if closed else n_seg - 1):
            a = i * n_seg + j; b = i * n_seg + (j + 1) % n_seg
            c = a + n_seg; d = b + n_seg
            F += [[a, b, d], [a, d, c]]
    return np.array(F, dtype=np.int64)


def cap(V, F, ring_start, n_seg, pole, flip=False):
    """Close a ring with a pole vertex."""
    V = np.vstack([V, pole])
    p = len(V) - 1
    extra = []
    for j in range(n_seg):
        a = ring_start + j; b = ring_start + (j + 1) % n_seg
        extra.append([a, p, b] if not flip else [b, p, a])
    return V, np.vstack([F, np.array(extra)])


def ellipsoid_mesh(center, R, radii, nu=24, nv=16):
    """UV ellipsoid in frame R (columns = local axes). Returns V, F, N."""
    u = np.linspace(0, 2 * np.pi, nu, endpoint=False)
    v = np.linspace(0, np.pi, nv + 1)[1:-1]
    uu, vv = np.meshgrid(u, v)
    loc = np.stack([np.sin(vv) * np.cos(uu), np.sin(vv) * np.sin(uu), np.cos(vv)], -1).reshape(-1, 3)
    loc = np.vstack([loc, [0, 0, 1], [0, 0, -1]])
    top, bot = len(loc) - 2, len(loc) - 1
    F = []
    for i in range(len(v) - 1):
        for j in range(nu):
            a = i * nu + j; b = i * nu + (j + 1) % nu
            F += [[a, b + nu, b], [a, a + nu, b + nu]]
    last = (len(v) - 1) * nu
    for j in range(nu):
        F.append([top, j, (j + 1) % nu])
        F.append([bot, last + (j + 1) % nu, last + j])
    F = np.array(F, dtype=np.int64)
    r = np.asarray(radii, float)
    Vl = loc * r
    Nl = loc / r
    V = Vl @ R.T + np.asarray(center)
    N = Nl @ R.T
    N /= np.linalg.norm(N, axis=1, keepdims=True)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    if (fn * (V[F[:, 0]] - np.asarray(center))).sum() < 0:
        F = F[:, ::-1].copy()
    return V, F, N


# ------------------------------------------------------------------ tail
def _profile(t):
    pts = np.array(P["tail_radius_profile"])
    r = np.interp(t, pts[:, 0], pts[:, 1])
    # soften the polyline profile with a short moving average
    k = 5
    rp = np.pad(r, (k, k), mode="edge")
    r = np.convolve(rp, np.ones(2 * k + 1) / (2 * k + 1), mode="same")[k:-k]
    # pointed (not blunt) tip: only the last ~2% is rounded off
    tip = t > 0.975
    r[tip] = np.minimum(r[tip], 0.13 * np.sqrt(np.clip(1 - t[tip], 0, 1)))
    return r


def tail_mesh(n_rings=72, n_seg=32, r_end=0.013, cap_rings=5):
    """Tail tube along the spline; the pointed tip ends in a small hemispherical cap (a bare
    pole vertex gave a degenerate normal that rendered as a white dot)."""
    sp = Spline(C.TAIL_SPLINE)
    s = np.linspace(0, 1, 4000)
    r_all = _profile(s)
    t_end = s[np.nonzero((r_all < r_end) & (s > 0.8))[0][0]]
    u = np.linspace(0, 1, n_rings)
    t = (1 - (1 - u) ** 1.25) * t_end            # denser toward the tip
    C_ = sp.point_at_arclength(t)
    T = sp.tangent_at_arclength(t)
    N, B = transport_frames(T, np.array([1.0, 0, 0]))
    r = _profile(t)
    th = np.linspace(0, 2 * np.pi, n_seg, endpoint=False)
    flat = P["tail_flatten"]
    rings = [C_[i] + r[i] * (np.cos(th)[:, None] * N[i] * flat + np.sin(th)[:, None] * B[i]) for i in range(n_rings)]
    tv = [np.full(n_seg, t[i]) for i in range(n_rings)]
    re = r[-1]
    for k in range(1, cap_rings):
        a = k / cap_rings * np.pi / 2
        c = C_[-1] + T[-1] * re * np.sin(a)
        rings.append(c + re * np.cos(a) * (np.cos(th)[:, None] * N[-1] * flat + np.sin(th)[:, None] * B[-1]))
        tv.append(np.full(n_seg, 1.0))
    V = np.vstack(rings)
    nr = len(rings)
    F = grid_faces(nr, n_seg)
    V, F = cap(V, F, (nr - 1) * n_seg, n_seg, (C_[-1] + T[-1] * re)[None], flip=False)
    V, F = cap(V, F, 0, n_seg, (C_[0] - T[0] * 0.03)[None], flip=True)
    tv = np.concatenate(tv + [np.array([1.0, 0.0])])
    if np.einsum("ij,ij->i", V[F[:, 0]] - V.mean(0), np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])).sum() < 0:
        F = F[:, ::-1].copy()
    Nn = vertex_normals(V, F)
    return V, F, Nn, tv


def tail_colors(V, Nn, tv):
    cream = C.linear("fur")
    side = Nn @ (np.array([0.55, 0.15, 0.82]) / np.linalg.norm([0.55, 0.15, 0.82]))
    o0 = P["tail_orange_from"]
    w = S.smoothstep(o0, o0 + 0.20, tv + 0.06 * side)
    col = cream * (1 - w[:, None]) + C.linear("orange_light") * w[:, None]
    w2 = S.smoothstep(o0 + 0.10, 1.0, tv + 0.04 * side)
    return col * (1 - w2[:, None]) + C.linear("tail_tip") * w2[:, None]


def tail_weights(tv, n_bones=6):
    c = (np.arange(n_bones) + 0.5) / n_bones
    W = {}
    for i in range(n_bones):
        w = np.clip(1 - np.abs(tv - c[i]) * n_bones, 0, 1)
        if i == 0:
            w = np.where(tv < c[0], 1.0, w)
        if i == n_bones - 1:
            w = np.where(tv > c[-1], 1.0, w)
        W[f"tail_{i + 1}"] = w
    return W


# ------------------------------------------------------------------ scarf
def _body_radius(theta, z):
    """Distance from the body axis to the body surface at angle theta, height z."""
    o = np.stack([np.zeros_like(theta), np.zeros_like(theta), np.full_like(theta, z)], 1)
    d = np.stack([np.cos(theta), np.sin(theta), np.zeros_like(theta)], 1)
    far = o + d * 0.5
    pts, hit = S.raycast(SH.body_sdf, far, -d, t_max=0.6)
    return np.linalg.norm(pts[:, :2], axis=1)


SCARF_FLAP_THETA = -np.pi / 2 + 0.78    # toward the fox's left side, beside the arm (ref 1)
FLAP_HW, FLAP_HT = 0.050, 0.0125          # flap half width / half thickness


def scarf_ring_mesh(n_u=96, n_v=20, u_repeat=14):
    z0 = P["scarf_z"]
    a_rad, b_vert = P["scarf_tube_radius"][1], P["scarf_tube_radius"][0]
    th = np.linspace(0, 2 * np.pi, n_u, endpoint=False)
    rb = _body_radius(th, z0)
    R_c = rb + a_rad * 0.55
    # slight droop at the front
    zc = z0 - 0.010 * np.clip(-np.sin(th), 0, 1) ** 2
    phi = np.linspace(0, 2 * np.pi, n_v, endpoint=False)
    e = 2.6
    cr = np.sign(np.cos(phi)) * np.abs(np.cos(phi)) ** (2 / e)
    cz = np.sign(np.sin(phi)) * np.abs(np.sin(phi)) ** (2 / e)
    V = []; UV = []
    for i in range(n_u):
        rad = np.array([np.cos(th[i]), np.sin(th[i]), 0.0])
        c = rad * R_c[i] + np.array([0, 0, zc[i]])
        for j in range(n_v):
            V.append(c + rad * a_rad * cr[j] + np.array([0, 0, b_vert * cz[j]]))
            UV.append([th[i] / (2 * np.pi) * u_repeat, phi[j] / (2 * np.pi) * 2.0])
    V = np.array(V); UV = np.array(UV)
    F = []
    for i in range(n_u):
        for j in range(n_v):
            a = i * n_v + j; b = i * n_v + (j + 1) % n_v
            c = ((i + 1) % n_u) * n_v + j; d = ((i + 1) % n_u) * n_v + (j + 1) % n_v
            F += [[a, c, d], [a, d, b]]
    F = np.array(F, dtype=np.int64)
    Nn = vertex_normals(V, F)
    if (Nn * (V - np.array([0, 0, z0]))).sum() < 0:
        F = F[:, ::-1].copy(); Nn = -Nn
    return V, F, Nn, UV, th.repeat(n_v)


def scarf_ring_weights(V, theta):
    x = V[:, 0]
    over_sh = S.smoothstep(0.06, 0.11, np.abs(x)) * S.smoothstep(0.08, 0.0, np.abs(V[:, 1]))
    W = {"scarf": 0.72 * (1 - over_sh * 0.3), "neck": 0.28 * (1 - over_sh * 0.3)}
    W["shoulder_L"] = np.where(x > 0, 0.3 * over_sh, 0.0)
    W["shoulder_R"] = np.where(x < 0, 0.3 * over_sh, 0.0)
    return W


def scarf_flap_mesh(n_len=44, n_seg=40, u_repeat=3.0):
    th = SCARF_FLAP_THETA
    rad = np.array([np.cos(th), np.sin(th), 0.0])
    tang = np.array([-np.sin(th), np.cos(th), 0.0])   # across the flap width
    z_top, z_bot = P["scarf_z"] - 0.005, 0.235
    hw, ht = FLAP_HW, FLAP_HT
    zs = np.linspace(z_top, z_bot, n_len)
    rb = np.array([_body_radius(np.array([th]), z)[0] for z in zs])
    # keep the flap hanging (not glued into concavities): monotone outward offset
    off = np.maximum.accumulate(rb)  # follow the chest outward, then hang straight
    centers = np.stack([rad * (o + ht + 0.004) for o in off]) + zs[:, None] * np.array([0, 0, 1.0])
    centers[:, 0] += np.linspace(0, 0.012, n_len)  # slight swing outward toward the side
    phi = np.linspace(0, 2 * np.pi, n_seg, endpoint=False)
    e = 6.0
    cw = np.sign(np.cos(phi)) * np.abs(np.cos(phi)) ** (2 / e)
    ct = np.sign(np.sin(phi)) * np.abs(np.sin(phi)) ** (2 / e)
    # rounded bottom end: shrink the last rings
    k_end = 8
    re = ht * 0.95
    rings = []; UV = []; vparam = []; wparam = []
    for i in range(n_len + k_end):
        if i < n_len:
            c = centers[i]; inset = 0.0
        else:
            a = (i - n_len + 1) / k_end * np.pi / 2
            c = centers[-1] - np.array([0, 0, re * np.sin(a)]); inset = re * (1 - np.cos(a))
        w_half = max(hw - inset, 0.002); t_half = max(ht - inset, 0.001)
        ring = c + np.outer(cw * w_half, tang) + np.outer(ct * t_half, rad)
        rings.append(ring)
        v = min(i, n_len - 1) / (n_len - 1)
        vparam.append(np.full(n_seg, v)); wparam.append(cw)
        UV.append(np.stack([phi / (2 * np.pi) * u_repeat * 2, np.full(n_seg, (z_top - c[2]) * 12)], 1))
    V = np.vstack(rings); UV = np.vstack(UV)
    vp = np.concatenate(vparam); wp = np.concatenate(wparam)
    F = grid_faces(n_len + k_end, n_seg)
    V, F = cap(V, F, (n_len + k_end - 1) * n_seg, n_seg, (centers[-1] - np.array([0, 0, re]))[None])
    V, F = cap(V, F, 0, n_seg, (centers[0] + np.array([0, 0, 0.004]))[None], flip=True)
    UV = np.vstack([UV, [[0, 0], [0, 0]]]); vp = np.concatenate([vp, [1.0, 0.0]]); wp = np.concatenate([wp, [0, 0]])
    Nn = vertex_normals(V, F)
    if (Nn * (V - V.mean(0))).sum() < 0:
        F = F[:, ::-1].copy(); Nn = -Nn
    front = np.concatenate([np.tile(ct, n_len + k_end), [0, 0]])
    return V, F, Nn, UV, vp, wp, front, (rad, tang, centers)


@functools.lru_cache(maxsize=None)
def flap_bone_points():
    """Flap centre-line where the two flap bones start / meet / end (config.bone_table), so the
    bones always sit inside the flap mesh whatever the body and scarf proportions."""
    centers = scarf_flap_mesh()[-1][2]
    return tuple(tuple(float(v) for v in centers[np.argmin(np.abs(centers[:, 2] - z))]) for z in (0.385, 0.31, 0.235))


def scarf_flap_spheres(n_across=9):
    """Mid-surface sample points of the hanging flap (rest pose) and their length parameter;
    a union of spheres of radius FLAP_HT around them approximates the flap's volume
    (clips.FlapGuard, clip_qa)."""
    rad, tang, centers = scarf_flap_mesh()[-1]
    w = np.linspace(-(FLAP_HW - FLAP_HT), FLAP_HW - FLAP_HT, n_across)
    pts = (centers[:, None, :] + w[None, :, None] * tang).reshape(-1, 3)
    vp = np.repeat(np.linspace(0.0, 1.0, len(centers)), n_across)
    return pts, vp


def scarf_flap_weights(vp):
    w2 = S.smoothstep(0.35, 0.75, vp)
    top = S.smoothstep(0.12, 0.0, vp)
    return {"scarf": top, "scarfFlap_1": (1 - w2) * (1 - top), "scarfFlap_2": w2 * (1 - top)}


def scarf_squares(frame):
    """Two slightly raised white knit squares on the flap front (diagonal)."""
    rad, tang, centers = frame
    n_len = len(centers)
    out = []
    for (wc, vc) in ((-0.34, 0.66), (0.34, 0.84)):
        i = int(round(vc * (n_len - 1)))
        c = centers[i] + tang * (wc * FLAP_HW) + rad * (FLAP_HT + 0.0006)
        R = np.stack([tang, np.array([0, 0, 1.0]), rad], 1)
        V, F, N = rounded_slab(c, R, (0.0115, 0.0105, 0.0016), 0.0012)
        out.append((V, F, N, vc))
    return out


def rounded_slab(center, R, half, r, n=6):
    """Small rounded box as the SDF-free union of a superellipsoid (cheap, smooth)."""
    u = np.linspace(-np.pi, np.pi, 4 * n, endpoint=False)
    v = np.linspace(-np.pi / 2, np.pi / 2, 2 * n + 1)[1:-1]
    e1, e2 = 0.25, 0.3
    def f(w, m):
        return np.sign(w) * np.abs(w) ** m
    uu, vv = np.meshgrid(u, v)
    x = f(np.cos(vv), e1) * f(np.cos(uu), e2)
    y = f(np.cos(vv), e1) * f(np.sin(uu), e2)
    z = f(np.sin(vv), e1)
    loc = np.stack([x, y, z], -1).reshape(-1, 3) * np.asarray(half)
    loc = np.vstack([loc, [0, 0, half[2]], [0, 0, -half[2]]])
    nu = len(u); nvv = len(v)
    F = []
    for i in range(nvv - 1):
        for j in range(nu):
            a = i * nu + j; b = i * nu + (j + 1) % nu
            F += [[a, b, b + nu], [a, b + nu, a + nu]]
    top, bot = len(loc) - 2, len(loc) - 1
    last = (nvv - 1) * nu
    for j in range(nu):
        F.append([top, last + j, last + (j + 1) % nu])
        F.append([bot, (j + 1) % nu, j])
    F = np.array(F, dtype=np.int64)
    V = loc @ R.T + center
    N = vertex_normals(V, F)
    if (N * (V - center)).sum() < 0:
        F = F[:, ::-1].copy(); N = -N
    return V, F, N
