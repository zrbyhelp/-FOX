"""Low-level animation helpers: quaternion math, armature-space -> bone-local conversion,
slot-aware action creation (Blender 4.4+ slotted actions; exporter needs an OBJECT slot).

Pose dict format (per keyframe):
    { bone_name: {"rot": q_arm (w,x,y,z) in ARMATURE space, "loc": (x,y,z) armature-space
                  offset, "scale": (sx,sy,sz) bone-local} }
Rotations are given in armature space (X = fox's left, Y = back, Z = up; rotation applied
about the bone's own pivot) and converted with q_local = R_rest^-1 * q_arm * R_rest.
"""
from __future__ import annotations

import math

import numpy as np

from . import config as C

# ---------------------------------------------------------------- quaternion helpers (w,x,y,z)


def qmul(a, b):
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return np.array([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ])


def qconj(q):
    return np.array([q[0], -q[1], -q[2], -q[3]])


def qnorm(q):
    q = np.asarray(q, dtype=np.float64)
    return q / np.linalg.norm(q)


def qaxis(axis, deg):
    axis = np.asarray(axis, dtype=np.float64)
    axis = axis / np.linalg.norm(axis)
    h = math.radians(deg) / 2
    return np.array([math.cos(h), *(axis * math.sin(h))])


def qeuler(x=0.0, y=0.0, z=0.0):
    """Armature-space euler in degrees, applied X then Y then Z (extrinsic)."""
    return qnorm(qmul(qaxis((0, 0, 1), z), qmul(qaxis((0, 1, 0), y), qaxis((1, 0, 0), x))))


def qslerp(a, b, t):
    a = qnorm(a); b = qnorm(b)
    d = float(np.dot(a, b))
    if d < 0:
        b = -b; d = -d
    if d > 0.9995:
        return qnorm(a + t * (b - a))
    th = math.acos(d)
    return (math.sin((1 - t) * th) * a + math.sin(t * th) * b) / math.sin(th)


def qmirror(q):
    """Mirror an armature-space rotation across the YZ plane (L <-> R)."""
    return np.array([q[0], q[1], -q[2], -q[3]])


def mat_to_quat(m):
    m = np.asarray(m, dtype=np.float64)
    t = np.trace(m)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        return qnorm([0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s])
    i = int(np.argmax(np.diag(m)))
    if i == 0:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        return qnorm([(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s])
    if i == 1:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        return qnorm([(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s])
    s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
    return qnorm([(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s])


def arm_to_local(q_arm, rest3x3):
    r = mat_to_quat(rest3x3)
    return qnorm(qmul(qconj(r), qmul(q_arm, r)))


def vec_arm_to_local(v, rest3x3):
    return np.asarray(rest3x3).T @ np.asarray(v, dtype=np.float64)


# ---------------------------------------------------------------- action creation

IDENT = np.array([1.0, 0, 0, 0])


def make_action(bpy, arm, name: str, keys: list, loop: bool = False, rest=None):
    """keys: list of (frame:int, pose:dict). Every bone is keyed at every key (identity
    when absent; expression bones default to their neutral visibility)."""
    from .rig import rest_matrices
    rest = rest or rest_matrices(arm)
    act = bpy.data.actions.get(name)
    if act:
        bpy.data.actions.remove(act)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    slot = act.slots.new(id_type="OBJECT", name=arm.name)
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    arm.animation_data.action_slot = slot

    default_visible = set(C.SPEC["expressions"]["defaultVisible"])
    prev_q = {}
    for frame, pose in keys:
        for pb in arm.pose.bones:
            bn = pb.name
            spec = pose.get(bn, {})
            q_arm = spec.get("rot", IDENT)
            ql = arm_to_local(q_arm, rest[bn])
            if bn in prev_q and np.dot(prev_q[bn], ql) < 0:
                ql = -ql  # keep hemisphere continuity
            prev_q[bn] = ql
            loc = vec_arm_to_local(spec.get("loc", (0, 0, 0)), rest[bn])
            if "scale" in spec:
                sc = spec["scale"]
            elif bn in C.EXPRESSION_BONES:
                sc = (1, 1, 1) if bn in default_visible else C.EPS_SCALE
            else:
                sc = (1, 1, 1)
            pb.rotation_quaternion = tuple(ql)
            pb.location = tuple(loc)
            pb.scale = tuple(sc)
            pb.keyframe_insert("rotation_quaternion", frame=frame, group=bn)
            pb.keyframe_insert("location", frame=frame, group=bn)
            pb.keyframe_insert("scale", frame=frame, group=bn)
    act.use_frame_range = True
    act.frame_start = keys[0][0]
    act.frame_end = keys[-1][0]
    act.use_cyclic = bool(loop)
    arm.animation_data.action = None
    reset_pose(arm)
    return act


def reset_pose(arm):
    for pb in arm.pose.bones:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
