"""Single source of truth for fox proportions, joints, colours and budgets.

Blender space (all coordinates in this file): Z up, fox faces -Y, fox's LEFT = +X.
glTF export converts (x, y, z) -> (x, z, -y): fox faces +Z, left stays +X.
1.0 unit = ground to ear tip.

Names (bones, clips, materials, cameras) live in ../../spec.json; this module loads it.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads((ROOT / "spec.json").read_text(encoding="utf-8"))

FPS = 30
EPS_SCALE = tuple(SPEC["expressions"]["hiddenScale"])  # uniform 0.001

# --------------------------------------------------------------------------------------
# Colours (sRGB hex, sampled from reference/1.webp). Use linear() before writing to
# vertex colours / Blender materials.
# --------------------------------------------------------------------------------------
COLORS = {
    "fur": "#F6E9DC",          # body cream
    "fur_white": "#FBF5F0",    # face mask / muzzle / head-top highlight
    "fur_shadow": "#EBD8C9",   # very subtle darker cream (inner thighs, under-chin), optional
    "orange": "#F07E3E",       # inner ear, feet, paw tips (saturated end of gradients)
    "orange_light": "#F9B07A", # light end of orange gradients
    "tail_tip": "#F2904F",
    "sole": "#F6A06A",         # foot soles: lighter than the toes (they face away from the key light)
    "sole_pad": "#F08852",     # paw pads (main pad + toe beans), a touch deeper
    "blush": "#F8A994",
    "scarf": "#E86F3E",
    "scarf_square": "#FBF3EC",
    "eye": "#2E1B14",
    "nose": "#3A2119",
    "line": "#3A2119",
    "mouth_inside": "#8E3B35",
    "tongue": "#F08C8C",
    "logo_cube": "#F4E2CE",
    "logo_star": "#F58D4E",
    "background": "#ECEAE9",
}


def hex_to_srgb(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float64)


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear(name_or_hex: str) -> np.ndarray:
    """Linear RGB (3,) for a COLORS key or a hex string."""
    h = COLORS.get(name_or_hex, name_or_hex)
    return srgb_to_linear(hex_to_srgb(h))


# --------------------------------------------------------------------------------------
# Proportions (metres-ish, Blender space). Modeling code reads these; tweak here.
# --------------------------------------------------------------------------------------
P = {
    # head (big, wide ellipsoid; pivot is low at neck centre)
    "head_center": (0.0, 0.0, 0.628),
    "head_radii": (0.255, 0.215, 0.215),     # half width (x), half depth (y), half height (z)
    "chin_z": 0.415,
    "head_top_z": 0.845,
    # ears: base centre on head top-side, tip position; thickness
    "ear_base": (0.150, 0.016, 0.800),      # on top of the dome, not out at the corners
    "ear_tip": (0.276, 0.040, 1.056),       # ~26 deg out from vertical, like the art
    "ear_base_width": 0.288,                # big broad leaf-shaped ears (w/h ~1.0)
    # face anchors (x, z); y is projected onto the head surface at build time
    "eye_xz": (0.130, 0.582),                 # big, wide-set, low on the face (chibi)
    "eye_size": (0.073, 0.087),               # width, height of the open eye
    "brow_xz": (0.132, 0.662),
    "nose_xz": (0.0, 0.558),
    "mouth_xz": (0.0, 0.527),
    "blush_xz": (0.188, 0.534),
    # body (pear)
    "body_bottom_z": 0.075,
    "body_top_z": 0.47,
    "body_max_radius": (0.190, 0.165),       # x, y at widest (z ~ 0.20)
    "body_widest_z": 0.20,
    "body_top_radius": (0.115, 0.105),
    # neck / scarf
    "scarf_z": 0.405,
    "scarf_ring_radius": 0.128,              # centre-line radius of the ring
    "scarf_tube_radius": (0.056, 0.050),     # vertical, radial half-thickness (chunky knit)
    # limbs
    "arm_radius": 0.049,                     # half-width at the shoulder (widens to the paw)
    "paw_radius": 0.057,                     # half-width of the paw, the widest part
    "leg_radius": 0.073,
    "foot_size": (0.138, 0.146, 0.096),      # x width, y length, z height
    # tail (see TAIL_SPLINE); radius profile over normalised arc length t in [0,1]
    "tail_radius_profile": [(0.0, 0.050), (0.10, 0.095), (0.30, 0.152), (0.52, 0.156),
                            (0.72, 0.124), (0.86, 0.080), (0.95, 0.040), (1.0, 0.0)],
    "tail_flatten": 0.92,                    # cross-section squash (lateral)
    "tail_orange_from": 0.68,                # t where the orange tip gradient starts
}

# Tail centre-line (cubic Catmull-Rom through these points). Root sits inside the butt on
# the mid-line; the tail sweeps back and out to the fox's LEFT (+X), rises beside the body so
# it frames it from the front / front-right (like the art), tip curling forward and in.
TAIL_SPLINE = [                        # bends gently near the root (the thick tube must not fold)
    (0.000, 0.105, 0.170),
    (0.036, 0.240, 0.160),
    (0.118, 0.342, 0.240),
    (0.200, 0.362, 0.395),
    (0.218, 0.312, 0.535),
    (0.186, 0.246, 0.606),
]

# --------------------------------------------------------------------------------------
# Skeleton: name -> (parent, head, tail). Rest pose = A-pose (arms ~40deg out).
# Expression bones point straight up so bone-local Y == world vertical.
# --------------------------------------------------------------------------------------
_A = math.radians(40.0)
_ARM_DIR = (math.sin(_A), 0.0, -math.cos(_A))
SHOULDER = (0.124, -0.022, 0.334)      # upperArm pivot (fox's left): body side, under the scarf
LEG_X = 0.088                          # thick legs a little apart: a clear rounded notch between
ARM_LEN = (0.083, 0.069, 0.055)        # upperArm, forearm, paw: short stubs like the art
PAW_OFFSET = 0.034                     # wrist -> paw centre along the arm


def _along(p, d, length):
    return tuple(p[i] + d[i] * length for i in range(3))


def _tail_points(n_bones: int = 6):
    from .spline import Spline  # local import to avoid cycles
    sp = Spline(TAIL_SPLINE)
    ts = np.linspace(0.0, 1.0, n_bones + 1)
    return [tuple(sp.point_at_arclength(t)) for t in ts]


def paw_frame(side="L"):
    """Rest-pose paw frame (bind pose). x = across the paw (medial), y = along the arm,
    z = back of the hand (front of the fox at rest), palm = -z.
    The right paw's frame is the exact mirror (x -> -x) of the left one."""
    if side == "R":
        m = np.array([-1.0, 1.0, 1.0])
        return {k: (v * m if isinstance(v, np.ndarray) else v) for k, v in paw_frame("L").items()}
    up = np.array(SHOULDER)
    ax = np.array(_ARM_DIR)
    wr = up + ax * (ARM_LEN[0] + ARM_LEN[1])
    pc = wr + ax * PAW_OFFSET
    x = np.cross(ax, (0.0, -1.0, 0.0)); x /= np.linalg.norm(x)
    z = np.cross(x, ax)
    return {"centre": pc, "x": x, "y": ax, "z": z}


def bone_table() -> dict:
    """Ordered dict name -> (parent, head, tail) in Blender space."""
    b = {}
    b["root"] = (None, (0, 0, 0), (0, 0, 0.08))
    b["hips"] = ("root", (0, 0.0, 0.17), (0, 0.0, 0.26))
    b["spine"] = ("hips", (0, 0.0, 0.26), (0, 0.0, 0.34))
    b["breath"] = ("spine", (0, -0.02, 0.24), (0, -0.02, 0.31))
    b["chest"] = ("spine", (0, 0.0, 0.34), (0, 0.0, 0.42))
    b["neck"] = ("chest", (0, 0.0, 0.42), (0, 0.0, 0.47))
    b["head"] = ("neck", (0, 0.0, 0.47), (0, 0.0, 0.76))
    for s, sx in (("L", 1), ("R", -1)):
        eb = P["ear_base"]; et = P["ear_tip"]
        base = (sx * eb[0], eb[1], eb[2]); tip = (sx * et[0], et[1], et[2])
        mid = tuple(base[i] + 0.5 * (tip[i] - base[i]) for i in range(3))
        b[f"ear_{s}"] = ("head", base, mid)
        b[f"earTip_{s}"] = (f"ear_{s}", mid, tip)
    # expression bones (y is refined at build time; only x/z matter for the scale pivot)
    ex, ez = P["eye_xz"]; bx, bz = P["brow_xz"]
    for s, sx in (("L", 1), ("R", -1)):
        for kind in ("eyeOpen", "eyeHappy", "eyeSleep"):
            b[f"{kind}_{s}"] = ("head", (sx * ex, -0.19, ez), (sx * ex, -0.19, ez + 0.05))
        b[f"brow_{s}"] = ("head", (sx * bx, -0.18, bz), (sx * bx, -0.18, bz + 0.04))
    mx, mz = P["mouth_xz"]
    b["mouthSmile"] = ("head", (mx, -0.215, mz), (mx, -0.215, mz + 0.04))
    b["mouthOpen"] = ("head", (mx, -0.215, mz), (mx, -0.215, mz + 0.04))
    for s, sx in (("L", 1), ("R", -1)):
        # shoulder pivot on the body's side surface, just under the scarf ring
        sh = (sx * 0.050, -0.022, 0.352)
        up = (sx * SHOULDER[0], SHOULDER[1], SHOULDER[2])
        d = (sx * _ARM_DIR[0], _ARM_DIR[1], _ARM_DIR[2])
        el = _along(up, d, ARM_LEN[0])
        wr = _along(el, d, ARM_LEN[1])
        tip = _along(wr, d, ARM_LEN[2])
        b[f"shoulder_{s}"] = ("chest", sh, up)
        b[f"upperArm_{s}"] = (f"shoulder_{s}", up, el)
        b[f"forearm_{s}"] = (f"upperArm_{s}", el, wr)
        b[f"paw_{s}"] = (f"forearm_{s}", wr, tip)
    b["scarf"] = ("chest", (0, 0.0, 0.405), (0, 0.0, 0.445))
    from .parametric import flap_bone_points   # the flap follows the body surface
    f0, f1, f2 = flap_bone_points()
    b["scarfFlap_1"] = ("scarf", f0, f1)
    b["scarfFlap_2"] = ("scarfFlap_1", f1, f2)
    for s, sx in (("L", 1), ("R", -1)):
        lx = sx * LEG_X
        b[f"thigh_{s}"] = ("hips", (lx, 0.0, 0.17), (lx, 0.0, 0.105))
        b[f"shin_{s}"] = (f"thigh_{s}", (lx, 0.0, 0.105), (lx, 0.0, 0.045))
        b[f"foot_{s}"] = (f"shin_{s}", (lx, 0.0, 0.045), (lx, -0.075, 0.035))
    pts = _tail_points(6)
    parent = "hips"
    for i in range(6):
        name = f"tail_{i + 1}"
        b[name] = (parent, pts[i], pts[i + 1])
        parent = name
    # keep spec order
    order = [bn["name"] for bn in SPEC["bones"]]
    assert set(order) == set(b), (set(order) ^ set(b))
    return {n: b[n] for n in order}


DEFORM_BONES = [bn["name"] for bn in SPEC["bones"] if bn["kind"] == "deform"]
EXPRESSION_BONES = [bn["name"] for bn in SPEC["bones"] if bn["kind"] == "expression"]
CLIP_NAMES = [c["name"] for c in SPEC["clips"]]

# Budgets
BUDGET = {
    "fox_triangles": 90_000,
    "glb_bytes_raw": 8_000_000,
    "max_influences": 4,
}

# Output paths
OUT_GLB = ROOT / "web" / "public" / "models" / "fox.glb"          # meshopt-compressed
RAW_GLB = ROOT / "build" / "fox.raw.glb"                           # uncompressed (validation)
OUT_LOGO_GLB = ROOT / "web" / "public" / "models" / "logo.glb"
OUT_BLEND = ROOT / "models" / "fox.blend"
OUT_CLIPS_JSON = ROOT / "web" / "public" / "models" / "clips.json"
BUILD_DIR = ROOT / "build"
