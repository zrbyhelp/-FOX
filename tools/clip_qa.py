"""Interpenetration QA: skins every part at sampled frames of every clip and measures how deep
limbs / tail sink into other parts (nearest-surface test against the posed mesh + normals).

    .venv/bin/python tools/clip_qa.py [--every 3] [--verbose]
Exit code 1 when a pair exceeds its allowed depth.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fox_build import clips as CL, model  # noqa: E402
from fox_build.poses import Rig, Skin  # noqa: E402

# (mover, obstacle, allowed depth in m, ignore mover vertices within R of these joints)
PAIRS = [
    ("Arm_L", "Body", 0.018, ("upperArm_L", 0.085)),
    ("Arm_R", "Body", 0.018, ("upperArm_R", 0.085)),
    # arm roots within ~10 cm of the shoulder pivot sit under the scarf ring (hidden)
    ("Arm_L", "Head", 0.012, ("upperArm_L", 0.10)),
    ("Arm_R", "Head", 0.012, ("upperArm_R", 0.10)),
    # the flap is thin: tested against its volume (FlapGuard spheres), not the nearest-surface normal
    ("Arm_L", "ScarfFlap", 0.008, ("upperArm_L", 0.10)),
    ("Arm_R", "ScarfFlap", 0.008, ("upperArm_R", 0.10)),
    ("Arm_L", "Arm_R", 0.012, None),
    ("Tail", "Body", 0.020, ("tail_1", 0.12)),
    ("Tail", "Leg_L", 0.010, None),
    ("Tail", "Leg_R", 0.010, None),
    ("Leg_L", "Leg_R", 0.008, None),
]


def depth(mover_v, obs_v, obs_n, tree):
    """Penetration depth of each mover vertex (0 if outside)."""
    d, i = tree.query(mover_v, k=1)
    s = ((mover_v - obs_v[i]) * obs_n[i]).sum(1)     # signed distance along obstacle normal
    return np.where((s < 0) & (d < 0.05), -s, 0.0)


def main():
    every = int(sys.argv[sys.argv.index("--every") + 1]) if "--every" in sys.argv else 3
    verbose = "--verbose" in sys.argv
    parts = {p.name: p for p in model.build_parts()}
    rig = Rig(model.bone_table())
    ground_skin = Skin(rig, list(parts.values()), names={"Body", "Leg_L", "Leg_R"}, stride=3)
    tail_skin = Skin(rig, list(parts.values()), names={"Tail"}, stride=2)
    flap = CL.FlapGuard(rig, list(parts.values()))
    names = {n for pr in PAIRS for n in pr[:2]}
    skins = {n: Skin(rig, [parts[n]]) for n in names}
    rest_N = {n: np.asarray(parts[n].normals) for n in names}
    rows = []; fail = False
    for clip in CL.make_clips(rig):
        n = int(round(clip.duration * CL.FPS))
        # finalize every frame, exactly like the build (series smoothing depends on the frame
        # spacing), then test every `every`-th
        allf = list(range(0, n + 1))
        full = CL.finalize_series(clip, [clip.pose_at(f / CL.FPS) for f in allf], ground_skin, tail_skin, flap)
        fs = allf[::every]
        poses = full[::every]
        worst = {}
        for f, pose in zip(fs, poses):
            Qw, Hw = rig.fk(pose)
            V = {k: skins[k].deform(pose) for k in names}
            N = {k: skins[k].deform_normals(pose, rest_N[k]) for k in names}
            trees = {}
            for mover, obs, allow, ign in PAIRS:
                mv = V[mover]
                if ign:
                    mv = mv[np.linalg.norm(mv - Hw[ign[0]], axis=1) > ign[1]]
                if not len(mv):
                    continue
                if obs == "ScarfFlap":
                    dp = flap.depth(pose, mv)
                else:
                    trees.setdefault(obs, cKDTree(V[obs]))
                    dp = depth(mv, V[obs], N[obs], trees[obs]).max()
                key = f"{mover}>{obs}"
                if dp > worst.get(key, (0, 0, 0))[0]:
                    worst[key] = (dp, f, allow)
        bad = {k: v for k, v in worst.items() if v[0] > v[2]}
        fail |= bool(bad)
        shown = bad if not verbose else worst
        txt = "; ".join(f"{k} {v[0] * 100:.1f}cm@f{v[1]}" for k, v in sorted(shown.items(), key=lambda x: -x[1][0]))
        rows.append((clip.name, not bad, txt))
    for name, ok, txt in rows:
        print(f"  {'PASS' if ok else 'FAIL'}  {name:16s} {txt}")
    print(f"{sum(ok for _, ok, _ in rows)}/{len(rows)} clips without clipping")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
