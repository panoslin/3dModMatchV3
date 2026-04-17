"""Shared coordinate-frame and rotation utilities used by web_viewer.py and server.py.

Replicates the C++ alignDirections() logic in Python so that the frontend
preview coordinates match the backend wrapping-ratio computation exactly.
"""

from __future__ import annotations

import math
import numpy as np


def normalize(v: np.ndarray) -> np.ndarray:
    """Return unit vector; zero vector is returned unchanged."""
    n = np.linalg.norm(v)
    return v if n == 0 else (v / n)


def build_frame(longitudinal: np.ndarray, vertical: np.ndarray) -> np.ndarray:
    """Build an orthonormal 3x3 frame [x, y, z] matching C++ alignDirections."""
    x = normalize(longitudinal)
    side = np.cross(x, vertical)
    if np.linalg.norm(side) < 1e-6:
        if abs(x[0]) < 0.9:
            side = np.cross(x, np.array([1.0, 0.0, 0.0]))
        else:
            side = np.cross(x, np.array([0.0, 1.0, 0.0]))
    y = normalize(side)
    z = normalize(np.cross(x, y))
    return np.column_stack([x, y, z])


def rodrigues_rotation(axis: np.ndarray, angle_rad: float) -> np.ndarray:
    """Compute 3x3 rotation matrix via Rodrigues' formula."""
    k = normalize(axis)
    K = np.array([
        [0, -k[2], k[1]],
        [k[2], 0, -k[0]],
        [-k[1], k[0], 0],
    ])
    return np.eye(3) + math.sin(angle_rad) * K + (1 - math.cos(angle_rad)) * (K @ K)


def compute_alignment_rotation(
    target_vertices: np.ndarray,
    target_faces: np.ndarray,
    candidate_vertices: np.ndarray,
    candidate_faces: np.ndarray,
    mesh_matcher_module,
) -> np.ndarray:
    """Compute the 3x3 rotation matrix that aligns target to candidate frame.

    This mirrors C++ MeshMatcher::alignDirections() and returns:
        R = candidate_frame @ target_frame.T
    """
    def _axis(fn, verts, faces):
        return normalize(np.array(fn(
            verts.flatten().tolist(), faces.flatten().tolist()
        ), dtype=float))

    MM = mesh_matcher_module.MeshMatcher
    t_long = _axis(MM.compute_longitudinal_axis, target_vertices, target_faces)
    t_vert = _axis(MM.compute_vertical_axis, target_vertices, target_faces)
    c_long = _axis(MM.compute_longitudinal_axis, candidate_vertices, candidate_faces)
    c_vert = _axis(MM.compute_vertical_axis, candidate_vertices, candidate_faces)

    target_frame = build_frame(t_long, t_vert)
    candidate_frame = build_frame(c_long, c_vert)
    return candidate_frame @ target_frame.T
