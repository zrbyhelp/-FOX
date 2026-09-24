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


EAR_Y0 = -0.035        # base sinks into the head
EAR_FLAT = 0.84        # front-back squash of the ear's round cross-section
EAR_TIP = 0.020        # radius of the softly rounded tip


def _ear_radius(y):
    """Half-width along the ear: a rounded leaf, full near the base with gently bulging sides."""
    t = np.clip((y - EAR_Y0) / (EAR_LEN - EAR_Y0), 0.0, 1.0)
    return EAR_TIP + (P["ear_base_width"] / 2 - EAR_TIP) * (1.0 - t ** 1.45) ** 0.82


def _tube(q, ys, radii, z_off=None):
    """Smooth tube along local y with a varying radius (chain of round cones)."""
    z_off = np.zeros(len(ys)) if z_off is None else z_off
    d = np.full(len(q), np.inf)
    for i in range(len(ys) - 1):
        d = np.minimum(d, S.round_cone(q, (0, ys[i], z_off[i]), (0, ys[i + 1], z_off[i + 1]),
                                       radii[i], radii[i + 1]))
    return d


def _ear_shape(q, inner=False):
    """Fox auricle in ear-local coords q (x across, y along base->tip, z = front).

    A cupped shell, not a flat cut-out: the outer surface is a leaf-shaped tube (round cross
    section, slightly squashed front-back); the hollow is a narrower tube shifted forward, so the
    section is a C whose side lips curl forward and in around a deep bowl (like the art). The
    hollow stops short of the tip, which stays solid cream. inner=True returns the hollow
    (head_sdf subtracts it, parts.head_colors paints it orange)."""
    ys = np.linspace(EAR_Y0, EAR_LEN - EAR_TIP * 0.3, 14)
    R = _ear_radius(ys)
    qq = q.copy()
    qq[:, 2] = q[:, 2] / EAR_FLAT
    if not inner:
        return _tube(qq, ys, R) * EAR_FLAT
    # hollow: from a little above the base to ~85% of the length, centred forward of the axis
    t = np.clip((ys - EAR_Y0) / (EAR_LEN - EAR_Y0), 0, 1)
    k = np.clip((t - 0.06) / 0.10, 0, 1) * np.clip((0.86 - t) / 0.14, 0, 1)     # fade in / out
    # (in the squashed frame the outer section is a circle of radius R: a circle of radius 0.82R
    #  centred 0.58R forward leaves side lips curling in to ~82% of the width, a deep bowl and a
    #  thick rounded back)
    Rin = np.maximum(R * 0.82 - 0.004, 0.003) * (0.35 + 0.65 * k)
    return _tube(qq, ys, Rin, R * 0.58) * EAR_FLAT


def ear_local(p):
    q = S.mirror_x(p)
    return S.to_local(q, EAR_BASE, EAR_R)


def head_core(p):
    """Head without ears."""
    q = S.mirror_x(p)
    # wide, gently domed (mochi), widest around the eyes; the cheeks only fill the lower face
    skull = S.ellipsoid(p, (0, 0.0, 0.646), (0.310, 0.230, 0.212))
    cheeks = S.ellipsoid(p, (0, -0.020, 0.560), (0.298, 0.200, 0.150))
    d = S.smin(skull, cheeks, 0.09)
    muzzle = S.ellipsoid(p, (0, -0.160, 0.547), (0.090, 0.058, 0.055))
    d = S.smin(d, muzzle, 0.06)
    neck = S.ellipsoid(p, (0, 0.0, 0.455), (0.105, 0.098, 0.075))
    d = S.smin(d, neck, 0.05)
    # cheek fluff tufts pointing outward/down
    t1 = S.round_cone(q, (0.246, -0.030, 0.552), (0.322, -0.004, 0.512), 0.050, 0.010)
    d = S.smin(d, t1, 0.030)
    return d


def ear_outer(p):
    return _ear_shape(ear_local(p))


def ear_inner(p):
    return _ear_shape(ear_local(p), inner=True)


def head_sdf(p):
    d = S.smin(head_core(p), ear_outer(p), 0.035)
    d = S.ssub(d, ear_inner(p), 0.010)
    return d


HEAD_BBOX = ((-0.44, -0.28, 0.36), (0.44, 0.27, 1.12))


def _leg_column(q):
    """Left leg (use with mirror_x): a short thick column growing out of the belly."""
    # (constants, not the bone table: the flap bones are placed on this body's surface)
    top = np.array([C.LEG_X, -0.006, 0.165])
    bot = np.array([C.LEG_X + 0.002, -0.026, 0.068])
    return S.round_cone(q, top, bot, P["leg_radius"] * 1.05, P["leg_radius"] * 0.90)


def body_sdf(p):
    """Pear body with the legs as part of its surface: the lower belly flows in a soft S-curve
    into two short thick legs with a rounded notch between them (like the art); the feet are
    separate parts (leg_sdf)."""
    # the pear ends ~0.11 above the floor so the short legs read below it
    lower = S.ellipsoid(p, (0, 0.012, 0.236), (0.198, 0.170, 0.128))
    upper = S.ellipsoid(p, (0, 0.004, 0.352), (0.138, 0.120, 0.128))
    d = S.smin(lower, upper, 0.12)
    belly = S.ellipsoid(p, (0, -0.044, 0.236), (0.152, 0.132, 0.120))
    d = S.smin(d, belly, 0.05)
    butt = S.ellipsoid(p, (0, 0.072, 0.200), (0.165, 0.124, 0.100))
    d = S.smin(d, butt, 0.05)
    return S.smin(d, _leg_column(S.mirror_x(p)), 0.050)


BODY_BBOX = ((-0.23, -0.21, -0.005), (0.23, 0.22, 0.50))


def _arm_pts(side="L"):
    bt = C.bone_table()
    sh = np.array(bt[f"upperArm_{side}"][1]); el = np.array(bt[f"forearm_{side}"][1])
    wr = np.array(bt[f"paw_{side}"][1]); tip = np.array(bt[f"paw_{side}"][2])
    return sh, el, wr, tip


ARM_FLAT = 0.80        # arm / paw thickness : width (flattened, not a round tube)
ARM_WIDEN = 1.12       # half-width at the wrist : at the shoulder (the arm widens toward the paw)


def arm_sdf(p, side="L"):
    """A flattened stubby arm that widens gradually from the shoulder into a rounded mitten paw
    (the widest part). Local frame: x across the arm, y along it, z front/back (thickness)."""
    sh, el, wr, tip = _arm_pts(side)
    f = C.paw_frame(side)
    o, R = S.frame(sh, f["x"], f["y"])
    q = S.to_local(p, o, R)
    q[:, 2] /= ARM_FLAT
    L = float(np.linalg.norm(wr - sh))
    ar = P["arm_radius"]; pr = P["paw_radius"]
    d = S.round_cone(q, (0, 0, 0), (0, L, 0), ar, ar * ARM_WIDEN)
    pc = L + float((f["centre"] - wr) @ f["y"])
    paw = S.ellipsoid(q, (0, pc, 0), (pr, pr * 1.06, pr * 1.04))
    d = S.smin(d, paw, 0.035) * ARM_FLAT
    return S.smin(d, S.sphere(p, sh, ar * 1.05), 0.02)  # rounded root at the shoulder pivot


def arm_bbox(side="L"):
    pts = np.array(_arm_pts(side))
    return pts.min(0) - 0.09, pts.max(0) + 0.09


def _leg_pts(side="L"):
    bt = C.bone_table()
    hip = np.array(bt[f"thigh_{side}"][1]); knee = np.array(bt[f"shin_{side}"][1])
    ankle = np.array(bt[f"foot_{side}"][1]); toe = np.array(bt[f"foot_{side}"][2])
    return hip, knee, ankle, toe


def leg_sdf(p, side="L"):
    """The foot: rounded, a bit wider than the leg, flat sole, two toe grooves; a short ankle
    stub reaches up inside the leg column (body_sdf) so the foot stays attached when it bends."""
    hip, knee, ankle, toe = _leg_pts(side)
    fx, fy, fz = P["foot_size"]
    fc = np.array([ankle[0], -0.030, fz * 0.5])
    d = S.ellipsoid(p, fc, (fx / 2, fy / 2, fz / 2))
    stub = S.round_cone(p, np.array([ankle[0], -0.026, 0.050]), np.array([ankle[0], -0.024, 0.100]),
                        P["leg_radius"] * 0.80, P["leg_radius"] * 0.78)
    d = S.smin(d, stub, 0.03)
    d = S.smax(d, -(p[:, 2] - 0.002), 0.012)   # flat sole on the ground plane
    for gx in (-0.018, 0.018):
        a = np.array([ankle[0] + gx, fc[1] - fy * 0.30, fz * 0.80])
        b = np.array([ankle[0] + gx, fc[1] - fy * 0.62, fz * 0.30])
        d = S.ssub(d, S.capsule(p, a, b, 0.0042), 0.006)
    return d


def leg_bbox(side="L"):
    hip, knee, ankle, toe = _leg_pts(side)
    return (np.array([hip[0] - 0.085, -0.125, -0.01]), np.array([hip[0] + 0.085, 0.06, 0.175]))


