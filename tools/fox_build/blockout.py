"""Blockout v0: capsule/ellipsoid stand-ins built on the real skeleton (for pipeline and
web integration tests before the SDF model exists). Rigid weights per part."""
from __future__ import annotations

import numpy as np

from . import config as C
from .assemble import Part


def _uv_sphere(center, radii, nu=24, nv=16):
    u = np.linspace(0, 2 * np.pi, nu, endpoint=False)
    v = np.linspace(0, np.pi, nv + 1)[1:-1]
    uu, vv = np.meshgrid(u, v)
    x = np.sin(vv) * np.cos(uu); y = np.sin(vv) * np.sin(uu); z = np.cos(vv)
    pts = np.stack([x.ravel(), y.ravel(), z.ravel()], 1)
    pts = np.vstack([pts, [[0, 0, 1]], [[0, 0, -1]]])
    top = len(pts) - 2; bot = len(pts) - 1
    F = []
    for i in range(len(v) - 1):
        for j in range(nu):
            a = i * nu + j; b = i * nu + (j + 1) % nu
            c = (i + 1) * nu + j; d = (i + 1) * nu + (j + 1) % nu
            F += [[a, c, b], [b, c, d]]
    for j in range(nu):
        F.append([top, j, (j + 1) % nu])
        a = (len(v) - 1) * nu
        F.append([bot, a + (j + 1) % nu, a + j])
    n = pts / np.asarray(radii)  # ellipsoid normal ~ p / r^2
    n = n / np.linalg.norm(n, axis=1, keepdims=True)
    return pts * np.asarray(radii) + np.asarray(center), np.array(F), n


def _capsule(a, b, r, nu=16, nv=12):
    a = np.asarray(a, float); b = np.asarray(b, float)
    L = np.linalg.norm(b - a)
    V, F, N = _uv_sphere((0, 0, 0), (r, r, r), nu, nv)
    V[:, 2] += np.where(V[:, 2] > 0, L, 0)
    # rotate +Z to (b-a)
    d = (b - a) / L
    z = np.array([0, 0, 1.0])
    v = np.cross(z, d); s = np.linalg.norm(v); c = z @ d
    if s < 1e-8:
        R = np.eye(3) if c > 0 else np.diag([1, -1, -1])
    else:
        vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
        R = np.eye(3) + vx + vx @ vx * ((1 - c) / s ** 2)
    return V @ R.T + a, F, N @ R.T


def _merge(parts):
    V = []; F = []; N = []; off = 0
    for v, f, n in parts:
        V.append(v); F.append(f + off); N.append(n); off += len(v)
    return np.vstack(V), np.vstack(F), np.vstack(N)


def _col(n, key):
    return np.tile(C.linear(key), (n, 1))


def build_parts():
    bt = C.bone_table()
    P = C.P
    parts = []

    def rigid(name, geo, bone, mat="Fur", color="fur"):
        V, F, N = geo
        parts.append(Part(name, V, F, material=mat, normals=N, colors=_col(len(V), color),
                          weights={bone: np.ones(len(V))}))

    # head + ears
    hv, hf, hn = _uv_sphere(P["head_center"], P["head_radii"], 32, 20)
    ears = []
    for s in ("L", "R"):
        _, b0, _ = bt[f"ear_{s}"]; _, _, t1 = bt[f"earTip_{s}"]
        ears.append(_capsule(b0, t1, 0.06))
    V, F, N = _merge([(hv, hf, hn)] + ears)
    w_head = np.ones(len(V)); nh = len(hv)
    ne = len(ears[0][0])
    wL = np.zeros(len(V)); wR = np.zeros(len(V))
    wL[nh:nh + ne] = 1; wR[nh + ne:] = 1; w_head[nh:] = 0
    parts.append(Part("Head", V, F, normals=N, colors=_col(len(V), "fur"),
                      weights={"head": w_head, "ear_L": wL, "ear_R": wR}))
    # body
    rigid("Body", _uv_sphere((0, 0, 0.25), (0.18, 0.16, 0.2), 28, 18), "spine")
    for s in ("L", "R"):
        _, a, _ = bt[f"upperArm_{s}"]; _, _, b = bt[f"paw_{s}"]
        rigid(f"Arm_{s}", _capsule(a, b, P["arm_radius"]), f"upperArm_{s}", color="orange_light")
        _, a, _ = bt[f"thigh_{s}"]; _, _, b = bt[f"shin_{s}"]
        rigid(f"Leg_{s}", _capsule(a, b, P["leg_radius"]), f"shin_{s}", color="orange")
    # tail: one capsule per bone, weighted per bone
    segs = []
    for i in range(6):
        _, a, b = bt[f"tail_{i + 1}"]
        r = 0.05 + 0.07 * np.sin(np.pi * (i + 0.5) / 6)
        segs.append(_capsule(a, b, r))
    V, F, N = _merge(segs)
    W = {}
    off = 0
    for i, (v, _, _) in enumerate(segs):
        w = np.zeros(len(V)); w[off:off + len(v)] = 1; W[f"tail_{i + 1}"] = w; off += len(v)
    parts.append(Part("Tail", V, F, normals=N, colors=_col(len(V), "fur"), weights=W))
    # scarf ring (as a squashed sphere) + face features
    rigid("Scarf", _uv_sphere((0, 0, P["scarf_z"]), (0.15, 0.14, 0.04)), "scarf", mat="Scarf",
          color="scarf")
    for s in ("L", "R"):
        _, h, _ = bt[f"eyeOpen_{s}"]
        rigid(f"Eye_{s}", _uv_sphere(h, (0.025, 0.012, 0.031), 12, 8), f"eyeOpen_{s}", mat="Eye")
        rigid(f"EyeHappy_{s}", _uv_sphere(h, (0.028, 0.01, 0.008), 12, 8), f"eyeHappy_{s}", mat="Line")
    _, h, _ = bt["mouthOpen"]
    rigid("MouthOpen", _uv_sphere(h, (0.03, 0.01, 0.02), 12, 8), "mouthOpen", mat="MouthInside")
    return parts
