"""Colour and skin-weight fields for the SDF body parts (shapes live in shapes.py).

Everything in Blender space (Z up, fox faces -Y, fox's left = +X).
"""
from __future__ import annotations

import numpy as np

from . import config as C
from . import sdf as S
from .shapes import (EAR_LEN, _arm_pts, ear_inner, ear_local, ear_nub, ear_outer, head_core)

P = C.P


def _mix(a, b, t):
    t = np.asarray(t)[:, None]
    return a * (1 - t) + b * t


def head_colors(V, N):
    cream = C.linear("fur"); white = C.linear("fur_white")
    x, y, z = V[:, 0], V[:, 1], V[:, 2]
    ax = np.abs(x)
    front = S.smoothstep(0.02, -0.06, y)
    # white face mask: eye patches + muzzle + lower face
    e_eye = ((ax - 0.136) / 0.114) ** 2 + ((z - 0.600) / 0.090) ** 2
    m_eye = S.smoothstep(1.25, 0.85, e_eye)
    e_muz = (x / 0.115) ** 2 + ((z - 0.532) / 0.062) ** 2
    m_muz = S.smoothstep(1.3, 0.8, e_muz)
    m_low = S.smoothstep(0.55, 0.515, z) * S.smoothstep(0.08, -0.02, y)
    mask = np.maximum(np.maximum(m_eye, m_muz), m_low) * front
    col = _mix(cream, white, mask)
    # blush
    bx, bz = P["blush_xz"]
    e_bl = ((ax - bx) / 0.046) ** 2 + ((z - bz) / 0.032) ** 2
    blush = np.exp(-1.6 * e_bl) * S.smoothstep(0.0, -0.08, y)
    col = _mix(col, C.linear("blush"), np.clip(blush * 1.05, 0, 0.92))
    # inner ear orange (recessed area) with a lighter base
    d_in = ear_inner(V)
    ql = ear_local(V)
    t_ear = np.clip(ql[:, 1] / EAR_LEN, 0, 1)
    # (the cavity floor sits ~6 mm off the cone surface after the smooth subtraction)
    inner = S.smoothstep(0.019, 0.008, d_in) * S.smoothstep(-0.01, 0.01, ql[:, 2])
    ear_col = _mix(np.tile(C.linear("orange_light"), (len(V), 1)), C.linear("orange"),
                   S.smoothstep(0.05, 0.35, t_ear))
    col = _mix(col, ear_col, inner)
    # ear-base nubs: white
    nub = S.smoothstep(0.004, 0.0, ear_nub(V))
    col = _mix(col, white, nub)
    return col


def head_weights(V):
    q = ear_local(V)
    d_ear = ear_outer(V)
    d_core = head_core(V)
    w_ear = S.smoothstep(0.012, -0.015, d_ear - d_core) * S.smoothstep(-0.005, 0.03, q[:, 1])
    t = np.clip(q[:, 1] / EAR_LEN, 0, 1)
    tip = S.smoothstep(0.38, 0.68, t)
    left = V[:, 0] > 0
    W = {"head": 1.0 - w_ear}
    for s, m in (("L", left), ("R", ~left)):
        W[f"ear_{s}"] = np.where(m, w_ear * (1 - tip), 0.0)
        W[f"earTip_{s}"] = np.where(m, w_ear * tip, 0.0)
    return W


def body_colors(V, N):
    cream = C.linear("fur"); white = C.linear("fur_white")
    x, y, z = V[:, 0], V[:, 1], V[:, 2]
    belly = S.smoothstep(-0.05, -0.14, y) * np.exp(-((z - 0.22) / 0.12) ** 2) * np.exp(-(x / 0.12) ** 2)
    return _mix(np.tile(cream, (len(V), 1)), white, 0.45 * belly)


def body_weights(V):
    z = V[:, 2]
    centers = {"hips": 0.12, "spine": 0.245, "chest": 0.365, "neck": 0.465}
    sig = 0.075
    W = {b: np.exp(-((z - c) / sig) ** 2) for b, c in centers.items()}
    W["hips"] = np.maximum(W["hips"], S.smoothstep(0.16, 0.10, z))
    W["neck"] *= S.smoothstep(0.40, 0.45, z)
    breath = 0.8 * np.exp(-((z - 0.235) / 0.085) ** 2) * S.smoothstep(0.02, -0.08, V[:, 1])
    W["breath"] = breath
    return W


def _chain_param(V, pts):
    """Arc-length parameter of the closest point on polyline pts."""
    best_s = np.zeros(len(V)); best_d = np.full(len(V), np.inf)
    s0 = 0.0
    for a, b in zip(pts[:-1], pts[1:]):
        ab = b - a; L = np.linalg.norm(ab)
        t = np.clip(((V - a) @ ab) / (L * L), 0, 1)
        d = np.linalg.norm(V - (a + t[:, None] * ab), axis=1)
        m = d < best_d
        best_d[m] = d[m]; best_s[m] = s0 + t[m] * L
        s0 += L
    return best_s


def arm_colors(V, N, side="L"):
    sh, el, wr, tip = _arm_pts(side)
    s = _chain_param(V, [sh, el, wr, tip])
    L1 = np.linalg.norm(el - sh); L2 = L1 + np.linalg.norm(wr - el)
    Lt = L2 + np.linalg.norm(tip - wr)
    cream = C.linear("fur")
    g1 = S.smoothstep(L2 - 0.014, L2 + 0.022, s)       # cream -> light orange (paw only)
    g2 = S.smoothstep(L2 + 0.018, Lt + 0.012, s)       # light -> orange at the toes
    col = _mix(np.tile(cream, (len(V), 1)), C.linear("orange_light"), g1)
    return _mix(col, C.linear("orange"), g2)


def arm_weights(V, side="L"):
    sh, el, wr, tip = _arm_pts(side)
    s = _chain_param(V, [sh, el, wr, tip])
    L1 = np.linalg.norm(el - sh); L2 = L1 + np.linalg.norm(wr - el)
    e = S.smoothstep(L1 - 0.036, L1 + 0.036, s)
    w = S.smoothstep(L2 - 0.024, L2 + 0.024, s)
    # fingers / thumb: vertices on the nubs (share of the paw weight)
    f = C.paw_frame(side)
    along = (V - f["knuckle"]) @ f["y"]
    dist_f = np.full(len(V), np.inf)
    for off in f["finger_offsets"]:
        a = f["knuckle"] + f["x"] * off; b = f["finger_tip"] + f["x"] * off
        ab = b - a; t = np.clip(((V - a) @ ab) / (ab @ ab), 0, 1)
        dist_f = np.minimum(dist_f, np.linalg.norm(V - (a + t[:, None] * ab), axis=1))
    wf = S.smoothstep(f["finger_r"] + 0.010, f["finger_r"] + 0.002, dist_f) * S.smoothstep(-0.016, 0.020, along)
    tb, tt = f["thumb_base"], f["thumb_tip"]
    ab = tt - tb; t = np.clip(((V - tb) @ ab) / (ab @ ab), 0, 1)
    dist_t = np.linalg.norm(V - (tb + t[:, None] * ab), axis=1)
    wt = S.smoothstep(f["thumb_r"] + 0.009, f["thumb_r"] + 0.002, dist_t) * S.smoothstep(0.0, 0.35, t)
    wt = np.where(wf >= wt, 0.0, wt)
    wf = np.minimum(wf, 1.0 - wt)
    return {f"upperArm_{side}": 1 - e, f"forearm_{side}": e - w, f"paw_{side}": w * (1 - wf - wt),
            f"fingers_{side}": w * wf, f"thumb_{side}": w * wt}


def leg_colors(V, N, side="L"):
    z = V[:, 2]
    cream = C.linear("fur")
    g = S.smoothstep(0.125, 0.06, z)
    col = _mix(np.tile(cream, (len(V), 1)), C.linear("orange_light"), g)
    col = _mix(col, C.linear("orange"), 0.9 * S.smoothstep(0.085, 0.035, z))
    # sole + toe beans slightly deeper
    sole = S.smoothstep(0.012, 0.004, z)
    col = _mix(col, C.linear("sole"), 0.6 * sole)
    return col


def leg_weights(V, side="L"):
    z = V[:, 2]; y = V[:, 1]
    thigh = S.smoothstep(0.115, 0.15, z)
    foot = S.smoothstep(0.075, 0.045, z) * np.maximum(S.smoothstep(0.0, -0.03, y), S.smoothstep(0.05, 0.02, z))
    foot = np.clip(foot, 0, 1)
    shin = np.clip(1 - thigh - foot, 0, 1)
    return {f"thigh_{side}": thigh, f"shin_{side}": shin, f"foot_{side}": foot}
