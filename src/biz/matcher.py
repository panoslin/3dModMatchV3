#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鞋模-粗胚优化匹配脚本（基于生产场景）

使用严格的方向对齐约束和位置优化算法：
1. 严格方向对齐：鞋跟-鞋头方向和上下方向必须对齐（误差≤0.1度）
2. 前后位置优化：在纵向轴上找到最优平移位置，最大化包裹体积
3. 完全包裹筛选：筛选出所有满足完全包裹条件的候选
4. 体积最小化：从满足条件的候选中选择体积最小的
"""

import sys
import time
from pathlib import Path
from typing import List, Tuple, Optional
import numpy as np

try:
    from load_3dm import load_3dm_file, ThreeDMFileError
except ImportError as e:
    print(f"❌ 错误: 无法导入 load_3dm 模块: {e}")
    sys.exit(1)

try:
    import mesh_matcher
except ImportError as e:
    print(f"❌ 错误: 无法导入 mesh_matcher 模块: {e}")
    print("请确保已编译C++模块")
    sys.exit(1)


def find_optimal_match(
    target_file: Path,
    candidate_files: List[Path],
    wrapping_threshold: float = 0.99,
    verbose: bool = False,
    ga_params: Optional[mesh_matcher.GeneticAlgorithmParams] = None
) -> Tuple[Optional[Path], dict]:
    """
    使用优化算法找到最优匹配
    
    Args:
        target_file: 目标鞋模文件路径
        candidate_files: 候选粗胚文件路径列表
        wrapping_threshold: 包裹率阈值（默认0.99，即99%）
        verbose: 是否输出详细信息
        
    Returns:
        Tuple[Optional[Path], dict]: (最匹配的文件路径, 匹配结果信息)
    """
    # 加载目标鞋模
    if verbose:
        print(f"加载目标鞋模: {target_file}")
    
    try:
        target_vertices, target_faces = load_3dm_file(target_file, mesh_quality='high')
    except ThreeDMFileError as e:
        if verbose:
            print(f"❌ 无法加载目标文件: {e}")
        return None, {'error': str(e)}
    
    if verbose:
        print(f"  顶点数: {len(target_vertices):,}, 面数: {len(target_faces):,}")
    
    # 创建匹配器
    matcher = mesh_matcher.MeshMatcher()
    matcher.set_verbose(verbose)
    matcher.load_target_mesh(target_vertices, target_faces)
    
    # 遍历所有候选粗胚
    valid_matches = []
    all_candidate_results = []  # 收集所有候选结果（包括未通过阈值的）

    for idx, candidate_file in enumerate(candidate_files):
        if verbose:
            print(f"\n[{idx+1}/{len(candidate_files)}] 检查候选: {candidate_file.name}")

        try:
            # 加载候选粗胚
            candidate_vertices, candidate_faces = load_3dm_file(
                candidate_file, mesh_quality='high'
            )

            # 加载到匹配器
            if not matcher.load_candidate_mesh(candidate_vertices, candidate_faces):
                if verbose:
                    print("  ⚠️  无法加载网格数据")
                all_candidate_results.append({
                    'candidate_path': str(candidate_file),
                    'candidate_name': candidate_file.name,
                    'error': '无法加载网格数据',
                })
                continue

            # 执行优化匹配
            start_time = time.time()
            result = matcher.match_optimized(
                wrapping_threshold=wrapping_threshold,
                ga_params=ga_params if ga_params else mesh_matcher.GeneticAlgorithmParams()
            )
            match_time = time.time() - start_time

            result.candidate_index = idx
            result.candidate_path = str(candidate_file)

            if verbose:
                print(f"  方向对齐验证:")
                print(f"    鞋跟-鞋头对齐: {result.direction_alignment.heel_toe_alignment:.4f} "
                      f"(角度: {result.direction_alignment.heel_toe_angle_deg:.2f}°)")
                print(f"    上下方向对齐: {result.direction_alignment.vertical_alignment:.4f} "
                      f"(角度: {result.direction_alignment.vertical_angle_deg:.2f}°)")
                print(f"    方向约束满足: {'✅' if result.meets_direction_constraints else '❌'}")
                print(f"  包裹率: {result.wrapping_ratio:.4f} ({result.wrapping_ratio*100:.2f}%)")
                print(f"  完全包裹: {'✅' if result.is_fully_wrapped else '❌'}")
                print(f"  体积: {result.volume:.2f}")
                print(f"  最优平移: {result.optimal_translation:.4f}")
                print(f"  匹配时间: {match_time*1000:.2f}ms")

            # 记录该候选的完整结果（无论是否通过阈值）
            candidate_result = {
                'candidate_path': str(candidate_file),
                'candidate_name': candidate_file.name,
                'wrapping_ratio': result.wrapping_ratio,
                'percentile96_clearance': result.percentile96_clearance,
                'volume': result.volume,
                'is_fully_wrapped': result.is_fully_wrapped,
                'meets_direction_constraints': result.meets_direction_constraints,
                'optimal_translation': result.optimal_translation,
                'optimal_rotation_angle_deg': result.optimal_rotation_angle_deg,
                'optimal_lateral_offset': result.optimal_lateral_offset,
                'match_time_ms': match_time * 1000,
                'direction_alignment': {
                    'heel_toe_alignment': result.direction_alignment.heel_toe_alignment,
                    'vertical_alignment': result.direction_alignment.vertical_alignment,
                    'heel_toe_angle_deg': result.direction_alignment.heel_toe_angle_deg,
                    'vertical_angle_deg': result.direction_alignment.vertical_angle_deg,
                    'is_valid': result.direction_alignment.is_valid,
                },
            }
            all_candidate_results.append(candidate_result)

            # 检查是否满足所有条件
            if (result.meets_direction_constraints and
                result.is_fully_wrapped):
                valid_matches.append((result, match_time))
                if verbose:
                    print("  ✅ 满足所有匹配条件")
            else:
                if verbose:
                    reasons = []
                    if not result.meets_direction_constraints:
                        reasons.append("方向约束")
                    if not result.is_fully_wrapped:
                        reasons.append("不完全包裹")
                    print(f"  ❌ 不满足匹配条件: {', '.join(reasons)}")

        except ThreeDMFileError as e:
            if verbose:
                print(f"  ❌ 无法加载文件: {e}")
            all_candidate_results.append({
                'candidate_path': str(candidate_file),
                'candidate_name': candidate_file.name,
                'error': str(e),
            })
            continue
        except Exception as e:
            if verbose:
                print(f"  ❌ 匹配过程出错: {e}")
                import traceback
                traceback.print_exc()
            all_candidate_results.append({
                'candidate_path': str(candidate_file),
                'candidate_name': candidate_file.name,
                'error': str(e),
            })
            continue

    # 如果没有有效匹配，返回None（但仍包含所有候选结果数据）
    if not valid_matches:
        return None, {
            'error': 'No valid matches found',
            'total_candidates': len(candidate_files),
            'valid_matches': 0,
            'all_candidate_results': all_candidate_results,
        }
    
    # 选择体积最小的匹配
    best_match = min(valid_matches, key=lambda x: x[0].volume)
    result, match_time = best_match
    
    return Path(result.candidate_path), {
        'candidate_path': result.candidate_path,
        'volume': result.volume,
        'wrapping_ratio': result.wrapping_ratio,
        'percentile96_clearance': result.percentile96_clearance,
        'optimal_translation': result.optimal_translation,
        'optimal_rotation_angle_deg': result.optimal_rotation_angle_deg,
        'optimal_lateral_offset': result.optimal_lateral_offset,
        'is_fully_wrapped': result.is_fully_wrapped,
        'meets_direction_constraints': result.meets_direction_constraints,
        'target_wrapping_ratio': wrapping_threshold,
        'direction_alignment': {
            'heel_toe_alignment': result.direction_alignment.heel_toe_alignment,
            'vertical_alignment': result.direction_alignment.vertical_alignment,
            'heel_toe_angle_deg': result.direction_alignment.heel_toe_angle_deg,
            'vertical_angle_deg': result.direction_alignment.vertical_angle_deg,
            'is_valid': result.direction_alignment.is_valid
        },
        'generation_history': [
            {
                'generation': g.generation,
                'best_fitness': g.best_fitness,
                'avg_fitness': g.avg_fitness,
                'translation': g.translation,
                'rotation_angle_deg': g.rotation_angle_deg,
                'lateral_offset': g.lateral_offset,
            } for g in result.generation_history
        ],
        'match_time_ms': match_time * 1000,
        'total_valid_matches': len(valid_matches),
        'total_candidates': len(candidate_files),
        'all_candidate_results': all_candidate_results,
    }


def match_testcase_optimized(
    testcase_dir: Path,
    wrapping_threshold: float = 0.99,
    verbose: bool = False,
    ga_params: Optional[mesh_matcher.GeneticAlgorithmParams] = None
) -> dict:
    """
    使用优化算法匹配单个测试用例
    
    Args:
        testcase_dir: 测试用例目录路径
        wrapping_threshold: 包裹率阈值
        verbose: 是否输出详细信息
        ga_params: 遗传算法参数（可选）
        
    Returns:
        dict: 匹配结果统计
    """
    target_dir = testcase_dir / 'target'
    candidate_dir = testcase_dir / 'candidate_set'
    
    if not target_dir.exists():
        return {'error': f'Target directory not found: {target_dir}'}
    if not candidate_dir.exists():
        return {'error': f'Candidate directory not found: {candidate_dir}'}
    
    # 查找所有目标文件和候选文件
    target_files = sorted(target_dir.glob('*.3dm'))
    candidate_files = sorted(candidate_dir.glob('*.3dm'))
    
    if not target_files:
        return {'error': 'No target files found'}
    if not candidate_files:
        return {'error': 'No candidate files found'}
    
    results = []
    
    for target_file in target_files:
        if verbose:
            print(f"\n{'='*70}")
            print(f"匹配目标: {target_file.name}")
            print(f"{'='*70}")
        
        best_match, match_info = find_optimal_match(
            target_file, candidate_files,
            wrapping_threshold=wrapping_threshold,
            verbose=verbose,
            ga_params=ga_params
        )
        
        result = {
            'target_file': str(target_file),
            'target_name': target_file.name,
            'best_match': str(best_match) if best_match else None,
            'best_match_name': best_match.name if best_match else None,
            **match_info
        }
        results.append(result)
        
        if verbose:
            if best_match:
                print(f"\n✅ 最佳匹配: {best_match.name}")
                print(f"   体积: {match_info.get('volume', 0):.2f}")
                print(f"   包裹率: {match_info.get('wrapping_ratio', 0)*100:.2f}%")
                print(f"   方向对齐: 鞋跟-鞋头 {match_info.get('direction_alignment', {}).get('heel_toe_angle_deg', 0):.2f}°, "
                      f"上下 {match_info.get('direction_alignment', {}).get('vertical_angle_deg', 0):.2f}°")
                print(f"   匹配时间: {match_info.get('match_time_ms', 0):.2f}ms")
            else:
                print(f"\n❌ 未找到匹配")
    
    return {
        'testcase': str(testcase_dir),
        'results': results,
        'total_targets': len(target_files),
        'total_candidates': len(candidate_files)
    }


def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='鞋模-粗胚优化匹配系统（基于生产场景）',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument(
        'testcase_dir',
        type=str,
        help='测试用例目录路径'
    )
    
    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='输出详细信息'
    )
    
    parser.add_argument(
        '--wrapping-threshold',
        type=float,
        default=0.99,
        help='包裹率阈值（默认: 0.99，即99%%）'
    )
    
    # 遗传算法参数
    parser.add_argument(
        '--ga-population-size',
        type=int,
        default=50,
        help='GA种群大小（默认: 50）'
    )
    parser.add_argument(
        '--ga-max-generations',
        type=int,
        default=30,
        help='GA最大代数（默认: 30）'
    )
    parser.add_argument(
        '--ga-crossover-rate',
        type=float,
        default=0.8,
        help='GA交叉率（默认: 0.8）'
    )
    parser.add_argument(
        '--ga-mutation-rate',
        type=float,
        default=0.1,
        help='GA变异率（默认: 0.1）'
    )
    parser.add_argument(
        '--ga-mutation-scale',
        type=float,
        default=0.1,
        help='GA变异幅度（默认: 0.1）'
    )
    parser.add_argument(
        '--ga-selection-rate',
        type=float,
        default=0.5,
        help='GA选择率（默认: 0.5）'
    )
    parser.add_argument(
        '--ga-translation-range',
        type=float,
        default=50.0,
        help='GA纵向位移搜索范围（mm，默认: ±50）'
    )
    parser.add_argument(
        '--ga-rotation-range',
        type=float,
        default=180.0,
        help='GA旋转角度搜索范围（度，默认: ±180）'
    )
    parser.add_argument(
        '--ga-lateral-range',
        type=float,
        default=30.0,
        help='GA横向位移搜索范围（mm，默认: ±30）'
    )
    parser.add_argument(
        '--ga-target-wrapping-ratio',
        type=float,
        default=0.96,
        help='GA目标包裹率（默认: 0.96，达到此值即停止优化，0表示禁用）'
    )
    parser.add_argument(
        '--num-sample-points',
        type=int,
        default=500,
        help='采样点数量（默认: 500）'
    )
    
    args = parser.parse_args()
    
    testcase_dir = Path(args.testcase_dir)
    if not testcase_dir.exists():
        print(f"❌ 错误: 测试用例目录不存在: {testcase_dir}")
        sys.exit(1)
    
    # 创建遗传算法参数对象
    ga_params = mesh_matcher.GeneticAlgorithmParams()
    ga_params.population_size = args.ga_population_size
    ga_params.max_generations = args.ga_max_generations
    ga_params.crossover_rate = args.ga_crossover_rate
    ga_params.mutation_rate = args.ga_mutation_rate
    ga_params.mutation_scale = args.ga_mutation_scale
    ga_params.selection_rate = args.ga_selection_rate
    ga_params.translation_range = args.ga_translation_range
    ga_params.rotation_range = args.ga_rotation_range * 3.14159265358979323846 / 180.0  # 度转弧度
    ga_params.lateral_range = args.ga_lateral_range
    ga_params.num_sample_points = args.num_sample_points
    ga_params.target_wrapping_ratio = args.ga_target_wrapping_ratio
    
    if args.verbose:
        print(f"\n{'='*70}")
        print(f"使用算法: 遗传算法 (GA)")
        print(f"GA参数: 种群={ga_params.population_size}, 代数={ga_params.max_generations}")
        print(f"{'='*70}\n")
    
    result = match_testcase_optimized(
        testcase_dir,
        wrapping_threshold=args.wrapping_threshold,
        verbose=args.verbose,
        ga_params=ga_params
    )
    
    if 'error' in result:
        print(f"❌ 错误: {result['error']}")
        sys.exit(1)
    
    # 输出总结
    print(f"\n{'='*70}")
    print("优化匹配总结")
    print(f"{'='*70}")
    print(f"测试用例: {result['testcase']}")
    print(f"目标文件数: {result['total_targets']}")
    print(f"候选文件数: {result['total_candidates']}")
    print(f"\n匹配结果:")
    
    for r in result['results']:
        print(f"  目标: {r['target_name']}")
        if r['best_match']:
            print(f"    ✅ 最佳匹配: {r['best_match_name']}")
            print(f"       体积: {r.get('volume', 0):.2f}")
            print(f"       包裹率: {r.get('wrapping_ratio', 0)*100:.2f}%")
            dir_align = r.get('direction_alignment', {})
            print(f"       方向对齐: 鞋跟-鞋头 {dir_align.get('heel_toe_angle_deg', 0):.2f}°, "
                  f"上下 {dir_align.get('vertical_angle_deg', 0):.2f}°")
        else:
            print(f"    ❌ 未找到匹配")
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
