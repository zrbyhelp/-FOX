"""Centripetal Catmull-Rom spline with arc-length parameterisation (numpy only)."""
from __future__ import annotations

import numpy as np


class Spline:
    def __init__(self, points, samples_per_seg: int = 200):
        p = np.asarray(points, dtype=np.float64)
        # phantom end points (reflect) so the curve passes through first/last point
        p = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])
        self.ctrl = p
        dense = []
        for i in range(1, len(p) - 2):
            ts = np.linspace(0.0, 1.0, samples_per_seg, endpoint=(i == len(p) - 3))
            dense.append(self._seg(p[i - 1], p[i], p[i + 1], p[i + 2], ts))
        self.dense = np.vstack(dense)
        seg = np.linalg.norm(np.diff(self.dense, axis=0), axis=1)
        self.cum = np.concatenate([[0.0], np.cumsum(seg)])
        self.length = float(self.cum[-1])

    @staticmethod
    def _seg(p0, p1, p2, p3, ts, alpha=0.5):
        def tj(ti, pi, pj):
            return ti + max(np.linalg.norm(pj - pi), 1e-9) ** alpha
        t0 = 0.0
        t1 = tj(t0, p0, p1)
        t2 = tj(t1, p1, p2)
        t3 = tj(t2, p2, p3)
        t = t1 + (t2 - t1) * ts[:, None]
        a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
        a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
        a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
        b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
        b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
        return (t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2

    def point_at_arclength(self, u):
        """u in [0,1] (fraction of total length) -> point(s)."""
        u = np.clip(np.asarray(u, dtype=np.float64), 0.0, 1.0)
        s = u * self.length
        idx = np.clip(np.searchsorted(self.cum, s) - 1, 0, len(self.cum) - 2)
        f = (s - self.cum[idx]) / np.maximum(self.cum[idx + 1] - self.cum[idx], 1e-12)
        f = f[..., None] if np.ndim(f) else f
        return self.dense[idx] * (1 - f) + self.dense[idx + 1] * f

    def tangent_at_arclength(self, u, h: float = 1e-3):
        a = self.point_at_arclength(np.clip(np.asarray(u) - h, 0, 1))
        b = self.point_at_arclength(np.clip(np.asarray(u) + h, 0, 1))
        d = b - a
        return d / np.linalg.norm(d, axis=-1, keepdims=True)

    def closest(self, pts):
        """For points (N,3) return (u in [0,1], distance) to the dense polyline (approx)."""
        pts = np.asarray(pts, dtype=np.float64)
        best_u = np.zeros(len(pts)); best_d = np.full(len(pts), np.inf)
        a = self.dense[:-1]; b = self.dense[1:]
        ab = b - a; L2 = np.maximum((ab ** 2).sum(1), 1e-12)
        # chunk over segments to bound memory
        for s in range(0, len(a), 64):
            aa = a[s:s + 64]; abab = ab[s:s + 64]; ll = L2[s:s + 64]
            ap = pts[:, None, :] - aa[None]
            t = np.clip((ap * abab[None]).sum(-1) / ll[None], 0, 1)
            proj = aa[None] + t[..., None] * abab[None]
            d = np.linalg.norm(pts[:, None, :] - proj, axis=-1)
            j = d.argmin(1); dj = d[np.arange(len(pts)), j]
            better = dj < best_d
            seg_i = s + j
            u = (self.cum[seg_i] + t[np.arange(len(pts)), j] * np.sqrt(L2[seg_i])) / self.length
            best_d = np.where(better, dj, best_d); best_u = np.where(better, u, best_u)
        return best_u, best_d
