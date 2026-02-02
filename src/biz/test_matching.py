#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试验证脚本：运行所有测试用例并生成测试报告

验证匹配准确率、性能指标等
"""

import sys
import json
import time
from pathlib import Path
from typing import Dict, List
from datetime import datetime

try:
    from match_shoe_mold_optimized import find_optimal_match
    from pathlib import Path
except ImportError as e:
    print(f"❌ 错误: 无法导入 match_shoe_mold_optimized 模块: {e}")
    sys.exit(1)


def get_expected_match(target_name: str, candidate_dir: Path) -> Path:
    """
    根据目标文件名推断预期的匹配结果
    
    例如：target/002大(1).3dm -> candidate_set/002大(1).3dm
    """
    expected_file = candidate_dir / target_name
    if expected_file.exists():
        return expected_file
    
    # 如果直接匹配失败，尝试其他变体
    # 这里可以根据实际命名规则调整
    return None


def run_all_testcases(
    testcases_dir: Path,
    verbose: bool = False
) -> Dict:
    """
    运行所有测试用例
    
    Args:
        testcases_dir: 测试用例根目录
        verbose: 是否输出详细信息
        
    Returns:
        Dict: 测试结果统计
    """
    # 查找所有测试用例目录
    testcase_dirs = [d for d in testcases_dir.iterdir() 
                    if d.is_dir() and d.name.startswith('testcase')]
    testcase_dirs.sort()
    
    if not testcase_dirs:
        return {'error': f'No testcase directories found in {testcases_dir}'}
    
    all_results = []
    total_correct = 0
    total_tests = 0
    total_match_time = 0.0
    
    for testcase_dir in testcase_dirs:
        if verbose:
            print(f"\n{'='*70}")
            print(f"测试用例: {testcase_dir.name}")
            print(f"{'='*70}")
        
        # 运行匹配
        target_dir = testcase_dir / 'target'
        candidate_dir = testcase_dir / 'candidate_set'
        
        if not target_dir.exists() or not candidate_dir.exists():
            result = {'error': f'Missing target or candidate_set directory in {testcase_dir}'}
        else:
            # 获取所有目标文件和候选文件
            target_files = sorted(target_dir.glob('*.3dm')) + sorted(target_dir.glob('*.stl'))
            candidate_files = sorted(candidate_dir.glob('*.3dm')) + sorted(candidate_dir.glob('*.stl'))
            
            if not target_files:
                result = {'error': f'No target files found in {target_dir}'}
            else:
                results = []
                for target_file in target_files:
                    best_match, match_info = find_optimal_match(
                        target_file, candidate_files, verbose=verbose
                    )
                    results.append({
                        'target_name': str(target_file),
                        'best_match_name': str(best_match) if best_match else None,
                        'volume': match_info.get('volume', 0) if best_match else None,
                        'match_time_ms': match_info.get('match_time_ms', 0) if best_match else None
                    })
                result = {'results': results}
        
        if 'error' in result:
            print(f"⚠️  测试用例 {testcase_dir.name} 出错: {result['error']}")
            continue
        
        # 验证每个匹配结果
        candidate_dir = testcase_dir / 'candidate_set'
        
        for r in result['results']:
            total_tests += 1
            target_name = Path(r['target_name']).name
            best_match_name = r['best_match_name']
            
            # 获取预期匹配
            expected_match = get_expected_match(target_name, candidate_dir)
            
            is_correct = False
            if expected_match and best_match_name:
                is_correct = (Path(best_match_name).name == expected_match.name)
            
            if is_correct:
                total_correct += 1
            
            r['expected_match'] = str(expected_match) if expected_match else None
            r['is_correct'] = is_correct
            
            if r.get('match_time_ms'):
                total_match_time += r['match_time_ms']
        
        result['testcase_name'] = testcase_dir.name
        all_results.append(result)
    
    # 计算统计信息
    accuracy = (total_correct / total_tests * 100) if total_tests > 0 else 0.0
    avg_match_time = (total_match_time / total_tests) if total_tests > 0 else 0.0
    
    return {
        'testcases_dir': str(testcases_dir),
        'testcase_count': len(testcase_dirs),
        'total_tests': total_tests,
        'total_correct': total_correct,
        'accuracy': accuracy,
        'avg_match_time_ms': avg_match_time,
        'total_match_time_ms': total_match_time,
        'results': all_results,
        'timestamp': datetime.now().isoformat()
    }


def generate_report(results: Dict, output_file: Path = None):
    """
    生成测试报告
    
    Args:
        results: 测试结果字典
        output_file: 输出文件路径（可选）
    """
    print("\n" + "="*70)
    print("测试报告")
    print("="*70)
    print(f"测试时间: {results.get('timestamp', 'N/A')}")
    print(f"测试用例目录: {results.get('testcases_dir', 'N/A')}")
    print(f"测试用例数: {results.get('testcase_count', 0)}")
    print(f"总测试数: {results.get('total_tests', 0)}")
    print(f"正确匹配数: {results.get('total_correct', 0)}")
    print(f"准确率: {results.get('accuracy', 0):.2f}%")
    print(f"平均匹配时间: {results.get('avg_match_time_ms', 0):.2f}ms")
    print(f"总匹配时间: {results.get('total_match_time_ms', 0):.2f}ms")
    print("="*70)
    
    # 详细结果
    print("\n详细结果:")
    for testcase_result in results.get('results', []):
        print(f"\n测试用例: {testcase_result.get('testcase_name', 'N/A')}")
        for r in testcase_result.get('results', []):
            target_name = r.get('target_name', 'N/A')
            best_match = r.get('best_match_name', 'None')
            expected = Path(r.get('expected_match', '')).name if r.get('expected_match') else 'N/A'
            is_correct = r.get('is_correct', False)
            status = "✅" if is_correct else "❌"
            
            print(f"  {status} {target_name}")
            print(f"     最佳匹配: {best_match}")
            print(f"     预期匹配: {expected}")
            if r.get('volume'):
                print(f"     体积: {r.get('volume', 0):.2f}")
            if r.get('match_time_ms'):
                print(f"     匹配时间: {r.get('match_time_ms', 0):.2f}ms")
    
    # 保存JSON报告
    if output_file:
        output_file.parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        print(f"\n报告已保存到: {output_file}")
    
    # 准确率检查
    accuracy = results.get('accuracy', 0)
    if accuracy >= 99.0:
        print(f"\n✅ 准确率 {accuracy:.2f}% 达到要求（≥99%）")
        return 0
    else:
        print(f"\n❌ 准确率 {accuracy:.2f}% 未达到要求（需要≥99%）")
        return 1


def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='测试验证脚本：运行所有测试用例并生成报告',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument(
        'testcases_dir',
        type=str,
        help='测试用例根目录路径'
    )
    
    parser.add_argument(
        '--output', '-o',
        type=str,
        help='输出报告文件路径（JSON格式）'
    )
    
    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='输出详细信息'
    )
    
    args = parser.parse_args()
    
    testcases_dir = Path(args.testcases_dir)
    if not testcases_dir.exists():
        print(f"❌ 错误: 测试用例目录不存在: {testcases_dir}")
        sys.exit(1)
    
    # 运行所有测试用例
    start_time = time.time()
    results = run_all_testcases(testcases_dir, verbose=args.verbose)
    total_time = time.time() - start_time
    
    if 'error' in results:
        print(f"❌ 错误: {results['error']}")
        sys.exit(1)
    
    results['total_test_time_seconds'] = total_time
    
    # 生成报告
    output_file = Path(args.output) if args.output else None
    exit_code = generate_report(results, output_file)
    
    sys.exit(exit_code)


if __name__ == '__main__':
    sys.exit(main())
