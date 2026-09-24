"""Armature creation + helpers to convert armature-space rotations to bone-local ones."""
from __future__ import annotations

import numpy as np

from . import config as C


def create_armature(bpy, collection, bone_table=None, name="FoxRig"):
    bt = bone_table or C.bone_table()
    data = bpy.data.armatures.new(name)
    data.display_type = "STICK"
    arm = bpy.data.objects.new(name, data)
    collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    deform = set(C.DEFORM_BONES)
    for bname, (parent, head, tail) in bt.items():
        eb = data.edit_bones.new(bname)
        eb.head = head
        eb.tail = tail
        eb.roll = 0.0
        eb.use_deform = True  # expression bones also skin their feature meshes
        eb.use_connect = False
        if parent:
            eb.parent = data.edit_bones[parent]
        if bname not in deform:
            eb.bbone_x = eb.bbone_z = 0.004
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return arm


def rest_matrices(arm) -> dict:
    """bone name -> 3x3 rest rotation (armature space) as numpy."""
    out = {}
    for b in arm.data.bones:
        m = b.matrix_local.to_3x3()
        out[b.name] = np.array([[m[i][j] for j in range(3)] for i in range(3)])
    return out


def rest_heads(arm) -> dict:
    return {b.name: np.array(b.head_local[:]) for b in arm.data.bones}
