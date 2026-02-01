#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试脚本：验证 load_3dm.py 能否正确读取 testcases/ 目录下的所有 3DM 文件

用法:
    python test_3dm_files.py [testcases_dir]

默认测试目录: testcases/
"""

import sys
from pathlib import Path
from typing import List, Tuple
import traceback
import numpy as np

try:
    from load_3dm import load_3dm_file, get_3dm_file_info, ThreeDMFileError
except ImportError as e:
    print(f"❌ 错误: 无法导入 load_3dm 模块: {e}")
    print("请确保 load_3dm.py 文件在当前目录或 Python 路径中")
    sys.exit(1)


def find_all_3dm_files(testcases_dir: Path) -> List[Path]:
    """
    查找指定目录下所有的 .3dm 文件
    
    Args:
        testcases_dir: 测试用例目录路径
        
    Returns:
        List[Path]: 所有找到的 .3dm 文件路径列表
    """
    if not testcases_dir.exists():
        return []
    
    # 递归查找所有 .3dm 文件
    files = list(testcases_dir.rglob('*.3dm'))
    return sorted(files)


def test_single_file(file_path: Path, verbose: bool = False) -> Tuple[bool, str, dict]:
    """
    测试单个 3DM 文件
    
    Args:
        file_path: 3DM 文件路径
        verbose: 是否输出详细信息
        
    Returns:
        Tuple[bool, str, dict]: (是否成功, 错误信息, 文件信息)
    """
    try:
        # 先获取文件信息
        info = get_3dm_file_info(file_path)
        
        # 尝试加载文件
        vertices, faces = load_3dm_file(file_path, mesh_quality='high')
        
        # 验证数据有效性
        if len(vertices) == 0:
            return False, "文件加载成功但顶点数为 0", info
        
        if len(faces) == 0:
            return False, "文件加载成功但面数为 0", info
        
        # 验证面索引有效性
        max_vertex_idx = len(vertices) - 1
        if len(faces) > 0:
            invalid_faces = faces >= len(vertices)
            if np.any(invalid_faces):
                return False, f"发现无效的面索引（超出顶点范围）", info
        
        result_info = {
            'vertices': len(vertices),
            'faces': len(faces),
            'file_size': info['file_size'],
            'object_count': info['object_count'],
            'mesh_count': info['mesh_count'],
            'brep_count': info.get('brep_count', 0),
        }
        
        if verbose:
            print(f"  ✓ 顶点数: {result_info['vertices']:,}")
            print(f"  ✓ 面数: {result_info['faces']:,}")
            print(f"  ✓ 对象数: {result_info['object_count']}")
            print(f"  ✓ 网格数: {result_info['mesh_count']}")
            if result_info['brep_count'] > 0:
                print(f"  ✓ BREP 数: {result_info['brep_count']}")
        
        return True, "", result_info
        
    except Exception as e:
        error_msg = f"{type(e).__name__}: {str(e)}"
        if verbose:
            traceback.print_exc()
        return False, error_msg, {}


def main():
    """主函数"""
    # 确定测试目录
    if len(sys.argv) > 1:
        testcases_dir = Path(sys.argv[1])
    else:
        testcases_dir = Path('testcases')
    
    # 检查目录是否存在
    if not testcases_dir.exists():
        print(f"❌ 错误: 测试目录不存在: {testcases_dir}")
        print(f"请提供有效的测试目录路径")
        sys.exit(1)
    
    print("=" * 70)
    print("3DM 文件读取测试")
    print("=" * 70)
    print(f"测试目录: {testcases_dir.absolute()}")
    print()
    
    # 查找所有 3DM 文件
    files = find_all_3dm_files(testcases_dir)
    
    if not files:
        print(f"⚠️  警告: 在 {testcases_dir} 目录下未找到任何 .3dm 文件")
        sys.exit(0)
    
    print(f"找到 {len(files)} 个 .3dm 文件")
    print("-" * 70)
    
    # 测试每个文件
    results = []
    success_count = 0
    fail_count = 0
    
    for idx, file_path in enumerate(files, 1):
        # 计算相对路径用于显示
        try:
            rel_path = file_path.relative_to(testcases_dir)
        except ValueError:
            rel_path = file_path
        
        print(f"\n[{idx}/{len(files)}] {rel_path}")
        
        success, error_msg, info = test_single_file(file_path, verbose=False)
        
        if success:
            success_count += 1
            print(f"  ✅ 成功")
            if info:
                print(f"     顶点: {info.get('vertices', 0):,}, "
                      f"面: {info.get('faces', 0):,}, "
                      f"对象: {info.get('object_count', 0)}")
            results.append((file_path, True, "", info))
        else:
            fail_count += 1
            print(f"  ❌ 失败: {error_msg}")
            results.append((file_path, False, error_msg, {}))
    
    # 输出总结
    print("\n" + "=" * 70)
    print("测试总结")
    print("=" * 70)
    print(f"总文件数: {len(files)}")
    print(f"✅ 成功: {success_count}")
    print(f"❌ 失败: {fail_count}")
    print(f"成功率: {success_count / len(files) * 100:.1f}%")
    print("=" * 70)
    
    # 如果有失败的文件，列出详细信息
    if fail_count > 0:
        print("\n失败的文件:")
        for file_path, success, error_msg, _ in results:
            if not success:
                try:
                    rel_path = file_path.relative_to(testcases_dir)
                except ValueError:
                    rel_path = file_path
                print(f"  - {rel_path}: {error_msg}")
    
    # 返回退出码
    if fail_count == 0:
        print("\n✅ 所有文件测试通过！")
        return 0
    else:
        print(f"\n❌ 有 {fail_count} 个文件测试失败")
        return 1


if __name__ == '__main__':
    sys.exit(main())
