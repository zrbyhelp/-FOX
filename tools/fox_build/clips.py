"""All animation clips (spec.json "clips"), authored as key poses + procedural overlays.

Each clip = keys [(t_sec, Pose)] eased with smootherstep, plus an optional overlay
f(t, pose) for cyclic motion (breathing, tail sway, waving). Loops are built from periodic
functions so the last frame equals the first. Poses are grounded (lowest body/leg vertex
on the floor) unless the clip is airborne.
"""
from __future__ import annotations

import math

import numpy as np

from . import config as C
from .anim import IDENT, make_action, qeuler, qmirror, qmul, qnorm
from .poses import Pose, Rig, Skin, aim_bone, arm_ik, blend, ground, qrot, vis_of

FPS = C.FPS
STEP = 2  # key every 2 frames; the exporter samples every frame

LOGO_B = np.array([-0.56, -0.20, 0.50])  # spec.logo (glTF -> Blender: (x, -z, y))


# ------------------------------------------------------------------ helpers
def smoother(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * t * (t * (t * 6 - 15) + 10)


def in_chest(rig, pose, p_rest):
    """Rest-space point expressed in the posed chest frame -> world."""
    Qw, Hw = rig.fk(pose)
    return Hw["chest"] + qrot(Qw["chest"], np.asarray(p_rest, float) - rig.head["chest"])


def dir_chest(rig, pose, d):
    Qw, _ = rig.fk(pose)
    return qrot(Qw["chest"], np.asarray(d, float))


def paw_to(rig, pose, side, wrist, aim=None, pole=None, twist=0.0, space="chest"):
    """IK a paw: wrist target (+ paw aim direction), both given in rest space and carried by
    the posed chest (space='chest') or in world space (space='world')."""
    if space == "chest":
        wrist = in_chest(rig, pose, wrist)
        aim = dir_chest(rig, pose, aim) if aim is not None else None
        pole = dir_chest(rig, pose, pole) if pole is not None else None
    arm_ik(rig, pose, side, wrist, pole=pole, twist=twist)
    if aim is not None:
        aim_bone(rig, pose, f"paw_{side}", np.asarray(aim, float))
    return pose


def tail_curve(pose, x=0.0, z=0.0, falloff=1.0, start=1):
    for i in range(start, 7):
        k = falloff ** (i - start)
        pose.add(f"tail_{i}", x=x * k, z=z * k)
    return pose


def mirror_pose_arms(pose):
    for b in ("shoulder", "upperArm", "forearm", "paw"):
        if f"{b}_L" in pose.rot:
            pose.rot[f"{b}_R"] = qmirror(pose.rot[f"{b}_L"])
    return pose


# ------------------------------------------------------------------ key poses
class Lib:
    def __init__(self, rig: Rig):
        self.rig = rig

    def base(self):
        return Pose()

    def stand(self):
        """Neutral standing pose: paws held loosely in front of the chest."""
        p = Pose()
        p.set("ear_L", y=-4, mirror=True)
        for s, sx in (("L", 1), ("R", -1)):
            paw_to(self.rig, p, s, (sx * 0.088, -0.168, 0.292), aim=(sx * -0.25, -0.35, -1.0),
                   pole=(sx * 1.0, 0.3, -0.8))
        return p

    def clasp(self, p=None):
        """Ref 1: paws together at the chest pointing up."""
        p = p or Pose()
        for s, sx in (("L", 1), ("R", -1)):
            paw_to(self.rig, p, s, (sx * 0.046, -0.180, 0.322), aim=(sx * -0.25, -0.35, 1.0),
                   pole=(sx * 1.0, 0.2, -1.0))
        return p

    def heart(self, p=None):
        """Ref 7: paws form a heart at the chest (tips meet low in the middle)."""
        p = p or Pose()
        for s, sx in (("L", 1), ("R", -1)):
            paw_to(self.rig, p, s, (sx * 0.062, -0.190, 0.322), aim=(sx * -0.75, -0.25, -0.55),
                   pole=(sx * 1.0, 0.3, -0.6))
        return p

    def paw_chest(self, p, side, low=False):
        sx = 1 if side == "L" else -1
        if low:   # resting on the belly, elbow only lightly bent
            return paw_to(self.rig, p, side, (sx * 0.088, -0.178, 0.268), aim=(sx * -0.55, -0.45, 0.2),
                          pole=(sx * 1.0, 0.3, -1.0))
        return paw_to(self.rig, p, side, (sx * 0.060, -0.180, 0.300), aim=(sx * -0.35, -0.4, 0.9),
                      pole=(sx * 1.0, 0.3, -1.0))

    def wave_up(self, p, side="L", swing=0.0):
        sx = 1 if side == "L" else -1
        paw_to(self.rig, p, side, (sx * 0.200, -0.105, 0.500), aim=(sx * (0.25 + swing), -0.25, 1.0),
               pole=(sx * 1.0, 0.4, -0.6))
        return p

    def present(self, p, side="R"):
        sx = 1 if side == "L" else -1
        return paw_to(self.rig, p, side, (sx * 0.245, -0.150, 0.340), aim=(sx * 1.0, -0.55, 0.25),
                      pole=(sx * 0.6, 0.6, -1.0), twist=-70)

    def reach(self, p, side="R"):
        sx = 1 if side == "L" else -1
        return paw_to(self.rig, p, side, (sx * 0.215, -0.170, 0.505), aim=(sx * 0.55, -0.45, 1.0),
                      pole=(sx * 1.0, 0.5, -0.4), space="chest")

    def shrug(self, p):
        for s, sx in (("L", 1), ("R", -1)):
            paw_to(self.rig, p, s, (sx * 0.225, -0.135, 0.325), aim=(sx * 1.0, -0.5, 0.35),
                   pole=(sx * 0.5, 0.6, -1.0), twist=-65)
        p.set("shoulder_L", y=-9, mirror=True)
        return p

    def sit(self, p=None, lean=0.0):
        """Sitting on the floor, legs forward (soles to the camera), tail curled to the left."""
        p = p or Pose()
        p.set("hips", x=-10)
        p.set("spine", x=7 + lean)
        p.set("chest", x=4)
        for s in ("L", "R"):
            sx = 1 if s == "L" else -1
            p.set(f"thigh_{s}", x=-50, z=sx * 12)
            p.set(f"shin_{s}", x=-16)
            p.set(f"foot_{s}", x=-30)
        p.set("tail_1", x=-30, z=-10)
        tail_curve(p, x=-4, z=-24, start=2, falloff=0.95)
        return p

    def stand_legs(self, p):
        return p


# ------------------------------------------------------------------ clip builder
class Clip:
    def __init__(self, name, duration, keys, overlay=None, loop=False, grounded=True, meta=None):
        self.name = name; self.duration = duration; self.keys = keys
        self.overlay = overlay; self.loop = loop; self.grounded = grounded
        self.meta = meta or {}

    def pose_at(self, t):
        ks = self.keys
        if t <= ks[0][0]:
            p = ks[0][1].copy()
        elif t >= ks[-1][0]:
            p = ks[-1][1].copy()
        else:
            for (t0, a), (t1, b) in zip(ks[:-1], ks[1:]):
                if t0 <= t <= t1:
                    p = blend(a, b, smoother((t - t0) / (t1 - t0)))
                    break
        if self.overlay:
            self.overlay(t, p)
        return p


def lift_tail(tail_skin: Skin, pose: Pose, clearance=0.003, step=2.0, max_steps=40):
    """Pitch tail_1 up until the whole tail clears the floor."""
    for _ in range(max_steps):
        if tail_skin.deform(pose)[:, 2].min() >= clearance:
            break
        pose.add("tail_1", x=step)
    return pose


def finalize(clip: Clip, pose: Pose, ground_skin: Skin | None, tail_skin: Skin | None):
    if clip.grounded and ground_skin is not None:
        ground(ground_skin, pose)
    if tail_skin is not None:
        lift_tail(tail_skin, pose)
    return pose


def to_keys(clip: Clip, skin: Skin, tail_skin: Skin | None = None):
    frames = int(round(clip.duration * FPS))
    out = []
    for f in list(range(0, frames, STEP)) + [frames]:
        p = finalize(clip, clip.pose_at(f / FPS), skin, tail_skin)
        vis = vis_of(p)
        spec = {}
        for b, q in p.rot.items():
            spec.setdefault(b, {})["rot"] = q
        for b, l in p.loc.items():
            spec.setdefault(b, {})["loc"] = l
        for b, s in p.scale.items():
            spec.setdefault(b, {})["scale"] = s
        for b, v in vis.items():
            s = 0.001 + (1 - 0.001) * v
            spec.setdefault(b, {})["scale"] = (s, s, s)
        out.append((f + 1, spec))
    return out


# ------------------------------------------------------------------ overlays
def breathe(t, p, rate=0.25, amt=1.0):
    ph = 2 * math.pi * rate * t
    s = 1.0 + 0.022 * amt * math.sin(ph)
    p.scale["breath"] = (s, s, s)
    p.add("chest", x=-1.2 * amt * math.sin(ph))
    p.add("head", x=0.8 * amt * math.sin(ph - 0.6))


def tail_sway(t, p, rate=0.25, amp=7.0, lag=0.55):
    for i in range(1, 7):
        p.add(f"tail_{i}", z=amp * (0.5 + 0.12 * i) * math.sin(2 * math.pi * rate * t - lag * i))


def tail_wag(t, p, rate=2.2, amp=16.0):
    for i in range(2, 7):
        p.add(f"tail_{i}", z=amp * (0.45 + 0.1 * i) * math.sin(2 * math.pi * rate * t - 0.5 * i))


# ------------------------------------------------------------------ clip set
def make_clips(rig: Rig):
    L = Lib(rig)
    stand = L.stand()
    clips = []

    # Idle (loop 4s)
    def idle_ov(t, p):
        ph = 2 * math.pi * t / 4.0
        breathe(t, p, rate=0.5)
        p.add("spine", y=1.5 * math.sin(ph))
        p.add("chest", y=1.0 * math.sin(ph - 0.5))
        p.add("head", y=-2.0 * math.sin(ph - 0.9), z=2.5 * math.sin(ph * 0.5 * 2 - 0.3))
        p.add("ear_L", y=-2.5 * math.sin(ph * 2)); p.add("ear_R", y=2.5 * math.sin(ph * 2 + 0.4))
        tail_sway(t, p, rate=0.25 * 2)
    clips.append(Clip("Idle", 4.0, [(0, stand)], idle_ov, loop=True,
                      meta=dict(priority=0, lookAt=1.0)))

    # Idle_LookAround
    la = [(0, stand)]
    for t, z, x in ((0.6, 32, -4), (1.6, 32, -4), (2.3, -30, 2), (3.3, -30, 2), (4.0, 0, 0)):
        p = stand.copy(); p.add("neck", z=z * 0.35, x=x * 0.3); p.add("head", z=z * 0.65, x=x * 0.7, y=z * 0.12)
        la.append((t, p))
    def la_ov(t, p):
        breathe(t, p, rate=0.5)
        tail_sway(t, p, rate=0.5)
        tw = math.exp(-((t - 1.9) / 0.08) ** 2)
        p.add("earTip_L", x=-25 * tw)
    clips.append(Clip("Idle_LookAround", 4.0, la, la_ov, meta=dict(priority=1, lookAt=0.0)))

    # Wave (ref 2)
    w0 = stand.copy()
    w1 = L.wave_up(L.paw_chest(stand.copy(), "R"), "L")
    w1.add("head", y=-7, z=4).add("chest", y=-3).expression(mouth="open")
    def wave_ov(t, p):
        env = smoother((t - 0.35) / 0.25) * (1 - smoother((t - 2.05) / 0.3))
        sw = math.sin(2 * math.pi * 2.2 * (t - 0.35))
        p.add("forearm_L", y=-14 * env * sw)
        p.add("paw_L", y=-18 * env * math.sin(2 * math.pi * 2.2 * (t - 0.35) - 0.6))
        p.loc["hips"] = np.array([0, 0, 0.012 * env * abs(math.sin(math.pi * 2.2 * (t - 0.35)))])
        breathe(t, p, rate=0.5, amt=0.5)
        tail_wag(t, p, rate=1.6, amp=10 * env)
    clips.append(Clip("Wave", 2.7, [(0, w0), (0.35, w1), (2.1, w1), (2.7, w0)], wave_ov,
                      meta=dict(priority=2, lookAt=0.4, refTime=0.95)))

    # Happy (ref 1): clasp, ^^, sway, tiptoe bounce
    h1 = L.clasp(stand.copy()).expression(eyes="happy")
    h1.add("head", y=8, x=-3)
    def happy_ov(t, p):
        env = smoother(t / 0.3) * (1 - smoother((t - 1.9) / 0.3))
        p.add("head", y=-10 * env * math.sin(2 * math.pi * 0.9 * (t - 0.3)))
        p.add("chest", y=-3 * env * math.sin(2 * math.pi * 0.9 * (t - 0.3)))
        p.loc["hips"] = np.array([0, 0, 0.014 * env * abs(math.sin(2 * math.pi * 0.9 * (t - 0.3)))])
        tail_wag(t, p, rate=2.0, amp=14 * env)
        breathe(t, p, rate=0.5, amt=0.4)
    clips.append(Clip("Happy", 2.2, [(0, stand), (0.3, h1), (1.9, h1), (2.2, stand)], happy_ov,
                      meta=dict(priority=2, lookAt=0.6, refTime=1.0)))

    # Heart (ref 7)
    hh = L.heart(stand.copy()).expression(eyes="happy")
    hh.add("spine", x=4).add("head", y=-8, x=4)
    def heart_ov(t, p):
        env = smoother((t - 0.3) / 0.3) * (1 - smoother((t - 2.2) / 0.3))
        p.add("chest", y=2.5 * env * math.sin(2 * math.pi * 1.2 * t))
        tail_wag(t, p, rate=1.8, amp=12 * env)
        breathe(t, p, rate=0.5, amt=0.4)
    clips.append(Clip("Heart", 2.6, [(0, stand), (0.35, hh), (2.2, hh), (2.6, stand)], heart_ov,
                      meta=dict(priority=2, lookAt=0.5, refTime=1.2)))

    # Present (ref 3): right paw (viewer's left) palm-up toward the logo
    pr = L.present(L.paw_chest(stand.copy(), "L"), "R")
    pr.add("chest", z=-6).add("head", z=-12, y=-6, x=-2)
    clips.append(Clip("Present", 2.5, [(0, stand), (0.4, pr), (2.0, pr), (2.5, stand)],
                      lambda t, p: (breathe(t, p, 0.5, 0.5), tail_sway(t, p, 0.5)),
                      meta=dict(priority=2, lookAt=0.3, refTime=1.2, lookAtLogo=True)))

    # Reach (ref 5): tiptoe reach up toward the logo
    rc = L.reach(L.paw_chest(stand.copy(), "L"), "R")
    rc.add("spine", y=-5).add("chest", y=-4, z=-6).add("neck", x=-6).add("head", z=-14, x=-8, y=-4)
    rc.loc["root"] = np.array([0, 0, 0.0])
    for s in ("L", "R"):
        rc.set(f"foot_{s}", x=18)
    def reach_ov(t, p):
        env = smoother((t - 0.35) / 0.3) * (1 - smoother((t - 1.9) / 0.35))
        p.add("forearm_R", y=4 * env * math.sin(2 * math.pi * 1.5 * t))
        breathe(t, p, 0.5, 0.5)
        tail_wag(t, p, rate=1.2, amp=8 * env)
    clips.append(Clip("Reach", 2.5, [(0, stand), (0.45, rc), (1.9, rc), (2.5, stand)], reach_ov,
                      meta=dict(priority=2, lookAt=0.3, refTime=1.2, lookAtLogo=True)))

    # Shrug (ref 6)
    sh = L.shrug(stand.copy()).expression(brows="both")
    sh.add("head", y=9, x=-3).add("neck", y=3)
    clips.append(Clip("Shrug", 2.3, [(0, stand), (0.35, sh), (1.8, sh), (2.3, stand)],
                      lambda t, p: (breathe(t, p, 0.5, 0.5), tail_sway(t, p, 0.5)),
                      meta=dict(priority=2, lookAt=0.6, refTime=1.0)))

    # Sitting family (ref 4 / ref 8)
    think = L.sit()
    L.paw_chest(think, "L", low=True)
    paw_to(rig, think, "R", (-0.058, -0.198, 0.362), aim=(0.40, -0.30, 1.0), pole=(-1.0, 0.4, -0.8))
    think.add("neck", y=-4).add("head", y=-11, z=-8, x=3).expression(brows="left")
    def think_ov(t, p):
        ph = 2 * math.pi * t / 4.0
        breathe(t, p, rate=0.5, amt=0.8)
        p.add("head", y=-2.5 * math.sin(ph))
        p.add("tail_5", z=5 * math.sin(ph)); p.add("tail_6", z=7 * math.sin(ph - 0.5))
    clips.append(Clip("Sit_Think", 4.0, [(0, think)], think_ov, loop=True,
                      meta=dict(priority=1, lookAt=0.5, refTime=1.0)))

    doze = L.sit(lean=4)
    L.paw_chest(doze, "L", low=True)
    paw_to(rig, doze, "R", (-0.075, -0.192, 0.362), aim=(0.30, -0.25, 1.0), pole=(-1.0, 0.4, -0.8))
    doze.add("neck", x=6, y=-4).add("head", x=10, y=-12, z=-5).expression(eyes="sleep")
    doze.set("ear_L", x=-12, y=6); doze.set("ear_R", x=-12, y=-6)
    def doze_ov(t, p):
        ph = 2 * math.pi * t / 4.0
        breathe(t, p, rate=0.25, amt=1.3)
        p.add("head", x=3.5 * math.sin(ph), y=-1.5 * math.sin(ph))
    clips.append(Clip("Sit_Doze", 4.0, [(0, doze)], doze_ov, loop=True,
                      meta=dict(priority=1, lookAt=0.0, blink=0.0, refTime=1.0)))

    squat = stand.copy(); squat.set("hips", x=10).add("spine", x=6)
    for s in ("L", "R"):
        squat.set(f"thigh_{s}", x=-40); squat.set(f"shin_{s}", x=45); squat.set(f"foot_{s}", x=-5)
    clips.append(Clip("SitDown", 1.1, [(0, stand), (0.45, squat), (0.85, think), (1.1, think)],
                      lambda t, p: breathe(t, p, 0.5, 0.3), meta=dict(priority=3, interruptible=False)))
    clips.append(Clip("StandUp", 1.0, [(0, think), (0.35, squat), (0.8, stand), (1.0, stand)],
                      lambda t, p: breathe(t, p, 0.5, 0.3), meta=dict(priority=3, interruptible=False)))

    # Jump (airborne: not grounded; hand-set root heights)
    j_sq = squat.copy()
    for s, sx in (("L", 1), ("R", -1)):
        paw_to(rig, j_sq, s, (sx * 0.16, -0.08, 0.25), aim=(sx * 0.3, 0.3, -1.0), pole=(sx, 0.3, -0.5))
    j_up = stand.copy()
    for s, sx in (("L", 1), ("R", -1)):
        paw_to(rig, j_up, s, (sx * 0.19, -0.11, 0.52), aim=(sx * 0.4, -0.2, 1.0), pole=(sx, 0.4, -0.5))
        j_up.set(f"thigh_{s}", x=-25); j_up.set(f"shin_{s}", x=35); j_up.set(f"foot_{s}", x=10)
    j_up.expression(eyes="happy", mouth="open").add("head", x=-6)
    j_up.set("ear_L", x=-18, mirror=False); j_up.set("ear_R", x=-18)
    tail_curve(j_up, x=18, start=2, falloff=0.9)
    j_land = squat.copy(); j_land.expression(eyes="happy")
    def jump_root(t):
        # squat (0-0.25) -> airborne peak 0.14 at 0.5 -> land 0.75 -> settle
        if t < 0.25:
            return -0.03 * smoother(t / 0.25)
        if t < 0.75:
            u = (t - 0.25) / 0.5
            return -0.03 + (0.17 * 4 * u * (1 - u)) + 0.03 * u
        if t < 0.95:
            return -0.028 * math.sin(math.pi * (t - 0.75) / 0.2)
        return 0.0
    def jump_ov(t, p):
        p.loc["root"] = np.array([0, 0, jump_root(t)])
        sq = 0.0
        if 0.75 <= t < 1.0:
            sq = math.sin(math.pi * (t - 0.75) / 0.25)
        if t < 0.25:
            sq = 0.6 * smoother(t / 0.25)
        p.scale["root"] = (1 + 0.06 * sq, 1 + 0.06 * sq, 1 - 0.07 * sq)
    clips.append(Clip("Jump", 1.35, [(0, stand), (0.25, j_sq), (0.5, j_up), (0.78, j_land), (1.35, stand)],
                      jump_ov, grounded=False, meta=dict(priority=3, lookAt=0.3)))

    # Pet (loop): leaning into the hand, eyes ^^, ears back, tail wagging
    pet = L.clasp(stand.copy()).expression(eyes="happy")
    pet.set("ear_L", x=-22, y=8); pet.set("ear_R", x=-22, y=-8)
    def pet_ov(t, p):
        ph = 2 * math.pi * t / 1.6
        p.add("neck", y=4 * math.sin(ph)); p.add("head", y=10 * math.sin(ph), x=3 + 2 * math.sin(2 * ph), z=4 * math.sin(ph))
        p.add("chest", y=2 * math.sin(ph))
        tail_wag(t, p, rate=2.5, amp=18)
        breathe(t, p, rate=1.25, amt=0.6)
    clips.append(Clip("Pet", 1.6, [(0, pet)], pet_ov, loop=True, meta=dict(priority=2, lookAt=0.0)))

    # LookBack: turn toward the tail (fox's left/back), tail swish
    lb = stand.copy()
    lb.add("spine", z=14).add("chest", z=16).add("neck", z=14).add("head", z=26, x=4, y=6)
    def lb_ov(t, p):
        env = smoother((t - 0.3) / 0.3) * (1 - smoother((t - 1.9) / 0.4))
        for i in range(2, 7):
            p.add(f"tail_{i}", z=-20 * env * (0.4 + 0.12 * i) * math.sin(2 * math.pi * 1.4 * t - 0.6 * i),
                  x=6 * env)
        breathe(t, p, 0.5, 0.5)
    clips.append(Clip("LookBack", 2.4, [(0, stand), (0.45, lb), (1.9, lb), (2.4, stand)], lb_ov,
                      meta=dict(priority=2, lookAt=0.0)))

    return clips


def build_clips(bpy, arm, parts=None, bone_table=None):
    rig = Rig(bone_table)
    skin = Skin(rig, parts, names={"Body", "Leg_L", "Leg_R"}, stride=3) if parts else None
    tail = Skin(rig, parts, names={"Tail"}, stride=2) if parts else None
    meta = {}
    for c in make_clips(rig):
        if skin is None:
            c.grounded = False
        keys = to_keys(c, skin, tail)
        make_action(bpy, arm, c.name, keys, loop=c.loop)
        m = dict(loop=c.loop, duration=round(c.duration, 4), priority=1, interruptible=True,
                 lookAt=1.0, blink=1.0, springs=1.0)
        m.update(c.meta)
        meta[c.name] = m
    missing = set(C.CLIP_NAMES) - set(meta)
    assert not missing, missing
    return meta
