"""Turn numpy `Part`s into Blender objects skinned to the armature (no bpy operators)."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import config as C


@dataclass
class Part:
    name: str
    verts: np.ndarray                       # (N,3) Blender space
    faces: np.ndarray                       # (M,3) int, CCW seen from outside
    material: str = "Fur"                   # single material name (see MATERIALS)
    materials: list | None = None           # optional multi-material list
    material_ids: np.ndarray | None = None  # (M,) index into `materials`
    normals: np.ndarray | None = None       # (N,3) custom per-vertex normals
    colors: np.ndarray | None = None        # (N,3|4) LINEAR rgb(a)
    ao: np.ndarray | None = None            # (N,) 0..1 (1 = unoccluded)
    uv: np.ndarray | None = None            # (N,2) per-vertex uv
    weights: dict = field(default_factory=dict)  # bone -> (N,) raw weights


# Blender Principled settings per material. Colours are sRGB keys of config.COLORS.
MATERIALS = {
    "Fur": dict(vertex_color=True, roughness=0.9, sheen=1.0, sheen_roughness=0.45,
                specular=0.25),
    "Scarf": dict(vertex_color=True, roughness=0.95, sheen=0.8, sheen_roughness=0.5,
                  specular=0.2),
    "Eye": dict(color="eye", roughness=0.25, clearcoat=1.0, clearcoat_roughness=0.05,
                specular=0.5),
    "EyeHighlight": dict(color="#FFFFFF", roughness=0.4, emission=0.6),
    "Line": dict(color="line", roughness=0.5, specular=0.3),
    "Nose": dict(color="nose", roughness=0.3, clearcoat=0.8, clearcoat_roughness=0.1),
    "MouthInside": dict(color="mouth_inside", roughness=0.6),
    "Tongue": dict(color="tongue", roughness=0.5, sheen=0.3),
    "LogoCube": dict(color="logo_cube", roughness=0.38, clearcoat=0.35,
                     clearcoat_roughness=0.3, specular=0.4),
    "LogoStar": dict(color="logo_star", roughness=0.3, clearcoat=0.6,
                     clearcoat_roughness=0.15, specular=0.5),
}


def get_material(bpy, name: str):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    spec = MATERIALS[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    if spec.get("vertex_color"):
        vc = nt.nodes.new("ShaderNodeVertexColor")
        vc.layer_name = "Col"
        nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        rgb = C.linear(spec["color"])
        bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = spec.get("roughness", 0.5)
    bsdf.inputs["Metallic"].default_value = 0.0
    if "specular" in spec:
        bsdf.inputs["Specular IOR Level"].default_value = spec["specular"]
    if spec.get("sheen"):
        bsdf.inputs["Sheen Weight"].default_value = spec["sheen"]
        bsdf.inputs["Sheen Roughness"].default_value = spec.get("sheen_roughness", 0.5)
        bsdf.inputs["Sheen Tint"].default_value = (1.0, 1.0, 1.0, 1.0)
    if spec.get("clearcoat"):
        bsdf.inputs["Coat Weight"].default_value = spec["clearcoat"]
        bsdf.inputs["Coat Roughness"].default_value = spec.get("clearcoat_roughness", 0.05)
    if spec.get("emission"):
        rgb = C.linear(spec.get("color", "#FFFFFF"))
        bsdf.inputs["Emission Color"].default_value = (*rgb, 1.0)
        bsdf.inputs["Emission Strength"].default_value = spec["emission"]
    return mat


def _normalize_weights(part: Part, max_inf: int = 4):
    names = list(part.weights)
    if not names:
        return [], None
    W = np.stack([np.asarray(part.weights[n], dtype=np.float64) for n in names], axis=1)
    W = np.clip(np.nan_to_num(W), 0.0, None)
    if W.shape[1] > max_inf:
        idx = np.argsort(-W, axis=1)[:, max_inf:]
        np.put_along_axis(W, idx, 0.0, axis=1)
    s = W.sum(1, keepdims=True)
    bad = s[:, 0] <= 1e-8
    if bad.any():
        raise ValueError(f"{part.name}: {bad.sum()} vertices have no weights")
    W = W / s
    W[W < 1e-3] = 0.0
    W = W / W.sum(1, keepdims=True)
    return names, W


def create_object(bpy, part: Part, armature_obj, collection):
    V = np.asarray(part.verts, dtype=np.float64)
    F = np.asarray(part.faces, dtype=np.int64)
    me = bpy.data.meshes.new(part.name)
    me.vertices.add(len(V))
    me.vertices.foreach_set("co", V.astype(np.float32).ravel())
    me.loops.add(len(F) * 3)
    me.loops.foreach_set("vertex_index", F.astype(np.int32).ravel())
    me.polygons.add(len(F))
    me.polygons.foreach_set("loop_start", (np.arange(len(F)) * 3).astype(np.int32))
    me.polygons.foreach_set("loop_total", np.full(len(F), 3, np.int32))
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    me.polygons.foreach_set("use_smooth", np.ones(len(F), bool))

    if part.colors is not None:
        col = np.asarray(part.colors, dtype=np.float32)
        if col.shape[1] == 3:
            col = np.hstack([col, np.ones((len(col), 1), np.float32)])
        attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        attr.data.foreach_set("color", col.ravel())
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = me.color_attributes.active_color_index
    if part.ao is not None:
        a = me.attributes.new("_AO", "FLOAT", "POINT")
        a.data.foreach_set("value", np.asarray(part.ao, np.float32))
    if part.uv is not None:
        uvl = me.uv_layers.new(name="UVMap")
        loop_v = F.ravel()
        uvl.data.foreach_set("uv", np.asarray(part.uv, np.float32)[loop_v].ravel())

    mats = part.materials or [part.material]
    for m in mats:
        me.materials.append(get_material(bpy, m))
    if part.material_ids is not None:
        me.polygons.foreach_set("material_index", np.asarray(part.material_ids, np.int32))

    if part.normals is not None:
        n = np.asarray(part.normals, dtype=np.float64)
        n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        me.normals_split_custom_set_from_vertices([tuple(x) for x in n])

    ob = bpy.data.objects.new(part.name, me)
    collection.objects.link(ob)

    names, W = _normalize_weights(part, C.BUDGET["max_influences"])
    for j, bn in enumerate(names):
        vg = ob.vertex_groups.new(name=bn)
        nz = np.nonzero(W[:, j])[0]
        # group vertices by identical weight to reduce API calls
        for w in np.unique(np.round(W[nz, j], 4)):
            ids = nz[np.round(W[nz, j], 4) == w]
            vg.add(ids.tolist(), float(w), "REPLACE")
    ob.parent = armature_obj
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = armature_obj
    return ob
