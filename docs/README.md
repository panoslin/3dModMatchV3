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

**版本**: 4.0（使用遗传算法优化）

**重要说明**：实践证明，横向轴才是上下方向，垂直轴是左右方向。

---


### 3. 调试参数指南
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
  python src/biz/matcher.py /app/testcases/testcase1 --verbose

# 启动网页查看器
docker-compose up web-viewer
```

详细说明请参考 `docker_usage_guide.md`。

---

## 📒 TODO


---

## 📝 文档更新记录

- **2026-02-01**: 整理文档目录，保留核心文档
  - Docker 使用指南（整合构建、更新、测试、运行）
  - 匹配算法详细说明（更新为遗传算法版本）
  - 优化参数物理意义详解（详细解释三个优化参数的物理意义）
  - 包裹率计算详解（详细解释包裹率的计算方法）
  - 调试参数指南（包含所有可调参数和调试命令）
- **2026-02-01**: 移除梯度下降算法，统一使用遗传算法

---

**最后更新**: 2026-02-01
