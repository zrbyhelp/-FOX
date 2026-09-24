"""glTF export with every option explicit + pygltflib post-processing."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from . import config as C

GLTF_OPTS = dict(
    export_format="GLB",
    export_yup=True,
    export_apply=True,
    export_normals=True,
    export_tangents=False,
    export_texcoords=True,
    export_attributes=True,          # exports _AO (three: geometry.attributes._ao)
    export_vertex_color="ACTIVE",
    export_all_vertex_colors=False,
    export_active_vertex_color_when_no_material=True,
    export_materials="EXPORT",
    export_image_format="AUTO",
    export_skins=True,
    export_influence_nb=4,
    export_all_influences=False,
    export_def_bones=False,
    export_rest_position_armature=True,
    export_leaf_bone=False,
    export_hierarchy_flatten_bones=False,
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_anim_single_armature=True,
    export_reset_pose_bones=True,
    export_force_sampling=True,
    export_frame_step=1,
    export_anim_slide_to_zero=True,
    export_negative_frame="SLIDE",
    export_optimize_animation_size=True,
    export_morph=False,
    export_lights=False,
    export_cameras=False,
    export_extras=False,
    use_selection=False,
    use_visible=False,
)


def export_glb(bpy, path: Path, **overrides):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    opts = dict(GLTF_OPTS)
    opts.update(overrides)
    bpy.ops.export_scene.gltf(filepath=str(path), **opts)
    return path


def postprocess_fox(path: Path):
    """Default-hide expression bones in the glTF node TRS so any viewer shows the neutral face."""
    import pygltflib
    g = pygltflib.GLTF2().load(str(path))
    hidden = set(C.SPEC["expressions"]["defaultHidden"])
    hs = list(C.SPEC["expressions"]["hiddenScale"])
    for n in g.nodes:
        if n.name in hidden:
            n.scale = hs
    g.save(str(path))
    return path


def write_clips_json(meta: dict, path: Path = C.OUT_CLIPS_JSON):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")


def compress_glb(src: Path, dst: Path) -> bool:
    """Meshopt + quantization via @gltf-transform/cli (web devDependency). One quantization
    volume for the whole scene keeps a single shared skin. Falls back to a plain copy."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    web = C.ROOT / "web"
    cli = web / "node_modules" / ".bin" / ("gltf-transform.cmd" if os.name == "nt" else "gltf-transform")
    if cli.exists():
        cmd = [str(cli), "meshopt", str(src), str(dst), "--level", "medium",
               "--quantization-volume", "scene", "--quantize-color", "12"]
        r = subprocess.run(cmd, cwd=web, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode == 0 and dst.exists():
            return True
        print("[build] meshopt compression failed, copying raw glb:\n" + r.stdout + r.stderr)
    else:
        print("[build] @gltf-transform/cli not installed (cd web && npm i) -> copying raw glb")
    shutil.copyfile(src, dst)
    return False
