# 调试参数指南

本文档列出所有可调试的参数及其对应的 Docker 运行测试命令。

## 📋 目录

- [Python 命令行参数](#python-命令行参数)
- [梯度下降参数（可通过命令行调整）](#梯度下降参数可通过命令行调整)
- [常用调试命令](#常用调试命令)
- [参数调优建议](#参数调优建议)

---

## 🐍 Python 命令行参数

这些参数可以通过 `match_shoe_mold_optimized.py` 的命令行参数直接调整。

**注意**: `--angle-tolerance` 参数已移除。方向对齐现在通过 `alignDirections` 函数自动完成，确保鞋模和粗胚的方向完全一致，不再需要容差参数。

---

### 1. 穿模检测容差 (`--penetration-tolerance`)

**参数名**: `--penetration-tolerance` 或 `-p`  
**类型**: `float`  
**默认值**: `0.01` mm  
**说明**: 判断点是否在网格内部的容差。距离小于此值的点被认为在内部。

**Docker 命令**:
```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --penetration-tolerance 0.1 \
  --verbose
```

**调优建议**:
- 默认 `0.01` mm：高精度
- `0.1` mm：中等精度，计算更快
- `0.5` mm：低精度，适合快速测试

---

### 2. 包裹率阈值 (`--wrapping-threshold`)

**参数名**: `--wrapping-threshold` 或 `-w`  
**类型**: `float`  
**默认值**: `0.99` (99%)  
**说明**: 匹配成功所需的最低包裹率。只有包裹率 ≥ 此值的候选才会被接受。

**Docker 命令**:
```bash
# 要求 100% 包裹（最严格）
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --wrapping-threshold 1.0 \
  --verbose

# 要求 95% 包裹（较宽松）
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --wrapping-threshold 0.95 \
  --verbose
```

**调优建议**:
- `1.0` (100%)：最严格，只有完全包裹才接受
- `0.99` (99%)：默认值，允许少量边界点
- `0.95` (95%)：较宽松，适合快速筛选

---

### 3. 详细输出 (`--verbose`)

**参数名**: `--verbose` 或 `-v`  
**类型**: `bool` (flag)  
**默认值**: `False`  
**说明**: 是否输出详细的匹配过程信息，包括每个步骤的耗时、梯度下降迭代过程等。

**Docker 命令**:
```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --verbose
```

---

## ⚙️ 梯度下降参数（可通过命令行调整）

这些参数现在可以通过命令行直接调整，无需修改代码。

### 1. 梯度下降学习率

| 参数 | 命令行选项 | 默认值 | 说明 |
|------|-----------|--------|------|
| `learning_rate_translation` | `--lr-translation` | `0.2` | 纵向位移学习率 |
| `learning_rate_rotation` | `--lr-rotation` | `0.05` | 旋转角度学习率（弧度） |
| `learning_rate_vertical` | `--lr-vertical` | `0.2` | 垂直位移学习率 |

**Docker 命令**:
```bash
# 增大学习率，收敛更快
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --lr-translation 0.3 \
  --lr-rotation 0.1 \
  --lr-vertical 0.3 \
  --verbose
```

**调优建议**:
- 学习率太大：可能导致震荡，无法收敛
- 学习率太小：收敛慢，需要更多迭代
- 建议范围：
  - `--lr-translation`: 0.1 - 0.5
  - `--lr-rotation`: 0.01 - 0.1
  - `--lr-vertical`: 0.1 - 0.5

---

### 2. 数值梯度步长

| 参数 | 命令行选项 | 默认值 | 说明 |
|------|-----------|--------|------|
| `h_translation` | `--h-translation` | `0.1` mm | 纵向位移梯度计算步长 |
| `h_rotation` | `--h-rotation` | `0.01` 弧度 | 旋转角度梯度计算步长（约 0.57°） |
| `h_vertical` | `--h-vertical` | `0.1` mm | 垂直位移梯度计算步长 |

**Docker 命令**:
```bash
# 增大步长，梯度估计更粗糙但计算更快
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --h-translation 0.2 \
  --h-rotation 0.02 \
  --h-vertical 0.2 \
  --verbose
```

**调优建议**:
- 步长太大：梯度估计不准确
- 步长太小：梯度估计更准确但计算成本高
- 建议范围：
  - `--h-translation`: 0.05 - 0.5 mm
  - `--h-rotation`: 0.005 - 0.02 弧度
  - `--h-vertical`: 0.05 - 0.5 mm

---

### 3. 最大迭代次数

| 参数 | 命令行选项 | 默认值 | 说明 |
|------|-----------|--------|------|
| `max_iterations` | `--max-iterations` | `50` | 梯度下降最大迭代次数 |

**Docker 命令**:
```bash
# 增加最大迭代次数
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --max-iterations 100 \
  --verbose

# 减少迭代次数（快速测试）
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --max-iterations 30 \
  --verbose
```

**调优建议**:
- 默认 `50`：适合大多数情况
- `100`：更复杂的优化问题
- `30`：快速测试

---

### 4. 收敛阈值

| 参数 | 命令行选项 | 默认值 | 说明 |
|------|-----------|--------|------|
| `convergence_threshold` | `--convergence-threshold` | `0.001` | 梯度小于此值时认为收敛 |

**Docker 命令**:
```bash
# 更严格的收敛条件
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --convergence-threshold 0.0001 \
  --verbose

# 更宽松的收敛条件（更快收敛）
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --convergence-threshold 0.01 \
  --verbose
```

**调优建议**:
- `0.001`：默认值，平衡精度和速度
- `0.0001`：更严格，需要更多迭代
- `0.01`：更宽松，更快收敛

---

### 5. 采样点数量

| 参数 | 命令行选项 | 默认值 | 说明 |
|------|-----------|--------|------|
| `num_sample_points` | `--num-sample-points` | `500` | 用于计算包裹率的采样点数量 |

**Docker 命令**:
```bash
# 增加采样点（更高精度）
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --num-sample-points 1000 \
  --verbose

# 减少采样点（更快）
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --num-sample-points 200 \
  --verbose
```

**调优建议**:
- `500`：默认值，平衡精度和速度
- `1000`：更高精度，但计算更慢
- `200`：更快，但精度较低

---

## 🚀 常用调试命令

### 基本测试命令

```bash
# 测试单个用例（默认参数）
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --verbose

# 测试所有用例
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases \
  --verbose
```

### 调整包裹率阈值

```bash
# 要求 100% 包裹
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --wrapping-threshold 1.0 \
  --verbose

# 要求 95% 包裹（更宽松）
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --wrapping-threshold 0.95 \
  --verbose
```

### 调整穿模检测容差

```bash
# 更宽松的穿模检测（0.1mm）
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --penetration-tolerance 0.1 \
  --verbose

# 更严格的穿模检测（0.001mm）
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --penetration-tolerance 0.001 \
  --verbose
```

### 组合参数测试

```bash
# 严格模式：高精度、100%包裹
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --penetration-tolerance 0.001 \
  --wrapping-threshold 1.0 \
  --verbose

# 快速模式：宽松条件、快速测试
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --penetration-tolerance 0.1 \
  --wrapping-threshold 0.95 \
  --verbose
```

---

## 🎯 梯度下降参数组合示例

### 快速测试模式

```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --max-iterations 30 \
  --num-sample-points 200 \
  --convergence-threshold 0.01 \
  --verbose
```

### 高精度模式

```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --max-iterations 100 \
  --num-sample-points 1000 \
  --convergence-threshold 0.0001 \
  --lr-translation 0.1 \
  --lr-rotation 0.02 \
  --lr-vertical 0.1 \
  --verbose
```

### 调试收敛问题

```bash
# 如果收敛太慢，增大学习率和收敛阈值
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --lr-translation 0.3 \
  --lr-rotation 0.1 \
  --lr-vertical 0.3 \
  --convergence-threshold 0.01 \
  --max-iterations 100 \
  --verbose
```

---

## 📊 参数调优建议

### 场景1：高精度匹配

**目标**: 获得最精确的匹配结果

**参数设置**:
- `--penetration-tolerance`: `0.001` mm
- `--wrapping-threshold`: `1.0` (100%)
- `--num-sample-points`: `1000`（增加采样点）
- `--convergence-threshold`: `0.0001`（更严格收敛）
- `--max-iterations`: `100`（更多迭代）

**命令**:
```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --penetration-tolerance 0.001 \
  --wrapping-threshold 1.0 \
  --max-iterations 100 \
  --num-sample-points 1000 \
  --convergence-threshold 0.0001 \
  --verbose
```

---

### 场景2：快速测试

**目标**: 快速验证算法是否工作

**参数设置**:
- `--penetration-tolerance`: `0.1` mm
- `--wrapping-threshold`: `0.95` (95%)
- `--num-sample-points`: `200`（减少采样点）
- `--max-iterations`: `30`（减少迭代次数）

**命令**:
```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --penetration-tolerance 0.1 \
  --wrapping-threshold 0.95 \
  --max-iterations 30 \
  --num-sample-points 200 \
  --verbose
```

---

### 场景3：调试梯度下降

**目标**: 观察梯度下降的详细过程

**参数设置**:
- 使用 `--verbose` 查看详细日志
- `--max-iterations`: `100`（增加迭代次数）
- `--lr-translation`: `0.1`（减小学习率，观察更平滑的收敛）

**命令**:
```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --max-iterations 100 \
  --lr-translation 0.1 \
  --verbose 2>&1 | grep -E "迭代|梯度|损失"
```

---

### 场景4：处理收敛问题

**问题**: 梯度下降无法收敛或收敛太慢

**解决方案**:
1. **减小学习率**（如果震荡）:
   ```bash
   docker-compose run --rm test-3dm-loader \
     python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
     --lr-translation 0.1 \
     --lr-rotation 0.02 \
     --lr-vertical 0.1 \
     --verbose
   ```

2. **增大收敛阈值**（如果收敛太慢）:
   ```bash
   docker-compose run --rm test-3dm-loader \
     python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
     --convergence-threshold 0.01 \
     --verbose
   ```

3. **增加最大迭代次数**:
   ```bash
   docker-compose run --rm test-3dm-loader \
     python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
     --max-iterations 100 \
     --verbose
   ```

---

## 📝 参数总结表

### Python 命令行参数

| 参数 | 默认值 | 范围 | 说明 |
|------|--------|------|------|
| `--penetration-tolerance` | `0.01` mm | 0.001 - 1.0 | 穿模检测容差 |
| `--wrapping-threshold` | `0.99` | 0.0 - 1.0 | 包裹率阈值 |
| `--verbose` | `False` | - | 详细输出 |

**注意**: `--angle-tolerance` 参数已移除。方向对齐现在通过算法自动完成，确保鞋模和粗胚的方向完全一致。

### C++ 硬编码参数

| 参数 | 命令行选项 | 默认值 | 建议范围 | 说明 |
|------|-----------|--------|----------|------|
| `learning_rate_translation` | `--lr-translation` | `0.2` | 0.1 - 0.5 | 纵向位移学习率 |
| `learning_rate_rotation` | `--lr-rotation` | `0.05` | 0.01 - 0.1 | 旋转角度学习率 |
| `learning_rate_vertical` | `--lr-vertical` | `0.2` | 0.1 - 0.5 | 垂直位移学习率 |
| `h_translation` | `--h-translation` | `0.1` mm | 0.05 - 0.5 | 纵向位移步长 |
| `h_rotation` | `--h-rotation` | `0.01` 弧度 | 0.005 - 0.02 | 旋转角度步长 |
| `h_vertical` | `--h-vertical` | `0.1` mm | 0.05 - 0.5 | 垂直位移步长 |
| `max_iterations` | `--max-iterations` | `50` | 30 - 100 | 最大迭代次数 |
| `convergence_threshold` | `--convergence-threshold` | `0.001` | 0.0001 - 0.01 | 收敛阈值 |
| `num_sample_points` | `--num-sample-points` | `500` | 200 - 1000 | 采样点数量 |

---

## 🔍 调试技巧

### 1. 查看详细日志

```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --verbose 2>&1 | tee debug.log
```

### 2. 只查看梯度下降过程

```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --verbose 2>&1 | grep "optimizePositionAndRotation"
```

### 3. 查看包裹率计算

```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 \
  --verbose 2>&1 | grep "computeWrappingRatio"
```

### 4. 进入容器交互式调试

```bash
docker-compose run --rm test-3dm-loader /bin/bash

# 在容器内
python src/biz/match_shoe_mold_optimized.py /app/testcases/testcase1 --verbose
```

---

**文档版本**: 1.0  
**最后更新**: 2026-02-01
