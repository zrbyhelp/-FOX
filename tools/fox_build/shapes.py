"""SDF shapes of the fox's body parts (head, body, arms, legs). Blender space.
Meshes generated from these are cached by the hash of this file (see model.py), so keep
colour / weight logic in parts.py."""
from __future__ import annotations

import numpy as np

from . import config as C
from . import sdf as S

P = C.P


def _ear_frame():
    """Frame for the LEFT ear (+X). Columns: x = across ear (+ = lateral), y = base->tip,
    z = front normal."""
    base = np.array(P["ear_base"], float)
    tip = np.array(P["ear_tip"], float)
    axis = tip - base
    front = np.array([0.18, -1.0, 0.05])  # forward, a little outward
    y = axis / np.linalg.norm(axis)
    z = front - (front @ y) * y
    z /= np.linalg.norm(z)
    x = np.cross(y, z)
    return base, np.stack([x, y, z], 1), float(np.linalg.norm(axis))


EAR_BASE, EAR_R, EAR_LEN = _ear_frame()


# The ear is a rolled sheet, like a fennec's (smaller and rounder): a C-shaped section swept from
# the base to the tip. Section angles (deg) are measured about the ear axis from the front (+z)
# toward the lateral side (+x). The sheet runs from the LATERAL lip (at the ear's outer side: a
# thin rim that does not curl) round the lateral side, the bulging back and the medial side, and
# wraps onto the front up to the MEDIAL lip: a rounded rolled ridge covering the medial part of
# the cavity, wider toward the base where it wraps the ear's root. Between the lips the deep
# cavity is open to the front.
EAR_Y0 = -0.035        # base sinks into the head
EAR_FRONT = 0.55       # front / back squash of the section (the back bulges more)
EAR_BACK = 0.72
EAR_TT = [0.0, 0.15, 0.35, 0.55, 0.75, 0.84, 0.90, 1.0]     # along the ear, base -> tip
EAR_PL = [82, 82, 80, 78, 72, 60, 40, 40]                   # lateral lip angle
EAR_PM = [25, 5, -32, -46, -42, -22, 30, 40]                # medial lip angle (wraps onto the front)
EAR_HB = [0.26, 0.24, 0.22, 0.22, 0.24, 0.30, 0.50, 0.50]   # back half-thickness / R
EAR_HL = [0.07, 0.07, 0.07, 0.07, 0.08, 0.12, 0.50, 0.50]   # lateral rim half-thickness / R
EAR_HM = [0.20, 0.20, 0.19, 0.18, 0.18, 0.20, 0.50, 0.50]   # medial rolled lip radius / R
EAR_HMS = [0.16, 0.15, 0.13, 0.12, 0.12, 0.16, 0.50, 0.50]  # medial sheet half-thickness / R
# (from ~0.9 up all four reach 0.5 R: the section closes into the solid, softly rounded tip)


def _ear_radius(y):
    """Half-width of the leaf outline; ~(1 - t)^0.62 at the end gives a softly rounded tip."""
    t = np.clip((y - EAR_Y0) / (EAR_LEN - EAR_Y0), 0.0, 1.0)
    return (P["ear_base_width"] / 2) * np.maximum(1.0 - t ** 1.6, 0.0) ** 0.62 + 1e-4


def ear_section(q):
    """Rolled-sheet ear in ear-local coords q. Returns (d, off, h): the (squashed) distance to
    the sheet, the radial offset from the sheet's mid-surface (< 0 = the inner, cavity side) and
    the local half-thickness."""
    qq = q.copy()
    qq[:, 2] = np.where(q[:, 2] > 0, q[:, 2] / EAR_FRONT, q[:, 2] / EAR_BACK)
    t = np.clip((q[:, 1] - EAR_Y0) / (EAR_LEN - EAR_Y0), 0, 1)
    R = _ear_radius(np.maximum(q[:, 1], EAR_Y0))
    f = lambda tab: np.interp(t, EAR_TT, tab)
    pl, pm = np.radians(f(EAR_PL)), np.radians(f(EAR_PM))
    hb, hl, hm, hms = f(EAR_HB) * R, f(EAR_HL) * R, f(EAR_HM) * R, f(EAR_HMS) * R
    x, z = qq[:, 0], qq[:, 2]
    r = np.hypot(x, z)
    span = pm + 2 * np.pi - pl                   # lateral lip -> back -> medial lip
    a = np.mod(np.arctan2(x, z) - pl, 2 * np.pi)
    a_back = np.pi - pl
    # half-thickness along the sheet: thin lateral rim -> plush back -> medial sheet
    u1 = S.smoothstep(0.0, 1.0, np.clip(a / np.maximum(a_back, 1e-3), 0, 1))
    u2 = S.smoothstep(0.0, 1.0, np.clip((a - a_back) / np.maximum(span - a_back, 1e-3), 0, 1))
    h = np.where(a < a_back, hl + (hb - hl) * u1, hb + (hms - hb) * u2)
    rho = R - h                                   # the outer surface stays on the leaf outline
    d_arc = np.where(a <= span, np.abs(r - rho) - h, np.inf)
    # round lips: a thin rim on the lateral side, a fuller rolled lip on the medial side
    p2 = np.stack([x, z], 1)
    eL = np.stack([(R - hl) * np.sin(pl), (R - hl) * np.cos(pl)], 1)
    eM = np.stack([(R - hm) * np.sin(pm), (R - hm) * np.cos(pm)], 1)
    d = np.minimum.reduce([d_arc, np.linalg.norm(p2 - eL, axis=1) - hl, np.linalg.norm(p2 - eM, axis=1) - hm])
    d = np.maximum(d, q[:, 1] - EAR_LEN)          # nothing past the tip
    d = np.maximum(d, EAR_Y0 - q[:, 1])           # capped inside the head
    return d, r - rho, h


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
    """Distance to the ear (the rolled sheet; scaled to stay a conservative bound)."""
    return ear_section(ear_local(p))[0] * EAR_FRONT * 0.9


def head_sdf(p):
    return S.smin(head_core(p), ear_outer(p), 0.035)


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
PAW_GROOVE_HW = 0.0045     # finger groove half-width (soft, wide creases like the toes)
PAW_GROOVE_DEPTH = 0.0042  # finger groove depth (fades in toward the tip)


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
    d = S.smin(d, paw, 0.035)
    # two soft finger grooves (like the toes): over the back of the paw (+z) and round its tip,
    # fading in from the middle of the paw and out toward the palm
    depth = PAW_GROOVE_DEPTH * S.smoothstep(pc, pc + 0.5 * pr, q[:, 1]) * S.smoothstep(-0.55 * pr, -0.15 * pr, q[:, 2])
    for gx in (-0.34 * pr, 0.34 * pr):
        g = np.maximum(np.abs(q[:, 0] - gx) - PAW_GROOVE_HW, -(d + depth))
        d = S.ssub(d, g, 0.006)
    d = d * ARM_FLAT
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


