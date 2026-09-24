"""Motion QA on the exported glb (what the browser plays): per-frame angular velocity of every
bone rotation track and root/hips translation; flags twitches (sudden velocity changes).

    .venv/bin/python tools/motion_qa.py [build/fox.raw.glb] [--verbose]
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pygltflib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fox_build import config as C  # noqa: E402
from validate_glb import accessor  # noqa: E402

JERK_DEG = 6.0        # change of angular velocity between consecutive frames (deg/frame)
JERK_TAIL = 10.0      # fast happy tail wags are intended
SPEED_DEG = 25.0      # angular speed per frame considered a pop
LOC_JERK = 0.006      # translation velocity change per frame (m)


def angle(a, b):
    d = np.abs((a * b).sum(-1)).clip(0, 1)
    return np.degrees(2 * np.arccos(d))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = Path(args[0]) if args else C.RAW_GLB
    verbose = "--verbose" in sys.argv
    g = pygltflib.GLTF2().load(str(path))
    blob = g.binary_blob()
    bad_clips = 0
    for an in g.animations:
        issues = []
        for ch in an.channels:
            node = g.nodes[ch.target.node].name
            s = an.samplers[ch.sampler]
            v = accessor(g, blob, s.output).astype(np.float64)
            if len(v) < 4:
                continue
            if ch.target.path == "rotation":
                q = v[:, [3, 0, 1, 2]]
                w = angle(q[1:], q[:-1])            # deg per frame
                jerk = np.abs(np.diff(w))
                i = int(np.argmax(jerk))
                lim = JERK_TAIL if node.startswith("tail_") else JERK_DEG
                if jerk[i] > lim or w.max() > SPEED_DEG:
                    issues.append((max(jerk[i], w.max()), f"{node}.rot jerk {jerk[i]:.1f}°/f² @f{i + 1}, max speed {w.max():.1f}°/f"))
            elif ch.target.path == "translation" and node in ("root", "hips"):
                vel = np.linalg.norm(np.diff(v, axis=0), axis=1)
                acc = np.abs(np.diff(vel))
                i = int(np.argmax(acc))
                if acc[i] > LOC_JERK:
                    issues.append((acc[i] * 1000, f"{node}.loc jerk {acc[i] * 1000:.1f}mm/f² @f{i + 1}"))
        issues.sort(reverse=True)
        ok = not issues
        bad_clips += not ok
        print(f"  {'PASS' if ok else 'FAIL'}  {an.name:16s} " + ("" if ok else "; ".join(t for _, t in issues[: (20 if verbose else 4)])))
    print(f"{len(g.animations) - bad_clips}/{len(g.animations)} clips smooth")
    sys.exit(1 if bad_clips else 0)


if __name__ == "__main__":
    main()
