# 调试参数指南

本文档列出所有可调试的参数及其对应的 Docker 运行测试命令。

## 📋 目录

- [Python 命令行参数](#python-命令行参数)
- [遗传算法参数（可通过命令行调整）](#遗传算法参数可通过命令行调整)
- [常用调试命令](#常用调试命令)
- [参数调优建议](#参数调优建议)

---

## 🐍 Python 命令行参数

这些参数可以通过 `matcher.py` 的命令行参数直接调整。

### 1. 包裹率阈值 (`--wrapping-threshold`)

**参数名**: `--wrapping-threshold`  
**类型**: `float`  
**默认值**: `0.99` (99%)  
**说明**: 匹配成功所需的最低包裹率。只有包裹率 ≥ 此值的候选才会被接受。

**Docker 命令**:
```bash
# 要求 100% 包裹（最严格）
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --wrapping-threshold 1.0 \
  --verbose

# 要求 95% 包裹（较宽松）
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --wrapping-threshold 0.95 \
  --verbose
```

**调优建议**:
- `1.0` (100%)：最严格，只有完全包裹才接受
- `0.99` (99%)：默认值，允许少量边界点
- `0.95` (95%)：较宽松，适合快速筛选

---

### 2. 详细输出 (`--verbose`)

**参数名**: `--verbose` 或 `-v`  
**类型**: `bool` (flag)  
**默认值**: `False`  
**说明**: 是否输出详细的匹配过程信息，包括方向对齐、遗传算法迭代过程等。

**Docker 命令**:
```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --verbose
```

---

## ⚙️ 遗传算法参数（可通过命令行调整）

这些参数现在可以通过命令行直接调整，无需修改代码。

### 1. 种群和代数参数

| 参数 | 命令行选项 | 默认值 | 说明 |
|------|-----------|--------|------|
| `population_size` | `--ga-population-size` | `50` | 种群大小（每代个体数） |
| `max_generations` | `--ga-max-generations` | `30` | 最大代数（迭代次数） |

**Docker 命令**:
```bash
# 增大种群和代数，搜索更全面但更慢
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --ga-population-size 100 \
  --ga-max-generations 50 \
  --verbose
```

**调优建议**:
- 种群大小：
  - `50`：默认值，平衡速度和搜索范围
  - `100`：更全面的搜索，但计算时间翻倍
  - `30`：快速测试
- 最大代数：
  - `30`：默认值，适合大多数情况
  - `50`：更复杂的优化问题
  - `20`：快速测试

---

### 2. 交叉和变异参数

| 参数 | 命令行选项 | 默认值 | 说明 |
|------|-----------|--------|------|
| `crossover_rate` | `--ga-crossover-rate` | `0.8` | 交叉率（产生新个体的概率） |
| `mutation_rate` | `--ga-mutation-rate` | `0.1` | 变异率（个体变异的概率） |
| `mutation_scale` | `--ga-mutation-scale` | `0.1` | 变异幅度（变异的大小） |
| `selection_rate` | `--ga-selection-rate` | `0.5` | 选择率（保留前N%的个体） |

**Docker 命令**:
```bash
# 增加变异，探索更多可能性
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --ga-mutation-rate 0.2 \
  --ga-mutation-scale 0.15 \
  --verbose
```

**调优建议**:
- 交叉率：
  - `0.8`：默认值，平衡探索和利用
  - `0.9`：更多交叉，更快收敛
  - `0.6`：更保守，保持多样性
- 变异率：
  - `0.1`：默认值
  - `0.2`：增加探索，避免过早收敛
  - `0.05`：减少变异，更快收敛
- 变异幅度：
  - `0.1`：默认值
  - `0.2`：更大的变异，探索更广
  - `0.05`：更小的变异，精细调整

---

### 3. 搜索范围参数

| 参数 | 命令行选项 | 默认值 | 说明 |
|------|-----------|--------|------|
| `translation_range` | `--ga-translation-range` | `50.0` mm | 纵向位移搜索范围（±50mm，前后方向） |
| `rotation_range` | `--ga-rotation-range` | `180.0` 度 | 旋转角度搜索范围（±180度，绕纵向轴） |
| `lateral_range` | `--ga-lateral-range` | `30.0` mm | 横向位移搜索范围（±30mm，上下方向，横向轴是上下方向） |

**Docker 命令**:
```bash
# 扩大搜索范围
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --ga-translation-range 100.0 \
  --ga-rotation-range 360.0 \
  --ga-lateral-range 50.0 \
  --verbose
```

**调优建议**:
- 如果匹配失败，可以尝试扩大搜索范围
- 如果计算时间太长，可以缩小搜索范围

---

### 4. 提前终止参数

| 参数 | 命令行选项 | 默认值 | 说明 |
|------|-----------|--------|------|
| `target_wrapping_ratio` | `--ga-target-wrapping-ratio` | `0.96` | 目标包裹率（达到此值即停止，0表示禁用） |
| `num_sample_points` | `--num-sample-points` | `500` | 采样点数量（用于计算包裹率） |

**Docker 命令**:
```bash
# 设置更高的目标包裹率，提前终止
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --ga-target-wrapping-ratio 0.98 \
  --num-sample-points 1000 \
  --verbose
```

**调优建议**:
- `target_wrapping_ratio`：
  - `0.96`：默认值，达到96%即停止
  - `0.98`：更严格，需要更高包裹率
  - `0`：禁用提前终止，运行完整代数
- `num_sample_points`：
  - `500`：默认值，平衡精度和速度
  - `1000`：更高精度，但计算更慢
  - `200`：更快，但精度较低

---

## 🚀 常用调试命令

### 基本测试命令

```bash
# 测试单个用例（默认参数）
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --verbose

# 测试所有用例
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases \
  --verbose
```

### 调整包裹率阈值

```bash
# 要求 100% 包裹
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --wrapping-threshold 1.0 \
  --verbose

# 要求 95% 包裹（更宽松）
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --wrapping-threshold 0.95 \
  --verbose
```

### 组合参数测试

```bash
# 严格模式：高精度、100%包裹
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --wrapping-threshold 1.0 \
  --ga-population-size 100 \
  --ga-max-generations 50 \
  --num-sample-points 1000 \
  --verbose

# 快速模式：宽松条件、快速测试
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --wrapping-threshold 0.95 \
  --ga-population-size 30 \
  --ga-max-generations 20 \
  --num-sample-points 200 \
  --verbose
```

---

## 🎯 遗传算法参数组合示例

### 快速测试模式

```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --ga-population-size 30 \
  --ga-max-generations 20 \
  --num-sample-points 200 \
  --ga-target-wrapping-ratio 0.95 \
  --verbose
```

### 高精度模式

```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --ga-population-size 100 \
  --ga-max-generations 50 \
  --num-sample-points 1000 \
  --ga-target-wrapping-ratio 0.98 \
  --wrapping-threshold 1.0 \
  --verbose
```

### 调试收敛问题

```bash
# 如果收敛太慢，增加种群和代数
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --ga-population-size 100 \
  --ga-max-generations 50 \
  --ga-mutation-rate 0.2 \
  --verbose
```

---

## 📊 参数调优建议

### 场景1：高精度匹配

**目标**: 获得最精确的匹配结果

**参数设置**:
- `--wrapping-threshold`: `1.0` (100%)
- `--num-sample-points`: `1000`（增加采样点）
- `--ga-population-size`: `100`（更大种群）
- `--ga-max-generations`: `50`（更多代数）
- `--ga-target-wrapping-ratio`: `0.98`（更严格目标）

**命令**:
```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --wrapping-threshold 1.0 \
  --ga-population-size 100 \
  --ga-max-generations 50 \
  --num-sample-points 1000 \
  --ga-target-wrapping-ratio 0.98 \
  --verbose
```

---

### 场景2：快速测试

**目标**: 快速验证算法是否工作

**参数设置**:
- `--wrapping-threshold`: `0.95` (95%)
- `--num-sample-points`: `200`（减少采样点）
- `--ga-population-size`: `30`（更小种群）
- `--ga-max-generations`: `20`（更少代数）
- `--ga-target-wrapping-ratio`: `0.95`（更宽松目标）

**命令**:
```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --wrapping-threshold 0.95 \
  --ga-population-size 30 \
  --ga-max-generations 20 \
  --num-sample-points 200 \
  --ga-target-wrapping-ratio 0.95 \
  --verbose
```

---

### 场景3：调试遗传算法

**目标**: 观察遗传算法的详细过程

**参数设置**:
- 使用 `--verbose` 查看详细日志
- `--ga-max-generations`: `50`（增加代数）
- `--ga-population-size`: `50`（默认值）

**命令**:
```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --ga-max-generations 50 \
  --verbose 2>&1 | grep -E "代|适应度|包裹率"
```

---

### 场景4：处理收敛问题

**问题**: 遗传算法无法找到好的解或收敛太慢

**解决方案**:
1. **增加种群大小**（如果搜索范围不够）:
   ```bash
   docker-compose run --rm test-3dm-loader \
     python src/biz/matcher.py /app/testcases/testcase1 \
     --ga-population-size 100 \
     --verbose
   ```

2. **增加变异率**（如果过早收敛）:
   ```bash
   docker-compose run --rm test-3dm-loader \
     python src/biz/matcher.py /app/testcases/testcase1 \
     --ga-mutation-rate 0.2 \
     --ga-mutation-scale 0.15 \
     --verbose
   ```

3. **扩大搜索范围**（如果最优解在范围外）:
   ```bash
   docker-compose run --rm test-3dm-loader \
     python src/biz/matcher.py /app/testcases/testcase1 \
     --ga-translation-range 100.0 \
     --ga-rotation-range 360.0 \
     --ga-lateral-range 50.0 \
     --verbose
   ```

---

## 📝 参数总结表

### Python 命令行参数

| 参数 | 默认值 | 范围 | 说明 |
|------|--------|------|------|
| `--wrapping-threshold` | `0.99` | 0.0 - 1.0 | 包裹率阈值 |
| `--verbose` | `False` | - | 详细输出 |

### 遗传算法参数

| 参数 | 命令行选项 | 默认值 | 建议范围 | 说明 |
|------|-----------|--------|----------|------|
| `population_size` | `--ga-population-size` | `50` | 30 - 100 | 种群大小 |
| `max_generations` | `--ga-max-generations` | `30` | 20 - 50 | 最大代数 |
| `crossover_rate` | `--ga-crossover-rate` | `0.8` | 0.6 - 0.9 | 交叉率 |
| `mutation_rate` | `--ga-mutation-rate` | `0.1` | 0.05 - 0.2 | 变异率 |
| `mutation_scale` | `--ga-mutation-scale` | `0.1` | 0.05 - 0.2 | 变异幅度 |
| `selection_rate` | `--ga-selection-rate` | `0.5` | 0.3 - 0.7 | 选择率 |
| `translation_range` | `--ga-translation-range` | `50.0` mm | 20 - 100 | 纵向位移范围（前后方向） |
| `rotation_range` | `--ga-rotation-range` | `180.0` 度 | 90 - 360 | 旋转角度范围（绕纵向轴） |
| `lateral_range` | `--ga-lateral-range` | `30.0` mm | 10 - 50 | 横向位移范围（上下方向，横向轴是上下方向） |
| `target_wrapping_ratio` | `--ga-target-wrapping-ratio` | `0.96` | 0.0 - 1.0 | 目标包裹率（0=禁用） |
| `num_sample_points` | `--num-sample-points` | `500` | 200 - 1000 | 采样点数量 |

---

## 🔍 调试技巧

### 1. 查看详细日志

```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --verbose 2>&1 | tee debug.log
```

### 2. 只查看遗传算法过程

```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --verbose 2>&1 | grep -E "代|适应度|包裹率"
```

### 3. 查看包裹率计算

```bash
docker-compose run --rm test-3dm-loader \
  python src/biz/matcher.py /app/testcases/testcase1 \
  --verbose 2>&1 | grep "包裹率"
```

### 4. 进入容器交互式调试

```bash
docker-compose run --rm test-3dm-loader /bin/bash

# 在容器内
python src/biz/matcher.py /app/testcases/testcase1 --verbose
```

---

**文档版本**: 2.0（更新为遗传算法版本）  
**最后更新**: 2026-02-01
