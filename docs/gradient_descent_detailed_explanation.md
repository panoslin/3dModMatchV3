# 梯度下降优化算法详细说明

## 📐 一、优化空间（3D空间）

### 优化维度

当前算法在 **3维空间** 中优化，三个维度分别是：

| 维度 | 参数名 | 单位 | 含义 | 初始值 |
|------|--------|------|------|--------|
| **维度1** | `current_offset` | 毫米(mm) | 沿纵向轴的前后位移 | 质心差在纵向轴上的投影 |
| **维度2** | `current_relative_angle` | 弧度(rad) | 绕纵向轴的旋转角度 | 0.0 |
| **维度3** | `current_vertical_offset` | 毫米(mm) | 垂直方向的上下位移 | 质心差在垂直轴上的投影 |

### 优化目标

**最小化损失函数**：
```
损失 = 1 - 包裹率
```

其中包裹率 = 鞋模采样点在粗胚内部的比例（0-1之间）

---

## 🎯 二、初始化阶段

### 2.1 计算参考轴

**纵向轴**（已对齐，作为参考）：
```cpp
Eigen::Vector3d longitudinal_axis = computeLongitudinalAxis(candidate_vertices, candidate_faces);
```

**垂直轴**（上下方向）：
```cpp
Eigen::Vector3d vertical_axis = computeVerticalAxis(candidate_vertices, candidate_faces);
```

### 2.2 计算质心

**鞋模质心**：
```cpp
target_center = (所有鞋模顶点坐标之和) / 顶点数
```

**粗胚质心**：
```cpp
candidate_center = (所有粗胚顶点坐标之和) / 顶点数
```

### 2.3 计算初始值

**初始纵向位移**：
```cpp
center_diff = target_center - candidate_center
current_offset = center_diff · longitudinal_axis  // 点积投影
```

**初始垂直位移**：
```cpp
current_vertical_offset = center_diff · vertical_axis  // 点积投影
```

**初始旋转角度**：
```cpp
current_relative_angle = 0.0  // 弧度
```

### 2.4 固定采样点

**为什么固定采样点？**
- 确保整个迭代过程中使用相同的采样点
- 保证损失比较有意义（使用相同基准）
- 梯度估计更准确

**采样策略**：
```cpp
1. 从鞋模中均匀采样 500 个点
2. 使用固定的起始偏移（0）
3. 步长 = 总顶点数 / 500
4. 在整个迭代过程中使用这 500 个固定点
```

---

## 📊 三、损失函数（Loss Function）

### 3.1 损失函数定义

```cpp
损失(offset, angle, vertical_offset) = 1 - 包裹率(offset, angle, vertical_offset)
```

### 3.2 包裹率计算过程

对于给定的参数 `(offset, angle, vertical_offset)`：

**步骤1：变换粗胚**
```cpp
1. 计算旋转矩阵：R = 绕纵向轴旋转 angle 角度
2. 计算平移向量：T = longitudinal_axis × offset + vertical_axis × vertical_offset
3. 对粗胚的每个顶点：
   v_new = R × (v_old - center) + center + T
```

**步骤2：构建KD-tree**
```cpp
1. 计算变换后粗胚所有面的中心点
2. 构建KD-tree（用于加速最近邻搜索）
```

**步骤3：计算包裹率**
```cpp
1. 对固定的 500 个采样点：
   - 计算点到粗胚表面的有符号距离
   - 如果距离 <= 0.1mm，认为点在内部
2. 包裹率 = 内部点数 / 总采样点数
```

**步骤4：计算损失**
```cpp
损失 = 1 - 包裹率
```

### 3.3 损失函数的特性

- **范围**：[0, 1]
  - 0 = 100%包裹（完美匹配）
  - 1 = 0%包裹（完全不匹配）
- **目标**：最小化损失（最大化包裹率）
- **平滑性**：由于使用采样，损失函数有轻微噪声，但整体平滑

---

## 🔢 四、梯度计算（数值梯度法）

### 4.1 数值梯度原理

使用**有限差分法**（Finite Difference Method）计算梯度：

```
梯度 ≈ (f(x+h) - f(x-h)) / (2h)
```

这是对导数的数值近似。

### 4.2 三个维度的梯度计算

#### 维度1：纵向位移梯度

```cpp
// 在当前位置附近测试两个点
loss_plus_t = computeLoss(current_offset + h_translation, 
                          current_relative_angle, 
                          current_vertical_offset)
loss_minus_t = computeLoss(current_offset - h_translation, 
                           current_relative_angle, 
                           current_vertical_offset)

// 计算梯度
gradient_translation = (loss_plus_t - loss_minus_t) / (2.0 * h_translation)
```

**参数**：
- `h_translation = 0.1mm`（步长）

**含义**：
- 如果 `gradient_translation > 0`：向前移动会增加损失（应该向后移动）
- 如果 `gradient_translation < 0`：向前移动会减少损失（应该向前移动）

#### 维度2：旋转角度梯度

```cpp
loss_plus_r = computeLoss(current_offset, 
                          current_relative_angle + h_rotation, 
                          current_vertical_offset)
loss_minus_r = computeLoss(current_offset, 
                           current_relative_angle - h_rotation, 
                           current_vertical_offset)

gradient_rotation = (loss_plus_r - loss_minus_r) / (2.0 * h_rotation)
```

**参数**：
- `h_rotation = 0.01` 弧度（约 0.57°）

**含义**：
- 如果 `gradient_rotation > 0`：顺时针旋转会增加损失（应该逆时针旋转）
- 如果 `gradient_rotation < 0`：顺时针旋转会减少损失（应该顺时针旋转）

#### 维度3：垂直位移梯度

```cpp
loss_plus_v = computeLoss(current_offset, 
                          current_relative_angle, 
                          current_vertical_offset + h_vertical)
loss_minus_v = computeLoss(current_offset, 
                           current_relative_angle, 
                           current_vertical_offset - h_vertical)

gradient_vertical = (loss_plus_v - loss_minus_v) / (2.0 * h_vertical)
```

**参数**：
- `h_vertical = 0.1mm`（步长）

**含义**：
- 如果 `gradient_vertical > 0`：向上移动会增加损失（应该向下移动）
- 如果 `gradient_vertical < 0`：向上移动会减少损失（应该向上移动）

### 4.3 梯度计算成本

每次迭代需要计算 **6次损失**：
- `f(x+h, y, z)` - 纵向位移梯度
- `f(x-h, y, z)` - 纵向位移梯度
- `f(x, y+h, z)` - 旋转梯度
- `f(x, y-h, z)` - 旋转梯度
- `f(x, y, z+h)` - 垂直位移梯度
- `f(x, y, z-h)` - 垂直位移梯度

每次损失计算需要：
- 变换粗胚所有顶点（O(n)）
- 构建KD-tree（O(n log n)）
- 检查500个采样点（O(500 × log n)）

**总计算量**：每次迭代约 2-4 秒

---

## 🔄 五、参数更新

### 5.1 更新公式

```cpp
new_offset = current_offset - learning_rate_translation × gradient_translation
new_relative_angle = current_relative_angle - learning_rate_rotation × gradient_rotation
new_vertical_offset = current_vertical_offset - learning_rate_vertical × gradient_vertical
```

**学习率**：
- `learning_rate_translation = 0.2`
- `learning_rate_rotation = 0.05` 弧度
- `learning_rate_vertical = 0.2`

### 5.2 更新方向

**梯度下降的核心思想**：
- 沿着**负梯度方向**更新参数
- 梯度指向损失增加最快的方向
- 负梯度指向损失减少最快的方向

**示例**：
```
如果 gradient_translation = -0.05（负值）
→ 向前移动会减少损失
→ new_offset = current_offset - 0.2 × (-0.05) = current_offset + 0.01
→ 向前移动 0.01mm
```

### 5.3 角度范围限制

```cpp
// 限制旋转角度在 ±180度范围内
if (new_relative_angle > π) new_relative_angle -= 2π
if (new_relative_angle < -π) new_relative_angle += 2π
```

---

## ✅ 六、接受/拒绝机制

### 6.1 损失比较

```cpp
new_loss = computeLoss(new_offset, new_relative_angle, new_vertical_offset)
current_loss = computeLoss(current_offset, current_relative_angle, current_vertical_offset)
```

### 6.2 接受条件

**如果新损失 < 当前损失**：
```cpp
✅ 接受新参数
current_offset = new_offset
current_relative_angle = new_relative_angle
current_vertical_offset = new_vertical_offset
```

**如果新损失 >= 当前损失**：
```cpp
❌ 拒绝新参数
// 减小学习率（步长太大，需要缩小）
learning_rate_translation *= 0.5
learning_rate_rotation *= 0.5
learning_rate_vertical *= 0.5
```

### 6.3 学习率自适应

**为什么减小学习率？**
- 如果新位置损失更大，说明步长太大
- 减小学习率，下次更新时步长更小
- 这样可以更精细地搜索最优解

**退出条件**：
```cpp
if (learning_rate < 阈值) {
    // 学习率太小，无法继续优化
    退出迭代
}
```

---

## 🎯 七、收敛判断

### 7.1 收敛条件

```cpp
if (|gradient_translation| < 0.001 && 
    |gradient_rotation| < 0.001 && 
    |gradient_vertical| < 0.001) {
    // 所有方向的梯度都很小
    // 说明已经到达（局部）最优点
    收敛，退出迭代
}
```

**含义**：
- 梯度接近0 = 损失函数在该点的斜率接近0
- 说明已经到达（局部）最优点
- 继续优化不会显著改善

### 7.2 提前退出条件

**达到100%包裹率**：
```cpp
if (new_loss < 1e-6) {
    // 损失接近0 = 包裹率接近100%
    // 已经找到完美匹配
    提前退出
}
```

**学习率太小**：
```cpp
if (learning_rate < 阈值) {
    // 学习率太小，无法继续优化
    退出
}
```

**达到最大迭代次数**：
```cpp
if (iter >= 50) {
    // 达到最大迭代次数
    退出
}
```

---

## 🔄 八、完整迭代流程

### 单次迭代步骤

```
迭代 i:
├─ 1. 计算梯度（6次损失计算）
│   ├─ 纵向位移梯度
│   ├─ 旋转角度梯度
│   └─ 垂直位移梯度
│
├─ 2. 检查收敛
│   └─ 如果所有梯度 < 阈值 → 退出
│
├─ 3. 更新参数
│   ├─ new_offset = current_offset - lr × grad_t
│   ├─ new_angle = current_angle - lr × grad_r
│   └─ new_vertical = current_vertical - lr × grad_v
│
├─ 4. 限制角度范围（±180度）
│
├─ 5. 计算新损失
│   └─ new_loss = computeLoss(new_offset, new_angle, new_vertical)
│
├─ 6. 接受/拒绝判断
│   ├─ 如果 new_loss < current_loss:
│   │   └─ ✅ 接受新参数
│   └─ 否则:
│       └─ ❌ 拒绝，减小学习率
│
└─ 7. 检查提前退出条件
    ├─ 如果损失 < 1e-6 → 退出（完美匹配）
    └─ 如果学习率太小 → 退出
```

### 完整优化流程

```
开始
  ↓
初始化
  ├─ 计算纵向轴和垂直轴
  ├─ 计算质心
  ├─ 计算初始值（质心差投影）
  └─ 固定采样500个点
  ↓
迭代循环（最多50次）
  ├─ 计算三个维度的梯度（6次损失计算）
  ├─ 检查收敛 → 如果收敛，退出
  ├─ 更新参数（沿负梯度方向）
  ├─ 限制角度范围
  ├─ 计算新损失
  ├─ 接受/拒绝判断
  │   ├─ 接受 → 更新当前参数
  │   └─ 拒绝 → 减小学习率
  └─ 检查提前退出条件
  ↓
返回最优参数
  ├─ optimal_offset
  ├─ optimal_relative_angle
  └─ optimal_vertical_offset
```

---

## 📈 九、优化示例

### 示例：B004加大匹配B004大

**初始状态**：
```
current_offset = 2.0mm
current_relative_angle = 0.0度
current_vertical_offset = 0.0mm
current_loss = 0.138
```

**迭代1**：
```
梯度计算：
  gradient_translation = -0.05
  gradient_rotation = -0.6
  gradient_vertical = 0.12

更新：
  new_offset = 2.0 - 0.2 × (-0.05) = 2.01mm
  new_angle = 0.0 - 0.05 × (-0.6) = 0.03弧度 ≈ 1.72度
  new_vertical = 0.0 - 0.2 × 0.12 = -0.024mm

新损失 = 0.124 < 0.138 ✅ 接受
```

**迭代2**：
```
梯度计算：
  gradient_translation = -0.09
  gradient_rotation = -0.7
  gradient_vertical = -0.02

更新：
  new_offset = 2.01 - 0.2 × (-0.09) = 2.028mm
  new_angle = 0.03 - 0.05 × (-0.7) = 0.065弧度 ≈ 3.72度
  new_vertical = -0.024 - 0.2 × (-0.02) = -0.02mm

新损失 = 0.086 < 0.124 ✅ 接受
```

**迭代3**：
```
梯度计算：
  gradient_translation = 0.05
  gradient_rotation = -0.6
  gradient_vertical = 0

更新：
  new_offset = 2.028 - 0.2 × 0.05 = 2.018mm
  new_angle = 0.065 - 0.05 × (-0.6) = 0.095弧度 ≈ 5.44度
  new_vertical = -0.02 - 0.2 × 0 = -0.02mm

新损失 = 0.076 < 0.086 ✅ 接受
```

**最终结果**：
```
最优纵向位移: 2.104mm
最优旋转角度: 5.44度
最优垂直位移: -2.54mm
最终损失: 0.076（包裹率 = 92.4%）
```

---

## ⚙️ 十、关键参数

### 10.1 学习率（Learning Rate）

| 参数 | 值 | 说明 |
|------|-----|------|
| `learning_rate_translation` | 0.2 | 纵向位移学习率 |
| `learning_rate_rotation` | 0.05 | 旋转角度学习率（弧度） |
| `learning_rate_vertical` | 0.2 | 垂直位移学习率 |

**自适应调整**：
- 如果损失没有改善，学习率减半
- 最小学习率阈值：0.01（位移），0.001（旋转）

### 10.2 梯度计算步长（h）

| 参数 | 值 | 说明 |
|------|-----|------|
| `h_translation` | 0.1mm | 纵向位移步长 |
| `h_rotation` | 0.01弧度 | 旋转角度步长（约0.57°） |
| `h_vertical` | 0.1mm | 垂直位移步长 |

### 10.3 其他参数

| 参数 | 值 | 说明 |
|------|-----|------|
| `max_iterations` | 50 | 最大迭代次数 |
| `convergence_threshold` | 0.001 | 收敛阈值 |
| `num_sample_points` | 500 | 固定采样点数 |

---

## 🎓 十一、算法特点

### 优点

1. **多维度优化**：同时优化三个维度，更灵活
2. **自适应学习率**：根据损失改善情况自动调整
3. **固定采样点**：保证损失比较有意义
4. **收敛判断**：多个退出条件，避免无效迭代
5. **数值稳定**：使用有限差分法，计算稳定

### 局限性

1. **局部最优**：可能陷入局部最优解
2. **计算成本**：每次迭代需要6次损失计算
3. **采样噪声**：使用500个采样点，损失函数有轻微噪声
4. **学习率敏感**：学习率需要仔细调整

### 优化方向

1. **动量法**：加入动量项，加速收敛
2. **Adam优化器**：自适应学习率 + 动量
3. **线搜索**：在梯度方向上寻找最优步长
4. **二阶方法**：使用Hessian矩阵（计算成本高）

---

## 📝 十二、总结

当前梯度下降算法是一个**3维数值梯度下降**算法，具有以下特点：

1. **优化空间**：3D（纵向位移、旋转角度、垂直位移）
2. **梯度计算**：使用有限差分法（数值梯度）
3. **参数更新**：沿负梯度方向，使用独立学习率
4. **接受机制**：只有损失改善才接受新参数
5. **自适应学习率**：损失不改善时自动减小学习率
6. **收敛判断**：多个退出条件，确保算法终止

算法在每次迭代中通过计算三个维度的梯度，沿着损失减少最快的方向更新参数，最终找到（局部）最优解。

---

**文档版本**: 2.0（3D优化版本）  
**最后更新**: 2026-02-01
