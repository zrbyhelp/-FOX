"""Numeric deformation QA: skin every part in numpy at sampled frames of every clip and flag
collapsed / over-stretched triangles and floor penetration (no rendering needed).

    .venv/bin/python tools/deform_qa.py [--every 4]
Exit code 1 on failure.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fox_build import clips as CL, model  # noqa: E402
from fox_build.poses import Rig, Skin  # noqa: E402

# Per-triangle area ratio vs bind pose. Inner elbow/wrist creases legitimately compress under
# linear-blend skinning (hidden inside the fold), so only near-degenerate or over-stretched
# triangles count as defects.
AREA_MIN, AREA_MAX = 0.10, 3.0
BAD_FRACTION = 0.006                 # allowed fraction of out-of-range triangles per part
FLOOR = -0.012                       # allowed penetration (m)
FACE = {"Eye_L", "Eye_R", "EyeHappy_L", "EyeHappy_R", "EyeSleep_L", "EyeSleep_R", "Brow_L",
        "Brow_R", "MouthSmile", "MouthOpen"}   # scaled by expression bones on purpose


def tri_area(V, F):
    return 0.5 * np.linalg.norm(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]), axis=1)


def main():
    every = 4
    if "--every" in sys.argv:
        every = int(sys.argv[sys.argv.index("--every") + 1])
    parts = [p for p in model.build_parts() if p.name not in FACE]
    rig = Rig(model.bone_table())
    ground_skin = Skin(rig, parts, names={"Body", "Leg_L", "Leg_R"}, stride=3)
    tail_skin = Skin(rig, parts, names={"Tail"}, stride=2)
    skins = {p.name: Skin(rig, [p]) for p in parts}
    rest_area = {p.name: tri_area(np.asarray(p.verts), np.asarray(p.faces)) for p in parts}
    failures = []
    rows = []
    for clip in CL.make_clips(rig):
        n = int(round(clip.duration * CL.FPS))
        worst = {"area": 0.0, "floor": 0.0, "where": ""}
        for f in range(0, n + 1, every):
            pose = CL.finalize(clip, clip.pose_at(f / CL.FPS), ground_skin, tail_skin)
            for p in parts:
                V = skins[p.name].deform(pose)
                a = tri_area(V, np.asarray(p.faces)) / np.maximum(rest_area[p.name], 1e-12)
                bad = ((a < AREA_MIN) | (a > AREA_MAX)).mean()
                if bad > worst["area"]:
                    worst.update(area=bad, where=f"{p.name}@{f}")
                if clip.grounded:
                    mz = V[:, 2].min()
                    if mz < worst["floor"]:
                        worst["floor"] = mz
                        worst["floor_where"] = f"{p.name}@{f}"
        ok_area = worst["area"] <= BAD_FRACTION
        ok_floor = worst["floor"] >= FLOOR
        rows.append((clip.name, ok_area and ok_floor, worst))
        if not (ok_area and ok_floor):
            failures.append(clip.name)
    for name, ok, w in rows:
        print(f"  {'PASS' if ok else 'FAIL'}  {name:16s} bad-tri {w['area'] * 100:5.2f}% ({w['where']})"
              f"  floor {w['floor'] * 100:+.1f}cm {w.get('floor_where', '')}")
    print(f"{len(rows) - len(failures)}/{len(rows)} clips pass")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
