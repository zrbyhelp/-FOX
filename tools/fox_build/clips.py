"""All animation clips (spec.json "clips"), authored as key poses + procedural overlays.

Each clip = keys [(t_sec, Pose)] eased with smootherstep, plus an optional overlay
f(t, pose) for cyclic motion (breathing, tail sway, waving). Loops are built from periodic
functions so the last frame equals the first. Poses are grounded (lowest body/leg vertex
on the floor) unless the clip is airborne.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from . import config as C
from .anim import IDENT, make_action, qeuler, qmirror, qmul, qnorm
from .poses import ArmSolver, Pose, Rig, Skin, _q2m, aim_bone, arm_ik, blend, ground, qrot, vis_of

FPS = C.FPS
STEP = 1  # key every frame (linear interpolation) -> no spline overshoot between keys

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


# ------------------------------------------------------------------ arm solver (+ cache)
_SOLVER = {}


def get_solver(rig: Rig):
    key = id(rig)
    if key not in _SOLVER:
        from . import model, shapes
        parts = {p.name: p for p in model.build_parts() if p.name in ("Arm_L", "Arm_R")}
        _SOLVER[key] = ArmSolver(rig, {"L": parts["Arm_L"], "R": parts["Arm_R"]},
                                 shapes.body_sdf, shapes.head_sdf)
    return _SOLVER[key]


class _SolveCache:
    """Solutions keyed by the inputs + the source of everything that shapes the arms/body."""
    def __init__(self):
        import hashlib, json
        from . import model
        here = Path(__file__).resolve().parent
        h = hashlib.sha1()
        for f in ("shapes.py", "poses.py", "sdf.py"):
            h.update((here / f).read_bytes())
        h.update(repr(sorted(C.P.items())).encode())
        h.update(repr(list(C.bone_table().items())).encode())
        self.salt = h.hexdigest()[:12]
        self.path = C.BUILD_DIR / "cache" / "arm_solutions.json"
        try:
            self.data = json.loads(self.path.read_text())
        except Exception:  # noqa: BLE001
            self.data = {}
        self.dirty = False
        import atexit
        atexit.register(self.save)   # QA tools build clips without going through build_clips

    def key(self, pose, side, target, aim, extra):
        parts = [self.salt, side, np.round(target, 4).tolist(), None if aim is None else np.round(aim, 3).tolist(), extra]
        for b in ("root", "hips", "spine", "chest", "neck", "head", f"shoulder_{side}"):
            parts.append(np.round(pose.rot.get(b, np.array([1.0, 0, 0, 0])), 4).tolist())
        return repr(parts)

    def save(self):
        if self.dirty:
            import json
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.data))
            self.dirty = False


_CACHE = None


# ------------------------------------------------------------------ key poses
class Lib:
    def __init__(self, rig: Rig):
        self.rig = rig

    def arm(self, p, side, paw_centre, aim=None, **kw):
        """Place the paw centre (rest space, carried by the posed chest) with the collision-aware
        solver. aim: desired paw direction (rest space)."""
        global _CACHE
        _CACHE = _CACHE or _SolveCache()
        paw_centre = np.asarray(paw_centre, float)
        # the shoulders sit at the body's sides under the scarf; reaching in front of the chest
        # they roll forward (protraction, up to 45 deg) so the short arms still meet there
        sx = 1.0 if side == "L" else -1.0
        fwd = float(np.clip((-paw_centre[1] - 0.10) / 0.12, 0.0, 1.0))
        if fwd > 1e-3:
            p.add(f"shoulder_{side}", z=-sx * 45.0 * fwd)
        # in front of the chest the arms hug it, sinking a little into the soft fur (the root of a
        # side-mounted arm has to cross the chest's curve to bring the paws together)
        kw.setdefault("margin", round(0.004 - 0.012 * fwd, 4))
        # short stubby arms: pull targets beyond a slightly bent arm's reach in along the
        # shoulder -> target line (keeps the pose's direction instead of trading it for aim)
        Qw, Hw = self.rig.fk(p)
        sh = (Hw[f"upperArm_{side}"] - Hw["chest"]) @ _q2m(Qw["chest"]) + self.rig.head["chest"]
        v = paw_centre - sh
        reach = 0.95 * (C.ARM_LEN[0] + C.ARM_LEN[1] + C.PAW_OFFSET)
        if np.linalg.norm(v) > reach:
            paw_centre = sh + v * (reach / np.linalg.norm(v))
        tgt = in_chest(self.rig, p, paw_centre)
        aim_w = dir_chest(self.rig, p, aim) if aim is not None else None
        if kw.get("palm") is not None:
            kw["palm"] = tuple(np.round(dir_chest(self.rig, p, kw["palm"]), 5))
        k = _CACHE.key(p, side, tgt, aim_w, sorted(kw.items()))
        if k in _CACHE.data:
            x = np.array(_CACHE.data[k])
            from .poses import rotvec_q
            p.rot[f"upperArm_{side}"] = rotvec_q(x[0:3]); p.rot[f"forearm_{side}"] = rotvec_q(x[3:6])
            p.rot[f"paw_{side}"] = rotvec_q(x[6:9])
            return p
        _, x, err = get_solver(self.rig).solve(p, side, tgt, aim_w, **kw)
        if err > 0.02:
            print(f"[clips] arm {side} target miss {err * 100:.1f}cm at {np.round(tgt, 3)}")
        _CACHE.data[k] = x.tolist(); _CACHE.dirty = True
        return p

    def base(self):
        return Pose()

    def stand(self):
        """Neutral standing pose: arms hanging at the body's sides, a little behind the belly's
        front, so the scarf is never covered."""
        p = Pose()
        p.set("ear_L", y=-4, mirror=True)
        for s, sx in (("L", 1), ("R", -1)):
            self.arm(p, s, (sx * 0.250, -0.020, 0.200), aim=(sx * 0.15, 0.05, -1.0))
        return p

    def clasp(self, p=None, **kw):
        """Ref 1: paws together at the chest pointing up."""
        p = p or Pose()
        for s, sx in (("L", 1), ("R", -1)):
            # tips down and in, orange ends underneath (ref 1)
            self.arm(p, s, (sx * 0.056, -0.215, 0.300), aim=(sx * -0.45, -0.45, -0.75), **kw)
        return p

    def heart(self, p=None):
        """Ref 7: paws form a heart at the chest (tips meet low in the middle)."""
        p = p or Pose()
        for s, sx in (("L", 1), ("R", -1)):
            # paws meet at the chest, tips touching (the web adds a pink heart that pops out)
            self.arm(p, s, (sx * 0.052, -0.222, 0.296), aim=(sx * -0.62, -0.40, -0.62), palm=(-sx * 0.9, 0.0, 0.2))
        return p

    def paw_chest(self, p, side, low=False):
        sx = 1 if side == "L" else -1
        if low:   # resting on the belly
            return self.arm(p, side, (sx * 0.105, -0.215, 0.228), aim=(sx * -0.55, -0.45, 0.2), margin=-0.002)
        return self.arm(p, side, (sx * 0.055, -0.218, 0.298), aim=(sx * -0.30, -0.30, 1.0))

    def wave_up(self, p, side="L", swing=0.0):
        sx = 1 if side == "L" else -1
        self.arm(p, side, (sx * 0.360, -0.100, 0.440), aim=(sx * (0.30 + swing), -0.25, 1.0), palm=(0.0, -1.0, 0.15))
        return p

    def present(self, p, side="R"):
        sx = 1 if side == "L" else -1
        self.arm(p, side, (sx * 0.285, -0.150, 0.330), aim=(sx * 1.0, -0.50, 0.20), palm=(0.0, -0.2, 1.0))
        return p

    def reach(self, p, side="R"):
        sx = 1 if side == "L" else -1
        self.arm(p, side, (sx * 0.262, -0.205, 0.440), aim=(sx * 0.60, -0.55, 0.8))
        return p

    def shrug(self, p):
        p.set("shoulder_L", y=-9, mirror=True)
        for s, sx in (("L", 1), ("R", -1)):
            self.arm(p, s, (sx * 0.280, -0.140, 0.300), aim=(sx * 1.0, -0.40, 0.30), palm=(0.0, -0.2, 1.0))
        return p

    def sit(self, p=None, lean=0.0):
        """Sitting on the floor, legs forward in a little V (soles to the camera), tail curled to
        the left. The legs are short and the belly is round: the pelvis rolls back a little and the
        legs spread so the feet rest low beside / below the belly instead of pushing into it."""
        p = p or Pose()
        p.set("hips", x=-8)
        p.set("spine", x=11 + lean)                        # the upper body stays as upright as before
        p.set("chest", x=4)
        for s in ("L", "R"):
            sx = 1 if s == "L" else -1
            p.set(f"thigh_{s}", x=-45, z=sx * 28)
            p.set(f"shin_{s}", x=-10)
            p.set(f"foot_{s}", x=-10)
        p.set("tail_1", x=0, z=15)                         # lying on the floor beside the fox
        tail_curve(p, x=-10, z=0, start=2, falloff=0.95)
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


def tail_lift_needed(tail_skin: Skin, pose: Pose, clearance=0.004):
    """Smallest tail_1 pitch-up (deg) that makes the whole tail clear the floor (bisection)."""
    if tail_skin.deform(pose)[:, 2].min() >= clearance:
        return 0.0
    lo, hi = 0.0, 90.0
    for _ in range(12):
        mid = 0.5 * (lo + hi)
        q = pose.copy()
        q.add("tail_1", x=mid)
        if tail_skin.deform(q)[:, 2].min() >= clearance:
            hi = mid
        else:
            lo = mid
    return hi


def _smooth(x, sigma, loop, envelope=False):
    """Gaussian smoothing of a per-frame series (circular for loops). envelope=True keeps the
    result >= the input (running max first) so smoothed lifts never under-shoot."""
    x = np.asarray(x, float)
    if len(x) < 3 or sigma <= 0:
        return x
    r = int(3 * sigma)
    pad = (lambda a: np.concatenate([a[-r - 1:-1], a, a[1:r + 1]])) if loop else \
          (lambda a: np.concatenate([np.full(r, a[0]), a, np.full(r, a[-1])]))
    y = pad(x)
    if envelope:
        y = np.array([y[max(0, i - r // 2):i + r // 2 + 1].max() for i in range(len(y))])
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    return np.convolve(y, k, mode="same")[r:-r]


class FlapGuard:
    """Keeps the arms from cutting through the hanging scarf flap. Paws held at the chest put a
    forearm right across the flap, just under the ring, where no forward swing can clear it; the
    flap then tucks behind the forearm (top swung back against the chest, the lower half swung
    out again so its tip still shows below the arm). Arms reaching lower push it forward (drape)
    or outward. Candidates are scored by swing and by how much of the flap sinks into the body.
    Test: posed arm vertices against the flap volume (spheres on its mid-surface), each flap bone
    carrying its own stretch of the flap."""

    ROOT = 0.10        # arm vertices this close to the shoulder pivot sit under the scarf ring
    TOL = 0.006        # knit fabric + fuzz give a little
    HIDDEN = 0.25      # flap length fraction covered by the ring (tube half-height / flap length)
    # (armature-Y swing: negative = outward, scarfFlap_1 pitch: + = back toward the chest,
    #  scarfFlap_2 pitch relative to scarfFlap_1)
    LATS = (0.0,)
    PITCH1 = tuple(float(a) for a in range(-40, 31, 5))
    PITCH2 = (-1.0, -0.5, 0.0)          # x PITCH1: -1 = the lower half hangs straight down again
    STICKY = 12.0                       # cost bonus for keeping the previous frame's answer

    def __init__(self, rig: Rig, parts):
        from scipy.spatial import cKDTree
        from .parametric import scarf_flap_spheres, FLAP_HT
        from . import shapes
        self.rig = rig; self.ht = FLAP_HT; self.body_sdf = shapes.body_sdf
        pts, vp = scarf_flap_spheres()
        seen = vp > self.HIDDEN
        own2 = vp > 0.55                               # scarf_flap_weights: 50/50 at v = 0.55
        self.trees = {"scarfFlap_1": cKDTree(pts[seen & ~own2]), "scarfFlap_2": cKDTree(pts[own2])}
        self.flap_pts = {"scarfFlap_1": pts[seen & ~own2][::3], "scarfFlap_2": pts[own2][::3]}
        byname = {p.name: p for p in parts}
        self.arms = Skin(rig, [byname["Arm_L"], byname["Arm_R"]])   # every vertex (thin flap)

    @staticmethod
    def apply(pose, lat, a1, a2):
        if lat:
            pose.add("scarfFlap_1", y=float(lat))
        if a1:
            pose.add("scarfFlap_1", x=float(a1))
        if a2:
            pose.add("scarfFlap_2", x=float(a2))
        return pose

    def _arm_points(self, pose):
        Qw, Hw = self.rig.fk(pose)
        P = self.arms.deform(pose)
        keep = (np.linalg.norm(P - Hw["upperArm_L"], axis=1) > self.ROOT) & \
               (np.linalg.norm(P - Hw["upperArm_R"], axis=1) > self.ROOT)
        return P[keep]

    def depth(self, pose, P=None):
        from .poses import _qrot_many
        P = self._arm_points(pose) if P is None else P
        Qw, Hw = self.rig.fk(pose)
        worst = 0.0
        for b, tree in self.trees.items():
            q = Qw[b]
            local = _qrot_many(np.array([q[0], -q[1], -q[2], -q[3]]), P - Hw[b]) + self.rig.head[b]
            d, _ = tree.query(local, distance_upper_bound=0.05)
            worst = max(worst, float(np.max(self.ht - d)))
        return max(worst, 0.0)

    def buried(self, pose):
        """Fraction of the visible flap inside the body (chest-relative rest space)."""
        from .poses import _qrot_many
        Qw, Hw = self.rig.fk(pose)
        qc = Qw["chest"]; qc_inv = np.array([qc[0], -qc[1], -qc[2], -qc[3]])
        inside = []; n = 0
        for b, pts in self.flap_pts.items():
            w = _qrot_many(Qw[b], pts - self.rig.head[b]) + Hw[b]
            r = _qrot_many(qc_inv, w - Hw["chest"]) + self.rig.head["chest"]
            inside.append((self.body_sdf(r) < -0.004).sum()); n += len(pts)
        return float(sum(inside)) / max(n, 1)

    def swing_needed(self, pose, prev=None, family=None):
        """(lateral, pitch_1, pitch_2) in degrees; (0, 0, 0) when the arms are clear.
        Coarse grid (10 deg pitch steps), then the 5 deg neighbours of the best candidate;
        `prev` (the previous frame's answer) is kept while it still clears and costs about the
        same, so the flap does not flip between equally good solutions. family: 'tuck' (pitch_1
        >= 0) or 'drape' (<= 0) keeps a whole clip on one side of the arm. Sets self.excess
        (penetration left beyond TOL)."""
        P = self._arm_points(pose)                 # the arms do not move with the flap
        self.excess = 0.0
        if self.depth(pose, P) <= self.TOL:
            return (0.0, 0.0, 0.0)
        pitches = [a for a in self.PITCH1 if family is None or (a >= 0 if family == "tuck" else a <= 0)]
        seen = {}

        def score(lat, a1, k):
            key = (lat, a1, k)
            if key not in seen:
                q = self.apply(pose.copy(), lat, a1, k * a1)
                d = self.depth(q, P)
                c = abs(a1) + 0.5 * abs(k * a1) + 0.7 * abs(lat) + 60.0 * self.buried(q) if d <= self.TOL else None
                seen[key] = (d, c)
            return seen[key]

        coarse = [a for a in pitches if a % 10 == 0]
        for lat in self.LATS:
            for a1 in coarse:
                for k in self.PITCH2:
                    score(lat, a1, k)
        ok = [(v[1], key) for key, v in seen.items() if v[1] is not None]
        if ok:
            lat, a1, k = min(ok)[1]
            for d1 in (-5.0, 5.0):
                if a1 + d1 in pitches:
                    for kk in self.PITCH2:
                        score(lat, a1 + d1, kk)
            ok = [(v[1], key) for key, v in seen.items() if v[1] is not None]
            if prev is not None and prev[1]:
                pk = (prev[0], prev[1], prev[2] / prev[1])
                d, c = score(*pk)
                if c is not None:
                    ok.append((c - self.STICKY, pk))
            lat, a1, k = min(ok)[1]
        else:
            lat, a1, k = min((v[0], key) for key, v in seen.items())[1]
        self.excess = max(0.0, seen[(lat, a1, k)][0] - self.TOL)
        return (lat, a1, k * a1)


def finalize_series(clip: Clip, poses, ground_skin: Skin | None, tail_skin: Skin | None, flap: "FlapGuard | None" = None):
    """Ground the body and keep the tail off the floor for a whole clip, smoothing both
    corrections over time (per-frame solutions alone pop when the support point switches)."""
    loop = clip.loop
    if clip.grounded and ground_skin is not None:
        dz = []
        for p in poses:
            base = p.loc.get("root", np.zeros(3))[2]
            ground(ground_skin, p)
            dz.append(p.loc["root"][2] - base)
            p.loc["root"][2] = base
        dz = _smooth(dz, 1.5, loop)
        for p, d in zip(poses, dz):
            loc = p.loc.get("root", np.zeros(3)).copy(); loc[2] += d; p.loc["root"] = loc
    # hops / bounces ride on top of the grounded pose; smoothing spreads each landing's velocity
    # change over ~4 frames (a parabola's cusp jolts the web's tail chain)
    hops = np.array([getattr(p, "hop", 0.0) for p in poses])
    if hops.any():
        hops = np.maximum(_smooth(hops, 1.3, loop), 0.0)
        for p, h in zip(poses, hops):
            if h > 1e-6:
                loc = p.loc.get("root", np.zeros(3)).copy(); loc[2] += h; p.loc["root"] = loc
    if tail_skin is not None:
        lift = _smooth([tail_lift_needed(tail_skin, p) for p in poses], 2.0, loop, envelope=True)
        for p, a in zip(poses, lift):
            if a > 1e-3:
                p.add("tail_1", x=float(a))
    if flap is not None:   # the flap tucks / drapes / swings aside instead of being cut
        best = None
        for fam in ("tuck", "drape"):   # one side of the arm for the whole clip (no flip-flop)
            sw = []; left = 0.0; cost = 0.0
            for p in poses:
                sw.append(flap.swing_needed(p, sw[-1] if sw else None, family=fam))
                left += flap.excess
                cost += abs(sw[-1][0]) * 0.7 + abs(sw[-1][1]) + abs(sw[-1][2]) * 0.5
            if not any(any(x) for x in sw):
                break                    # nothing touches the flap in this clip
            key = (round(left, 3), cost)
            if best is None or key < best[0]:
                best = (key, sw)
        sw = np.array(best[1] if best else sw)
        cols = []
        for x in sw.T:   # envelope per angle: never less swing than a frame needs (like the tail lift)
            if x.max() > 0 and x.min() < 0:     # both directions within the clip: plain smoothing
                cols.append(_smooth(x, 2.0, loop))
            else:
                sgn = 1.0 if x.max() > 0 else -1.0
                cols.append(sgn * _smooth(np.abs(x), 2.0, loop, envelope=True))
        sw = np.stack(cols, 1)
        # repair: frames still touching after smoothing get a little more pitch (same side)
        sgn = 1.0 if sw[:, 1].sum() >= 0 else -1.0
        extra = np.zeros(len(poses))
        for i, (p, v) in enumerate(zip(poses, sw)):
            if not v.any() and flap.depth(p) <= flap.TOL:
                continue
            e = 0.0
            while e < 20.0 and flap.depth(flap.apply(p.copy(), v[0], v[1] + sgn * e, v[2])) > flap.TOL:
                e += 5.0
            extra[i] = e
        if extra.any():
            sw[:, 1] += sgn * _smooth(extra, 1.5, loop, envelope=True)
        for p, (lat, a1, a2) in zip(poses, sw):
            flap.apply(p, *(v if abs(v) > 1e-3 else 0.0 for v in (lat, a1, a2)))
    return poses


def finalize(clip: Clip, pose: Pose, ground_skin: Skin | None, tail_skin: Skin | None):
    """Single-pose variant (QA tools)."""
    return finalize_series(clip, [pose], ground_skin, tail_skin)[0]


def to_keys(clip: Clip, skin: Skin, tail_skin: Skin | None = None, flap: "FlapGuard | None" = None):
    frames = int(round(clip.duration * FPS))
    fs = list(range(0, frames, STEP)) + [frames]
    poses = finalize_series(clip, [clip.pose_at(f / FPS) for f in fs], skin, tail_skin, flap)
    out = []
    for f, p in zip(fs, poses):
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


def tail_sway(t, p, rate=0.25, amp=13.0, lag=0.6):
    """Slow travelling wave: the tail swings through the centre to both sides."""
    for i in range(1, 7):
        ph = 2 * math.pi * rate * t - lag * i
        p.add(f"tail_{i}", z=amp * (0.55 + 0.1 * i) * math.sin(ph), x=2.5 * math.sin(2 * ph))


def tail_wag(t, p, rate=2.2, amp=26.0):
    """Fast happy wag with a whip-like lag toward the tip."""
    for i in range(1, 7):
        k = 0.35 if i == 1 else 0.45 + 0.1 * i
        p.add(f"tail_{i}", z=amp * k * math.sin(2 * math.pi * rate * t - 0.55 * i))


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
    w1 = stand.copy(); w1.add("head", y=-7, z=4).add("chest", y=-3).expression(mouth="open")
    w1 = L.wave_up(L.paw_chest(w1, "R"), "L")
    def wave_ov(t, p):
        env = smoother((t - 0.45) / 0.3) * (1 - smoother((t - 2.15) / 0.3))
        sw = math.sin(2 * math.pi * 2.0 * (t - 0.45))
        p.add("forearm_L", y=-14 * env * (0.5 * sw - 0.5))
        p.add("paw_L", y=-18 * env * (0.5 * math.sin(2 * math.pi * 2.0 * (t - 0.45) - 0.6) - 0.5))
        p.hop = 0.012 * env * abs(math.sin(math.pi * 2.0 * (t - 0.45)))
        breathe(t, p, rate=0.5, amt=0.5)
        tail_wag(t, p, rate=1.6, amp=18 * env)
    clips.append(Clip("Wave", 2.9, [(0, w0), (0.5, w1), (2.2, w1), (2.9, w0)], wave_ov,
                      meta=dict(priority=2, lookAt=0.4, refTime=0.95)))

    # Happy (ref 1): clasp, ^^, sway, tiptoe bounce
    h1 = stand.copy().expression(eyes="happy"); h1.add("head", y=8, x=-3)
    h1 = L.clasp(h1)
    def happy_ov(t, p):
        env = smoother(t / 0.45) * (1 - smoother((t - 1.95) / 0.45))
        p.add("head", y=-6 * env * math.sin(2 * math.pi * 0.9 * (t - 0.45)))
        p.add("chest", y=-3 * env * math.sin(2 * math.pi * 0.9 * (t - 0.45)))
        p.hop = 0.016 * env * abs(math.sin(2 * math.pi * 0.9 * (t - 0.45)))
        tail_wag(t, p, rate=2.0, amp=24 * env)
        breathe(t, p, rate=0.5, amt=0.4)
    clips.append(Clip("Happy", 2.4, [(0, stand), (0.45, h1), (1.95, h1), (2.4, stand)], happy_ov,
                      meta=dict(priority=2, lookAt=0.6, refTime=1.0)))

    # Heart (ref 7)
    hh = stand.copy().expression(eyes="happy"); hh.add("spine", x=4).add("head", y=-8, x=4)
    hh = L.heart(hh)
    def heart_ov(t, p):
        env = smoother((t - 0.3) / 0.35) * (1 - smoother((t - 2.2) / 0.4))
        p.add("chest", y=2.5 * env * math.sin(2 * math.pi * 1.2 * t))
        tail_wag(t, p, rate=1.8, amp=20 * env)
        breathe(t, p, rate=0.5, amt=0.4)
    clips.append(Clip("Heart", 2.8, [(0, stand), (0.5, hh), (2.25, hh), (2.8, stand)], heart_ov,
                      meta=dict(priority=2, lookAt=0.5, refTime=1.2)))

    # Present (ref 3): right paw (viewer's left) palm-up toward the logo
    pr = stand.copy(); pr.add("chest", z=-6).add("head", z=-12, y=-6, x=-2)
    pr = L.present(L.paw_chest(pr, "L"), "R")
    clips.append(Clip("Present", 2.6, [(0, stand), (0.5, pr), (2.05, pr), (2.6, stand)],
                      lambda t, p: (breathe(t, p, 0.5, 0.5), tail_sway(t, p, 0.5)),
                      meta=dict(priority=2, lookAt=0.3, refTime=1.2, lookAtLogo=True)))

    # Reach (ref 5): tiptoe reach up toward the logo
    rc = stand.copy(); rc.add("spine", y=-5).add("chest", y=-4, z=-6).add("neck", x=-6).add("head", z=-14, x=-8, y=-4)
    rc = L.reach(L.paw_chest(rc, "L"), "R")
    rc.loc["root"] = np.array([0, 0, 0.0])
    for s in ("L", "R"):
        rc.set(f"foot_{s}", x=18)
    def reach_ov(t, p):
        env = smoother((t - 0.35) / 0.3) * (1 - smoother((t - 1.9) / 0.35))
        p.add("forearm_R", y=4 * env * math.sin(2 * math.pi * 1.5 * t))
        breathe(t, p, 0.5, 0.5)
        tail_wag(t, p, rate=1.2, amp=14 * env)
    clips.append(Clip("Reach", 2.6, [(0, stand), (0.5, rc), (1.95, rc), (2.6, stand)], reach_ov,
                      meta=dict(priority=2, lookAt=0.3, refTime=1.2, lookAtLogo=True)))

    # Shrug (ref 6)
    sh = stand.copy().expression(brows="both"); sh.add("head", y=9, x=-3).add("neck", y=3)
    sh = L.shrug(sh)
    clips.append(Clip("Shrug", 2.4, [(0, stand), (0.45, sh), (1.85, sh), (2.4, stand)],
                      lambda t, p: (breathe(t, p, 0.5, 0.5), tail_sway(t, p, 0.5)),
                      meta=dict(priority=2, lookAt=0.6, refTime=1.0)))

    # Sitting family (ref 4 / ref 8)
    think = L.sit()
    think.add("neck", y=-4).add("head", y=-11, z=-8, x=3)
    L.paw_chest(think, "L", low=True)
    L.arm(think, "R", (-0.088, -0.236, 0.346), aim=(0.35, -0.35, 1.0), head_margin=0.002)
    think.expression(brows="left")
    def think_ov(t, p):
        ph = 2 * math.pi * t / 4.0
        breathe(t, p, rate=0.5, amt=0.8)
        p.add("head", y=-2.5 * math.sin(ph))
        p.add("tail_5", z=5 * math.sin(ph)); p.add("tail_6", z=7 * math.sin(ph - 0.5))
    clips.append(Clip("Sit_Think", 4.0, [(0, think)], think_ov, loop=True,
                      meta=dict(priority=1, lookAt=0.5, refTime=1.0)))

    doze = L.sit(lean=2)
    doze.add("neck", x=7, y=-4).add("head", x=12, y=-12, z=-5)
    L.paw_chest(doze, "L", low=True)
    L.arm(doze, "R", (-0.104, -0.236, 0.340), aim=(0.30, -0.30, 1.0), head_margin=0.016,   # room to nod
          margin=0.0)                               # resting on the chest, not sinking into it
    doze.expression(eyes="sleep")
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
    clips.append(Clip("StandUp", 1.0, [(0, think), (0.45, squat), (0.88, stand), (1.0, stand)],
                      lambda t, p: breathe(t, p, 0.5, 0.3), meta=dict(priority=3, interruptible=False)))

    # Jump: grounded crouches, the airborne arc rides on top as a hop
    j_sq = squat.copy()     # arms stay hanging at the sides through the crouch
    j_up = stand.copy()
    for s, sx in (("L", 1), ("R", -1)):
        L.arm(j_up, s, (sx * 0.292, -0.110, 0.455), aim=(sx * 0.5, -0.2, 1.0))
        j_up.set(f"thigh_{s}", x=-25); j_up.set(f"shin_{s}", x=35); j_up.set(f"foot_{s}", x=10)
    j_up.expression(eyes="happy", mouth="open").add("head", x=-6)
    j_up.set("ear_L", x=-18, mirror=False); j_up.set("ear_R", x=-18)
    tail_curve(j_up, x=-10, start=2, falloff=0.9)
    j_land = squat.copy(); j_land.expression(eyes="happy")
    for b in ("shoulder", "upperArm", "forearm", "paw"):     # arms still up on landing
        for s in ("L", "R"):
            j_land.rot[f"{b}_{s}"] = j_up.rot[f"{b}_{s}"].copy()
    T_SQ, T_TAKE, T_LAND, T_SET = 0.32, 0.36, 0.90, 1.12
    def jump_hop(t):
        # airborne arc between take-off and landing; the crouches are grounded poses (the feet
        # stay on the floor instead of sinking into it)
        if T_SQ <= t < T_LAND:
            u = (t - T_SQ) / (T_LAND - T_SQ)
            return 0.17 * 4 * u * (1 - u)
        return 0.0
    def jump_ov(t, p):
        p.hop = jump_hop(t)
        sq = 0.0
        if T_LAND <= t < T_SET + 0.08:
            sq = math.sin(math.pi * min(1.0, (t - T_LAND) / (T_SET + 0.08 - T_LAND)))
        if t < T_SQ:
            sq = 0.6 * smoother(t / T_SQ)
        elif t < T_TAKE + 0.08:
            sq = 0.6 * (1 - smoother((t - T_SQ) / (T_TAKE + 0.08 - T_SQ)))
        p.scale["root"] = (1 + 0.06 * sq, 1 - 0.07 * sq, 1 + 0.06 * sq)   # root local Y = up
        tail_wag(t, p, rate=1.5, amp=10)
    clips.append(Clip("Jump", 1.7, [(0, stand), (T_SQ, j_sq), (0.70, j_up), (T_LAND + 0.12, j_land), (1.7, stand)],
                      jump_ov, meta=dict(priority=3, lookAt=0.3, interruptible=False)))

    # ---- Dance (one-shot, 6 s): groove side to side on the beat with alternating paws raised,
    # hop + full turn with the arms out, cheer with both paws up shaking, little bow
    def dance_arms(p, up_side):
        for s, sx in (("L", 1), ("R", -1)):
            if s == up_side:      # up and out beside the head, like the wave (the head is big)
                L.arm(p, s, (sx * 0.340, -0.100, 0.460), aim=(sx * 0.40, -0.20, 1.0), palm=(0.0, -1.0, 0.15))
            else:
                L.arm(p, s, (sx * 0.240, -0.030, 0.220), aim=(sx * 0.45, 0.0, -1.0))
        return p
    dz = stand.copy().expression(eyes="happy", mouth="open")
    d_ready = dz.copy()
    for s in ("L", "R"):
        d_ready.set(f"thigh_{s}", x=-16); d_ready.set(f"shin_{s}", x=22); d_ready.set(f"foot_{s}", x=-6)
    g_l = dance_arms(dz.copy(), "L")
    g_r = dance_arms(dz.copy(), "R")
    d_out = dz.copy()
    for s, sx in (("L", 1), ("R", -1)):
        # palms down: raising the hanging arms sideways, without rolling them over
        L.arm(d_out, s, (sx * 0.300, -0.040, 0.340), aim=(sx * 1.0, -0.10, 0.25), palm=(0.0, -0.1, -1.0))
    d_cheer = dz.copy()
    for s, sx in (("L", 1), ("R", -1)):
        L.arm(d_cheer, s, (sx * 0.310, -0.100, 0.460), aim=(sx * 0.50, -0.20, 1.0), head_margin=0.02)
    d_bow = stand.copy().expression(eyes="happy")
    d_bow.add("spine", x=8).add("chest", x=6).add("neck", x=4).add("head", x=8)
    BEAT = 0.6

    def dance_ov(t, p):
        # groove (0.4 .. 2.8 s): sway to one side per beat, bounce on every beat
        g = smoother((t - 0.35) / 0.2) * (1 - smoother((t - 2.75) / 0.2))
        ph = math.pi * (t - 0.4) / BEAT
        sway = math.sin(ph)
        p.loc["root"] = np.array([0.018 * g * sway, 0.0, 0.0])
        p.add("hips", y=6 * g * sway).add("spine", y=-3 * g * sway)
        p.add("head", y=-8 * g * sway, x=3 * g * abs(sway))
        hop = 0.013 * g * abs(sway)
        # hop + full turn (2.85 .. 3.75 s)
        u = min(max((t - 2.85) / 0.9, 0.0), 1.0)
        if 0.0 < u < 1.0:
            p.add("root", z=360.0 * smoother(u))
            hop += 0.05 * math.sin(math.pi * u)
        # cheer (3.9 .. 5.3 s): paws shake, two bounces
        c = smoother((t - 4.0) / 0.25) * (1 - smoother((t - 5.2) / 0.25))
        shake = math.sin(2 * math.pi * 3.0 * t)
        for s, sx in (("L", 1), ("R", -1)):
            p.add(f"forearm_{s}", y=-sx * 9 * c * shake)
        hop += 0.02 * c * abs(math.sin(math.pi * (t - 4.0) / 0.6))
        p.hop = hop
        e = max(g, c)
        tail_wag(t, p, rate=1 / BEAT, amp=24 * e)
        p.add("ear_L", x=-10 * e * abs(sway)); p.add("ear_R", x=-10 * e * abs(sway))
        breathe(t, p, rate=0.5, amt=0.4)
    clips.append(Clip("Dance", 6.0, [(0, stand), (0.25, d_ready), (0.7, g_l), (1.3, g_r), (1.9, g_l), (2.5, g_r),
                                     (2.85, d_out), (3.75, d_out), (4.2, d_cheer), (5.1, d_cheer), (5.5, d_bow),
                                     (6.0, stand)],
                      dance_ov, meta=dict(priority=2, lookAt=0.2, refTime=1.3)))

    # Pet (loop): leaning into the hand, eyes ^^, ears back, tail wagging
    pet = stand.copy().expression(eyes="happy"); pet.add("head", x=2)
    pet = L.clasp(pet, head_margin=0.022)       # room for the nuzzling head sway (overlay)
    pet.set("ear_L", x=-22, y=8); pet.set("ear_R", x=-22, y=-8)
    def pet_ov(t, p):
        ph = 2 * math.pi * t / 1.6
        p.add("neck", y=3 * math.sin(ph)); p.add("head", y=6 * math.sin(ph), x=2 + 1.5 * math.sin(2 * ph), z=3 * math.sin(ph))
        p.add("chest", y=2 * math.sin(ph))
        tail_wag(t, p, rate=2.5, amp=23)
        breathe(t, p, rate=1.25, amt=0.6)
    clips.append(Clip("Pet", 1.6, [(0, pet)], pet_ov, loop=True, meta=dict(priority=2, lookAt=0.0)))

    # LookBack: turn toward the tail (fox's left/back), tail swish
    lb = stand.copy()
    lb.add("spine", z=14).add("chest", z=16).add("neck", z=14).add("head", z=26, x=4, y=6)
    lb.add("tail_1", z=15)          # the tail swings out of the way of the turning body
    def lb_ov(t, p):
        env = smoother((t - 0.3) / 0.3) * (1 - smoother((t - 1.9) / 0.4))
        for i in range(1, 7):
            p.add(f"tail_{i}", z=-24 * env * (0.3 + 0.12 * i) * math.sin(2 * math.pi * 1.3 * t - 0.6 * i),
                  x=8 * env)
        breathe(t, p, 0.5, 0.5)
    clips.append(Clip("LookBack", 2.4, [(0, stand), (0.45, lb), (1.9, lb), (2.4, stand)], lb_ov,
                      meta=dict(priority=2, lookAt=0.0)))

    # ---- Type (loop): paws tap a floating keyboard (spec.keyboard) at chest height
    # one solved pose over the keys; the taps are small shoulder / elbow / wrist offsets on top,
    # so the arms never re-solve (separately solved key poses jumped between solutions)
    tb = stand.copy()
    tb.add("head", x=12).add("neck", x=4)
    tb.set("ear_L", x=6, y=-4); tb.set("ear_R", x=6, y=4)
    for s, sx in (("L", 1), ("R", -1)):
        # back rows of the (bigger) keyboard, which tilts its keys toward the viewer: the rows
        # nearest the fox are the highest (top ~0.255 there, back edge y -0.20)
        L.arm(tb, s, (sx * 0.080, -0.236, 0.292), aim=(-sx * 0.15, -0.55, -0.35), palm=(0.0, 0.0, -1.0))
    def typing_pose(sl, dl, sr, dr):
        """s*: sideways step along the keys (deg, + = outward); d*: 1 = key pressed, 0 = lifted."""
        p = tb.copy()
        for side, sx, st, dn in (("L", 1, sl, dl), ("R", -1, sr, dr)):
            p.add(f"upperArm_{side}", z=sx * st)
            p.add(f"forearm_{side}", x=6.0 * dn - 3.0)
            p.add(f"paw_{side}", x=14.0 * dn - 7.0)
        return p
    tp = [typing_pose(0, 1, 2, 0), typing_pose(2, 0, -1, 1), typing_pose(4, 1, 3, 0), typing_pose(-2, 0, 1, 1)]
    keys = [(i * 0.15, tp[i % 4]) for i in range(8)] + [(1.2, tp[0])]
    def type_ov(t, p):
        breathe(t, p, rate=1.25, amt=0.4)
        p.add("head", y=2.0 * math.sin(2 * math.pi * t / 1.2), x=1.2 * math.sin(2 * math.pi * 5 * t / 1.2 * 0.8))
        tail_sway(t, p, rate=1 / 1.2, amp=9)
    clips.append(Clip("Type", 1.2, keys, type_ov, loop=True,
                      meta=dict(priority=2, lookAt=0.0, blink=1.0)))

    return clips


def build_clips(bpy, arm, parts=None, bone_table=None):
    rig = Rig(bone_table)
    skin = Skin(rig, parts, names={"Body", "Leg_L", "Leg_R"}, stride=3) if parts else None
    tail = Skin(rig, parts, names={"Tail"}, stride=2) if parts else None
    flap = FlapGuard(rig, parts) if parts else None
    meta = {}
    for c in make_clips(rig):
        if skin is None:
            c.grounded = False
        keys = to_keys(c, skin, tail, flap)
        make_action(bpy, arm, c.name, keys, loop=c.loop)
        m = dict(loop=c.loop, duration=round(c.duration, 4), priority=1, interruptible=True,
                 lookAt=1.0, blink=1.0, springs=1.0)
        m.update(c.meta)
        meta[c.name] = m
    if _CACHE is not None:
        _CACHE.save()
    missing = set(C.CLIP_NAMES) - set(meta)
    assert not missing, missing
    return meta
