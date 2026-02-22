#!/bin/bash
# 运行所有匹配测试并导出结果

set -e  # 遇到错误立即退出

echo "=========================================="
echo "开始运行所有匹配测试..."
echo "=========================================="
echo ""

# 确保结果目录存在
mkdir -p match_results

# 运行测试（使用 docker-compose）
# 注意：如果测试时间很长，可能需要增加超时时间
echo "正在运行测试，这可能需要一些时间..."
echo ""

docker compose run --rm \
    test-3dm-loader \
    sh -c "mkdir -p /app/match_results && \
           python src/biz/test_all_matches.py /app/testcases \
           --output-csv /app/match_results/results.csv \
           --output-html /app/match_results/results.html \
           --output-json /app/match_results/results.json \
           --verbose"

echo ""
echo "=========================================="
echo "测试完成！结果已导出到 match_results/ 目录"
echo "=========================================="
echo ""
echo "生成的文件："
ls -lh match_results/ | grep -E "\.(csv|html|json)$" || echo "  未找到结果文件"
echo ""
