"""Animation clips. PLACEHOLDER (v0): Idle + Wave only, to exercise the pipeline.
Replaced by the full pose library / clip set (see spec.json "clips")."""
from __future__ import annotations

import math

from . import config as C
from .anim import make_action, qeuler, qmirror


def _idle(frame_count=120, step=10):
    keys = []
    for f in range(0, frame_count + 1, step):
        ph = 2 * math.pi * f / frame_count
        keys.append((f + 1, {
            "breath": {"scale": (1 + 0.02 * math.sin(ph),) * 3},
            "head": {"rot": qeuler(y=3 * math.sin(ph))},
            "tail_2": {"rot": qeuler(z=8 * math.sin(ph))},
            "tail_4": {"rot": qeuler(z=8 * math.sin(ph - 1.0))},
            "upperArm_L": {"rot": qeuler(y=35)},
            "upperArm_R": {"rot": qmirror(qeuler(y=35))},
        }))
    return keys


def _wave():
    keys = []
    for i, f in enumerate(range(0, 61, 6)):
        a = 20 * math.sin(i * math.pi / 2)
        keys.append((f + 1, {
            "upperArm_L": {"rot": qeuler(y=-110 + a)},
            "upperArm_R": {"rot": qmirror(qeuler(y=35))},
            "mouthOpen": {"scale": (1, 1, 1)},
            "mouthSmile": {"scale": C.EPS_SCALE},
        }))
    return keys


def build_clips(bpy, arm):
    meta = {}
    make_action(bpy, arm, "Idle", _idle(), loop=True)
    meta["Idle"] = {"loop": True, "duration": 4.0}
    make_action(bpy, arm, "Wave", _wave(), loop=False)
    meta["Wave"] = {"loop": False, "duration": 2.0}
    return meta
