"""Single build entry point.

    .venv/bin/python tools/build.py              # full model (Windows: .venv\\Scripts\\python)
    .venv/bin/python tools/build.py --blockout   # capsule stand-ins on the real skeleton
    .venv/bin/python tools/build.py --no-logo --no-blend

Outputs: web/public/models/fox.glb, logo.glb, clips.json and models/fox.blend.
Holds an exclusive lock (.build.lock) so concurrent builds cannot clobber each other.
"""
from __future__ import annotations

import argparse
import contextlib
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fox_build import config as C  # noqa: E402


def build_fox(bpy, blockout: bool, save_blend: bool, out_name: str = "fox"):
    from fox_build import anim, assemble, clips, export, rig

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = C.FPS
    col = scene.collection

    t0 = time.time()
    if blockout:
        from fox_build import blockout as model
    else:
        try:
            from fox_build import model  # full SDF / parametric model
        except ImportError:
            print("[build] fox_build.model not found -> using blockout")
            from fox_build import blockout as model
    parts = model.build_parts()
    print(f"[build] parts: {len(parts)} ({time.time() - t0:.1f}s)")

    bt = model.bone_table() if hasattr(model, "bone_table") else None
    arm = rig.create_armature(bpy, col, bt)
    tris = 0
    for p in parts:
        assemble.create_object(bpy, p, arm, col)
        tris += len(p.faces)
    print(f"[build] triangles: {tris}")

    t1 = time.time()
    meta = clips.build_clips(bpy, arm, parts, bt)
    anim.reset_pose(arm)
    print(f"[build] clips: {list(meta)} ({time.time() - t1:.1f}s)")

    out_glb = C.OUT_GLB if out_name == "fox" else C.OUT_GLB.parent / "dev" / f"{out_name}.glb"
    out_clips = C.OUT_CLIPS_JSON if out_name == "fox" else out_glb.with_suffix(".clips.json")
    export.export_glb(bpy, out_glb)
    export.postprocess_fox(out_glb)
    export.write_clips_json(meta, out_clips)
    print(f"[build] wrote {out_glb} ({out_glb.stat().st_size / 1e6:.2f} MB)")
    if save_blend and out_name == "fox":
        C.OUT_BLEND.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(C.OUT_BLEND), compress=True)
        print(f"[build] wrote {C.OUT_BLEND}")


def build_logo(bpy):
    try:
        from fox_build import logo
    except ImportError:
        print("[build] fox_build.logo not found -> skipping logo")
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    logo.build(bpy)
    from fox_build import export
    export.export_glb(bpy, C.OUT_LOGO_GLB, export_animations=False, export_skins=False)
    print(f"[build] wrote {C.OUT_LOGO_GLB}")


@contextlib.contextmanager
def build_lock(path):
    """Exclusive inter-process lock (fcntl on Unix, msvcrt on Windows)."""
    with open(path, "a+") as lf:
        try:
            import fcntl
            try:
                fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print("[build] another build is running; waiting for the lock...")
                fcntl.flock(lf, fcntl.LOCK_EX)
        except ImportError:
            import msvcrt
            lf.seek(0)
            while True:
                try:
                    msvcrt.locking(lf.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    time.sleep(0.5)
        yield


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blockout", action="store_true")
    ap.add_argument("--no-logo", action="store_true")
    ap.add_argument("--no-blend", action="store_true")
    ap.add_argument("--no-fox", action="store_true")
    ap.add_argument("--out-name", default="fox",
                    help="'fox' -> web/public/models/fox.glb (+ .blend); anything else -> "
                         "web/public/models/dev/<name>.glb (scratch output, no .blend)")
    a = ap.parse_args()

    with build_lock(C.ROOT / ".build.lock"):
        import bpy
        if not a.no_fox:
            build_fox(bpy, a.blockout, not a.no_blend, a.out_name)
        if not a.no_logo:
            build_logo(bpy)


if __name__ == "__main__":
    main()
