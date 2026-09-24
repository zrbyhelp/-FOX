"""Static ambient occlusion baked from SDFs into the `_AO` vertex attribute (1 = open).

Only contacts that persist in every pose are included (limbs/tail/head roots against the
body, chin against the scarf, ear cavities); arms are self-occluded only because their
A-pose rest position differs from every animated pose.
"""
from __future__ import annotations

import numpy as np

from . import config as C
from . import sdf as S
from . import shapes as SH
from .spline import Spline

P = C.P


def tail_sdf(p, n=48):
    from .parametric import _profile
    sp = Spline(C.TAIL_SPLINE)
    t = np.linspace(0, 1, n)
    ctr = sp.point_at_arclength(t)
    r = _profile(t)
    d = np.full(len(p), np.inf)
    for c, rr in zip(ctr, r):
        if rr > 0.004:
            d = np.minimum(d, S.length(p - c) - rr)
    return d


def scarf_sdf(p):
    z0 = P["scarf_z"]
    rr = np.sqrt(p[:, 0] ** 2 + p[:, 1] ** 2)
    R = 0.145
    b, a = P["scarf_tube_radius"]
    q = np.stack([(rr - R) / a, (p[:, 2] - z0) / b], 1)
    return (np.sqrt((q ** 2).sum(1)) - 1.0) * min(a, b)


def legs_sdf(p):
    return np.minimum(SH.leg_sdf(p, "L"), SH.leg_sdf(p, "R"))


CONTEXT = {
    "Head": lambda p: np.minimum(np.minimum(SH.head_sdf(p), scarf_sdf(p)), SH.body_sdf(p)),
    "Body": lambda p: np.minimum.reduce([SH.body_sdf(p), SH.head_sdf(p), scarf_sdf(p), legs_sdf(p),
                                         tail_sdf(p)]),
    "Leg_L": lambda p: np.minimum(SH.leg_sdf(p, "L"), SH.body_sdf(p)),
    "Leg_R": lambda p: np.minimum(SH.leg_sdf(p, "R"), SH.body_sdf(p)),
    # parametric parts: occluded by OTHER parts only (their own shape has no SDF twin)
    "Tail": lambda p: SH.body_sdf(p),
    "Scarf": lambda p: np.minimum(SH.head_sdf(p), SH.body_sdf(p)),
    "Arm_L": lambda p: SH.arm_sdf(p, "L"),
    "Arm_R": lambda p: SH.arm_sdf(p, "R"),
}


# per-part (step, strength, floor): the face must stay bright right above the scarf
PARAMS = {"Head": (0.008, 1.8, 0.6), "Scarf": (0.010, 2.0, 0.55)}


def bake(name, V, N, steps=5, h=0.013, k=2.2, floor=0.45):
    fn = CONTEXT.get(name)
    if fn is None:
        return None
    h, k, floor = PARAMS.get(name, (h, k, floor))
    occ = np.zeros(len(V))
    for i in range(1, steps + 1):
        d = h * i
        occ += (d - fn(V + N * d)) / (2.0 ** i)
    ao = np.clip(1.0 - k * np.maximum(occ, 0.0) / h, floor, 1.0)
    return ao
