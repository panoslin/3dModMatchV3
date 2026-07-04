#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一 mesh 文件加载模块

按文件后缀派发到不同的加载器：
- .3dm → load_3dm.load_3dm_file（rhino3dm）
- .stl → trimesh

返回格式统一为 (vertices: np.ndarray[N,3] float64, faces: np.ndarray[M,3] int32)，
可直接喂给 mesh_matcher.MeshMatcher.load_target_mesh / load_candidate_mesh。
"""

from __future__ import annotations

import os
import struct
import warnings
from pathlib import Path
from typing import Any, Dict, Tuple

import numpy as np


class MeshFileError(Exception):
    """Mesh 文件读取相关的通用异常基类"""
    pass


class MeshFileNotFoundError(MeshFileError):
    """文件不存在"""
    pass


class MeshFileReadError(MeshFileError):
    """文件读取 / 解析失败"""
    pass


class MeshFileEmptyError(MeshFileError):
    """文件为空或没有有效网格数据"""
    pass


# ---------------------------------------------------------------------------
# 内部: STL 加载
# ---------------------------------------------------------------------------

def _load_stl(path: Path) -> Tuple[np.ndarray, np.ndarray]:
    """用 trimesh 加载 STL 文件（自动识别 ASCII / 二进制）。

    trimesh process=True 会自动:
      - 合并重复顶点（merge_vertices）
      - 修复法线方向（fix_normals）

    Returns:
        (vertices float64[N,3], faces int32[M,3])
    """
    try:
        import trimesh
    except ImportError as e:
        raise MeshFileReadError(
            "trimesh 未安装，无法加载 STL 文件。请运行: pip install trimesh>=4.0"
        ) from e

    try:
        mesh = trimesh.load(str(path), file_type='stl', process=True, force='mesh')
    except Exception as e:
        raise MeshFileReadError(f"trimesh 加载 STL 失败: {e}") from e

    if mesh.is_empty or len(mesh.vertices) == 0 or len(mesh.faces) == 0:
        raise MeshFileEmptyError(f"STL 文件无有效网格数据: {path}")

    # 尝试修复非流形; 仅警告不 abort（BVHTree::isPointInside 对非流形敏感）
    try:
        mesh.fill_holes()
    except Exception:
        pass

    # 若 winding 不一致（典型于三方导出或自相交 STL），调用 trimesh.repair.fix_normals
    # 统一三角形定向。对 BVH 3 射线多数投票仍有帮助（减少"半翻转"区域的误判）。
    if not mesh.is_winding_consistent:
        try:
            import trimesh.repair as _repair
            _repair.fix_normals(mesh)
        except Exception:
            pass

    if not mesh.is_watertight:
        warnings.warn(
            f"STL 网格非水密（non-watertight）: {path}，"
            "BVH 射线投票的包裹率计算可能不准确"
        )

    V = np.ascontiguousarray(mesh.vertices, dtype=np.float64)
    F = np.ascontiguousarray(mesh.faces, dtype=np.int32)
    return V, F


# ---------------------------------------------------------------------------
# 公开 API
# ---------------------------------------------------------------------------

_SUPPORTED_EXTENSIONS = {'.3dm', '.stl'}


def load_mesh_file(
    file_path: str | Path,
    mesh_quality: str = 'high',
    raise_on_empty: bool = True,
) -> Tuple[np.ndarray, np.ndarray]:
    """加载 mesh 文件并返回 (vertices float64[N,3], faces int32[M,3])。

    按后缀派发:
      .3dm → load_3dm.load_3dm_file
      .stl → trimesh
    """
    path = Path(file_path)

    if not path.exists():
        raise MeshFileNotFoundError(f"文件不存在: {path}")
    if not path.is_file():
        raise ValueError(f"路径不是文件: {path}")

    suffix = path.suffix.lower()

    if suffix == '.3dm':
        from load_3dm import load_3dm_file, ThreeDMFileError
        try:
            return load_3dm_file(path, mesh_quality=mesh_quality, raise_on_empty=raise_on_empty)
        except ThreeDMFileError as e:
            raise MeshFileError(str(e)) from e

    if suffix == '.stl':
        return _load_stl(path)

    raise ValueError(
        f"不支持的文件格式: {suffix}（支持: {', '.join(sorted(_SUPPORTED_EXTENSIONS))}）"
    )


def get_mesh_file_info(file_path: str | Path) -> Dict[str, Any]:
    """获取 mesh 文件的元信息（不加载完整网格）。

    .3dm → load_3dm.get_3dm_file_info
    .stl → 读取三角形计数 + 文件大小
    """
    path = Path(file_path)

    if not path.exists():
        raise MeshFileNotFoundError(f"文件不存在: {path}")
    if not path.is_file():
        raise ValueError(f"路径不是文件: {path}")

    suffix = path.suffix.lower()

    if suffix == '.3dm':
        from load_3dm import get_3dm_file_info, ThreeDMFileError
        try:
            return get_3dm_file_info(path)
        except ThreeDMFileError as e:
            raise MeshFileError(str(e)) from e

    if suffix == '.stl':
        return _get_stl_file_info(path)

    raise ValueError(f"不支持的文件格式: {suffix}")


def _get_stl_file_info(path: Path) -> Dict[str, Any]:
    """读取 STL 文件的基本信息（不做 full parse）。

    二进制 STL: 80B header + 4B uint32 triangle_count + 50B * N triangles
    ASCII STL:  以 'solid ' 开头，逐行 facet normal ...
    """
    file_size = path.stat().st_size
    triangle_count = 0

    try:
        with open(path, 'rb') as f:
            header = f.read(80)
            raw = f.read(4)
            if len(raw) == 4:
                tri_count = struct.unpack('<I', raw)[0]
                expected_size = 80 + 4 + tri_count * 50
                # 如果文件大小和二进制 STL 预期一致（±1），认为是二进制
                if abs(file_size - expected_size) <= 1:
                    triangle_count = tri_count
    except Exception:
        pass

    return {
        'file_path': str(path),
        'file_size': file_size,
        'object_count': 1 if triangle_count > 0 else 0,
        'mesh_count': 1 if triangle_count > 0 else 0,
        'brep_count': 0,
        'curve_count': 0,
        'triangle_count': triangle_count,
        'unit_system': None,  # STL 不含单位信息
    }
