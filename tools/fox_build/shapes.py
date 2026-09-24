"""SDF shapes of the fox's body parts (head, body, arms, legs). Blender space.
Meshes generated from these are cached by the hash of this file (see model.py), so keep
colour / weight logic in parts.py."""
from __future__ import annotations

import numpy as np

from . import config as C
from . import sdf as S

P = C.P


def _ear_frame():
    """Frame for the LEFT ear (+X). Columns: x = across ear, y = base->tip, z = front normal."""
    base = np.array(P["ear_base"], float)
    tip = np.array(P["ear_tip"], float)
    axis = tip - base
    front = np.array([0.38, -1.0, 0.05])  # forward and a little outward
    y = axis / np.linalg.norm(axis)
    z = front - (front @ y) * y
    z /= np.linalg.norm(z)
    x = np.cross(y, z)
    return base, np.stack([x, y, z], 1), float(np.linalg.norm(axis))


EAR_BASE, EAR_R, EAR_LEN = _ear_frame()


def _tri2d(px, py, qx, qy):
    """IQ isosceles triangle SDF: apex at origin, base (half width qx) at y = qy > 0."""
    px = np.abs(px)
    qq = qx * qx + qy * qy
    t = np.clip((px * qx + py * qy) / qq, 0.0, 1.0)
    ax = px - qx * t; ay = py - qy * t
    tb = np.clip(px / qx, 0.0, 1.0)
    bx = px - qx * tb; by = py - qy
    d1 = np.minimum(ax * ax + ay * ay, bx * bx + by * by)
    d2 = np.minimum(-(px * qy - py * qx), -(py - qy))
    return -np.sqrt(d1) * np.sign(d2)


EAR_ROUND = 0.060      # 2D corner rounding (rounded tip)
EAR_Y0 = -0.035        # base sinks into the head


def _ear_outline(q, inset=0.0, y0=EAR_Y0):
    """2D rounded-triangle distance in the ear plane (x across, y along)."""
    hw = P["ear_base_width"] / 2
    apex = EAR_LEN + EAR_ROUND * 0.55 - inset * 1.9
    qx = hw - EAR_ROUND - inset * 0.8
    qy = apex - y0
    return _tri2d(q[:, 0], apex - q[:, 1], qx * (1 - EAR_ROUND / qy), qy - EAR_ROUND) - EAR_ROUND


def _ear_half_thickness(y):
    t = np.clip(y / EAR_LEN, 0, 1)
    return P["ear_thickness"] / 2 * (1 - 0.38 * t)


def _ear_shape(q, inner=False):
    """Pillowy rounded-triangle slab in ear-local coords q (x across, y along, z = front)."""
    if inner:
        # recess volume: inset outline, from (front face - depth) forward
        d2 = _ear_outline(q, inset=0.031)
        d2 = np.maximum(d2, 0.03 - q[:, 1])           # recess starts a bit above the base
        h = _ear_half_thickness(q[:, 1])
        depth = 0.020 * (1 - 0.5 * np.clip(q[:, 1] / EAR_LEN, 0, 1))
        dz = (h - depth) - q[:, 2]
        return np.maximum(d2, dz)
    d2 = _ear_outline(q)
    h = _ear_half_thickness(q[:, 1])
    rr = 0.012
    wx = d2 + rr; wz = np.abs(q[:, 2]) - h + rr
    return np.minimum(np.maximum(wx, wz), 0) + np.sqrt(np.maximum(wx, 0) ** 2 + np.maximum(wz, 0) ** 2) - rr


def ear_local(p):
    q = S.mirror_x(p)
    return S.to_local(q, EAR_BASE, EAR_R)


def head_core(p):
    """Head without ears."""
    q = S.mirror_x(p)
    skull = S.ellipsoid(p, (0, 0.0, 0.650), (0.242, 0.205, 0.205))
    cheeks = S.ellipsoid(p, (0, -0.020, 0.560), (0.282, 0.188, 0.152))
    d = S.smin(skull, cheeks, 0.09)
    muzzle = S.ellipsoid(p, (0, -0.160, 0.547), (0.090, 0.058, 0.055))
    d = S.smin(d, muzzle, 0.06)
    neck = S.ellipsoid(p, (0, 0.0, 0.455), (0.105, 0.098, 0.075))
    d = S.smin(d, neck, 0.05)
    # cheek fluff tufts pointing outward/down
    t1 = S.round_cone(q, (0.226, -0.030, 0.556), (0.300, -0.004, 0.516), 0.050, 0.010)
    d = S.smin(d, t1, 0.030)
    return d


def ear_nub(p):
    q = S.mirror_x(p)
    c = EAR_BASE + EAR_R @ np.array([-0.062, 0.035, 0.022])
    return S.sphere(q, c, 0.0125)


def ear_outer(p):
    return _ear_shape(ear_local(p))


def ear_inner(p):
    return _ear_shape(ear_local(p), inner=True)


def head_sdf(p):
    d = S.smin(head_core(p), ear_outer(p), 0.035)
    d = S.ssub(d, ear_inner(p), 0.008)
    d = S.smin(d, ear_nub(p), 0.010)
    return d


HEAD_BBOX = ((-0.42, -0.27, 0.36), (0.42, 0.26, 1.07))


def body_sdf(p):
    lower = S.ellipsoid(p, (0, 0.012, 0.205), (0.190, 0.168, 0.155))
    upper = S.ellipsoid(p, (0, 0.004, 0.352), (0.128, 0.112, 0.128))
    d = S.smin(lower, upper, 0.12)
    belly = S.ellipsoid(p, (0, -0.042, 0.215), (0.150, 0.128, 0.132))
    d = S.smin(d, belly, 0.05)
    butt = S.ellipsoid(p, (0, 0.070, 0.165), (0.158, 0.120, 0.118))
    d = S.smin(d, butt, 0.05)
    return d


BODY_BBOX = ((-0.23, -0.21, 0.03), (0.23, 0.22, 0.50))


def _arm_pts(side="L"):
    bt = C.bone_table()
    sh = np.array(bt[f"upperArm_{side}"][1]); el = np.array(bt[f"forearm_{side}"][1])
    wr = np.array(bt[f"paw_{side}"][1]); tip = np.array(bt[f"paw_{side}"][2])
    return sh, el, wr, tip


def arm_sdf(p, side="L"):
    sh, el, wr, tip = _arm_pts(side)
    ar = P["arm_radius"]; pr = P["paw_radius"]
    d = S.round_cone(p, sh, el, ar * 0.98, ar * 0.93)
    d = S.smin(d, S.round_cone(p, el, wr, ar * 0.93, ar * 0.97), 0.02)
    ax = (tip - wr) / np.linalg.norm(tip - wr)
    pc = wr + ax * 0.034
    # mitten paw: ellipsoid in a local frame (x lateral, y along axis, z front/back)
    o, R = S.frame(pc, np.cross(ax, [0, -1, 0]), ax)
    ql = S.to_local(p, o, R)
    paw = S.ellipsoid(ql, (0, 0, 0), (pr * 1.0, pr * 1.08, pr * 0.86))
    d = S.smin(d, paw, 0.03)
    d = S.smin(d, S.sphere(p, sh, ar * 1.02), 0.02)  # ball root at the shoulder pivot
    # two toe grooves across the tip (front half)
    for gx in (-0.017, 0.017):
        a = o + R @ np.array([gx, pr * 0.35, pr * 0.2])
        b = o + R @ np.array([gx, pr * 1.25, pr * 0.2])
        g = S.capsule(p, a, b, 0.0042)
        d = S.ssub(d, g, 0.006)
    return d


def arm_bbox(side="L"):
    pts = np.array(_arm_pts(side))
    return pts.min(0) - 0.09, pts.max(0) + 0.09


def _leg_pts(side="L"):
    bt = C.bone_table()
    hip = np.array(bt[f"thigh_{side}"][1]); knee = np.array(bt[f"shin_{side}"][1])
    ankle = np.array(bt[f"foot_{side}"][1]); toe = np.array(bt[f"foot_{side}"][2])
    return hip, knee, ankle, toe


def leg_sdf(p, side="L"):
    hip, knee, ankle, toe = _leg_pts(side)
    lr = P["leg_radius"]
    fx, fy, fz = P["foot_size"]
    d = S.sphere(p, hip, lr * 1.04)
    d = S.smin(d, S.round_cone(p, hip, ankle + np.array([0, 0, 0.02]), lr, lr * 0.98), 0.02)
    fc = np.array([ankle[0], -0.030, fz * 0.5])
    foot = S.ellipsoid(p, fc, (fx / 2, fy / 2, fz / 2))
    d = S.smin(d, foot, 0.035)
    d = S.smax(d, -(p[:, 2] - 0.002), 0.012)   # flat sole on the ground plane
    for gx in (-0.018, 0.018):
        a = np.array([ankle[0] + gx, fc[1] - fy * 0.30, fz * 0.80])
        b = np.array([ankle[0] + gx, fc[1] - fy * 0.62, fz * 0.30])
        d = S.ssub(d, S.capsule(p, a, b, 0.0042), 0.006)
    return d


def leg_bbox(side="L"):
    hip, knee, ankle, toe = _leg_pts(side)
    return (np.array([hip[0] - 0.1, -0.14, -0.01]), np.array([hip[0] + 0.1, 0.1, hip[2] + 0.08]))


