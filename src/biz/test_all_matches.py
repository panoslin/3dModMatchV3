#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试所有匹配组合：对每个 target 和每个 candidate 进行匹配
生成完整的匹配结果表格
"""

import sys
import json
import time
import csv
from pathlib import Path
from typing import Dict, List, Tuple
from datetime import datetime

try:
    from load_mesh import load_mesh_file, MeshFileError
except ImportError as e:
    print(f"❌ 错误: 无法导入 load_mesh 模块: {e}")
    sys.exit(1)

try:
    import mesh_matcher
except ImportError as e:
    print(f"❌ 错误: 无法导入 mesh_matcher 模块: {e}")
    print("请确保已编译C++模块")
    sys.exit(1)


def match_single_pair(
    target_file: Path,
    candidate_file: Path,
    wrapping_threshold: float = 0.99,
    ga_params=None,
    verbose: bool = False
) -> Tuple[bool, Dict]:
    """匹配单个 target-candidate 文件对，返回 (成功标志, 结果字典)。"""
    try:
        # 加载目标文件
        target_vertices, target_faces = load_mesh_file(target_file, mesh_quality='high')
        
        # 创建匹配器
        matcher = mesh_matcher.MeshMatcher()
        matcher.set_verbose(verbose)
        matcher.load_target_mesh(target_vertices, target_faces)
        
        # 加载候选文件
        candidate_vertices, candidate_faces = load_mesh_file(
            candidate_file, mesh_quality='high'
        )
        
        if not matcher.load_candidate_mesh(candidate_vertices, candidate_faces):
            return False, {'error': '无法加载候选网格数据'}
        
        # 执行优化匹配
        start_time = time.time()
        result = matcher.match_optimized(
            wrapping_threshold=wrapping_threshold,
            ga_params=ga_params if ga_params else mesh_matcher.GeneticAlgorithmParams()
        )
        match_time = time.time() - start_time
        
        # 构建结果字典
        match_info = {
            'volume': result.volume,
            'wrapping_ratio': result.wrapping_ratio,
            'percentile96_clearance': result.percentile96_clearance,  # 96%分位数间隙值
            'optimal_translation': result.optimal_translation,
            'meets_direction_constraints': result.meets_direction_constraints,
            'is_fully_wrapped': result.is_fully_wrapped,
            'direction_alignment': {
                'heel_toe_alignment': result.direction_alignment.heel_toe_alignment,
                'vertical_alignment': result.direction_alignment.vertical_alignment,
                'heel_toe_angle_deg': result.direction_alignment.heel_toe_angle_deg,
                'vertical_angle_deg': result.direction_alignment.vertical_angle_deg,
                'is_valid': result.direction_alignment.is_valid
            },
            'match_time_ms': match_time * 1000,
            'is_valid_match': (
                result.meets_direction_constraints and
                result.is_fully_wrapped
            )
        }
        
        return True, match_info
        
    except MeshFileError as e:
        return False, {'error': f'文件加载错误: {str(e)}'}
    except Exception as e:
        return False, {'error': f'匹配过程出错: {str(e)}'}


def test_all_matches(
    testcases_dir: Path,
    verbose: bool = False,
    wrapping_threshold: float = 0.99,
    ga_params=None,
    specific_testcase: str = None,
    show_only_valid: bool = False
) -> Dict:
    """遍历 testcases_dir 下所有测试用例，执行全排列匹配并汇总结果。"""
    # 查找所有测试用例目录
    if specific_testcase:
        # 如果指定了特定测试用例，只测试该用例
        testcase_path = testcases_dir / specific_testcase
        if testcase_path.exists() and testcase_path.is_dir():
            testcase_dirs = [testcase_path]
        else:
            return {'error': f'Specific testcase not found: {specific_testcase}'}
    else:
        testcase_dirs = [d for d in testcases_dir.iterdir() 
                        if d.is_dir() and d.name.startswith('testcase')]
        testcase_dirs.sort()
    
    if not testcase_dirs:
        return {'error': f'No testcase directories found in {testcases_dir}'}
    
    all_results = []
    total_matches = 0
    total_valid_matches = 0
    
    for testcase_dir in testcase_dirs:
        if verbose:
            print(f"\n{'='*70}")
            print(f"测试用例: {testcase_dir.name}")
            print(f"{'='*70}")
        
        target_dir = testcase_dir / 'target'
        candidate_dir = testcase_dir / 'candidate_set'
        
        if not target_dir.exists() or not candidate_dir.exists():
            print(f"⚠️  跳过 {testcase_dir.name}: 缺少 target 或 candidate_set 目录")
            continue
        
        # 获取所有目标文件和候选文件
        target_files = sorted(target_dir.glob('*.3dm')) + sorted(target_dir.glob('*.stl'))
        candidate_files = sorted(candidate_dir.glob('*.3dm')) + sorted(candidate_dir.glob('*.stl'))
        
        if not target_files:
            print(f"⚠️  跳过 {testcase_dir.name}: 没有找到目标文件")
            continue
        if not candidate_files:
            print(f"⚠️  跳过 {testcase_dir.name}: 没有找到候选文件")
            continue
        
        testcase_results = []
        
        for target_idx, target_file in enumerate(target_files):
            if verbose:
                print(f"\n目标文件 [{target_idx+1}/{len(target_files)}]: {target_file.name}")
            
            target_results = []
            valid_results = []  # 存储通过匹配的结果
            
            for candidate_idx, candidate_file in enumerate(candidate_files):
                if verbose:
                    print(f"  匹配 [{candidate_idx+1}/{len(candidate_files)}]: {candidate_file.name}", end=' ... ')
                
                success, match_info = match_single_pair(
                    target_file,
                    candidate_file,
                    wrapping_threshold=wrapping_threshold,
                    ga_params=ga_params,
                    verbose=verbose
                )
                
                total_matches += 1
                
                if success:
                    if match_info.get('is_valid_match'):
                        total_valid_matches += 1
                        status = "✅"
                    else:
                        status = "❌"
                    
                    if verbose:
                        print(f"{status} 体积={match_info.get('volume', 0):.2f}, "
                              f"包裹率={match_info.get('wrapping_ratio', 0)*100:.1f}%, "
                              f"间隙={match_info.get('percentile96_clearance', 0):.4f}mm, "
                              f"时间={match_info.get('match_time_ms', 0):.1f}ms")
                else:
                    status = "⚠️"
                    if verbose:
                        print(f"{status} {match_info.get('error', '未知错误')}")
                
                result_row = {
                    'testcase': testcase_dir.name,
                    'target_file': target_file.name,
                    'target_path': str(target_file),
                    'candidate_file': candidate_file.name,
                    'candidate_path': str(candidate_file),
                    'success': success,
                    **match_info
                }
                
                target_results.append(result_row)
                
                # 如果通过匹配，添加到 valid_results 用于排序
                if success and match_info.get('is_valid_match'):
                    valid_results.append(result_row)
            
            # 对通过匹配的结果按体积从小到大排序
            # 处理 volume 可能为 None 或空的情况
            def get_volume_for_sort(result):
                volume = result.get('volume')
                if volume is None or volume == '':
                    return float('inf')
                try:
                    return float(volume)
                except (ValueError, TypeError):
                    return float('inf')
            
            valid_results.sort(key=get_volume_for_sort)
            
            # 将排序后的有效结果添加到 testcase_results
            # 先添加有效结果（已排序），再添加无效结果
            testcase_results.extend(valid_results)
            
            # 如果 show_only_valid 为 False，添加未通过匹配的结果（保持原始顺序）
            if not show_only_valid:
                for result in target_results:
                    if not (result.get('success') and result.get('is_valid_match')):
                        testcase_results.append(result)
        
        all_results.extend(testcase_results)
    
    return {
        'testcases_dir': str(testcases_dir),
        'testcase_count': len(testcase_dirs),
        'total_matches': total_matches,
        'total_valid_matches': total_valid_matches,
        'results': all_results,
        'timestamp': datetime.now().isoformat()
    }


def generate_csv_table(results: Dict, output_file: Path):
    """将匹配结果写入 CSV 文件。"""
    if 'error' in results:
        print(f"❌ 错误: {results['error']}")
        return
    
    rows = results.get('results', [])
    if not rows:
        print("⚠️  没有匹配结果")
        return
    
    # 定义 CSV 列
    fieldnames = [
        'testcase',
        'target_file',
        'candidate_file',
        'is_valid_match',
        'volume',
        'wrapping_ratio',
        'percentile96_clearance',
        'meets_direction_constraints',
        'is_fully_wrapped',
        'heel_toe_angle_deg',
        'vertical_angle_deg',
        'optimal_translation',
        'match_time_ms',
        'success',
        'error'
    ]
    
    output_file.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_file, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        
        for row in rows:
            csv_row = {
                'testcase': row.get('testcase', ''),
                'target_file': row.get('target_file', ''),
                'candidate_file': row.get('candidate_file', ''),
                'is_valid_match': row.get('is_valid_match', False),
                'volume': row.get('volume', ''),
                'wrapping_ratio': row.get('wrapping_ratio', ''),
                'percentile96_clearance': row.get('percentile96_clearance', ''),
                'meets_direction_constraints': row.get('meets_direction_constraints', ''),
                'is_fully_wrapped': row.get('is_fully_wrapped', ''),
                'heel_toe_angle_deg': row.get('direction_alignment', {}).get('heel_toe_angle_deg', ''),
                'vertical_angle_deg': row.get('direction_alignment', {}).get('vertical_angle_deg', ''),
                'optimal_translation': row.get('optimal_translation', ''),
                'match_time_ms': row.get('match_time_ms', ''),
                'success': row.get('success', False),
                'error': row.get('error', '')
            }
            writer.writerow(csv_row)
    
    print(f"\n✅ CSV 表格已保存到: {output_file}")


def generate_html_table(results: Dict, output_file: Path):
    """将匹配结果写入带样式的 HTML 表格文件。"""
    if 'error' in results:
        print(f"❌ 错误: {results['error']}")
        return
    
    rows = results.get('results', [])
    if not rows:
        print("⚠️  没有匹配结果")
        return
    
    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>匹配结果表格</title>
    <style>
        body {{
            font-family: Arial, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
        }}
        h1 {{
            color: #333;
        }}
        .summary {{
            background-color: white;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
        table {{
            border-collapse: collapse;
            width: 100%;
            background-color: white;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
        th, td {{
            border: 1px solid #ddd;
            padding: 8px;
            text-align: left;
        }}
        th {{
            background-color: #4CAF50;
            color: white;
            position: sticky;
            top: 0;
        }}
        tr:nth-child(even) {{
            background-color: #f2f2f2;
        }}
        tr:hover {{
            background-color: #e8f5e9;
        }}
        .valid {{
            color: green;
            font-weight: bold;
        }}
        .invalid {{
            color: red;
        }}
        .error {{
            color: orange;
        }}
    </style>
</head>
<body>
    <h1>3DM 文件匹配结果</h1>
    <div class="summary">
        <p><strong>测试时间:</strong> {results.get('timestamp', 'N/A')}</p>
        <p><strong>测试用例目录:</strong> {results.get('testcases_dir', 'N/A')}</p>
        <p><strong>测试用例数:</strong> {results.get('testcase_count', 0)}</p>
        <p><strong>总匹配数:</strong> {results.get('total_matches', 0)}</p>
        <p><strong>有效匹配数:</strong> {results.get('total_valid_matches', 0)}</p>
    </div>
    <table>
        <thead>
            <tr>
                <th>测试用例</th>
                <th>目标文件</th>
                <th>候选文件</th>
                <th>有效匹配</th>
                <th>体积</th>
                <th>包裹率 (%)</th>
                <th>96%分位数间隙 (mm)</th>
                <th>方向约束</th>
                <th>完全包裹</th>
                <th>鞋跟-鞋头角度 (°)</th>
                <th>上下角度 (°)</th>
                <th>最优平移</th>
                <th>匹配时间 (ms)</th>
                <th>状态</th>
            </tr>
        </thead>
        <tbody>
"""
    
    for row in rows:
        is_valid = row.get('is_valid_match', False)
        success = row.get('success', False)
        error = row.get('error', '')
        
        if error:
            status_class = 'error'
            status_text = f'错误: {error}'
        elif is_valid:
            status_class = 'valid'
            status_text = '✅ 有效'
        else:
            status_class = 'invalid'
            status_text = '❌ 无效'
        
        volume = row.get('volume', '')
        if volume:
            volume = f'{volume:.2f}'
        
        wrapping_ratio = row.get('wrapping_ratio', '')
        if wrapping_ratio:
            wrapping_ratio = f'{wrapping_ratio * 100:.2f}'
        
        percentile96_clearance = row.get('percentile96_clearance', '')
        if percentile96_clearance:
            percentile96_clearance = f'{percentile96_clearance:.4f}'
        
        heel_toe_angle = row.get('direction_alignment', {}).get('heel_toe_angle_deg', '')
        if heel_toe_angle:
            heel_toe_angle = f'{heel_toe_angle:.2f}'
        
        vertical_angle = row.get('direction_alignment', {}).get('vertical_angle_deg', '')
        if vertical_angle:
            vertical_angle = f'{vertical_angle:.2f}'
        
        optimal_translation = row.get('optimal_translation', '')
        if optimal_translation:
            optimal_translation = f'{optimal_translation:.4f}'
        
        match_time = row.get('match_time_ms', '')
        if match_time:
            match_time = f'{match_time:.2f}'
        
        html += f"""            <tr>
                <td>{row.get('testcase', '')}</td>
                <td>{row.get('target_file', '')}</td>
                <td>{row.get('candidate_file', '')}</td>
                <td class="{status_class}">{'是' if is_valid else '否'}</td>
                <td>{volume}</td>
                <td>{wrapping_ratio}</td>
                <td>{percentile96_clearance}</td>
                <td>{'是' if row.get('meets_direction_constraints') else '否'}</td>
                <td>{'是' if row.get('is_fully_wrapped') else '否'}</td>
                <td>{heel_toe_angle}</td>
                <td>{vertical_angle}</td>
                <td>{optimal_translation}</td>
                <td>{match_time}</td>
                <td class="{status_class}">{status_text}</td>
            </tr>
"""
    
    html += """        </tbody>
    </table>
</body>
</html>"""
    
    output_file.parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(html)
    
    print(f"✅ HTML 表格已保存到: {output_file}")


def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='测试所有匹配组合：对每个 target 和每个 candidate 进行匹配',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument(
        'testcases_dir',
        type=str,
        help='测试用例根目录路径'
    )
    
    parser.add_argument(
        '--output-csv', '-c',
        type=str,
        help='输出 CSV 文件路径'
    )
    
    parser.add_argument(
        '--output-html',
        type=str,
        help='输出 HTML 文件路径'
    )
    
    parser.add_argument(
        '--output-json', '-j',
        type=str,
        help='输出 JSON 文件路径'
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
    
    parser.add_argument(
        '--testcase',
        type=str,
        help='只测试指定的测试用例（例如: testcase3）'
    )
    
    parser.add_argument(
        '--show-only-valid',
        action='store_true',
        help='只显示通过匹配的结果（默认: 显示所有结果，但通过匹配的会按体积排序）'
    )
    
    args = parser.parse_args()
    
    testcases_dir = Path(args.testcases_dir)
    if not testcases_dir.exists():
        print(f"❌ 错误: 测试用例目录不存在: {testcases_dir}")
        sys.exit(1)
    
    # 创建默认参数对象
    ga_params = mesh_matcher.GeneticAlgorithmParams()
    
    # 运行所有匹配测试
    print("开始测试所有匹配组合...")
    start_time = time.time()
    results = test_all_matches(
        testcases_dir,
        verbose=args.verbose,
        wrapping_threshold=args.wrapping_threshold,
        ga_params=ga_params,
        specific_testcase=args.testcase,
        show_only_valid=args.show_only_valid
    )
    total_time = time.time() - start_time
    
    if 'error' in results:
        print(f"❌ 错误: {results['error']}")
        sys.exit(1)
    
    results['total_test_time_seconds'] = total_time
    
    # 输出统计信息
    print(f"\n{'='*70}")
    print("测试完成")
    print(f"{'='*70}")
    print(f"测试时间: {results.get('timestamp', 'N/A')}")
    print(f"测试用例数: {results.get('testcase_count', 0)}")
    print(f"总匹配数: {results.get('total_matches', 0)}")
    print(f"有效匹配数: {results.get('total_valid_matches', 0)}")
    print(f"总耗时: {total_time:.2f} 秒")
    print(f"{'='*70}\n")
    
    # 生成输出文件
    if args.output_csv:
        generate_csv_table(results, Path(args.output_csv))
    
    if args.output_html:
        generate_html_table(results, Path(args.output_html))
    
    if args.output_json:
        output_file = Path(args.output_json)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        print(f"✅ JSON 结果已保存到: {output_file}")
    
    # 如果没有指定任何输出，至少生成 CSV
    if not args.output_csv and not args.output_html and not args.output_json:
        default_csv = testcases_dir.parent / 'match_results.csv'
        generate_csv_table(results, default_csv)
        print(f"\n提示: 使用 --output-csv, --output-html 或 --output-json 指定输出文件路径")
    
    sys.exit(0)


if __name__ == '__main__':
    sys.exit(main())
