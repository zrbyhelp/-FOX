"""Validate web/public/models/{fox,logo}.glb against spec.json and budgets.

    .venv/bin/python tools/validate_glb.py [path/to/fox.glb] [--khronos]
Defaults to the uncompressed build/fox.raw.glb (pygltflib cannot decode meshopt buffers);
the shipped compressed web/public/models/fox.glb is checked structurally.
Exit code 1 on any failure.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import pygltflib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fox_build import config as C  # noqa: E402

COMP = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
FUR_MESHES = ["Head", "Body", "Arm_L", "Arm_R", "Leg_L", "Leg_R", "Tail", "Scarf", "ScarfFlap"]
CLOSED = ["Head", "Body", "Arm_L", "Arm_R", "Leg_L", "Leg_R", "Tail"]


class Report:
    def __init__(self):
        self.rows = []

    def check(self, ok, name, detail=""):
        self.rows.append((bool(ok), name, detail))

    def print(self):
        for ok, n, d in self.rows:
            print(f"  {'PASS' if ok else 'FAIL'}  {n}{(' — ' + d) if d else ''}")
        bad = sum(not ok for ok, _, _ in self.rows)
        print(f"{len(self.rows) - bad}/{len(self.rows)} checks passed")
        return bad == 0


def accessor(g, blob, i):
    a = g.accessors[i]
    bv = g.bufferViews[a.bufferView]
    n = NCOMP[a.type]
    arr = np.frombuffer(blob, COMP[a.componentType], a.count * n, (bv.byteOffset or 0) + (a.byteOffset or 0))
    arr = arr.reshape(a.count, n) if n > 1 else arr
    if a.normalized:
        arr = arr.astype(np.float32) / np.iinfo(COMP[a.componentType]).max
    return arr


def sanitize(name):
    return re.sub(r"[\[\]\.:/]", "", re.sub(r"\s", "_", name))


def validate_fox(path: Path, r: Report):
    g = pygltflib.GLTF2().load(str(path))
    blob = g.binary_blob()
    names = [n.name for n in g.nodes]
    san = [sanitize(n) for n in names if n]
    r.check(len(san) == len(set(san)), "sanitized node names unique")
    spec_bones = [b["name"] for b in C.SPEC["bones"]]
    missing = [b for b in spec_bones if b not in names]
    r.check(not missing, "all spec bones present", ", ".join(missing))
    r.check(len(g.skins) >= 1, "has a skin")

    clips = {a.name: a for a in g.animations}
    miss = [c for c in C.CLIP_NAMES if c not in clips]
    r.check(not miss, f"all {len(C.CLIP_NAMES)} clips present", ", ".join(miss))
    for cname, a in clips.items():
        chans = {}
        for ch in a.channels:
            chans.setdefault(g.nodes[ch.target.node].name, set()).add(ch.target.path)
        no_rot = [b for b in C.DEFORM_BONES if "rotation" not in chans.get(b, set())]
        no_scale = [b for b in C.EXPRESSION_BONES if "scale" not in chans.get(b, set())]
        r.check(not no_rot and not no_scale, f"clip {cname}: channels complete",
                f"no rot: {no_rot[:4]} no scale: {no_scale[:4]}" if (no_rot or no_scale) else "")
        for s in a.samplers:
            v = accessor(g, blob, s.output)
            if not np.isfinite(v).all():
                r.check(False, f"clip {cname}: finite keys"); break

    meshes = {m.name: m for m in g.meshes}
    miss = [m for m in C.SPEC["meshes"] if m not in meshes]
    r.check(not miss, "all spec meshes present", ", ".join(miss))
    tris = 0
    for m in g.meshes:
        for p in m.primitives:
            tris += g.accessors[p.indices].count // 3
            pos = accessor(g, blob, p.attributes.POSITION)
            if not np.isfinite(pos).all():
                r.check(False, f"{m.name}: finite positions")
            if p.attributes.WEIGHTS_0 is not None:
                w = accessor(g, blob, p.attributes.WEIGHTS_0).astype(np.float64)
                err = np.abs(w.sum(1) - 1).max()
                if err > 0.01:
                    r.check(False, f"{m.name}: weights normalised", f"max err {err:.3f}")
            else:
                r.check(False, f"{m.name}: skinned")
        if m.name in FUR_MESHES:
            has_col = all(p.attributes.COLOR_0 is not None for p in m.primitives)
            r.check(has_col, f"{m.name}: COLOR_0")
        if m.name in CLOSED:
            p = m.primitives[0]
            V = accessor(g, blob, p.attributes.POSITION).astype(np.float64)
            F = accessor(g, blob, p.indices).reshape(-1, 3).astype(np.int64)
            vol = np.einsum("ij,ij->i", V[F[:, 0]], np.cross(V[F[:, 1]], V[F[:, 2]])).sum() / 6
            r.check(vol > 0, f"{m.name}: positive volume", f"{vol:.5f}")
    r.check(tris <= C.BUDGET["fox_triangles"], "triangle budget", f"{tris} <= {C.BUDGET['fox_triangles']}")
    size = path.stat().st_size
    r.check(size <= C.BUDGET["glb_bytes_raw"], "file size budget", f"{size / 1e6:.2f} MB")

    hidden = set(C.SPEC["expressions"]["defaultHidden"])
    hs = np.array(C.SPEC["expressions"]["hiddenScale"])
    bad = [n.name for n in g.nodes if n.name in hidden and not np.allclose(n.scale or [1, 1, 1], hs)]
    r.check(not bad, "expression bones hidden by default", ", ".join(bad))
    mats = {m.name for m in g.materials}
    r.check({"Fur", "Scarf", "Eye", "Line", "Nose"} <= mats, "core materials present", ", ".join(sorted(mats)))


def validate_logo(path: Path, r: Report):
    if not path.exists():
        r.check(False, "logo.glb exists")
        return
    g = pygltflib.GLTF2().load(str(path))
    names = {n.name for n in g.nodes}
    miss = [p for p in C.SPEC["logo"]["pieces"] if p not in names]
    r.check(not miss, "logo pieces present", ", ".join(miss))
    r.check({"LogoCube", "LogoStar"} <= {m.name for m in g.materials}, "logo materials present")


def validate_shipped(path: Path, r: Report):
    """Structure of the compressed glb the web app loads (names, clips, one shared skin)."""
    g = pygltflib.GLTF2().load(str(path))
    names = {n.name for n in g.nodes}
    r.check(all(b["name"] in names for b in C.SPEC["bones"]), f"{path.name}: bones present")
    r.check({a.name for a in g.animations} >= set(C.CLIP_NAMES), f"{path.name}: clips present")
    r.check(len(g.skins) == 1, f"{path.name}: single shared skin", f"{len(g.skins)} skins")
    size = path.stat().st_size
    r.check(size <= 2_000_000, f"{path.name}: compressed size", f"{size / 1e6:.2f} MB")


def khronos(path: Path, r: Report):
    try:
        out = subprocess.run(["npx", "--yes", "gltf-validator", str(path), "-o"], capture_output=True,
                             text=True, timeout=300, cwd=C.ROOT / "web")
        txt = out.stdout + out.stderr
        m = re.search(r'"numErrors":\s*(\d+)', txt)
        errs = int(m.group(1)) if m else -1
        r.check(errs == 0, f"Khronos gltf-validator: {path.name}", f"errors={errs}")
    except Exception as e:  # noqa: BLE001
        r.check(False, "Khronos gltf-validator ran", str(e))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    fox = Path(args[0]) if args else C.RAW_GLB
    r = Report()
    print(f"validating {fox}")
    validate_fox(fox, r)
    validate_logo(C.OUT_LOGO_GLB, r)
    if not args and C.OUT_GLB.exists():
        validate_shipped(C.OUT_GLB, r)
    if "--khronos" in sys.argv:
        khronos(fox, r)
        khronos(C.OUT_LOGO_GLB, r)
    sys.exit(0 if r.print() else 1)


if __name__ == "__main__":
    main()
