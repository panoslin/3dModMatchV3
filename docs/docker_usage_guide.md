# Docker 使用指南

本文档介绍如何使用 Docker 构建、更新、测试和运行 3D 鞋模匹配系统。

## 📋 目录

- [环境要求](#环境要求)
- [构建 Docker 镜像](#构建-docker-镜像)
- [更新 Docker 镜像](#更新-docker-镜像)
- [测试单个测试用例](#测试单个测试用例)
- [运行 Docker Compose 服务](#运行-docker-compose-服务)
- [常见问题](#常见问题)

---

## 🔧 环境要求

### 必需软件

1. **Docker** (版本 20.10+)
   - 下载地址: https://www.docker.com/get-started
   - 用于构建和运行容器化环境

2. **Docker Compose** (版本 1.29+)
   - 通常随 Docker Desktop 一起安装
   - 用于管理多容器应用

### 系统要求

- **操作系统**: macOS, Linux, 或 Windows (WSL2)
- **内存**: 建议至少 8GB RAM
- **磁盘空间**: 至少 5GB 可用空间
- **CPU**: 支持多核处理器（用于并行计算加速）

### 验证安装

```bash
docker --version
docker-compose --version
docker ps
```

---

## 🏗️ 构建 Docker 镜像

### 构建所有镜像

项目包含两个服务，使用相同的 Dockerfile：

```bash
# 在项目根目录执行
cd /Volumes/PanosT9/Projects/3dModMatchV3

# 构建镜像（两个服务使用相同的镜像）
docker build -f Dockerfile -t 3dm-matcher:latest .
```

**预计耗时**: 5-10 分钟（首次构建需要下载依赖）

### 构建过程说明

1. **基础镜像**: `python:3.10-slim`
2. **安装系统依赖**: 
   - CMake, Eigen3, gcc/g++, make, git
   - 用于编译 C++ 核心模块
3. **安装 Python 依赖**:
   - rhino3dm==8.17.0
   - numpy==1.26.4
   - pybind11==2.11.1
   - Flask>=2.0.0, Flask-CORS>=3.0.0
4. **编译 C++ 模块**:
   - 使用 CMake 构建 `mesh_matcher.so`
   - 支持 OpenMP 并行处理（如果系统支持）
5. **验证构建**:
   - 自动验证 C++ 模块是否成功加载

### 构建输出示例

```
[+] Building 120.5s (21/21) FINISHED
 => [internal] load build context
 => => transferring context: 1.2MB
 ...
 => [19/19] RUN python3 -c "import sys; sys.path.insert(0, '/app'); import mesh_matcher; print('C++ module loaded successfully')"
 => => C++ module loaded successfully
```

### 验证镜像构建成功

```bash
docker run --rm 3dm-matcher:latest python3 -c "import mesh_matcher; print('Module loaded successfully')"
```

应该输出: `Module loaded successfully`

---

## 🔄 更新 Docker 镜像

### 何时需要更新

- 修改了 C++ 代码（`src/core/` 目录）
- 修改了 Python 代码（`src/biz/` 或 `src/viz/` 目录）
- 修改了 Dockerfile
- 修改了依赖（`requirements.txt`）

### 更新步骤

```bash
# 1. 停止运行中的容器
docker-compose down

# 2. 重新构建镜像（不使用缓存）
docker build --no-cache -f Dockerfile -t 3dm-matcher:latest .

# 或者使用 docker-compose 构建
docker-compose build --no-cache
```

### 清理旧镜像（可选）

```bash
# 删除未使用的镜像
docker image prune -a

# 清理所有未使用的资源
docker system prune -a
```

---

## 🧪 测试单个测试用例

### 基本用法

```bash
# 测试单个测试用例（testcase1）
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py \
  /app/testcases/testcase1 \
  --verbose
```

### 测试特定目标文件

```bash
# 只测试 testcase1 中的 B004加大.3dm
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py \
  /app/testcases/testcase1/target/B004加大.3dm \
  --verbose
```

### 自定义参数

```bash
# 自定义包裹率阈值（默认 0.99，即 99%）
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py \
  /app/testcases/testcase1 \
  --wrapping-threshold 0.99 \
  --verbose

# 调整遗传算法参数
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py \
  /app/testcases/testcase1 \
  --ga-population-size 100 \
  --ga-max-generations 50 \
  --verbose
```

### 测试所有用例

```bash
# 测试所有测试用例
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py \
  /app/testcases \
  --verbose
```

### 使用其他测试脚本

```bash
# 运行所有匹配测试（生成详细报告）
docker-compose run --rm test-3dm-loader \
  python src/biz/test_all_matches.py \
  /app/testcases \
  --output-csv /app/match_results/results.csv \
  --output-html /app/match_results/results.html \
  --output-json /app/match_results/results.json \
  --verbose
```

---

## 🚀 运行 Docker Compose 服务

### 服务说明

项目包含两个服务：

1. **web-viewer**: 网页查看器服务
   - 端口: 5001 (映射到容器内的 5000)
   - 功能: 在浏览器中查看 3DM 文件

2. **test-3dm-loader**: 测试服务
   - 功能: 运行匹配测试和分析

### 启动网页查看器

```bash
# 启动服务（后台运行）
docker-compose up -d web-viewer

# 查看日志
docker-compose logs -f web-viewer

# 查看服务状态
docker-compose ps
```

**访问地址**: http://localhost:5001

### 停止服务

```bash
# 停止网页查看器
docker-compose stop web-viewer

# 停止并删除容器
docker-compose down web-viewer
```

### 重启服务

```bash
# 重启服务
docker-compose restart web-viewer

# 重新构建并启动
docker-compose up -d --build web-viewer
```

### 查看服务日志

```bash
# 查看所有服务日志
docker-compose logs

# 查看特定服务日志
docker-compose logs web-viewer

# 实时跟踪日志
docker-compose logs -f web-viewer
```

### 健康检查

```bash
# 检查服务健康状态
curl http://localhost:5001/api/health

# 应该返回:
# {"matcher_available":true,"message":"3DM Viewer API is running","status":"ok"}
```

---

## 📁 测试用例结构

```
testcases/
├── testcase1/
│   ├── target/          # 目标鞋模文件
│   │   ├── B004加大.3dm
│   │   ├── B004大.3dm
│   │   └── B004小.3dm
│   └── candidate_set/  # 候选粗胚文件
│       ├── B004加大.3dm
│       ├── B004大.3dm
│       └── B004小.3dm
├── testcase2/
│   ├── target/
│   └── candidate_set/
└── ...
```

---

## 📊 测试结果解读

### 成功匹配示例

```
======================================================================
匹配目标: B004加大.3dm
======================================================================
[1/3] 检查候选: B004加大.3dm
  方向对齐验证:
    鞋跟-鞋头对齐: 1.0000 (角度: 0.00°)
    上下方向对齐: 1.0000 (角度: 0.00°)
    方向约束满足: ✅
  包裹率: 1.0000 (100.00%)
  完全包裹: ✅
  无穿模: ✅
  体积: 1544742.29
  最优平移: 2.3753mm
  最优旋转角度: -2.59622度
  最优横向位移: -0.8mm（上下方向，横向轴是上下方向）
  匹配时间: 23773.09ms
  ✅ 满足匹配条件

✅ 找到匹配: B004加大.3dm
```

### 关键指标说明

| 指标 | 说明 | 合格标准 |
|------|------|---------|
| **方向对齐** | 鞋模和粗胚的方向一致性 | 鞋跟-鞋头: ≤0.1°, 上下: ≤0.1° |
| **包裹率** | 鞋模被粗胚包裹的比例 | **必须 ≥ 99%**（默认阈值） |
| **完全包裹** | 是否所有采样点都在粗胚内部 | **必须 = true** |
| **体积** | 粗胚的体积 | 越小越好（用于最终选择） |
| **最优平移** | 沿纵向轴的最优相对位移（前后方向） | 自动优化（遗传算法） |
| **最优旋转角度** | 绕纵向轴的最优相对旋转 | 自动优化（遗传算法） |
| **最优横向位移** | 沿横向轴的最优位移（上下方向，横向轴是上下方向） | 自动优化（遗传算法） |

---

## ❓ 常见问题

### Q1: Docker 构建失败

**问题**: `CMake Error: Could not find a package configuration file provided by "pybind11"`

**解决方案**:
1. 检查 Dockerfile 中的依赖安装是否正确
2. 确保网络连接正常（需要下载依赖）
3. 尝试清理 Docker 缓存后重新构建:
   ```bash
   docker system prune -a
   docker build --no-cache -f Dockerfile -t test-3dm-loader:latest .
   ```

### Q2: 模块导入失败

**问题**: `ModuleNotFoundError: No module named 'mesh_matcher'`

**解决方案**:
1. 检查 C++ 模块是否成功编译:
   ```bash
   docker run --rm 3dm-matcher:latest ls -la /app/mesh_matcher*
   ```
2. 重新构建镜像

### Q3: 测试运行很慢

**原因**: 
- 遗传算法需要评估多个个体（默认50个/代）
- 每代需要运行多代（默认30代）
- 每次包裹率计算需要检查 500 个点
- KD-tree 构建需要时间

**这是正常现象**，算法已优化（使用 KD-tree、OpenMP 并行化）

**优化建议**:
- 减少种群大小：`--ga-population-size 30`
- 减少代数：`--ga-max-generations 20`
- 减少采样点：`--num-sample-points 200`

### Q4: 端口被占用

**问题**: `Error: bind: address already in use`

**解决方案**:
```bash
# 停止占用端口的容器
docker-compose down

# 或者修改 docker-compose.yml 中的端口映射
# 将 "5001:5000" 改为其他端口，如 "5002:5000"
```

### Q5: 内存不足

**问题**: `Killed` 或 `Out of memory`

**解决方案**:
1. 增加 Docker 内存限制（Docker Desktop → Settings → Resources → Memory）
2. 减少并行测试数量
3. 关闭其他占用内存的应用

---

## 🔍 调试技巧

### 1. 查看详细日志

```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py \
  /app/testcases/testcase1 \
  --verbose 2>&1 | tee test_output.log
```

### 2. 进入容器调试

```bash
# 启动交互式容器
docker-compose run --rm test-3dm-loader /bin/bash

# 在容器内执行命令
python src/biz/matcher.py /app/testcases/testcase1 --verbose
```

### 3. 检查容器状态

```bash
# 查看运行中的容器
docker-compose ps

# 查看容器资源使用
docker stats

# 查看容器详细信息
docker inspect 3dm-web-viewer
```

---

## 📝 快速参考

### 常用命令

```bash
# 构建镜像
docker build -f Dockerfile -t 3dm-matcher:latest .

# 测试单个用例
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 --verbose

# 启动网页查看器
docker-compose up -d web-viewer

# 停止服务
docker-compose stop web-viewer

# 查看日志
docker-compose logs -f web-viewer

# 清理资源
docker-compose down
docker system prune -a
```

---

**文档版本**: 1.0  
**最后更新**: 2026-02-01
