"""Pose maths in numpy: forward kinematics, 2-bone IK, skinning (for grounding / QA) and a
small pose library.

A Pose stores, per bone, a rotation q (w,x,y,z) expressed in REST ARMATURE axes and applied
relative to the parent's posed frame (so {"upperArm_L": qeuler(y=-90)} always means "swing
the left arm up 90deg in the frontal plane", whatever the bone roll). anim.make_action turns
it into Blender local quaternions via q_local = R_rest^-1 q R_rest.

Axes (Blender): X = fox's left, Y = back, Z = up.
  +X rot tips an up-pointing bone FORWARD (head nod); a down-pointing bone goes BACK.
  +Y rot tilts an up-pointing bone toward the fox's LEFT; lowers the left arm.
  +Z rot turns the face toward the fox's LEFT (viewer's right when facing the viewer).
Mirror L->R: (w,x,y,z) -> (w,x,-y,-z).
"""
from __future__ import annotations

import copy
import math

import numpy as np

from . import config as C
from .anim import IDENT, qaxis, qconj, qeuler, qmirror, qmul, qnorm, qslerp

EXPR_BONES = C.EXPRESSION_BONES


# ------------------------------------------------------------------ quaternion utils
def qrot(q, v):
    """Rotate vector(s) v by quaternion q."""
    v = np.asarray(v, dtype=np.float64)
    w, x, y, z = q
    u = np.array([x, y, z])
    t = 2.0 * np.cross(u, v)
    return v + w * t + np.cross(u, t)


def q_between(a, b):
    a = np.asarray(a, float) / np.linalg.norm(a)
    b = np.asarray(b, float) / np.linalg.norm(b)
    d = float(a @ b)
    if d < -0.999999:
        axis = np.cross([1.0, 0, 0], a)
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross([0, 1.0, 0], a)
        return qaxis(axis, 180.0)
    c = np.cross(a, b)
    return qnorm(np.array([1.0 + d, *c]))


# ------------------------------------------------------------------ rig description
class Rig:
    def __init__(self, bone_table=None):
        bt = bone_table or C.bone_table()
        self.order = list(bt)
        self.parent = {n: bt[n][0] for n in bt}
        self.head = {n: np.array(bt[n][1], float) for n in bt}
        self.tail = {n: np.array(bt[n][2], float) for n in bt}
        self.dir = {n: (self.tail[n] - self.head[n]) / np.linalg.norm(self.tail[n] - self.head[n]) for n in bt}
        self.length = {n: float(np.linalg.norm(self.tail[n] - self.head[n])) for n in bt}

    def fk(self, pose):
        """-> (Qw: bone -> world delta rotation, Hw: bone -> world head position)."""
        Qw, Hw = {}, {}
        for n in self.order:
            q = pose.rot.get(n, IDENT)
            loc = pose.loc.get(n, np.zeros(3))
            p = self.parent[n]
            if p is None:
                Qw[n] = q
                Hw[n] = self.head[n] + loc
            else:
                Qw[n] = qnorm(qmul(Qw[p], q))
                Hw[n] = Hw[p] + qrot(Qw[p], self.head[n] - self.head[p] + loc)
        return Qw, Hw

    def tail_world(self, Qw, Hw, n):
        return Hw[n] + qrot(Qw[n], self.tail[n] - self.head[n])


class Pose:
    def __init__(self, rot=None, loc=None, scale=None, expr=None):
        self.rot = dict(rot or {})
        self.loc = {k: np.asarray(v, float) for k, v in (loc or {}).items()}
        self.scale = dict(scale or {})
        self.expr = dict(expr or {"eyes": "open", "brows": "none", "mouth": "smile"})

    def copy(self):
        return copy.deepcopy(self)

    # convenience -----------------------------------------------------------
    def set(self, bone, x=0.0, y=0.0, z=0.0, mirror=False):
        """Set armature-axis euler (deg). mirror=True also sets the _R twin mirrored."""
        q = qeuler(x, y, z)
        self.rot[bone] = q
        if mirror and bone.endswith("_L"):
            self.rot[bone[:-2] + "_R"] = qmirror(q)
        return self

    def add(self, bone, x=0.0, y=0.0, z=0.0):
        """Pre-multiply an extra armature-axis rotation."""
        self.rot[bone] = qnorm(qmul(qeuler(x, y, z), self.rot.get(bone, IDENT)))
        return self

    def expression(self, eyes=None, brows=None, mouth=None):
        if eyes: self.expr["eyes"] = eyes
        if brows: self.expr["brows"] = brows
        if mouth: self.expr["mouth"] = mouth
        return self

    def expr_scales(self):
        vis = {b: 0.0 for b in EXPR_BONES}
        e = self.expr
        for s in ("L", "R"):
            vis[{"open": "eyeOpen", "happy": "eyeHappy", "sleep": "eyeSleep"}[e["eyes"]] + "_" + s] = 1.0
        if e["brows"] in ("both", "left"):
            vis["brow_L"] = 1.0
        if e["brows"] in ("both", "right"):
            vis["brow_R"] = 1.0
        vis["mouthSmile" if e["mouth"] == "smile" else "mouthOpen"] = 1.0
        return vis


def blend(a: Pose, b: Pose, t: float) -> Pose:
    out = Pose()
    for n in set(a.rot) | set(b.rot):
        out.rot[n] = qslerp(a.rot.get(n, IDENT), b.rot.get(n, IDENT), t)
    for n in set(a.loc) | set(b.loc):
        out.loc[n] = a.loc.get(n, np.zeros(3)) * (1 - t) + b.loc.get(n, np.zeros(3)) * t
    for n in set(a.scale) | set(b.scale):
        sa = np.asarray(a.scale.get(n, (1, 1, 1)), float); sb = np.asarray(b.scale.get(n, (1, 1, 1)), float)
        out.scale[n] = tuple(sa * (1 - t) + sb * t)
    # expressions: numeric visibilities blended, stored as explicit scales
    va = a.expr_scales() if not hasattr(a, "_vis") else a._vis
    vb = b.expr_scales() if not hasattr(b, "_vis") else b._vis
    out._vis = {k: va[k] * (1 - t) + vb[k] * t for k in va}
    out.expr = (a if t < 0.5 else b).expr.copy()
    return out


def vis_of(p: Pose):
    return p._vis if hasattr(p, "_vis") else p.expr_scales()


# ------------------------------------------------------------------ IK
def _solve_two_bone(S, L1, L2, T, pole):
    D = T - S
    if np.linalg.norm(D) < 1e-6:          # target on the joint: aim straight down
        D = np.array([0.0, 0.0, -1e-3])
    d = np.linalg.norm(D)
    d = np.clip(d, abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4)
    u = D / np.linalg.norm(D)
    T = S + u * d
    a = (L1 * L1 - L2 * L2 + d * d) / (2 * d)
    h = math.sqrt(max(L1 * L1 - a * a, 0.0))
    v = np.asarray(pole, float) - (np.asarray(pole, float) @ u) * u
    if np.linalg.norm(v) < 1e-8:
        v = np.cross(u, [0, 0, 1.0])
    if np.linalg.norm(v) < 1e-8:          # pole and target both vertical
        v = np.cross(u, [1.0, 0, 0])
    v /= np.linalg.norm(v)
    return S + u * a + v * h, T


def ik_chain(rig: Rig, pose: Pose, b1: str, b2: str, target, pole, twist=0.0, end_bone=None):
    """Aim b1->b2 so that b2's TAIL (or end_bone's head) reaches target. Twist (deg) rolls b1
    around its own axis (e.g. to turn a palm up)."""
    Qw, Hw = rig.fk(pose)
    p = rig.parent[b1]
    Qp = Qw[p] if p else IDENT
    S = Hw[b1]
    L1 = rig.length[b1]
    # b2 may be longer than the head->head distance if end_bone is its child
    L2 = rig.length[b2]
    E, T = _solve_two_bone(S, L1, L2, np.asarray(target, float), pole)
    d1_rest_w = qrot(Qp, rig.dir[b1])
    Q1 = qmul(q_between(d1_rest_w, E - S), Qp)
    if twist:
        Q1 = qmul(qaxis((E - S) / np.linalg.norm(E - S), twist), Q1)
    pose.rot[b1] = qnorm(qmul(qconj(Qp), Q1))
    d2_w = qrot(Q1, rig.dir[b2])
    Q2 = qmul(q_between(d2_w, T - E), Q1)
    pose.rot[b2] = qnorm(qmul(qconj(Q1), Q2))
    return pose


def arm_ik(rig, pose, side, wrist, pole=None, twist=0.0, paw=(0, 0, 0)):
    sx = 1 if side == "L" else -1
    pole = pole if pole is not None else (sx * 1.0, 0.6, -0.4)
    ik_chain(rig, pose, f"upperArm_{side}", f"forearm_{side}", wrist, pole, twist * sx)
    q = qeuler(*paw)
    pose.rot[f"paw_{side}"] = q if side == "L" else qmirror(q)
    return pose


def aim_bone(rig, pose, bone, world_dir, twist=0.0):
    """Rotate bone so its axis points along world_dir (keeps parent pose)."""
    Qw, Hw = rig.fk(pose)
    p = rig.parent[bone]
    Qp = Qw[p] if p else IDENT
    Q = qmul(q_between(qrot(Qp, rig.dir[bone]), world_dir), Qp)
    if twist:
        Q = qmul(qaxis(world_dir, twist), Q)
    pose.rot[bone] = qnorm(qmul(qconj(Qp), Q))
    return pose


def leg_ik(rig, pose, side, ankle, pole=(0, -1.0, 0.0), foot_world=None):
    ik_chain(rig, pose, f"thigh_{side}", f"shin_{side}", ankle, pole)
    Qw, _ = rig.fk(pose)
    Qs = Qw[f"shin_{side}"]
    fw = IDENT if foot_world is None else foot_world
    pose.rot[f"foot_{side}"] = qnorm(qmul(qconj(Qs), fw))
    return pose


# ------------------------------------------------------------------ skinning (numpy)
class Skin:
    """Subset of skinned vertices for grounding / QA."""
    def __init__(self, rig: Rig, parts, names=None, stride=1):
        self.rig = rig
        V = []; W = []; B = []
        bones = rig.order
        idx = {b: i for i, b in enumerate(bones)}
        for p in parts:
            if names and p.name not in names:
                continue
            v = np.asarray(p.verts)[::stride]
            w = np.zeros((len(v), len(bones)))
            for b, arr in p.weights.items():
                w[:, idx[b]] = np.asarray(arr)[::stride]
            s = w.sum(1, keepdims=True)
            w = w / np.maximum(s, 1e-9)
            V.append(v); W.append(w)
        self.V = np.vstack(V); self.W = np.vstack(W)
        self.bones = bones

    def deform(self, pose):
        Qw, Hw = self.rig.fk(pose)
        out = np.zeros_like(self.V)
        for i, b in enumerate(self.bones):
            w = self.W[:, i]
            m = w > 1e-6
            if not m.any():
                continue
            local = self.V[m] - self.rig.head[b]
            out[m] += w[m, None] * (_qrot_many(Qw[b], local) + Hw[b])
        return out


    def deform_normals(self, pose, N):
        """Blend-rotate per-vertex normals N (same vertex order as self.V)."""
        Qw, _ = self.rig.fk(pose)
        out = np.zeros_like(N)
        for i, b in enumerate(self.bones):
            w = self.W[:, i]
            m = w > 1e-6
            if m.any():
                out[m] += w[m, None] * _qrot_many(Qw[b], N[m])
        return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)


def _qrot_many(q, v):
    w, x, y, z = q
    u = np.array([x, y, z])
    t = 2.0 * np.cross(u, v)
    return v + w * t + np.cross(u, t)


def ground(skin: Skin, pose: Pose, floor=0.0):
    """Shift root so the lowest skinned vertex rests on the floor."""
    P = skin.deform(pose)
    dz = floor - P[:, 2].min()
    loc = pose.loc.get("root", np.zeros(3)).copy()
    loc[2] += dz
    pose.loc["root"] = loc
    return pose


# ------------------------------------------------------------------ collision-aware arm solver
def rotvec_q(r):
    r = np.asarray(r, float)
    a = np.linalg.norm(r)
    if a < 1e-9:
        return IDENT.copy()
    return qaxis(r / a, math.degrees(a))


def to_rest_space(rig, Qw, Hw, bone, pts):
    """Posed world points -> the rest space of `bone` (to evaluate that part's rest SDF)."""
    return _qrot_many(qconj(Qw[bone]), pts - Hw[bone]) + rig.head[bone]


def _q2m(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def q_to_rotvec(q):
    q = qnorm(q)
    if q[0] < 0:
        q = -q
    s = np.linalg.norm(q[1:])
    if s < 1e-9:
        return np.zeros(3)
    return q[1:] / s * 2 * math.atan2(s, q[0])


class ArmSolver:
    """Places a paw (centre of the mitten) at a target while keeping the arm outside the body
    and head. Unknowns: upperArm + forearm + paw rotations (axis-angle, armature axes,
    relative to the parent). Only the three arm bones are re-evaluated per step (fast), and the
    search starts from the analytic 2-bone IK solution. Elbow twist and extreme bends are
    penalised so poses stay natural."""

    def __init__(self, rig: Rig, arm_parts: dict, body_sdf, head_sdf, stride=10):
        self.rig = rig
        self.body_sdf = body_sdf
        self.head_sdf = head_sdf
        self.samples = {}
        for s in ("L", "R"):
            part = arm_parts[s]
            V = np.asarray(part.verts)[::stride]
            names = [f"upperArm_{s}", f"forearm_{s}", f"paw_{s}"]
            W = np.stack([np.asarray(part.weights.get(n, np.zeros(len(part.verts))))[::stride] for n in names], 1)
            for extra in (f"fingers_{s}", f"thumb_{s}"):      # fingers ride on the paw here
                if extra in part.weights:
                    W[:, 2] += np.asarray(part.weights[extra])[::stride]
            W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
            self.samples[s] = (V, W)

    def solve(self, pose: Pose, side: str, target, aim=None, margin=0.004, bend_max=95.0,
              head_margin=0.002, iters=2500, palm=None):
        from scipy.optimize import minimize
        rig = self.rig
        ua, fa, pw = f"upperArm_{side}", f"forearm_{side}", f"paw_{side}"
        target = np.asarray(target, float)
        aim = None if aim is None else np.asarray(aim, float) / np.linalg.norm(aim)
        palm = None if palm is None else np.asarray(palm, float) / np.linalg.norm(palm)
        palm_rest = -np.asarray(C.paw_frame(side)["z"], float)       # palm normal in the bind pose
        Qw, Hw = rig.fk(pose)
        Qs = Qw[rig.parent[ua]]
        H_ua = Hw[ua]
        Rc, Hc = _q2m(Qw["chest"]), Hw["chest"]
        Rh, Hh = _q2m(Qw["head"]), Hw["head"]
        hc_rest, hh_rest = rig.head["chest"], rig.head["head"]
        V, W = self.samples[side]
        h_ua, h_fa, h_pw = rig.head[ua], rig.head[fa], rig.head[pw]
        off_fa, off_pw = h_fa - h_ua, h_pw - h_fa
        pc_local = (rig.tail[pw] - h_pw) * 0.45
        paw_dir = rig.dir[pw]
        fa_axis = rig.dir[fa]
        Vl = [V - h_ua, V - h_fa, V - h_pw]
        far_rest = np.linalg.norm(V - h_ua, axis=1) > 0.075

        def chain(x):
            Q1 = qmul(Qs, rotvec_q(x[0:3])); R1 = _q2m(Q1)
            H2 = H_ua + R1 @ off_fa
            Q2 = qmul(Q1, rotvec_q(x[3:6])); R2 = _q2m(Q2)
            H3 = H2 + R2 @ off_pw
            Q3 = qmul(Q2, rotvec_q(x[6:9])); R3 = _q2m(Q3)
            return (R1, R2, R3), (H_ua, H2, H3)

        def cost(x):
            Rs, Hs = chain(x)
            pc = Hs[2] + Rs[2] @ pc_local
            e = np.sum((pc - target) ** 2) / 0.006 ** 2
            if aim is not None:
                e += 40.0 * (1.0 - (Rs[2] @ paw_dir) @ aim)
            if palm is not None:
                e += 25.0 * (1.0 - (Rs[2] @ palm_rest) @ palm)
            else:
                e += 2.0 * np.sum(x[6:9] ** 2)
            P = (W[:, 0:1] * (Vl[0] @ Rs[0].T + Hs[0]) + W[:, 1:2] * (Vl[1] @ Rs[1].T + Hs[1])
                 + W[:, 2:3] * (Vl[2] @ Rs[2].T + Hs[2]))
            pb = (P[far_rest] - Hc) @ Rc + hc_rest
            e += np.sum(np.maximum(margin - self.body_sdf(pb), 0.0) ** 2) / 0.003 ** 2
            ph = (P - Hh) @ Rh + hh_rest
            near = ph[:, 2] > 0.36
            if near.any():
                e += np.sum(np.maximum(head_margin - self.head_sdf(ph[near]), 0.0) ** 2) / 0.003 ** 2
            twist = x[3:6] @ fa_axis
            bend = math.degrees(np.linalg.norm(x[3:6]))
            e += 30.0 * twist ** 2 + 0.02 * max(bend - bend_max, 0.0) ** 2
            e += 0.3 * np.sum(x[6:9] ** 2) + 0.05 * np.sum(x[0:3] ** 2)
            return e

        # start from analytic IK (wrist ~ target minus half a paw along the aim)
        guess = pose.copy()
        d = aim if aim is not None else (target - H_ua) / max(np.linalg.norm(target - H_ua), 1e-6)
        arm_ik(rig, guess, side, target - d * np.linalg.norm(pc_local) * 1.0)
        if aim is not None:
            aim_bone(rig, guess, pw, aim)
        x0 = np.r_[q_to_rotvec(guess.rot[ua]), q_to_rotvec(guess.rot[fa]), q_to_rotvec(guess.rot.get(pw, IDENT))]
        r = minimize(cost, x0, method="Powell", options=dict(maxiter=iters, xtol=1e-3, ftol=1e-7))
        x = r.x
        pose.rot[ua] = rotvec_q(x[0:3]); pose.rot[fa] = rotvec_q(x[3:6]); pose.rot[pw] = rotvec_q(x[6:9])
        Rs, Hs = chain(x)
        err = float(np.linalg.norm(Hs[2] + Rs[2] @ pc_local - target))
        return pose, x, err
