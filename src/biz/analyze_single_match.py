#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
单个测试用例的详细匹配分析脚本

生成完整的匹配分析报告，包括匹配度评分、关键特征对比、误差分析等
"""

import sys
import json
import time
from pathlib import Path
from typing import Dict, List, Tuple
import numpy as np
from datetime import datetime

try:
    from load_3dm import load_3dm_file, ThreeDMFileError
except ImportError as e:
    print(f"❌ 错误: 无法导入 load_3dm 模块: {e}")
    sys.exit(1)

try:
    import mesh_matcher
except ImportError as e:
    print(f"❌ 错误: 无法导入 mesh_matcher 模块: {e}")
    sys.exit(1)


def compute_mesh_statistics(vertices, faces):
    """计算网格统计信息"""
    if len(vertices) == 0:
        return {}
    
    # 计算边界框
    min_coords = vertices.min(axis=0)
    max_coords = vertices.max(axis=0)
    bbox_size = max_coords - min_coords
    bbox_center = (min_coords + max_coords) / 2.0
    
    # 计算体积（使用有符号体积）
    volume = mesh_matcher.MeshMatcher.compute_volume(
        vertices.flatten().tolist(), faces.flatten().tolist()
    )
    
    # 计算主法线
    normal = mesh_matcher.MeshMatcher.compute_principal_normal(
        vertices.flatten().tolist(), faces.flatten().tolist()
    )
    
    # 计算表面积（近似）
    surface_area = 0.0
    for face in faces:
        if len(face) >= 3:
            v0, v1, v2 = vertices[face[0]], vertices[face[1]], vertices[face[2]]
            edge1 = v1 - v0
            edge2 = v2 - v0
            area = 0.5 * np.linalg.norm(np.cross(edge1, edge2))
            surface_area += area
    
    return {
        'vertex_count': len(vertices),
        'face_count': len(faces),
        'bbox_min': min_coords.tolist(),
        'bbox_max': max_coords.tolist(),
        'bbox_size': bbox_size.tolist(),
        'bbox_center': bbox_center.tolist(),
        'volume': volume,
        'surface_area': surface_area,
        'principal_normal': list(normal),
        'bbox_volume': np.prod(bbox_size)  # 边界框体积
    }


def analyze_match_detailed(
    target_file: Path,
    candidate_file: Path,
    normal_tolerance: float = 0.1,
    penetration_tolerance: float = 0.01
) -> Dict:
    """
    详细分析单个匹配
    
    Returns:
        Dict: 包含详细分析结果的字典
    """
    analysis = {
        'target_file': str(target_file),
        'candidate_file': str(candidate_file),
        'timestamp': datetime.now().isoformat(),
        'parameters': {
            'normal_tolerance': normal_tolerance,
            'penetration_tolerance': penetration_tolerance
        }
    }
    
    # 加载目标网格
    try:
        target_vertices, target_faces = load_3dm_file(target_file, mesh_quality='high')
        target_stats = compute_mesh_statistics(target_vertices, target_faces)
        analysis['target_stats'] = target_stats
    except Exception as e:
        analysis['error'] = f"无法加载目标文件: {e}"
        return analysis
    
    # 加载候选网格
    try:
        candidate_vertices, candidate_faces = load_3dm_file(candidate_file, mesh_quality='high')
        candidate_stats = compute_mesh_statistics(candidate_vertices, candidate_faces)
        analysis['candidate_stats'] = candidate_stats
    except Exception as e:
        analysis['error'] = f"无法加载候选文件: {e}"
        return analysis
    
    # 创建匹配器并执行匹配
    matcher = mesh_matcher.MeshMatcher()
    matcher.load_target_mesh(target_vertices, target_faces)
    matcher.load_candidate_mesh(candidate_vertices, candidate_faces)
    
    start_time = time.time()
    result = matcher.match_optimized(
        penetration_tolerance=penetration_tolerance,
        wrapping_threshold=1.0
    )
    match_time = time.time() - start_time
    
    # 基础匹配结果
    analysis['match_result'] = {
        'normal_alignment_score': result.normal_alignment_score,
        'is_fully_wrapped': result.is_fully_wrapped,
        'has_penetration': result.has_penetration,
        'volume': result.volume,
        'match_score': result.match_score,
        'wrapping_ratio': result.wrapping_ratio,
        'optimal_translation': result.optimal_translation,
        'optimal_rotation_angle_deg': result.optimal_rotation_angle_deg,
        'optimal_vertical_offset': result.optimal_vertical_offset,
        'direction_alignment': {
            'heel_toe_alignment': result.direction_alignment.heel_toe_alignment,
            'vertical_alignment': result.direction_alignment.vertical_alignment,
            'heel_toe_angle_deg': result.direction_alignment.heel_toe_angle_deg,
            'vertical_angle_deg': result.direction_alignment.vertical_angle_deg
        },
        'match_time_ms': match_time * 1000
    }
    
    # 详细特征对比
    analysis['feature_comparison'] = {
        'volume_ratio': candidate_stats['volume'] / target_stats['volume'] if target_stats['volume'] > 0 else 0,
        'bbox_size_ratio': (np.array(candidate_stats['bbox_size']) / np.array(target_stats['bbox_size'])).tolist(),
        'vertex_count_ratio': candidate_stats['vertex_count'] / target_stats['vertex_count'],
        'face_count_ratio': candidate_stats['face_count'] / target_stats['face_count'],
        'surface_area_ratio': candidate_stats['surface_area'] / target_stats['surface_area'] if target_stats['surface_area'] > 0 else 0
    }
    
    # 边界框分析
    target_bbox_min = np.array(target_stats['bbox_min'])
    target_bbox_max = np.array(target_stats['bbox_max'])
    candidate_bbox_min = np.array(candidate_stats['bbox_min'])
    candidate_bbox_max = np.array(candidate_stats['bbox_max'])
    
    # 检查边界框包含关系
    bbox_contains = np.all(candidate_bbox_min <= target_bbox_min) and np.all(candidate_bbox_max >= target_bbox_max)
    bbox_overlap = np.all(candidate_bbox_max >= target_bbox_min) and np.all(candidate_bbox_min <= target_bbox_max)
    
    analysis['bbox_analysis'] = {
        'candidate_contains_target': bbox_contains,
        'bboxes_overlap': bbox_overlap,
        'target_bbox_size': target_stats['bbox_size'],
        'candidate_bbox_size': candidate_stats['bbox_size'],
        'size_difference': (np.array(candidate_stats['bbox_size']) - np.array(target_stats['bbox_size'])).tolist()
    }
    
    # 法线对齐分析
    target_normal = np.array(target_stats['principal_normal'])
    candidate_normal = np.array(candidate_stats['principal_normal'])
    dot_product = np.dot(target_normal, candidate_normal)
    angle_rad = np.arccos(np.clip(abs(dot_product), -1, 1))
    angle_deg = np.degrees(angle_rad)
    
    analysis['normal_analysis'] = {
        'target_normal': target_normal.tolist(),
        'candidate_normal': candidate_normal.tolist(),
        'dot_product': float(dot_product),
        'angle_degrees': float(angle_deg),
        'alignment_score': result.normal_alignment_score,
        'meets_threshold': result.normal_alignment_score >= (1.0 - normal_tolerance)
    }
    
    # 综合评分
    scores = {
        'normal_alignment': result.normal_alignment_score,
        'wrapping': 1.0 if result.is_fully_wrapped else 0.0,
        'no_penetration': 1.0 if not result.has_penetration else 0.0,
        'volume_efficiency': 1.0 / (1.0 + analysis['feature_comparison']['volume_ratio']) if analysis['feature_comparison']['volume_ratio'] > 0 else 0.0
    }
    
    # 加权综合评分
    weights = {
        'normal_alignment': 0.3,
        'wrapping': 0.3,
        'no_penetration': 0.3,
        'volume_efficiency': 0.1
    }
    
    overall_score = sum(scores[k] * weights[k] for k in scores)
    
    analysis['scoring'] = {
        'component_scores': scores,
        'weights': weights,
        'overall_score': overall_score,
        'is_valid_match': (
            result.normal_alignment_score >= (1.0 - normal_tolerance) and
            result.is_fully_wrapped and
            not result.has_penetration
        )
    }
    
    # 误差分析
    analysis['error_analysis'] = {
        'normal_alignment_error': 1.0 - result.normal_alignment_score,
        'wrapping_failed': not result.is_fully_wrapped,
        'penetration_detected': result.has_penetration,
        'volume_calculation_issue': result.volume == 0.0
    }
    
    return analysis


def analyze_all_candidates(
    target_file: Path,
    candidate_dir: Path,
    normal_tolerance: float = 0.1,
    penetration_tolerance: float = 0.01
) -> Dict:
    """分析目标文件与所有候选文件的匹配"""
    candidate_files = sorted(candidate_dir.glob('*.3dm'))
    
    if not candidate_files:
        return {'error': f'在 {candidate_dir} 中未找到候选文件'}
    
    all_analyses = []
    
    for candidate_file in candidate_files:
        print(f"\n分析候选: {candidate_file.name}")
        analysis = analyze_match_detailed(
            target_file, candidate_file,
            normal_tolerance, penetration_tolerance
        )
        all_analyses.append(analysis)
    
    # 找出最佳匹配
    valid_matches = [a for a in all_analyses if a.get('scoring', {}).get('is_valid_match', False)]
    
    if valid_matches:
        best_match = max(valid_matches, key=lambda x: x.get('scoring', {}).get('overall_score', 0))
    else:
        # 如果没有完全匹配，选择综合评分最高的
        best_match = max(all_analyses, key=lambda x: x.get('scoring', {}).get('overall_score', 0))
    
    return {
        'target_file': str(target_file),
        'candidate_dir': str(candidate_dir),
        'total_candidates': len(candidate_files),
        'valid_matches': len(valid_matches),
        'best_match': best_match,
        'all_analyses': all_analyses,
        'summary': {
            'best_match_file': Path(best_match['candidate_file']).name,
            'best_match_score': best_match.get('scoring', {}).get('overall_score', 0),
            'best_match_valid': best_match.get('scoring', {}).get('is_valid_match', False)
        }
    }


def generate_report(results: Dict, output_file: Path = None):
    """生成详细的分析报告"""
    print("\n" + "="*80)
    print("详细匹配分析报告")
    print("="*80)
    
    if 'error' in results:
        print(f"❌ 错误: {results['error']}")
        return
    
    print(f"\n目标文件: {Path(results['target_file']).name}")
    print(f"候选文件数: {results['total_candidates']}")
    print(f"有效匹配数: {results['valid_matches']}")
    
    best = results['best_match']
    print(f"\n最佳匹配: {Path(best['candidate_file']).name}")
    print(f"综合评分: {best.get('scoring', {}).get('overall_score', 0):.4f}")
    print(f"是否有效匹配: {'✅' if best.get('scoring', {}).get('is_valid_match', False) else '❌'}")
    
    # 最佳匹配的详细信息
    print("\n" + "-"*80)
    print("最佳匹配详细信息")
    print("-"*80)
    
    match_result = best.get('match_result', {})
    print(f"\n匹配结果:")
    print(f"  法线对齐分数: {match_result.get('normal_alignment_score', 0):.4f}")
    print(f"  完全包裹: {'✅' if match_result.get('is_fully_wrapped', False) else '❌'}")
    print(f"  无穿模: {'✅' if not match_result.get('has_penetration', False) else '❌'}")
    print(f"  体积: {match_result.get('volume', 0):.2f}")
    print(f"  匹配时间: {match_result.get('match_time_ms', 0):.2f}ms")
    
    # 特征对比
    feature_comp = best.get('feature_comparison', {})
    print(f"\n特征对比:")
    print(f"  体积比: {feature_comp.get('volume_ratio', 0):.4f}")
    print(f"  边界框尺寸比: {feature_comp.get('bbox_size_ratio', [0,0,0])}")
    print(f"  顶点数比: {feature_comp.get('vertex_count_ratio', 0):.4f}")
    print(f"  面数比: {feature_comp.get('face_count_ratio', 0):.4f}")
    
    # 法线分析
    normal_analysis = best.get('normal_analysis', {})
    print(f"\n法线对齐分析:")
    print(f"  目标法线: {normal_analysis.get('target_normal', [0,0,0])}")
    print(f"  候选法线: {normal_analysis.get('candidate_normal', [0,0,0])}")
    print(f"  角度差: {normal_analysis.get('angle_degrees', 0):.2f}°")
    print(f"  对齐分数: {normal_analysis.get('alignment_score', 0):.4f}")
    print(f"  满足阈值: {'✅' if normal_analysis.get('meets_threshold', False) else '❌'}")
    
    # 误差分析
    error_analysis = best.get('error_analysis', {})
    print(f"\n误差分析:")
    print(f"  法线对齐误差: {error_analysis.get('normal_alignment_error', 0):.4f}")
    print(f"  包裹失败: {'❌' if error_analysis.get('wrapping_failed', False) else '✅'}")
    print(f"  检测到穿模: {'❌' if error_analysis.get('penetration_detected', False) else '✅'}")
    print(f"  体积计算问题: {'⚠️' if error_analysis.get('volume_calculation_issue', False) else '✅'}")
    
    # 所有候选的对比
    print("\n" + "-"*80)
    print("所有候选匹配对比")
    print("-"*80)
    
    for i, analysis in enumerate(results['all_analyses'], 1):
        candidate_name = Path(analysis['candidate_file']).name
        scoring = analysis.get('scoring', {})
        match_result = analysis.get('match_result', {})
        
        print(f"\n[{i}] {candidate_name}")
        print(f"    综合评分: {scoring.get('overall_score', 0):.4f}")
        print(f"    法线对齐: {match_result.get('normal_alignment_score', 0):.4f}")
        print(f"    完全包裹: {'✅' if match_result.get('is_fully_wrapped', False) else '❌'}")
        print(f"    无穿模: {'✅' if not match_result.get('has_penetration', False) else '❌'}")
        print(f"    体积: {match_result.get('volume', 0):.2f}")
        print(f"    有效匹配: {'✅' if scoring.get('is_valid_match', False) else '❌'}")
    
    # 保存JSON报告
    if output_file:
        output_file.parent.mkdir(parents=True, exist_ok=True)
        
        # 转换numpy类型为Python原生类型
        def convert_to_serializable(obj):
            if isinstance(obj, np.integer):
                return int(obj)
            elif isinstance(obj, np.floating):
                return float(obj)
            elif isinstance(obj, np.ndarray):
                return obj.tolist()
            elif isinstance(obj, np.bool_):
                return bool(obj)
            elif isinstance(obj, dict):
                return {k: convert_to_serializable(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [convert_to_serializable(item) for item in obj]
            return obj
        
        serializable_results = convert_to_serializable(results)
        
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(serializable_results, f, indent=2, ensure_ascii=False)
        print(f"\n详细报告已保存到: {output_file}")


def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='单个测试用例的详细匹配分析',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument(
        'target_file',
        type=str,
        help='目标文件路径'
    )
    
    parser.add_argument(
        'candidate_dir',
        type=str,
        help='候选文件目录'
    )
    
    parser.add_argument(
        '--output', '-o',
        type=str,
        default='/app/analysis_report.json',
        help='输出报告文件路径（JSON格式，默认: /app/analysis_report.json）'
    )
    
    parser.add_argument(
        '--normal-tolerance',
        type=float,
        default=0.1,
        help='法线对齐容差（默认: 0.1）'
    )
    
    parser.add_argument(
        '--penetration-tolerance',
        type=float,
        default=0.01,
        help='穿模检测容差（默认: 0.01）'
    )
    
    args = parser.parse_args()
    
    target_file = Path(args.target_file)
    candidate_dir = Path(args.candidate_dir)
    
    if not target_file.exists():
        print(f"❌ 错误: 目标文件不存在: {target_file}")
        sys.exit(1)
    
    if not candidate_dir.exists():
        print(f"❌ 错误: 候选目录不存在: {candidate_dir}")
        sys.exit(1)
    
    print("="*80)
    print("开始详细匹配分析")
    print("="*80)
    print(f"目标文件: {target_file}")
    print(f"候选目录: {candidate_dir}")
    print(f"法线容差: {args.normal_tolerance}")
    print(f"穿模容差: {args.penetration_tolerance}")
    
    results = analyze_all_candidates(
        target_file, candidate_dir,
        args.normal_tolerance, args.penetration_tolerance
    )
    
    output_file = Path(args.output) if args.output else None
    generate_report(results, output_file)
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
