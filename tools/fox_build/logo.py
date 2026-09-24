"""Logo: 4 cream rounded cubes in a diamond + an orange puffy 4-point star (top-right).

Built in its own bpy session (build.py calls read_factory_settings first). Layout is in the
logo plane facing the viewer (Blender -Y); the web app positions the group at spec.logo.
Piece names follow spec.logo.pieces.
"""
from __future__ import annotations

import numpy as np

from . import config as C
from .assemble import Part
from .parametric import vertex_normals

CUBE = 0.072                 # edge length
SPACING = 0.078              # centre offset from the diamond centre
LAYOUT = {                   # (x, z) in the logo plane, from reference/1.webp
    "Cube_Top": (0.0, SPACING),
    "Cube_Left": (-SPACING, 0.0),
    "Cube_Right": (SPACING, 0.004),
    "Cube_Bottom": (0.0, -SPACING),
    "Star": (0.100, 0.100),
}


def rounded_cube(edge, radius, n=6):
    """Cube with rounded edges: project a subdivided cube onto its inner-box + radius."""
    h = edge / 2
    g = np.linspace(-1, 1, 2 * n + 1)
    V = []; F = []
    for axis in range(3):
        for sign in (-1, 1):
            base = len(V)
            for i, a in enumerate(g):
                for j, b in enumerate(g):
                    p = [0, 0, 0]
                    p[axis] = sign
                    p[(axis + 1) % 3] = a
                    p[(axis + 2) % 3] = b
                    V.append(p)
            m = len(g)
            for i in range(m - 1):
                for j in range(m - 1):
                    a0 = base + i * m + j
                    quad = [a0, a0 + m, a0 + m + 1, a0 + 1]
                    if sign < 0:
                        quad = quad[::-1]
                    F += [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]]
    V = np.array(V, float) * h
    inner = h - radius
    core = np.clip(V, -inner, inner)
    d = V - core
    ln = np.linalg.norm(d, axis=1, keepdims=True)
    V = core + d / np.maximum(ln, 1e-12) * radius
    # weld duplicate vertices along cube edges
    key = np.round(V, 7)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    F = inv.reshape(-1)[np.array(F)]
    F = F[(F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])]
    V = uniq
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    if (fn * V[F[:, 0]]).sum() < 0:
        F = F[:, ::-1].copy()
    return V, F


def puffy_star(r=0.052, thickness=0.024, p=0.62, n_out=96, n_rings=10):
    """Inflated 4-point sparkle: superellipse |x|^p + |y|^p = r^p (p<1 -> concave sides)."""
    th = np.linspace(0, 2 * np.pi, n_out, endpoint=False)
    c, s = np.cos(th), np.sin(th)
    # polar radius of the superellipse
    rad = r / (np.abs(c) ** p + np.abs(s) ** p) ** (1 / p)
    ring2d = np.stack([rad * c, rad * s], 1)
    V = []; F = []
    rings = []
    for side in (1, -1):
        idx = []
        for k in range(n_rings):
            f = 1 - k / n_rings            # 1 at rim -> small at centre
            z = side * thickness / 2 * np.sqrt(max(1 - f ** 2, 0.0)) ** 0.8
            pts = np.column_stack([ring2d * f, np.full(n_out, z)])
            if k == 0 and side == -1:
                idx.append(rings[0][0])   # share the rim ring
                continue
            idx.append(list(range(len(V), len(V) + n_out)))
            V.extend(pts.tolist())
        V.append([0, 0, side * thickness / 2])
        idx.append(len(V) - 1)
        rings.append(idx)
    for side_i, idx in enumerate(rings):
        for k in range(n_rings - 1):
            a, b = idx[k], idx[k + 1]
            for j in range(n_out):
                q = [a[j], a[(j + 1) % n_out], b[(j + 1) % n_out], b[j]]
                if side_i == 1:
                    q = q[::-1]
                F += [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]
        last = idx[n_rings - 1]; pole = idx[n_rings]
        for j in range(n_out):
            t = [last[j], last[(j + 1) % n_out], pole]
            F.append(t if side_i == 0 else t[::-1])
    V = np.array(V, float)
    F = np.array(F, dtype=np.int64)
    # star lies in the X/Z plane facing -Y: map (x, y, z) -> (x, z, y)
    V = V[:, [0, 2, 1]] * np.array([1, -1, 1])
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    if (fn * V[F[:, 0]]).sum() < 0:
        F = F[:, ::-1].copy()
    return V, F


def _rot(x=0, y=0, z=0):
    x, y, z = np.radians([x, y, z])
    Rx = np.array([[1, 0, 0], [0, np.cos(x), -np.sin(x)], [0, np.sin(x), np.cos(x)]])
    Ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    Rz = np.array([[np.cos(z), -np.sin(z), 0], [np.sin(z), np.cos(z), 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def build(bpy):
    col = bpy.context.scene.collection
    root = bpy.data.objects.new("Logo", None)
    col.objects.link(root)
    for name, (x, z) in LAYOUT.items():
        if name == "Star":
            V, F = puffy_star()
            mat = "LogoStar"
        else:
            V, F = rounded_cube(CUBE, 0.014)
            V = V @ _rot(x=10, z=-18).T
            mat = "LogoCube"
        part = Part(name, V, F, material=mat, normals=vertex_normals(V, F))
        me_obj = _create_static(bpy, part, col)
        me_obj.location = (x, 0.0, z)
        me_obj.parent = root
    return root


def _create_static(bpy, part, col):
    """Like assemble.create_object but without skinning."""
    from .assemble import get_material
    V = np.asarray(part.verts, np.float32); F = np.asarray(part.faces, np.int32)
    me = bpy.data.meshes.new(part.name)
    me.vertices.add(len(V)); me.vertices.foreach_set("co", V.ravel())
    me.loops.add(len(F) * 3); me.loops.foreach_set("vertex_index", F.ravel())
    me.polygons.add(len(F))
    me.polygons.foreach_set("loop_start", (np.arange(len(F)) * 3).astype(np.int32))
    me.polygons.foreach_set("loop_total", np.full(len(F), 3, np.int32))
    me.update(calc_edges=True)
    me.polygons.foreach_set("use_smooth", np.ones(len(F), bool))
    me.normals_split_custom_set_from_vertices([tuple(n) for n in part.normals])
    me.materials.append(get_material(bpy, part.material))
    ob = bpy.data.objects.new(part.name, me)
    col.objects.link(ob)
    return ob
