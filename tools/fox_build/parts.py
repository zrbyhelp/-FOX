"""Colour and skin-weight fields for the SDF body parts (shapes live in shapes.py).

Everything in Blender space (Z up, fox faces -Y, fox's left = +X).
"""
from __future__ import annotations

import numpy as np

from . import config as C
from . import sdf as S
from .shapes import (EAR_LEN, EAR_Y0, _arm_pts, _leg_pts, ear_local, ear_outer, ear_section, head_core)

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
    ex, ez = P["eye_xz"]
    e_eye = ((ax - ex - 0.017) / 0.118) ** 2 + ((z - ez - 0.010) / 0.092) ** 2
    m_eye = S.smoothstep(1.25, 0.85, e_eye)
    e_muz = (x / 0.115) ** 2 + ((z - P["mouth_xz"][1] + 0.003) / 0.062) ** 2
    m_muz = S.smoothstep(1.3, 0.8, e_muz)
    m_low = S.smoothstep(0.545, 0.510, z) * S.smoothstep(0.08, -0.02, y)
    mask = np.maximum(np.maximum(m_eye, m_muz), m_low) * front
    col = _mix(cream, white, mask)
    # blush
    bx, bz = P["blush_xz"]
    e_bl = ((ax - bx) / 0.046) ** 2 + ((z - bz) / 0.032) ** 2
    blush = np.exp(-1.6 * e_bl) * S.smoothstep(0.0, -0.08, y)
    col = _mix(col, C.linear("blush"), np.clip(blush * 1.05, 0, 0.92))
    # inner ear: the cavity side of the rolled sheet (and the cavity floor) is orange, lighter at
    # the base; the outside, the lateral rim and the rolled medial lip stay cream
    ql = ear_local(V)
    _, off, h = ear_section(ql)
    t_ear = np.clip(ql[:, 1] / EAR_LEN, 0, 1)
    t_sec = (ql[:, 1] - EAR_Y0) / (EAR_LEN - EAR_Y0)
    inner = (S.smoothstep(0.45, -0.45, off / np.maximum(h, 1e-4))
             * S.smoothstep(-0.05, 0.05, t_sec) * S.smoothstep(0.97, 0.90, t_sec))
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
    return S.smoothstep(0.188, 0.100, V[:, 2]) * S.smoothstep(0.010, 0.050, np.abs(V[:, 0]))


def body_colors(V, N):
    cream = C.linear("fur"); white = C.linear("fur_white")
    x, y, z = V[:, 0], V[:, 1], V[:, 2]
    belly = S.smoothstep(-0.05, -0.14, y) * np.exp(-((z - 0.22) / 0.12) ** 2) * np.exp(-(x / 0.12) ** 2)
    col = _mix(np.tile(cream, (len(V), 1)), white, 0.45 * belly)
    # legs: airbrushed orange fading in toward the ankles (the feet are fully orange)
    leg = S.smoothstep(0.012, 0.040, np.abs(x))
    col = _mix(col, C.linear("orange_light"), leg * S.smoothstep(0.124, 0.074, z))
    return _mix(col, C.linear("orange"), 0.7 * leg * S.smoothstep(0.090, 0.050, z))


def body_weights(V):
    x, z = V[:, 0], V[:, 2]
    centers = {"hips": 0.12, "spine": 0.245, "chest": 0.365, "neck": 0.465}
    sig = 0.075
    W = {b: np.exp(-((z - c) / sig) ** 2) for b, c in centers.items()}
    W["hips"] = np.maximum(W["hips"], S.smoothstep(0.16, 0.10, z))
    W["neck"] *= S.smoothstep(0.40, 0.45, z)
    breath = 0.8 * np.exp(-((z - 0.235) / 0.085) ** 2) * S.smoothstep(0.02, -0.08, V[:, 1])
    W["breath"] = breath
    # the leg columns follow the thigh / shin bones (knee ~0.105); the web of the crotch between
    # them follows both legs half and half (when the fox sits and both legs swing forward it moves
    # with them instead of sagging / folding between the columns)
    legz = S.smoothstep(0.188, 0.100, z)
    leg = legz
    s = W["hips"] + W["spine"] + W["chest"] + W["neck"] + 1e-9
    for k in ("hips", "spine", "chest", "neck"):
        W[k] = W[k] / s * (1 - leg)
    W["breath"] *= 1 - _leg_share(V)
    shin = leg * S.smoothstep(0.118, 0.070, z)
    wl = S.smoothstep(-0.045, 0.045, x)
    for side, w in (("L", wl), ("R", 1 - wl)):
        W[f"thigh_{side}"] = (leg - shin) * w
        W[f"shin_{side}"] = shin * w
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
    g1 = S.smoothstep(L2 - 0.006, L2 + 0.032, s)       # cream -> light orange over the paw
    g2 = S.smoothstep(L2 + 0.026, Lt + 0.012, s)       # light -> orange at the tip only
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
    """The feet (the legs themselves are part of the body surface). The underside (seen when
    sitting / jumping) is a lighter warm orange with soft pads, so it never reads dark."""
    z = V[:, 2]
    col = np.tile(C.linear("orange_light"), (len(V), 1))
    col = _mix(col, C.linear("orange"), 0.9 * S.smoothstep(0.092, 0.035, z))
    # direction from the foot centre, normalised by the foot size (toes at -y)
    hip, knee, ankle, toe = _leg_pts(side)
    fx, fy, fz = P["foot_size"]
    u = (V - np.array([ankle[0], -0.030, fz * 0.5])) / (np.array([fx, fy, fz]) * 0.5)
    u /= np.maximum(np.linalg.norm(u, axis=1, keepdims=True), 1e-9)
    sole = S.smoothstep(-0.25, -0.60, u[:, 2])                 # lower half of the foot
    col = _mix(col, C.linear("sole"), 0.85 * sole)
    pads = [((0.0, 0.34, -0.94), 0.46)] + [((gx, -0.60, -0.80), 0.24) for gx in (-0.44, 0.0, 0.44)]
    pad = np.zeros(len(V))
    for c, r in pads:
        c = np.array(c) / np.linalg.norm(c)
        pad = np.maximum(pad, S.smoothstep(r, r * 0.72, np.linalg.norm(u - c, axis=1)))
    return _mix(col, C.linear("sole_pad"), 0.8 * pad * sole)


def leg_weights(V, side="L"):
    """Feet: the foot bone, blending into the shin up the ankle stub."""
    z = V[:, 2]; y = V[:, 1]
    foot = S.smoothstep(0.075, 0.045, z) * np.maximum(S.smoothstep(0.0, -0.03, y), S.smoothstep(0.05, 0.02, z))
    foot = np.clip(foot, 0, 1)
    return {f"shin_{side}": 1 - foot, f"foot_{side}": foot}
