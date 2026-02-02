# 文档目录

本目录包含 3D 鞋模匹配系统的完整文档。

## 📚 文档列表

### 1. Docker 使用指南
**文件**: `docker_usage_guide.md`

**内容**:
- Docker 环境要求
- 如何构建 Docker 镜像
- 如何更新 Docker 镜像
- 如何测试单个测试用例
- 如何运行 Docker Compose 服务
- 常见问题和调试技巧

**适用对象**: 所有用户

---

### 2. 匹配算法详细说明
**文件**: `algorithm_explanation_detailed.md`

**内容**:
- 算法基本思想（通俗易懂的解释）
- 完整流程（7个步骤）
- 关键数据结构
- 时间复杂度分析
- 完整执行示例
- 关键算法细节

**适用对象**: 算法研究人员、开发者

**版本**: 3.0（包含3D梯度下降优化）

---

### 3. 梯度下降算法详细说明
**文件**: `gradient_descent_detailed_explanation.md`

**内容**:
- 优化空间（3D空间）
- 初始化阶段
- 损失函数
- 梯度计算（数值梯度法）
- 参数更新
- 接受/拒绝机制
- 收敛判断
- 完整迭代流程
- 优化示例

**适用对象**: 算法研究人员、开发者

**版本**: 2.0（3D优化版本）

---

### 4. 调试参数指南
**文件**: `debugging_parameters.md`

**内容**:
- Python 命令行参数说明
- C++ 代码中的硬编码参数
- 常用调试命令
- 参数调优建议和场景示例

**适用对象**: 开发者、调试人员

---

## 🚀 快速开始

### 构建和运行

```bash
# 构建镜像
docker build -f Dockerfile -t 3dm-matcher:latest .

# 测试单个用例
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 --verbose

# 启动网页查看器
docker-compose up web-viewer
```

详细说明请参考 `docker_usage_guide.md`。

---

## 📝 文档更新记录

- **2026-02-01**: 整理文档目录，保留核心文档
  - Docker 使用指南（整合构建、更新、测试、运行）
  - 匹配算法详细说明（更新为3D优化版本）
  - 梯度下降算法详细说明（更新为3D优化版本）
  - 调试参数指南（新增，包含所有可调参数和调试命令）

---

**最后更新**: 2026-02-01
