#!/bin/bash
# 测试脚本：使用 Docker 验证 load_3dm.py 能否正确读取 testcases/ 目录下的所有 3DM 文件

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "3DM 文件读取测试 - Docker 版本"
echo "=========================================="
echo ""

# 检查必要文件是否存在
if [ ! -f "load_3dm.py" ]; then
    echo "❌ 错误: load_3dm.py 文件不存在"
    exit 1
fi

if [ ! -f "test_3dm_files.py" ]; then
    echo "❌ 错误: test_3dm_files.py 文件不存在"
    exit 1
fi

if [ ! -d "testcases" ]; then
    echo "❌ 错误: testcases 目录不存在"
    exit 1
fi

# 检查 Docker 是否可用
if ! command -v docker &> /dev/null; then
    echo "❌ 错误: Docker 未安装或不可用"
    exit 1
fi

echo "📦 构建 Docker 镜像..."
docker build -f Dockerfile.test_3dm -t test-3dm-loader:latest .

if [ $? -ne 0 ]; then
    echo "❌ Docker 镜像构建失败"
    exit 1
fi

echo ""
echo "🚀 运行测试..."
echo ""

# 使用 docker-compose 运行（如果可用）
if command -v docker-compose &> /dev/null || command -v docker compose &> /dev/null; then
    echo "使用 docker-compose 运行测试..."
    if command -v docker-compose &> /dev/null; then
        docker-compose -f docker-compose.test_3dm.yml up --build
    else
        docker compose -f docker-compose.test_3dm.yml up --build
    fi
    EXIT_CODE=$?
else
    # 直接使用 docker run
    echo "使用 docker run 运行测试..."
    docker run --rm \
        -v "$SCRIPT_DIR/testcases:/app/testcases:ro" \
        test-3dm-loader:latest
    EXIT_CODE=$?
fi

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ 测试完成！所有文件测试通过"
else
    echo "❌ 测试失败！有文件无法正确读取"
fi

exit $EXIT_CODE
