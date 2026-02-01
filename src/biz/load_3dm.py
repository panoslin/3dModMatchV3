#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
独立的 3DM 文件读取模块

从 hybrid_matcher.py 中提取并重构的 3DM 文件解析功能。
提供完整的文件路径验证、文件打开、数据读取、异常处理以及资源释放。

主要功能：
- 支持多种几何类型（Mesh, Brep, NurbsCurve等）
- 自动 BREP 网格化
- 可配置的网格质量参数
- 完整的异常处理和资源管理
- 清晰的函数接口供其他模块调用

依赖：
    rhino3dm>=8.0
    numpy>=1.20.0

示例：
    from load_3dm import load_3dm_file
    
    vertices, faces = load_3dm_file('model.3dm', mesh_quality='high')
    print(f"Loaded {len(vertices)} vertices and {len(faces)} faces")
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Tuple, Dict, Any
import warnings

import numpy as np
import rhino3dm

# 抑制警告
warnings.filterwarnings('ignore')


class ThreeDMFileError(Exception):
    """3DM 文件读取相关的自定义异常"""
    pass


class ThreeDMFileNotFoundError(ThreeDMFileError):
    """文件不存在异常"""
    pass


class ThreeDMFileReadError(ThreeDMFileError):
    """文件读取失败异常"""
    pass


class ThreeDMFileEmptyError(ThreeDMFileError):
    """文件为空或没有有效数据异常"""
    pass


def validate_file_path(file_path: str | Path) -> Path:
    """
    验证文件路径的有效性
    
    Args:
        file_path: 文件路径（字符串或 Path 对象）
        
    Returns:
        Path: 验证后的 Path 对象
        
    Raises:
        ThreeDMFileNotFoundError: 文件不存在
        ValueError: 路径无效或不是文件
    """
    path = Path(file_path)
    
    # 检查路径是否存在
    if not path.exists():
        raise ThreeDMFileNotFoundError(f"文件不存在: {path}")
    
    # 检查是否为文件（而非目录）
    if not path.is_file():
        raise ValueError(f"路径不是文件: {path}")
    
    # 检查文件扩展名
    if path.suffix.lower() != '.3dm':
        raise ValueError(f"文件扩展名不是 .3dm: {path}")
    
    # 检查文件是否可读
    if not os.access(path, os.R_OK):
        raise PermissionError(f"文件不可读: {path}")
    
    # 检查文件大小（避免读取空文件或损坏文件）
    file_size = path.stat().st_size
    if file_size == 0:
        raise ThreeDMFileEmptyError(f"文件为空: {path}")
    if file_size < 100:  # 3DM 文件通常至少几百字节
        raise ThreeDMFileReadError(f"文件可能已损坏（大小仅 {file_size} 字节）: {path}")
    
    return path


def get_mesh_quality_params(mesh_quality: str = 'high') -> Dict[str, float]:
    """
    获取网格质量参数
    
    Args:
        mesh_quality: 网格质量级别 ('low', 'medium', 'high')
        
    Returns:
        Dict: 包含网格参数的字典
    """
    quality_params = {
        'low': {
            'max_angle': 0.5,
            'max_edge': 10.0,
            'max_dist': 1.0,
            'min_edge': 0.1
        },
        'medium': {
            'max_angle': 0.35,
            'max_edge': 5.0,
            'max_dist': 0.5,
            'min_edge': 0.05
        },
        'high': {
            'max_angle': 0.2,
            'max_edge': 2.5,
            'max_dist': 0.25,
            'min_edge': 0.02
        }
    }
    
    return quality_params.get(mesh_quality, quality_params['high'])


def extract_mesh_from_geometry(geometry: Any, mesh_quality: str = 'high') -> Optional[rhino3dm.Mesh]:
    """
    从几何对象中提取或创建网格
    
    Args:
        geometry: rhino3dm 几何对象
        mesh_quality: 网格质量级别
        
    Returns:
        Optional[rhino3dm.Mesh]: 提取的网格对象，如果无法提取则返回 None
    """
    mesh = None
    
    # 尝试直接获取现有网格
    if isinstance(geometry, rhino3dm.Mesh):
        mesh = geometry
    elif hasattr(geometry, 'GetMesh'):
        try:
            mesh = geometry.GetMesh(rhino3dm.MeshType.Default)
        except Exception:
            pass
    
    # 如果仍然没有网格，尝试从 BREP 创建
    if mesh is None and isinstance(geometry, rhino3dm.Brep):
        try:
            params = get_mesh_quality_params(mesh_quality)
            meshing_params = rhino3dm.MeshingParameters()
            meshing_params.MaximumEdgeLength = params['max_edge']
            meshing_params.MinimumEdgeLength = params['min_edge']
            meshing_params.MaximumAngle = params['max_angle']
            meshing_params.MaximumDistance = params['max_dist']
            meshing_params.GridMinCount = 16
            meshing_params.SimplePlanes = True
            meshing_params.RefineGrid = True
            
            meshes = rhino3dm.Mesh.CreateFromBrep(geometry, meshing_params)
            if meshes and len(meshes) > 0:
                # 合并多个网格
                mesh = rhino3dm.Mesh()
                for m in meshes:
                    if m and len(m.Vertices) > 0:
                        mesh.Append(m)
        except Exception as e:
            warnings.warn(f"BREP 网格化失败: {e}")
    
    return mesh if (mesh and len(mesh.Vertices) > 0) else None


def extract_faces_from_mesh(mesh: rhino3dm.Mesh, vertex_offset: int = 0) -> list:
    """
    从网格中提取面索引
    
    Args:
        mesh: rhino3dm.Mesh 对象
        vertex_offset: 顶点偏移量（用于合并多个网格）
        
    Returns:
        list: 面索引列表，每个元素是 [a, b, c] 或 [a, b, c, d]
    """
    faces = []
    
    for face in mesh.Faces:
        try:
            # 优先使用 A/B/C/D 属性
            if hasattr(face, 'A'):
                a, b, c = face.A, face.B, face.C
                faces.append([a + vertex_offset, b + vertex_offset, c + vertex_offset])
                
                # 处理四边形（如果 D 有效）
                d = getattr(face, 'D', None)
                if d is not None and d not in (c, -1):
                    faces.append([a + vertex_offset, c + vertex_offset, d + vertex_offset])
            else:
                # 备用方法：索引访问
                a, b, c = face[0], face[1], face[2]
                faces.append([a + vertex_offset, b + vertex_offset, c + vertex_offset])
                
                if len(face) >= 4:
                    d = face[3]
                    if d != c and d != -1:
                        faces.append([a + vertex_offset, c + vertex_offset, d + vertex_offset])
        except Exception as e:
            warnings.warn(f"提取面索引失败: {e}")
            continue
    
    return faces


def load_3dm_file(
    file_path: str | Path,
    mesh_quality: str = 'high',
    validate_path: bool = True,
    raise_on_empty: bool = True
) -> Tuple[np.ndarray, np.ndarray]:
    """
    加载 3DM 文件并提取顶点和面数据
    
    Args:
        file_path: 3DM 文件路径
        mesh_quality: 网格质量级别 ('low', 'medium', 'high')
        validate_path: 是否在读取前验证文件路径
        raise_on_empty: 如果没有找到网格数据是否抛出异常
        
    Returns:
        Tuple[np.ndarray, np.ndarray]: (vertices, faces)
            - vertices: Nx3 的顶点数组，dtype=np.float64
            - faces: Mx3 的面索引数组，dtype=np.int32
            
    Raises:
        ThreeDMFileNotFoundError: 文件不存在
        ThreeDMFileReadError: 文件读取失败
        ThreeDMFileEmptyError: 文件为空或没有有效数据
        ValueError: 参数无效
    """
    # 验证文件路径
    if validate_path:
        path = validate_file_path(file_path)
    else:
        path = Path(file_path)
    
    # 读取 3DM 文件
    model = None
    try:
        model = rhino3dm.File3dm.Read(str(path))
        if not model:
            raise ThreeDMFileReadError(f"无法读取 3DM 文件: {path}")
    except Exception as e:
        if isinstance(e, (ThreeDMFileReadError, ThreeDMFileNotFoundError, ThreeDMFileEmptyError)):
            raise
        raise ThreeDMFileReadError(f"读取 3DM 文件时发生错误: {e}") from e
    
    # 提取顶点和面
    all_vertices = []
    all_faces = []
    vertex_offset = 0
    mesh_count = 0
    
    try:
        for obj in model.Objects:
            geometry = obj.Geometry
            mesh = extract_mesh_from_geometry(geometry, mesh_quality)
            
            if mesh:
                mesh_count += 1
                
                # 提取顶点
                vertices = np.array(
                    [[v.X, v.Y, v.Z] for v in mesh.Vertices],
                    dtype=np.float64
                )
                all_vertices.append(vertices)
                
                # 提取面
                faces = extract_faces_from_mesh(mesh, vertex_offset)
                all_faces.extend(faces)
                
                vertex_offset += len(vertices)
        
        # 检查是否有有效数据
        if not all_vertices:
            if raise_on_empty:
                raise ThreeDMFileEmptyError(
                    f"文件中没有找到网格数据: {path}\n"
                    f"找到 {len(model.Objects)} 个对象，但无法提取网格"
                )
            else:
                # 返回空数组
                return (
                    np.zeros((0, 3), dtype=np.float64),
                    np.zeros((0, 3), dtype=np.int32)
                )
        
        # 合并所有顶点
        vertices = np.vstack(all_vertices) if len(all_vertices) > 1 else all_vertices[0]
        
        # 转换面索引为 numpy 数组
        faces = np.asarray(all_faces, dtype=np.int32)
        
        # 验证数据有效性
        if len(vertices) == 0:
            raise ThreeDMFileEmptyError(f"提取的顶点数为 0: {path}")
        
        if len(faces) == 0:
            raise ThreeDMFileEmptyError(f"提取的面数为 0: {path}")
        
        # 验证面索引的有效性
        max_vertex_idx = len(vertices) - 1
        invalid_faces = faces >= len(vertices)
        if np.any(invalid_faces):
            warnings.warn(
                f"发现无效的面索引（超出顶点范围）: {path}\n"
                f"最大顶点索引: {max_vertex_idx}, 但面索引中有: {faces[invalid_faces].max()}"
            )
            # 过滤无效面
            valid_mask = np.all(faces <= max_vertex_idx, axis=1)
            faces = faces[valid_mask]
        
        return vertices, faces
        
    except Exception as e:
        if isinstance(e, (ThreeDMFileEmptyError, ThreeDMFileReadError)):
            raise
        raise ThreeDMFileReadError(f"处理 3DM 文件数据时发生错误: {e}") from e
    
    finally:
        # 资源释放（rhino3dm 对象通常会自动管理，但显式清理更安全）
        if model is not None:
            # rhino3dm 对象在 Python 中通常由垃圾回收器管理
            # 这里可以添加额外的清理逻辑（如果需要）
            del model


def get_3dm_file_info(file_path: str | Path) -> Dict[str, Any]:
    """
    获取 3DM 文件的元信息（不加载完整网格数据）
    
    Args:
        file_path: 3DM 文件路径
        
    Returns:
        Dict: 包含文件信息的字典
            - file_path: 文件路径
            - file_size: 文件大小（字节）
            - object_count: 对象数量
            - mesh_count: 网格对象数量
            - has_brep: 是否包含 BREP 对象
            - unit_system: 单位系统
    """
    path = validate_file_path(file_path)
    
    model = None
    try:
        model = rhino3dm.File3dm.Read(str(path))
        if not model:
            raise ThreeDMFileReadError(f"无法读取 3DM 文件: {path}")
        
        info = {
            'file_path': str(path),
            'file_size': path.stat().st_size,
            'object_count': len(model.Objects),
            'mesh_count': 0,
            'brep_count': 0,
            'curve_count': 0,
            'unit_system': None
        }
        
        # 统计对象类型
        for obj in model.Objects:
            geom = obj.Geometry
            if isinstance(geom, rhino3dm.Mesh):
                info['mesh_count'] += 1
            elif isinstance(geom, rhino3dm.Brep):
                info['brep_count'] += 1
            elif isinstance(geom, rhino3dm.NurbsCurve):
                info['curve_count'] += 1
        
        # 获取单位系统
        try:
            info['unit_system'] = str(model.Settings.ModelUnitSystem)
        except Exception:
            pass
        
        return info
        
    except Exception as e:
        raise ThreeDMFileReadError(f"读取文件信息时发生错误: {e}") from e
    
    finally:
        if model is not None:
            del model


# ========== CLI 接口 ==========

def main():
    """命令行接口"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='3DM 文件读取工具',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 加载 3DM 文件
  python load_3dm.py --input model.3dm
  
  # 获取文件信息
  python load_3dm.py --input model.3dm --info-only
  
  # 指定网格质量
  python load_3dm.py --input model.3dm --mesh-quality medium
        """
    )
    
    parser.add_argument(
        '--input', '-i',
        required=True,
        help='输入的 3DM 文件路径'
    )
    
    parser.add_argument(
        '--mesh-quality',
        choices=['low', 'medium', 'high'],
        default='high',
        help='网格质量级别（默认: high）'
    )
    
    parser.add_argument(
        '--info-only',
        action='store_true',
        help='仅显示文件信息，不加载完整数据'
    )
    
    parser.add_argument(
        '--output',
        help='输出文件路径（可选，用于保存顶点和面数据）'
    )
    
    args = parser.parse_args()
    
    try:
        if args.info_only:
            # 仅显示文件信息
            info = get_3dm_file_info(args.input)
            print("=" * 60)
            print("3DM 文件信息")
            print("=" * 60)
            print(f"文件路径: {info['file_path']}")
            print(f"文件大小: {info['file_size']:,} 字节")
            print(f"对象总数: {info['object_count']}")
            print(f"  - 网格对象: {info['mesh_count']}")
            print(f"  - BREP 对象: {info['brep_count']}")
            print(f"  - 曲线对象: {info['curve_count']}")
            if info['unit_system']:
                print(f"单位系统: {info['unit_system']}")
            print("=" * 60)
        else:
            # 加载完整数据
            print(f"正在加载 3DM 文件: {args.input}")
            vertices, faces = load_3dm_file(args.input, mesh_quality=args.mesh_quality)
            
            print("=" * 60)
            print("加载成功！")
            print("=" * 60)
            print(f"顶点数: {len(vertices):,}")
            print(f"面数: {len(faces):,}")
            print(f"顶点范围:")
            print(f"  X: [{vertices[:, 0].min():.2f}, {vertices[:, 0].max():.2f}]")
            print(f"  Y: [{vertices[:, 1].min():.2f}, {vertices[:, 1].max():.2f}]")
            print(f"  Z: [{vertices[:, 2].min():.2f}, {vertices[:, 2].max():.2f}]")
            print("=" * 60)
            
            # 保存数据（如果指定了输出路径）
            if args.output:
                output_path = Path(args.output)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                
                if output_path.suffix.lower() == '.npz':
                    np.savez(output_path, vertices=vertices, faces=faces)
                    print(f"数据已保存到: {output_path}")
                else:
                    print(f"警告: 不支持的文件格式 {output_path.suffix}，使用 .npz 格式")
                    npz_path = output_path.with_suffix('.npz')
                    np.savez(npz_path, vertices=vertices, faces=faces)
                    print(f"数据已保存到: {npz_path}")
    
    except (ThreeDMFileNotFoundError, ThreeDMFileReadError, ThreeDMFileEmptyError) as e:
        print(f"错误: {e}")
        return 1
    except Exception as e:
        print(f"未预期的错误: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    return 0


if __name__ == '__main__':
    exit(main())
