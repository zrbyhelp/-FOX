"""SDF -> clean triangle mesh: marching cubes -> isotropic remesh -> project to SDF -> normals."""
from __future__ import annotations

import time

import numpy as np

from . import sdf as S


def eval_grid(fn, lo, hi, voxel, pad=3, chunk=2_000_000):
    lo = np.asarray(lo, float) - pad * voxel
    hi = np.asarray(hi, float) + pad * voxel
    n = np.ceil((hi - lo) / voxel).astype(int) + 1
    xs = [lo[i] + np.arange(n[i]) * voxel for i in range(3)]
    vol = np.empty(n[0] * n[1] * n[2], dtype=np.float32)
    # iterate in x-slabs to bound memory
    per = max(1, chunk // (n[1] * n[2]))
    Y, Z = np.meshgrid(xs[1], xs[2], indexing="ij")
    yz = np.stack([Y.ravel(), Z.ravel()], 1)
    for i0 in range(0, n[0], per):
        i1 = min(n[0], i0 + per)
        X = np.repeat(xs[0][i0:i1], len(yz))
        P = np.column_stack([X, np.tile(yz, (i1 - i0, 1))])
        vol[i0 * len(yz):i1 * len(yz)] = fn(P)
    return vol.reshape(n), lo


def signed_volume(V, F):
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def mesh_sdf(fn, lo, hi, voxel=0.003, target_edge=0.007, keep_largest=True,
             project_iters=3, remesh_iters=6, adaptive=False, name="part", verbose=True):
    from skimage import measure
    import pymeshlab

    t0 = time.time()
    vol, origin = eval_grid(fn, lo, hi, voxel)
    if vol.min() >= 0:
        raise ValueError(f"{name}: SDF has no interior inside bbox")
    if (vol[[0, -1], :, :] < 0).any() or (vol[:, [0, -1], :] < 0).any() or (vol[:, :, [0, -1]] < 0).any():
        raise ValueError(f"{name}: SDF touches the bbox boundary; enlarge bbox")
    V, F, _, _ = measure.marching_cubes(-vol, level=0.0, spacing=(voxel,) * 3,
                                        allow_degenerate=False)
    V = V + origin
    t1 = time.time()

    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(V.astype(np.float64), F.astype(np.int32)))
    ms.meshing_remove_duplicate_vertices()
    if keep_largest:
        ms.meshing_remove_connected_component_by_face_number(mincomponentsize=200)
    ms.meshing_isotropic_explicit_remeshing(targetlen=pymeshlab.PureValue(target_edge),
                                            iterations=remesh_iters, adaptive=adaptive)
    m = ms.current_mesh()
    V = m.vertex_matrix().astype(np.float64)
    F = m.face_matrix().astype(np.int64)
    V = S.project(fn, V, iters=project_iters)
    if signed_volume(V, F) < 0:
        F = F[:, ::-1].copy()
    N = S.normals(fn, V)
    if verbose:
        print(f"[mesh] {name}: grid {vol.shape} mc {t1 - t0:.1f}s, remesh+proj {time.time() - t1:.1f}s"
              f" -> {len(V)} v / {len(F)} f")
    return V, F, N
