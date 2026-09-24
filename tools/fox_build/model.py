"""Full fox model: assembles every Part (SDF parts + parametric parts + face features).

SDF meshes are cached in build/cache keyed by the source of shapes/sdf/mesher/config, so
colour / weight tweaks (parts.py, face.py, parametric.py) rebuild in seconds.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np

from . import config as C
from . import ao, face, mesher, parametric as PM, parts as PT, shapes as SH
from .assemble import Part

HERE = Path(__file__).resolve().parent
CACHE = C.BUILD_DIR / "cache"

# target edge lengths (m) -> triangle budget
EDGE = {"Head": 0.0088, "Body": 0.011, "Arm": 0.0072, "Leg": 0.0072}
VOXEL = {"Head": 0.003, "Body": 0.004, "Arm": 0.0022, "Leg": 0.0022}


def _src_hash(*extra):
    h = hashlib.sha1()
    for f in ("shapes.py", "sdf.py", "mesher.py", "config.py"):
        h.update((HERE / f).read_bytes())
    for e in extra:
        h.update(repr(e).encode())
    return h.hexdigest()[:16]


def cached_mesh(name, fn, lo, hi, voxel, edge, adaptive=False):
    CACHE.mkdir(parents=True, exist_ok=True)
    key = _src_hash(name, voxel, edge, adaptive, np.round(lo, 4).tolist(), np.round(hi, 4).tolist())
    path = CACHE / f"{name}_{key}.npz"
    if path.exists():
        d = np.load(path)
        return d["V"], d["F"], d["N"]
    V, F, N = mesher.mesh_sdf(fn, lo, hi, voxel=voxel, target_edge=edge, adaptive=adaptive, name=name)
    np.savez_compressed(path, V=V, F=F, N=N)
    return V, F, N


def _rigid(name, mesh, bone, material=None, materials=None, ids=None, color=None):
    V, F, N = mesh[:3]
    col = np.tile(C.linear(color), (len(V), 1)) if color else None
    return Part(name, V, F, material=material or "Fur", materials=materials, material_ids=ids,
                normals=N, colors=col, weights={bone: np.ones(len(V))})


def build_parts():
    parts = []
    # ---- head
    V, F, N = cached_mesh("Head", SH.head_sdf, *SH.HEAD_BBOX, VOXEL["Head"], EDGE["Head"], adaptive=True)
    parts.append(Part("Head", V, F, normals=N, colors=PT.head_colors(V, N), weights=PT.head_weights(V)))
    # ---- body
    V, F, N = cached_mesh("Body", SH.body_sdf, *SH.BODY_BBOX, VOXEL["Body"], EDGE["Body"])
    parts.append(Part("Body", V, F, normals=N, colors=PT.body_colors(V, N), weights=PT.body_weights(V)))
    # ---- limbs
    for s in ("L", "R"):
        lo, hi = SH.arm_bbox(s)
        V, F, N = cached_mesh(f"Arm_{s}", lambda p, s=s: SH.arm_sdf(p, s), lo, hi, VOXEL["Arm"], EDGE["Arm"])
        parts.append(Part(f"Arm_{s}", V, F, normals=N, colors=PT.arm_colors(V, N, s),
                          weights=PT.arm_weights(V, s)))
        lo, hi = SH.leg_bbox(s)
        V, F, N = cached_mesh(f"Leg_{s}", lambda p, s=s: SH.leg_sdf(p, s), lo, hi, VOXEL["Leg"], EDGE["Leg"])
        parts.append(Part(f"Leg_{s}", V, F, normals=N, colors=PT.leg_colors(V, N, s),
                          weights=PT.leg_weights(V, s)))
    # ---- tail
    V, F, N, tv = PM.tail_mesh()
    parts.append(Part("Tail", V, F, normals=N, colors=PM.tail_colors(V, N, tv), weights=PM.tail_weights(tv)))
    # ---- scarf
    V, F, N, UV, th = PM.scarf_ring_mesh()
    parts.append(Part("Scarf", V, F, material="Scarf", normals=N, uv=UV,
                      colors=np.tile(C.linear("scarf"), (len(V), 1)), weights=PM.scarf_ring_weights(V, th)))
    V, F, N, UV, vp, wp, front, frame = PM.scarf_flap_mesh()
    col = np.tile(C.linear("scarf"), (len(V), 1))
    W = PM.scarf_flap_weights(vp)
    Vs, Fs, Ns, UVs, cols = [V], [F], [N], [UV], [col]
    Ws = {k: [v] for k, v in W.items()}
    off = len(V)
    for (v, f, n, vc) in PM.scarf_squares(frame):
        Vs.append(v); Fs.append(f + off); Ns.append(n); UVs.append(np.zeros((len(v), 2)))
        cols.append(np.tile(C.linear("scarf_square"), (len(v), 1)))
        wv = PM.scarf_flap_weights(np.full(len(v), vc))
        for k in Ws:
            Ws[k].append(wv[k])
        off += len(v)
    parts.append(Part("ScarfFlap", np.vstack(Vs), np.vstack(Fs), material="Scarf", normals=np.vstack(Ns),
                      uv=np.vstack(UVs), colors=np.vstack(cols),
                      weights={k: np.concatenate(v) for k, v in Ws.items()}))
    # ---- face
    for s in ("L", "R"):
        V, F, N, ids = face.eye(s)
        parts.append(Part(f"Eye_{s}", V, F, materials=["Eye", "EyeHighlight"], material_ids=ids,
                          normals=N, weights={f"eyeOpen_{s}": np.ones(len(V))}))
        parts.append(_rigid(f"EyeHappy_{s}", face.eye_arc(s, "happy"), f"eyeHappy_{s}", material="Line"))
        parts.append(_rigid(f"EyeSleep_{s}", face.eye_arc(s, "sleep"), f"eyeSleep_{s}", material="Line"))
        parts.append(_rigid(f"Brow_{s}", face.brow(s), f"brow_{s}", material="Line"))
    parts.append(_rigid("Nose", face.nose(), "head", material="Nose"))
    parts.append(_rigid("MouthSmile", face.mouth_smile(), "mouthSmile", material="Line"))
    V, F, N, ids = face.mouth_open()
    parts.append(Part("MouthOpen", V, F, materials=["MouthInside", "Tongue", "Line"], material_ids=ids,
                      normals=N, weights={"mouthOpen": np.ones(len(V))}))
    for p in parts:
        if p.name in ao.CONTEXT:
            p.ao = ao.bake(p.name, np.asarray(p.verts), np.asarray(p.normals))
    return parts


def bone_table():
    """config.bone_table() with expression pivots moved just inside the real head surface."""
    bt = C.bone_table()
    for name, head in face.expression_pivots().items():
        parent, _, _ = bt[name]
        h = tuple(float(v) for v in head)
        bt[name] = (parent, h, (h[0], h[1], h[2] + 0.04))
    return bt
