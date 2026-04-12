#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""load_mesh 模块的单元测试"""

import struct
import tempfile
from pathlib import Path

import numpy as np
import pytest

from load_mesh import (
    MeshFileEmptyError,
    MeshFileError,
    MeshFileNotFoundError,
    MeshFileReadError,
    get_mesh_file_info,
    load_mesh_file,
)

# ---------------------------------------------------------------------------
# 测试数据路径
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_3DM_FILE = _PROJECT_ROOT / 'testcases' / 'testcase1' / 'target' / 'B004大.3dm'
_STL_FILE = _PROJECT_ROOT / 'testcases' / 'testcase4' / 'target' / '002大.stl'


def _assert_valid_mesh(vertices: np.ndarray, faces: np.ndarray) -> None:
    """断言 mesh 数据满足 pybind_wrapper.cpp:83-88 的要求"""
    assert vertices.dtype == np.float64, f"vertices dtype={vertices.dtype}, expected float64"
    assert vertices.ndim == 2 and vertices.shape[1] == 3, f"vertices shape={vertices.shape}"
    assert faces.dtype == np.int32, f"faces dtype={faces.dtype}, expected int32"
    assert faces.ndim == 2 and faces.shape[1] == 3, f"faces shape={faces.shape}"
    assert len(vertices) > 0, "vertices is empty"
    assert len(faces) > 0, "faces is empty"
    assert faces.max() < len(vertices), (
        f"face index {faces.max()} >= vertex count {len(vertices)}"
    )
    assert faces.min() >= 0, f"negative face index: {faces.min()}"


# ---------------------------------------------------------------------------
# Happy-path 测试
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not _3DM_FILE.exists(), reason="testcase1 .3dm data not available")
class TestLoad3DM:
    def test_happy_path(self) -> None:
        V, F = load_mesh_file(_3DM_FILE)
        _assert_valid_mesh(V, F)

    def test_mesh_quality_param(self) -> None:
        V, F = load_mesh_file(_3DM_FILE, mesh_quality='medium')
        _assert_valid_mesh(V, F)


@pytest.mark.skipif(not _STL_FILE.exists(), reason="testcase4 .stl data not available")
class TestLoadSTL:
    def test_happy_path(self) -> None:
        V, F = load_mesh_file(_STL_FILE)
        _assert_valid_mesh(V, F)

    def test_vertices_are_merged(self) -> None:
        """trimesh process=True 应合并重复顶点, 顶点数 < 面数*3"""
        V, F = load_mesh_file(_STL_FILE)
        assert len(V) < len(F) * 3, "vertices not merged — possibly missing trimesh process"


# ---------------------------------------------------------------------------
# 错误场景
# ---------------------------------------------------------------------------

class TestErrors:
    def test_file_not_found(self) -> None:
        with pytest.raises((MeshFileNotFoundError, MeshFileError)):
            load_mesh_file('/nonexistent/path/model.stl')

    def test_unsupported_extension(self, tmp_path: Path) -> None:
        fake = tmp_path / 'model.obj'
        fake.write_text('dummy')
        with pytest.raises(ValueError, match='不支持的文件格式'):
            load_mesh_file(fake)

    def test_empty_stl(self, tmp_path: Path) -> None:
        """80B header + 0 triangles → MeshFileEmptyError"""
        fake = tmp_path / 'empty.stl'
        with open(fake, 'wb') as f:
            f.write(b'\x00' * 80)  # header
            f.write(struct.pack('<I', 0))  # 0 triangles
        with pytest.raises((MeshFileEmptyError, MeshFileReadError, MeshFileError)):
            load_mesh_file(fake)


# ---------------------------------------------------------------------------
# get_mesh_file_info 测试
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not _3DM_FILE.exists(), reason="testcase1 .3dm data not available")
class TestInfo3DM:
    def test_info(self) -> None:
        info = get_mesh_file_info(_3DM_FILE)
        assert info['file_size'] > 0
        assert info['mesh_count'] >= 1 or info.get('brep_count', 0) >= 1


@pytest.mark.skipif(not _STL_FILE.exists(), reason="testcase4 .stl data not available")
class TestInfoSTL:
    def test_info(self) -> None:
        info = get_mesh_file_info(_STL_FILE)
        assert info['file_size'] > 0
        assert info['unit_system'] is None
        assert info['triangle_count'] > 0
