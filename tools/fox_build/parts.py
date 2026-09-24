"""Colour and skin-weight fields for the SDF body parts (shapes live in shapes.py).

Everything in Blender space (Z up, fox faces -Y, fox's left = +X).
"""
from __future__ import annotations

import numpy as np

from . import config as C
from . import sdf as S
from .shapes import (EAR_LEN, _arm_pts, ear_inner, ear_local, ear_outer, head_core)

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
    # front test: the cavity floor sits a little behind the ear's mid-plane (ql z ~ -0.01); the
    # back surface (ql z ~ -0.044) is excluded by d_in anyway
    inner = S.smoothstep(0.011, 0.004, d_in) * S.smoothstep(-0.032, -0.018, ql[:, 2])
    ear_col = _mix(np.tile(C.linear("orange_light"), (len(V), 1)), C.linear("orange"),
                   S.smoothstep(0.05, 0.35, t_ear))
    return _mix(col, ear_col, inner)


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


def _leg_share(V):
    """How much of the body surface is leg (the legs grow out of the belly): 0 on the torso and
    the crotch centre line, 1 on the lower leg."""
    return S.smoothstep(0.150, 0.100, V[:, 2]) * S.smoothstep(0.014, 0.046, np.abs(V[:, 0]))


def body_colors(V, N):
    cream = C.linear("fur"); white = C.linear("fur_white")
    x, y, z = V[:, 0], V[:, 1], V[:, 2]
    belly = S.smoothstep(-0.05, -0.14, y) * np.exp(-((z - 0.22) / 0.12) ** 2) * np.exp(-(x / 0.12) ** 2)
    col = _mix(np.tile(cream, (len(V), 1)), white, 0.45 * belly)
    # legs: airbrushed orange fading in toward the ankles (the feet are fully orange)
    leg = S.smoothstep(0.012, 0.040, np.abs(x))
    col = _mix(col, C.linear("orange_light"), leg * S.smoothstep(0.128, 0.068, z))
    return _mix(col, C.linear("orange"), 0.75 * leg * S.smoothstep(0.086, 0.040, z))


def body_weights(V):
    x, z = V[:, 0], V[:, 2]
    centers = {"hips": 0.12, "spine": 0.245, "chest": 0.365, "neck": 0.465}
    sig = 0.075
    W = {b: np.exp(-((z - c) / sig) ** 2) for b, c in centers.items()}
    W["hips"] = np.maximum(W["hips"], S.smoothstep(0.16, 0.10, z))
    W["neck"] *= S.smoothstep(0.40, 0.45, z)
    breath = 0.8 * np.exp(-((z - 0.235) / 0.085) ** 2) * S.smoothstep(0.02, -0.08, V[:, 1])
    W["breath"] = breath
    # the leg columns follow the thigh / shin bones (knee ~0.105)
    leg = _leg_share(V)
    s = W["hips"] + W["spine"] + W["chest"] + W["neck"] + 1e-9
    for k in ("hips", "spine", "chest", "neck"):
        W[k] = W[k] / s * (1 - leg)
    W["breath"] *= 1 - leg
    shin = leg * S.smoothstep(0.112, 0.078, z)
    for side, m in (("L", x > 0), ("R", x <= 0)):
        W[f"thigh_{side}"] = np.where(m, leg - shin, 0.0)
        W[f"shin_{side}"] = np.where(m, shin, 0.0)
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
    g1 = S.smoothstep(L2 - 0.022, L2 + 0.020, s)       # cream -> light orange (paw, soft edge)
    g2 = S.smoothstep(L2 + 0.012, Lt + 0.010, s)       # light -> orange at the toes
    col = _mix(np.tile(cream, (len(V), 1)), C.linear("orange_light"), g1)
    return _mix(col, C.linear("orange"), g2)


def arm_weights(V, side="L"):
    sh, el, wr, tip = _arm_pts(side)
    s = _chain_param(V, [sh, el, wr, tip])
    L1 = np.linalg.norm(el - sh); L2 = L1 + np.linalg.norm(wr - el)
    e = S.smoothstep(L1 - 0.036, L1 + 0.036, s)
    w = S.smoothstep(L2 - 0.024, L2 + 0.024, s)
    return {f"upperArm_{side}": 1 - e, f"forearm_{side}": e - w, f"paw_{side}": w}


def leg_colors(V, N, side="L"):
    """The feet (the legs themselves are part of the body surface)."""
    z = V[:, 2]
    col = np.tile(C.linear("orange_light"), (len(V), 1))
    col = _mix(col, C.linear("orange"), 0.9 * S.smoothstep(0.092, 0.035, z))
    # sole + toe beans slightly deeper
    sole = S.smoothstep(0.012, 0.004, z)
    col = _mix(col, C.linear("sole"), 0.6 * sole)
    return col


def leg_weights(V, side="L"):
    """Feet: the foot bone, blending into the shin up the ankle stub."""
    z = V[:, 2]; y = V[:, 1]
    foot = S.smoothstep(0.075, 0.045, z) * np.maximum(S.smoothstep(0.0, -0.03, y), S.smoothstep(0.05, 0.02, z))
    foot = np.clip(foot, 0, 1)
    return {f"shin_{side}": 1 - foot, f"foot_{side}": foot}
