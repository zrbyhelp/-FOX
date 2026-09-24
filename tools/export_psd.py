"""Layered PSD of the Live2D-style puppet art (for rigging a real Cubism model in Live2D Cubism
Editor). Reads web/public/live2d/layers.json + layers/*.png (web/scripts/render_layers.mjs).

    .venv/bin/python tools/export_psd.py        -> models/fox_live2d_layers.psd
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
L2D = ROOT / "web" / "public" / "live2d"
OUT = ROOT / "models" / "fox_live2d_layers.psd"


def main():
    from pytoshop import enums
    from pytoshop.user import nested_layers as nl

    meta = json.loads((L2D / "layers.json").read_text(encoding="utf-8"))
    ppu = meta["pxPerUnit"]
    comp = meta["composite"]
    # canvas = the composite frame (model units -> pixels, y down)
    X0, Y1 = comp["x0"], comp["y0"] + comp["h"]
    W, H = int(round(comp["w"] * ppu)), int(round(comp["h"] * ppu))
    layers = []
    for L in meta["layers"]:            # back-to-front
        im = np.asarray(Image.open(L2D / L["file"]).convert("RGBA"))
        left = int(round((L["x0"] - X0) * ppu))
        top = int(round((Y1 - (L["y0"] + L["h"])) * ppu))
        h, w = im.shape[:2]
        chans = {0: im[..., 0], 1: im[..., 1], 2: im[..., 2], -1: im[..., 3]}
        layers.append(nl.Image(name=L["name"], visible=True, opacity=255, top=top, left=left,
                               bottom=top + h, right=left + w, channels=chans))
    # hidden-by-default expression layers (Live2D toggles them via parameters)
    for lay in layers:
        if lay.name in ("EyeHappy_L", "EyeHappy_R", "EyeSleep_L", "EyeSleep_R", "Brow_L", "Brow_R", "MouthOpen"):
            lay.visible = False
    psd = nl.nested_layers_to_psd(layers[::-1], enums.ColorMode.rgb, size=(H, W))   # top layer first
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "wb") as f:
        psd.write(f)
    print(f"wrote {OUT} ({W}x{H}, {len(layers)} layers)")


if __name__ == "__main__":
    sys.exit(main())
