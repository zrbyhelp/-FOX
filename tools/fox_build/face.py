"""Face features conformed to the head surface: eyes (+highlights), closed-eye arcs, brows,
nose, smile line, open mouth + tongue. Each feature is skinned 100% to its control bone,
whose pivot sits a few mm INSIDE the head surface at the feature centre (see spec.json)."""
from __future__ import annotations

import numpy as np

from . import config as C
from . import sdf as S
from . import shapes as SH
from .parametric import ellipsoid_mesh, transport_frames, vertex_normals

P = C.P
PIVOT_DEPTH = 0.004


def surface(x, z):
    """Front head-surface point + normal at (x, z)."""
    x = np.atleast_1d(np.asarray(x, float)); z = np.atleast_1d(np.asarray(z, float))
    o = np.stack([x, np.full_like(x, -0.6), z], 1)
    d = np.tile([0.0, 1.0, 0.0], (len(x), 1))
    pts, hit = S.raycast(SH.head_sdf, o, d, t_max=1.0)
    assert hit.all(), "face ray missed the head"
    return pts, S.normals(SH.head_sdf, pts)


def local_frame(p, n):
    """right (~ +X), up (~ +Z), normal (outward)."""
    up = np.array([0, 0, 1.0]) - n * n[2]
    up /= np.linalg.norm(up)
    right = np.cross(up, n)
    if right[0] < 0:
        right = -right
    return np.stack([right, up, n], 1)


def pivot(x, z):
    p, n = surface(x, z)
    return p[0] - n[0] * PIVOT_DEPTH


def tube_on_face(xz, radius, n_seg=8, embed=0.40):
    """Tube following a 2D (x,z) polyline projected onto the face."""
    xz = np.asarray(xz, float)
    # resample densely by arc length
    seg = np.linalg.norm(np.diff(xz, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(8, int(s[-1] / 0.002))
    ss = np.linspace(0, s[-1], n)
    xz = np.stack([np.interp(ss, s, xz[:, 0]), np.interp(ss, s, xz[:, 1])], 1)
    pts, nrm = surface(xz[:, 0], xz[:, 1])
    ctr = pts + nrm * radius * (1 - embed)
    T = np.gradient(ctr, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    N, B = transport_frames(T, nrm[0])
    th = np.linspace(0, 2 * np.pi, n_seg, endpoint=False)
    rings = [ctr[i] + radius * (np.cos(th)[:, None] * N[i] + np.sin(th)[:, None] * B[i]) for i in range(n)]
    V = np.vstack(rings)
    F = []
    for i in range(n - 1):
        for j in range(n_seg):
            a = i * n_seg + j; b = i * n_seg + (j + 1) % n_seg
            F += [[a, b, b + n_seg], [a, b + n_seg, a + n_seg]]
    F = np.array(F, dtype=np.int64)
    # hemispherical caps
    caps_V = [V]; caps_F = [F]; base = len(V)
    for end, sign in ((0, -1), (n - 1, 1)):
        k = 4
        prev = end * n_seg
        for m in range(1, k + 1):
            a = m / k * np.pi / 2
            ring = ctr[end] + sign * T[end] * radius * np.sin(a) + radius * np.cos(a) * (
                np.cos(th)[:, None] * N[end] + np.sin(th)[:, None] * B[end])
            if m == k:
                ring = ctr[end][None] + sign * T[end][None] * radius
                caps_V.append(ring); pole = base; base += 1
                ff = [[prev + j, prev + (j + 1) % n_seg, pole] for j in range(n_seg)]
                caps_F.append(np.array(ff))
            else:
                caps_V.append(ring); cur = base; base += n_seg
                ff = []
                for j in range(n_seg):
                    a0 = prev + j; b0 = prev + (j + 1) % n_seg
                    ff += [[a0, b0, cur + (j + 1) % n_seg], [a0, cur + (j + 1) % n_seg, cur + j]]
                caps_F.append(np.array(ff)); prev = cur
    V = np.vstack(caps_V); F = np.vstack(caps_F)
    Nn = vertex_normals(V, F)
    c = V.mean(0)
    # orient outward per-vertex relative to the local tube centre line
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    fc = V[F].mean(1)
    idx = np.argmin(((fc[:, None, :] - ctr[None, ::max(1, n // 40), :]) ** 2).sum(-1), axis=1)
    out = fc - ctr[::max(1, n // 40)][idx]
    if (fn * out).sum() < 0:
        F = F[:, ::-1].copy(); Nn = -Nn
    return V, F, vertex_normals(V, F)


def flat_patch(outline_xz, lift, n_ring=6):
    """Filled 2D polygon (x,z) conformed to the face, lifted along the normal."""
    o = np.asarray(outline_xz, float)
    c = o.mean(0)
    rings = [c + (o - c) * (k / n_ring) for k in range(1, n_ring + 1)]
    pts2 = np.vstack([c[None]] + rings)
    p, n = surface(pts2[:, 0], pts2[:, 1])
    V = p + n * lift
    m = len(o)
    F = [[0, 1 + (j + 1) % m, 1 + j] for j in range(m)]
    for k in range(n_ring - 1):
        a0 = 1 + k * m; b0 = 1 + (k + 1) * m
        for j in range(m):
            a = a0 + j; b = a0 + (j + 1) % m; cc = b0 + j; d = b0 + (j + 1) % m
            F += [[a, b, d], [a, d, cc]]
    F = np.array(F, dtype=np.int64)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    if (fn[:, 1]).sum() > 0:   # should face -Y (front)
        F = F[:, ::-1].copy()
    return V, F, n


def _merge(meshes):
    V = []; F = []; N = []; ids = []; off = 0
    for i, (v, f, n) in enumerate(meshes):
        V.append(v); F.append(f + off); N.append(n); ids.append(np.full(len(f), i)); off += len(v)
    return np.vstack(V), np.vstack(F), np.vstack(N), np.concatenate(ids)


# ------------------------------------------------------------------ features
def eye(side):
    sx = 1 if side == "L" else -1
    ex, ez = P["eye_xz"]; w, h = P["eye_size"]
    p, n = surface(sx * ex, ez)
    R = local_frame(p[0], n[0])
    ctr = p[0] - n[0] * 0.0045
    dome = ellipsoid_mesh(ctr, R, (w / 2, h / 2, 0.0145), nu=28, nv=18)
    # highlight: upper-left as seen by the viewer (viewer's left = fox's -X)
    hl_local = np.array([-0.0085 * 1, 0.0115, 0.0])
    loc = hl_local.copy()
    zdome = 0.0145 * np.sqrt(max(1 - (loc[0] / (w / 2)) ** 2 - (loc[1] / (h / 2)) ** 2, 0.05))
    hc = ctr + R @ np.array([loc[0], loc[1], zdome - 0.0005])
    hl = ellipsoid_mesh(hc, R, (0.0068, 0.0068, 0.0022), nu=16, nv=10)
    hl2c = ctr + R @ np.array([0.009, -0.012, 0.0145 * 0.62])
    hl2 = ellipsoid_mesh(hl2c, R, (0.0028, 0.0028, 0.0012), nu=10, nv=6)
    V, F, N, ids = _merge([dome, hl, hl2])
    ids = np.where(ids == 0, 0, 1)
    return V, F, N, ids


def eye_arc(side, kind):
    sx = 1 if side == "L" else -1
    ex, ez = P["eye_xz"]
    if kind == "happy":   # ^ ^ (arch)
        ph = np.radians(np.linspace(20, 160, 24))
        xz = np.stack([sx * (ex + 0.026 * np.cos(ph)), ez - 0.010 + 0.019 * np.sin(ph)], 1)
    else:                 # sleep: gentle downward curve ending in a small outer flick
        ph = np.radians(np.linspace(200, 340, 24))
        xz = np.stack([sx * (ex + 0.026 * np.cos(ph)), ez + 0.004 + 0.012 * np.sin(ph)], 1)
        end = xz[-1]
        xz = np.vstack([xz, [end[0] + sx * 0.006, end[1] + 0.005]])
    return tube_on_face(xz, 0.0052)


def brow(side):
    sx = 1 if side == "L" else -1
    bx, bz = P["brow_xz"]
    u = np.linspace(-1, 1, 20)
    # inner end (toward centre) raised = worried
    x = sx * (bx + 0.020 * u)
    z = bz - 0.008 * u + 0.004 * (1 - u ** 2)
    return tube_on_face(np.stack([x, z], 1), 0.0042)


def nose():
    nx, nz = P["nose_xz"]
    p, n = surface(nx, nz)
    R = local_frame(p[0], n[0])
    V, F, N = ellipsoid_mesh(p[0] - n[0] * 0.004, R, (0.0215, 0.0155, 0.0145), nu=28, nv=18)
    loc = (V - (p[0] - n[0] * 0.004)) @ R
    v = loc[:, 1] / 0.0155
    pinch = np.where(v < 0, 1 + 0.62 * v, 1 + 0.08 * v)
    loc[:, 0] *= pinch
    loc[:, 1] *= np.where(v > 0, 0.9, 1.0)
    V = loc @ R.T + (p[0] - n[0] * 0.004)
    return V, F, vertex_normals(V, F)


def mouth_smile():
    mx, mz = P["mouth_xz"]
    nx, nz = P["nose_xz"]
    r = 0.0038
    philtrum = tube_on_face([(0, nz - 0.014), (0, mz + 0.001)], r)
    parts = [philtrum]
    ph = np.radians(np.linspace(180, 345, 22))   # "ω": a U on each side of the philtrum
    for sx in (1, -1):
        xz = np.stack([sx * (0.0125 + 0.0125 * np.cos(ph)), mz + 0.001 + 0.0105 * np.sin(ph)], 1)
        parts.append(tube_on_face(xz, r))
    V, F, N, _ = _merge(parts)
    return V, F, N


def mouth_open():
    mx, mz = P["mouth_xz"]
    top = mz + 0.006
    w = 0.025; h = 0.030
    ph = np.radians(np.linspace(0, 180, 25))
    bottom = np.stack([w * np.cos(ph), top - h * np.sin(ph)], 1)[::-1]  # left->right along bottom
    edge_top = np.stack([np.linspace(w, -w, 12)[1:-1], np.full(10, top) + 0.002 * np.sin(np.linspace(0, np.pi, 10))], 1)
    outline = np.vstack([bottom, edge_top])
    inside = flat_patch(outline, 0.0010)
    tongue_ol = np.stack([0.0145 * np.cos(np.linspace(0, 2 * np.pi, 24, endpoint=False)),
                          top - h * 0.70 + 0.0085 * np.sin(np.linspace(0, 2 * np.pi, 24, endpoint=False))], 1)
    tongue = flat_patch(tongue_ol, 0.0018)
    rim = tube_on_face(np.vstack([outline, outline[:1]]), 0.0026, embed=0.6)
    V, F, N, ids = _merge([inside, tongue, rim])
    return V, F, N, ids   # ids: 0 MouthInside, 1 Tongue, 2 Line


def expression_pivots():
    ex, ez = P["eye_xz"]; bx, bz = P["brow_xz"]; mx, mz = P["mouth_xz"]
    out = {}
    for s, sx in (("L", 1), ("R", -1)):
        for kind in ("eyeOpen", "eyeHappy", "eyeSleep"):
            out[f"{kind}_{s}"] = pivot(sx * ex, ez)
        out[f"brow_{s}"] = pivot(sx * bx, bz)
    out["mouthSmile"] = pivot(mx, mz)
    out["mouthOpen"] = pivot(mx, mz - 0.006)
    return out
