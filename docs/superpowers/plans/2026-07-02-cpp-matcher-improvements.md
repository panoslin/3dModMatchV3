# C++ 匹配算法改进实施计划（准确性 + 效率 + 全测试集 ≥96%）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复已定位的 C++ 距离计算 bug 与采样 bug，统一符号距离实现，注入 GA 确定性与种子个体，使全部 5 个 testcase 稳定达到包裹率 ≥96%，同时缩短匹配耗时。

**Architecture:** 三层不动摇：Python 编排（matcher.py 双路径）→ pybind11 → C++ 引擎。改动集中在 `src/core/bvh.cpp`（点-三角形距离修复）、`src/core/matcher.cpp/.h`（最终指标切换 BVH、GA 种子/确定性）、`src/core/pybind_wrapper.cpp`（GIL 释放）、`src/biz/matcher.py`（refine 自适应预算）。以 `src/biz/test_mesh_matcher.py`（新增，pytest）做单元级 TDD，以 5 个 testcase 做集成验收。

**Tech Stack:** C++17 / Eigen / OpenMP / pybind11 / pytest / Python 3.10（`/opt/homebrew/bin/python3.10`，唯一具备 trimesh+scipy+rhino3dm+mesh_matcher 完整栈的解释器）。

**执行约定（对本仓库现状的偏差说明）：**
- 工作区已有一个大型未提交工作包（P2a/P4/refine，见 `docs/testcase5_failure_analysis.md`），本计划的改动叠加其上。**不做任何 git commit**——与既有未提交改动混合的提交策略由用户决定；改动前快照在 scratchpad `pre_improvement_snapshot.patch`。
- 重建命令：`cd src/core/build && cmake -DCMAKE_BUILD_TYPE=Release .. && make -j8`（产物自动落到 `src/biz/`）。
- 单元测试命令：`cd src/biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -v`。

**已确认的缺陷清单（阅读分析 + 冒烟测试证据）：**
1. **[BUG] `BVHTree::pointTriangleDistance`（bvh.cpp:290-371）区域分类错误**：`d=e0·(p-v0)`、`e=e1·(p-v0)` 用了 point-minus-v0 约定，但 `s = b*e - c*d`、`t = b*d - a*e` 是 Eberly 原始（v0-minus-point）约定的公式，二者均差一个负号 → 区域判定系统性错乱。实测：点 (5,5,5) 到 [0,10]³ 立方体距离应为 5，实际 7.071；点 (9.95,5,5) 应为 0.05，实际 5.0。影响 `signed_distance_batch` → containment-refine 的代价函数幅值失真（收敛慢）、`wrap_of` 容差判定偏严。
2. **[BUG B9] `computeWrappingRatio`/`computeAverageClearance` 硬编码 500 采样**（matcher.cpp:633,717），忽略 `num_sample_points`；500 采样对 96% 附近的读数标准差 ≈0.88pp，是"边界翻车"的直接来源。
3. **[不一致] 最终指标的符号距离是 KD-tree 半径搜索 + O(F) 全网格 3 射线**（matcher.cpp:198-407）：幅值可能漏最近面（10mm 半径），符号计算每点遍历全部面（500 点 × 240k 面 × 3 射线），慢且与 GA/refine 的 BVH 路径是两套实现。
4. **[不稳定] GA 用 `std::random_device` 播种**（matcher.cpp:951-952），run-to-run 结果漂移 ±4pp，历史上引发 tc2/tc3 winner flip。
5. **[回退风险] GA 初始种群纯随机**（matcher.cpp:967-981）：ICP+refine 已把 target 推到好姿态后，GA 从随机种群重新搜索，可能收敛到比"恒等变换"（refine 成果）更差的解——refine 报 ≥0.97 而最终只有 96.2% 的落差来源。
6. **[效率] pybind 长调用不释放 GIL**（pybind_wrapper.cpp 全文件无 `gil_scoped_release`）：桌面端 2 并发实际串行，匹配期间 Flask 全部请求被阻塞。
7. **[效率] containment-refine 对无望候选也烧满 10 次 restart**（matcher.py:226-242）：tc5 全集 ~30min 的主要构成。

---

### Task 0: 环境与安全快照（已完成）

- [x] 确认解释器：`/opt/homebrew/bin/python3.10`（mesh_matcher/trimesh 4.11.5/scipy 1.15.3/rhino3dm 全通过）
- [x] 确认 `.so`（Apr 23 12:59）晚于全部 C++ 源文件 mtime → 与源码同步
- [x] 冒烟测试暴露缺陷 1（距离幅值错误）
- [x] `git diff` 快照 + `.so` 备份存入 scratchpad

### Task 1: 测试脚手架 + 暴露缺陷的失败测试（RED）

**Files:**
- Create: `src/biz/test_mesh_matcher.py`

- [ ] **Step 1: 写测试文件（含 2 个当前必然失败的测试）**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mesh_matcher C++ 模块的单元测试（pytest）。

合成几何（轴对齐立方体）给出解析真值，秒级运行；
与 testcases/ 的分钟级集成验证互补。
"""
import numpy as np
import pytest

import mesh_matcher


def make_cube(lo: float, hi: float):
    """轴对齐立方体网格：8 顶点 12 三角形，外向法线。"""
    v = np.array(
        [[x, y, z] for x in (lo, hi) for y in (lo, hi) for z in (lo, hi)],
        dtype=np.float64,
    )
    f = np.array(
        [
            [0, 1, 3], [0, 3, 2],  # x=lo
            [4, 6, 7], [4, 7, 5],  # x=hi
            [0, 4, 5], [0, 5, 1],  # y=lo
            [2, 3, 7], [2, 7, 6],  # y=hi
            [0, 2, 6], [0, 6, 4],  # z=lo
            [1, 5, 7], [1, 7, 3],  # z=hi
        ],
        dtype=np.int32,
    )
    return v, f


@pytest.fixture
def candidate_cube_matcher():
    m = mesh_matcher.MeshMatcher()
    cv, cf = make_cube(0.0, 10.0)
    assert m.load_candidate_mesh(cv, cf)
    return m


def test_signed_distance_signs_and_magnitudes(candidate_cube_matcher):
    """[缺陷1回归] signed_distance_batch 的符号与幅值都必须正确。"""
    pts = np.array(
        [
            [5.0, 5.0, 5.0],    # 中心：-5
            [1.0, 1.0, 1.0],    # 角附近内部：-1（最近面 x/y/z=0 均为 1）
            [9.95, 5.0, 5.0],   # 贴 x=10 面内侧：-0.05
            [20.0, 5.0, 5.0],   # x=10 面外 10mm：+10
            [-0.5, 5.0, 5.0],   # x=0 面外 0.5mm：+0.5
        ],
        dtype=np.float64,
    )
    d = candidate_cube_matcher.signed_distance_batch(pts)
    expected = np.array([-5.0, -1.0, -0.05, 10.0, 0.5])
    np.testing.assert_allclose(d, expected, atol=1e-6)


def test_point_triangle_distance_bruteforce():
    """[缺陷1回归] 单三角形网格上 |signed distance| 对照重心坐标稠密采样真值。

    覆盖锐角/钝角三角形与全部 Voronoi 区域（面内投影、三边、三顶点）。
    """
    rng = np.random.default_rng(7)
    for tri_id in range(20):
        tri = rng.uniform(-10, 10, (3, 3))
        # 跳过接近退化的三角形
        area2 = np.linalg.norm(
            np.cross(tri[1] - tri[0], tri[2] - tri[0])
        )
        if area2 < 1e-3:
            continue
        m = mesh_matcher.MeshMatcher()
        assert m.load_candidate_mesh(
            np.ascontiguousarray(tri, dtype=np.float64),
            np.array([[0, 1, 2]], dtype=np.int32),
        )
        pts = rng.uniform(-15, 15, (30, 3))
        d = np.abs(m.signed_distance_batch(pts))
        # 稠密重心网格作为真值参考
        n = 200
        s = np.linspace(0, 1, n)
        u, w = np.meshgrid(s, s)
        mask = (u + w) <= 1.0
        u, w = u[mask], w[mask]
        grid = (
            tri[0][None, :]
            + u[:, None] * (tri[1] - tri[0])[None, :]
            + w[:, None] * (tri[2] - tri[0])[None, :]
        )
        for i, p in enumerate(pts):
            ref = np.min(np.linalg.norm(grid - p[None, :], axis=1))
            # 网格分辨率带来的误差上界 ~ 对角步长；容差取 0.05
            assert abs(d[i] - ref) < 0.05, (
                f"tri#{tri_id} pt#{i}: got {d[i]:.4f}, ref {ref:.4f}"
            )


def test_volume_cube():
    cv, cf = make_cube(0.0, 10.0)
    vol = mesh_matcher.MeshMatcher.compute_volume(cv, cf)
    assert abs(vol - 1000.0) < 1e-6


def test_cube_in_cube_wrap():
    """完全包含的目标 → 包裹率必须为 1.0。"""
    m = mesh_matcher.MeshMatcher()
    cv, cf = make_cube(0.0, 10.0)
    tv, tf = make_cube(2.0, 8.0)
    assert m.load_candidate_mesh(cv, cf)
    assert m.load_target_mesh(tv, tf)
    p = mesh_matcher.GeneticAlgorithmParams()
    p.max_generations = 5
    r = m.match_optimized(wrapping_threshold=0.96, ga_params=p)
    assert r.wrapping_ratio == pytest.approx(1.0)
    assert r.is_fully_wrapped
```

- [ ] **Step 2: 运行，确认恰好 2 个失败（缺陷 1 的两条）**

Run: `cd src/biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -v`
Expected: `test_signed_distance_signs_and_magnitudes` FAIL、`test_point_triangle_distance_bruteforce` FAIL、其余 2 个 PASS

### Task 2: 修复 `BVHTree::pointTriangleDistance`（GREEN）

**Files:**
- Modify: `src/core/bvh.cpp:289-371`（整函数替换）

- [ ] **Step 1: 用 Ericson 算法替换整个函数体**

与 `matcher.cpp:207-257` 的 lambda（Real-Time Collision Detection, Christer Ericson——已验证正确的实现）同一算法，消除两套实现的分歧：

```cpp
/// @brief 计算点到三角形的最短距离
///
/// Reference: Real-Time Collision Detection (Christer Ericson),
/// ClosestPtPointTriangle。与旧实现（Eberly 变体）相比修复了
/// d/e 采用 point-v0 约定但 s/t 判别式未同步取反导致的区域误判。
double BVHTree::pointTriangleDistance(const Eigen::Vector3d& point,
                                      const Triangle& tri) const {
    const Eigen::Vector3d& a = tri.v0;
    const Eigen::Vector3d& b = tri.v1;
    const Eigen::Vector3d& c = tri.v2;

    Eigen::Vector3d ab = b - a;
    Eigen::Vector3d ac = c - a;
    Eigen::Vector3d ap = point - a;

    double d1 = ab.dot(ap);
    double d2 = ac.dot(ap);
    if (d1 <= 0.0 && d2 <= 0.0) return (point - a).norm();  // 顶点 A

    Eigen::Vector3d bp = point - b;
    double d3 = ab.dot(bp);
    double d4 = ac.dot(bp);
    if (d3 >= 0.0 && d4 <= d3) return (point - b).norm();   // 顶点 B

    double vc = d1 * d4 - d3 * d2;
    if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {              // 边 AB
        double v = d1 / (d1 - d3);
        return (point - (a + v * ab)).norm();
    }

    Eigen::Vector3d cp = point - c;
    double d5 = ab.dot(cp);
    double d6 = ac.dot(cp);
    if (d6 >= 0.0 && d5 <= d6) return (point - c).norm();   // 顶点 C

    double vb = d5 * d2 - d1 * d6;
    if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {              // 边 AC
        double w = d2 / (d2 - d6);
        return (point - (a + w * ac)).norm();
    }

    double va = d3 * d6 - d5 * d4;
    if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) { // 边 BC
        double w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return (point - (b + w * (c - b))).norm();
    }

    // 面内投影
    double denom = 1.0 / (va + vb + vc);
    double v = vb * denom;
    double w = vc * denom;
    return (point - (a + ab * v + ac * w)).norm();
}
```

- [ ] **Step 2: 重建**

Run: `cd src/core/build && cmake -DCMAKE_BUILD_TYPE=Release .. > /dev/null && make -j8 2>&1 | tail -2`
Expected: 编译无错误，`.so` 更新至 `src/biz/`

- [ ] **Step 3: 运行单元测试全绿**

Run: `cd src/biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -v`
Expected: 4 passed

### Task 3: 最终指标切换 BVH + 尊重采样数（B9）+ 一次采样两个指标

**Files:**
- Modify: `src/core/matcher.h`（删 KD-tree 相关声明，改两个指标函数签名，新增私有 helper）
- Modify: `src/core/matcher.cpp`（重写 `computeWrappingRatio`/`computeAverageClearance`，重写 `matchOptimized` Step 6，删除 `signedDistanceToMeshWithKDTree`/`buildFaceKDTree`/`resolveKDTreeCache`）
- Test: `src/biz/test_mesh_matcher.py`（新增容差语义与间隙解析值测试）

- [ ] **Step 1: 先写失败/守护测试**

```python
def test_wrap_tolerance_semantics():
    """inside_tolerance_mm 语义：略微戳出 ≤τ 记内部，>τ 记外部。"""
    cv, cf = make_cube(0.0, 10.0)

    def final_wrap(target_lo, target_hi, tol):
        m = mesh_matcher.MeshMatcher()
        assert m.load_candidate_mesh(cv, cf)
        tv, tf = make_cube(target_lo, target_hi)
        assert m.load_target_mesh(tv, tf)
        p = mesh_matcher.GeneticAlgorithmParams()
        p.max_generations = 0          # 不进化，只测最终指标
        p.rotation_range = 0.0         # 锁死姿态搜索
        p.translation_range = 0.0
        p.lateral_range = 0.0
        p.target_wrapping_ratio = 0.0  # 禁用早停分支差异
        p.inside_tolerance_mm = tol
        r = m.match_optimized(wrapping_threshold=0.0, ga_params=p,
                              skip_align_directions=True)
        return r.wrapping_ratio

    assert final_wrap(2.0, 8.0, 0.1) == pytest.approx(1.0)      # 完全内含
    assert final_wrap(-0.05, 10.05, 0.1) == pytest.approx(1.0)  # 戳出0.05 ≤ 0.1
    assert final_wrap(-0.5, 10.5, 0.1) == pytest.approx(0.0)    # 戳出≈0.87 > 0.1


def test_clearance_analytic():
    """[2,8]³ 在 [0,10]³ 内：每个顶点到表面 2.0mm → 96 分位间隙 = 2.0。"""
    m = mesh_matcher.MeshMatcher()
    cv, cf = make_cube(0.0, 10.0)
    tv, tf = make_cube(2.0, 8.0)
    assert m.load_candidate_mesh(cv, cf)
    assert m.load_target_mesh(tv, tf)
    p = mesh_matcher.GeneticAlgorithmParams()
    p.max_generations = 0
    p.rotation_range = 0.0
    p.translation_range = 0.0
    p.lateral_range = 0.0
    r = m.match_optimized(wrapping_threshold=0.0, ga_params=p,
                          skip_align_directions=True)
    assert r.percentile96_clearance == pytest.approx(2.0, abs=1e-6)
```

说明：`max_generations=0` 时 GA 只评估初始种群；Task 5 会向种群注入恒等/质心种子，本测试把三个搜索范围全部置 0，使所有随机个体都退化为质心对齐姿态（对已对齐的同心立方体即恒等），姿态可控。

Run: `cd src/biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -v`
Expected: `test_wrap_tolerance_semantics` 中"戳出 0.05"用例大概率 FAIL（旧 KD-tree 幅值路径对贴面点的幅值不精确）；其余视旧实现表现。记录现状后进入 Step 2。

- [ ] **Step 2: matcher.h 声明变更**

删除（`matcher.h:242-288` 区域内）：`signedDistanceToMeshWithKDTree`、`buildFaceKDTree`、`KDTreeCache`、`resolveKDTreeCache` 声明与 `#include "kdtree.h"`（`matcher.h:9`）。

替换两个公开指标函数声明（`matcher.h:183-214`）为：

```cpp
    /// @brief 计算鞋模在粗胚 BVH 内的体积包裹率 [0,1]
    /// @param num_samples 采样点数；实现内部有 FINAL_METRIC_MIN_SAMPLES 下限
    /// @param inside_tolerance_mm signed distance <= 此值视为"在内部"
    double computeWrappingRatio(
        const std::vector<double>& target_vertices,
        const BVHTree& candidate_bvh,
        size_t num_samples,
        double inside_tolerance_mm = 0.1);

    /// @brief 计算在粗胚内的鞋模采样点到粗胚表面距离的96%分位数（mm）
    double computeAverageClearance(
        const std::vector<double>& target_vertices,
        const BVHTree& candidate_bvh,
        size_t num_samples,
        double inside_tolerance_mm = 0.1);
```

新增私有 helper 声明（放在 `collectSamplePoints` 声明后）：

```cpp
    /// @brief 对 target 均匀采样 num_samples 点，返回每点到 candidate BVH 的
    ///        signed distance（OpenMP 并行；负=内部）
    static std::vector<double> computeSampleSignedDistances(
        const std::vector<double>& target_vertices,
        const BVHTree& candidate_bvh,
        size_t num_samples);
```

- [ ] **Step 3: matcher.cpp 实现**

删除函数体：`signedDistanceToMeshWithKDTree`（matcher.cpp:198-407）、`buildFaceKDTree`（matcher.cpp:172-196）、`resolveKDTreeCache`（matcher.cpp:107-122）。

新增实现（放在 `collectSamplePoints` 之后）：

```cpp
// 最终指标的采样数下限：500 采样在 96% 附近的读数标准差约 0.9pp，
// 足以造成阈值边界误判；2000 采样将其压到约 0.44pp。
// GA 适应度不受此下限影响（那里由 num_sample_points 原值控制成本）。
static constexpr size_t FINAL_METRIC_MIN_SAMPLES = 2000;

std::vector<double> MeshMatcher::computeSampleSignedDistances(
    const std::vector<double>& target_vertices,
    const BVHTree& candidate_bvh,
    size_t num_samples) {
    auto points = collectSamplePoints(target_vertices, num_samples);
    std::vector<double> distances(points.size(), 0.0);
    #ifdef _OPENMP
    #pragma omp parallel for
    #endif
    for (int i = 0; i < static_cast<int>(points.size()); ++i) {
        distances[i] = candidate_bvh.signedDistance(points[i]);
    }
    return distances;
}

double MeshMatcher::computeWrappingRatio(
    const std::vector<double>& target_vertices,
    const BVHTree& candidate_bvh,
    size_t num_samples,
    double inside_tolerance_mm) {
    if (target_vertices.size() / 3 == 0) return 0.0;
    auto d = computeSampleSignedDistances(
        target_vertices, candidate_bvh,
        std::max(num_samples, FINAL_METRIC_MIN_SAMPLES));
    if (d.empty()) return 0.0;
    size_t inside = 0;
    for (double di : d) if (di <= inside_tolerance_mm) ++inside;
    return static_cast<double>(inside) / d.size();
}

double MeshMatcher::computeAverageClearance(
    const std::vector<double>& target_vertices,
    const BVHTree& candidate_bvh,
    size_t num_samples,
    double inside_tolerance_mm) {
    if (target_vertices.size() / 3 == 0) return 0.0;
    auto d = computeSampleSignedDistances(
        target_vertices, candidate_bvh,
        std::max(num_samples, FINAL_METRIC_MIN_SAMPLES));
    std::vector<double> clearances;
    clearances.reserve(d.size());
    for (double di : d) {
        if (di <= inside_tolerance_mm) clearances.push_back(std::abs(di));
    }
    if (clearances.empty()) return 0.0;
    std::sort(clearances.begin(), clearances.end());
    size_t idx96 = static_cast<size_t>(std::ceil(clearances.size() * 0.96) - 1);
    if (idx96 >= clearances.size()) idx96 = clearances.size() - 1;
    return clearances[idx96];
}
```

`matchOptimized` Step 6（matcher.cpp:1496-1528 区域）重写为一次采样、两个指标共用：

```cpp
    // 6. 计算体积包裹率和96%分位数间隙（共用一次 BVH 采样距离）
    t0 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "\n[LOG] Step 6: 开始计算最终包裹率和96%分位数间隙..." << std::endl);

    BVHTree final_bvh;
    final_bvh.build(optimized_candidate, candidate_faces_);

    const size_t final_samples = std::max(ga_params.num_sample_points,
                                          FINAL_METRIC_MIN_SAMPLES);
    auto final_dists = computeSampleSignedDistances(
        aligned_target, final_bvh, final_samples);

    {
        size_t inside = 0;
        std::vector<double> clearances;
        clearances.reserve(final_dists.size());
        for (double di : final_dists) {
            if (di <= ga_params.inside_tolerance_mm) {
                ++inside;
                clearances.push_back(std::abs(di));
            }
        }
        result.wrapping_ratio = final_dists.empty() ? 0.0 :
            static_cast<double>(inside) / final_dists.size();
        if (!clearances.empty()) {
            std::sort(clearances.begin(), clearances.end());
            size_t idx96 = static_cast<size_t>(
                std::ceil(clearances.size() * 0.96) - 1);
            if (idx96 >= clearances.size()) idx96 = clearances.size() - 1;
            result.percentile96_clearance = clearances[idx96];
        } else {
            result.percentile96_clearance = 0.0;
        }
        LOG_IF_VERBOSE("[LOG]   最终指标采样数: " << final_dists.size()
                  << " (inside_tol=" << ga_params.inside_tolerance_mm
                  << "mm)" << std::endl);
    }
```

同时删除原 Step 6 的 `clearance_tree`/`buildFaceKDTree` 调用与两次独立的指标函数调用。公开的 `computeWrappingRatio`/`computeAverageClearance`（新签名）保留供外部/测试复用。

- [ ] **Step 4: 重建 + 单测全绿**

Run: `cd src/core/build && make -j8 2>&1 | tail -2 && cd ../../biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -v`
Expected: 6 passed（tolerance/clearance 两条新测试转绿）

### Task 4: GA 确定性（固定种子）

**Files:**
- Modify: `src/core/matcher.cpp:951-952`
- Test: `src/biz/test_mesh_matcher.py`

- [ ] **Step 1: 失败测试**

```python
def test_ga_deterministic():
    """相同输入两次运行必须给出完全相同的结果（回归可复现的前提）。"""
    def run_once():
        m = mesh_matcher.MeshMatcher()
        cv, cf = make_cube(0.0, 10.0)
        tv, tf = make_cube(1.0, 6.0)   # 故意偏心，需要 GA 真正搜索
        m.load_candidate_mesh(cv, cf)
        m.load_target_mesh(tv, tf)
        p = mesh_matcher.GeneticAlgorithmParams()
        p.max_generations = 10
        r = m.match_optimized(wrapping_threshold=0.99, ga_params=p)
        return (r.wrapping_ratio, r.optimal_translation,
                r.optimal_rotation_angle_deg, r.optimal_lateral_offset)

    assert run_once() == run_once()
```

Run: `cd src/biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py::test_ga_deterministic -v`
Expected: FAIL（random_device 播种，两次结果不同；小概率碰巧相等则重跑确认）

- [ ] **Step 2: 固定种子**

matcher.cpp:951-952 由

```cpp
    std::random_device rd;
    std::mt19937 gen(rd());
```

改为

```cpp
    // 固定种子：保证同输入同输出（回归可复现、winner 不随 run 漂移）。
    // 多样性由种群规模与变异保证，不依赖熵源。
    std::mt19937 gen(20260702u);
```

- [ ] **Step 3: 重建 + 测试通过**

Run: `cd src/core/build && make -j8 2>&1 | tail -2 && cd ../../biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -v`
Expected: 7 passed

### Task 5: GA 种子个体注入（质心对齐 + 恒等变换）

**Files:**
- Modify: `src/core/matcher.cpp:967-981`（初始种群循环）
- Test: `src/biz/test_mesh_matcher.py`

- [ ] **Step 1: 失败测试**

```python
def test_ga_identity_seed_no_regression():
    """预对齐（skip_align_directions=True）时，GA 结果不得差于恒等变换。

    把已完美嵌套的 target/candidate 交给 GA 且给足大搜索范围：
    若种群含恒等种子 + 精英保留，最优个体适应度必然 ≥ 恒等姿态 → wrap=1.0。
    无种子时初始种群全随机（±50mm/±180°），gen=0 大概率达不到 1.0。
    """
    m = mesh_matcher.MeshMatcher()
    cv, cf = make_cube(0.0, 10.0)
    tv, tf = make_cube(2.0, 8.0)
    m.load_candidate_mesh(cv, cf)
    m.load_target_mesh(tv, tf)
    p = mesh_matcher.GeneticAlgorithmParams()
    p.max_generations = 0          # 只评估初始种群 → 直接检验种子是否存在
    p.target_wrapping_ratio = 0.0
    r = m.match_optimized(wrapping_threshold=0.99, ga_params=p,
                          skip_align_directions=True)
    assert r.wrapping_ratio == pytest.approx(1.0)
    assert abs(r.optimal_translation) < 1e-9
    assert abs(r.optimal_rotation_angle_deg) < 1e-9
```

Run: `cd src/biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py::test_ga_identity_seed_no_regression -v`
Expected: FAIL（随机初始种群拿不到精确 1.0/零变换）

注意：`p.max_generations = 0` 时进化循环不执行，但 gen-0 的"初始种群已达目标"早退分支（matcher.cpp:1028）与常规出口都会返回种群最优——两条路径都覆盖种子生效。

- [ ] **Step 2: 注入种子个体**

matcher.cpp:967-981 的初始化循环替换为：

```cpp
    // 1. 初始化种群
    //    - 种子0（质心对齐）：纵向/横向取质心差投影、零旋转 —— PCA 路径的自然起点
    //    - 种子1（恒等变换）：全零 —— 外部预对齐（ICP/refine）后的当前姿态；
    //      精英保留保证 GA 结果永不差于送入时的姿态（修复 refine 成果被 GA 丢失）
    //    - 其余：以质心对齐为中心的均匀随机（原行为）
    std::vector<Individual> population(params.population_size);
    for (int i = 0; i < params.population_size; ++i) {
        Individual ind(
            initial_translation + trans_dist(gen),
            rot_dist(gen),
            initial_lateral + lat_dist(gen)
        );
        ind.vertical_offset = draw_sym(vert_r);
        ind.pitch = draw_sym(pitch_r);
        ind.yaw   = draw_sym(yaw_r);
        population[i] = ind;
    }
    if (params.population_size >= 1) {
        population[0] = Individual(initial_translation, 0.0, initial_lateral);
    }
    if (params.population_size >= 2) {
        population[1] = Individual(0.0, 0.0, 0.0);  // 恒等变换
    }
```

- [ ] **Step 3: 重建 + 全部测试通过**

Run: `cd src/core/build && make -j8 2>&1 | tail -2 && cd ../../biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -v`
Expected: 8 passed（注意 Task 3 的两条测试依赖"搜索范围全零 → 个体=质心对齐"，种子 0 与之一致，不受影响）

### Task 6: pybind 释放 GIL

**Files:**
- Modify: `src/core/pybind_wrapper.cpp:127-167`
- Test: `src/biz/test_mesh_matcher.py`

- [ ] **Step 1: 并发功能测试（改前先跑，记录串行耗时基准）**

```python
def test_gil_released_during_match():
    """match_optimized 执行期间其他 Python 线程必须能运行。

    GIL 未释放时心跳线程会被完全冻结（计数≈0）；释放后计数应显著增长。
    """
    import threading, time

    m = mesh_matcher.MeshMatcher()
    cv, cf = make_cube(0.0, 10.0)
    tv, tf = make_cube(1.0, 6.0)
    m.load_candidate_mesh(cv, cf)
    m.load_target_mesh(tv, tf)
    p = mesh_matcher.GeneticAlgorithmParams()
    p.max_generations = 30
    p.population_size = 60

    beats = [0]
    stop = threading.Event()

    def heartbeat():
        while not stop.is_set():
            beats[0] += 1
            time.sleep(0.005)

    t = threading.Thread(target=heartbeat, daemon=True)
    t.start()
    time.sleep(0.05)                     # 心跳先行，确认线程活着
    baseline = beats[0]
    m.match_optimized(wrapping_threshold=0.99, ga_params=p)
    during = beats[0] - baseline
    stop.set()
    t.join(timeout=1)
    # match 至少几百 ms；若 GIL 释放，5ms 间隔的心跳应累计 ≥10 次
    assert during >= 10, f"match 期间心跳仅 {during} 次 → GIL 未释放"
```

Run: `cd src/biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py::test_gil_released_during_match -v`
Expected: FAIL（心跳被冻结，during≈0）。若合成小网格上 match 快到心跳来不及计数，把 `population_size` 提到 200 重试。

- [ ] **Step 2: 释放 GIL（先取 Python 对象，再进入无 GIL 区）**

`match_optimized` lambda（pybind_wrapper.cpp:145-162）改为：

```cpp
        .def("match_optimized", [](MeshMatcher& matcher,
                                   double wrapping_threshold,
                                   py::object ga_params_obj,
                                   bool skip_align_directions) {
            GeneticAlgorithmParams ga_params;
            if (!ga_params_obj.is_none()) {
                try {
                    ga_params = ga_params_obj.cast<GeneticAlgorithmParams>();
                } catch (...) {
                }
            }

            // C++ 长计算期间释放 GIL：桌面端并发任务与 Flask 请求不再被冻结
            py::gil_scoped_release release;
            return matcher.matchOptimized(
                wrapping_threshold,
                ga_params,
                skip_align_directions
            );
        },
```

`signed_distance_batch` lambda（pybind_wrapper.cpp:127-144）改为：

```cpp
        .def("signed_distance_batch", [](MeshMatcher& matcher, py::array_t<double> points) {
            py::buffer_info buf = points.request();
            if (buf.ndim != 2 || buf.shape[1] != 3) {
                throw std::runtime_error("points must be Nx3 array");
            }
            const size_t n = static_cast<size_t>(buf.shape[0]);
            std::vector<double> pts(static_cast<double*>(buf.ptr),
                                    static_cast<double*>(buf.ptr) + n * 3);
            std::vector<double> d;
            {
                py::gil_scoped_release release;   // BVH 构建+批量距离在无 GIL 区执行
                d = matcher.computeSignedDistanceBatch(pts);
            }
            py::array_t<double> result(d.size());
            py::buffer_info rbuf = result.request();
            std::memcpy(rbuf.ptr, d.data(), d.size() * sizeof(double));
            return result;
        },
```

风险确认：`matchOptimized`/`computeSignedDistanceBatch` 全程只碰 C++ 数据（verbose 走 std::cerr），无任何 Python API 调用 → 释放安全。返回值 `MatchResult` 的 pybind 转换发生在 lambda 返回后、GIL 自动恢复之后。

- [ ] **Step 3: 重建 + 全部测试通过**

Run: `cd src/core/build && make -j8 2>&1 | tail -2 && cd ../../biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -v`
Expected: 9 passed

### Task 7: containment-refine 自适应预算（Python 效率）

**Files:**
- Modify: `src/biz/matcher.py:141-253`（`containment_refine`）、`src/biz/matcher.py:344-366`（调用点）
- Test: `src/biz/test_mesh_matcher.py`

- [ ] **Step 1: 用假 matcher 写行为测试**

```python
class _FakeDistanceMatcher:
    """signed_distance_batch 的确定性假实现：记录调用次数。

    distance_fn(pts) -> np.ndarray，模拟不同的候选几何。
    """
    def __init__(self, distance_fn):
        self.calls = 0
        self._fn = distance_fn

    def signed_distance_batch(self, pts):
        self.calls += 1
        return self._fn(np.asarray(pts))


def _import_containment_refine():
    import importlib, sys
    sys.path.insert(0, ".")
    mod = importlib.import_module("matcher")
    return mod.containment_refine


def test_refine_skips_when_already_wrapped():
    """起点已全内含（d 全负）→ 应直接返回，不进入 L-BFGS-B/NM 循环。"""
    containment_refine = _import_containment_refine()
    fake = _FakeDistanceMatcher(lambda pts: np.full(len(pts), -1.0))
    tv, _ = make_cube(2.0, 8.0)
    M, wrap = containment_refine(fake, tv, verbose=False)
    assert wrap == pytest.approx(1.0)
    np.testing.assert_allclose(M, np.eye(4))
    assert fake.calls <= 3     # 初始 wrap 评估的常数次调用，而非数百次


def test_refine_bails_out_on_hopeless_candidate():
    """无论怎么移动 d 恒为 +5（无望候选）→ 有限次 restart 后放弃。"""
    containment_refine = _import_containment_refine()
    fake = _FakeDistanceMatcher(lambda pts: np.full(len(pts), 5.0))
    tv, _ = make_cube(2.0, 8.0)
    M, wrap = containment_refine(fake, tv, jitter_restarts=10, verbose=False)
    assert wrap == pytest.approx(0.0)
    # 旧实现会烧满 10 次 NM restart（每次 ~500 iter × 数百 batch 调用）；
    # 自适应预算下总 batch 调用数应远小于旧实现的量级
    assert fake.calls < 3000, f"batch 调用 {fake.calls} 次，未生效 bail-out"
```

Run: `cd src/biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -k refine -v`
Expected: 两条均 FAIL（旧实现无短路、无 bail-out）

- [ ] **Step 2: 实现自适应预算**

`containment_refine`（matcher.py:200-242 区域）修改——在 `w0 = wrap_of(p0)` 之后加短路，在 restart 循环加 bail-out：

```python
    p0 = np.zeros(6)
    w0 = wrap_of(p0)
    if verbose:
        print(f"  [containment-refine] 初始 wrap(strict)={w0*100:.2f}%, loss={loss_hinge(p0):.4f}")

    # 短路：起点已达标（例如 ICP 已把 target 完全推入）→ 不需要任何优化
    if w0 >= early_stop_wrap:
        if verbose:
            print(f"  [containment-refine] 初始 wrap 已 ≥{early_stop_wrap*100:.1f}%，跳过优化")
        return np.eye(4), w0
```

restart 循环（原 `for k in range(jitter_restarts):`）改为：

```python
        # 自适应预算：连续 no_improve_limit 次 restart 无改进且 wrap 距目标
        # 还差 hopeless_gap 以上 → 判为无望候选，停止烧预算。
        no_improve = 0
        no_improve_limit = 3
        hopeless_gap = 0.05
        for k in range(jitter_restarts):
            sigma_t, sigma_r = sigmas[k % len(sigmas)]
            jitter = rng.normal(0, [sigma_t]*3 + [sigma_r]*3, 6)
            r = minimize(loss_hinge, best_x + jitter, method='Nelder-Mead',
                         options={'maxiter': nm_maxiter, 'xatol': 1e-5, 'fatol': 1e-10, 'adaptive': True})
            r_wrap = wrap_of(r.x)
            # 接受准则：wrap 严格变好；或 wrap 持平且 loss 变好
            if r_wrap > best_wrap + 1e-4 or (abs(r_wrap - best_wrap) <= 1e-4 and r.fun < best_loss):
                best_x = r.x
                best_loss = r.fun
                best_wrap = r_wrap
                no_improve = 0
                if verbose:
                    print(f"  [containment-refine] restart {k} (σt={sigma_t},σr={sigma_r}): improved wrap={best_wrap*100:.2f}%, loss={best_loss:.4f}")
                if best_wrap >= early_stop_wrap:
                    if verbose:
                        print(f"  [containment-refine] early-stop (wrap>={early_stop_wrap*100:.1f}%) at restart {k}")
                    break
            else:
                no_improve += 1
                if (no_improve >= no_improve_limit
                        and best_wrap < early_stop_wrap - hopeless_gap):
                    if verbose:
                        print(f"  [containment-refine] {no_improve} 次 restart 无改进且 "
                              f"wrap={best_wrap*100:.2f}% 距目标 >{hopeless_gap*100:.0f}pp，放弃精调")
                    break
```

- [ ] **Step 3: 测试通过**

Run: `cd src/biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -v`
Expected: 11 passed

### Task 8: 全量集成验证（验收）

**Files:**
- 产出: scratchpad `validation/` 下 5 个 log + 汇总表

- [ ] **Step 1: 全部单元测试绿 + 重建确认**

Run: `cd src/core/build && cmake -DCMAKE_BUILD_TYPE=Release .. > /dev/null && make -j8 2>&1 | tail -2 && cd ../../biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -v`
Expected: 11 passed

- [ ] **Step 2: 逐 testcase 后台运行（每个独立 job，避免整链被杀）**

Run（对 tc1..tc5 各一个后台 job）: `/usr/bin/time /opt/homebrew/bin/python3.10 src/biz/matcher.py testcases/testcaseN --verbose > $SCRATCH/validation/testcaseN.log 2>&1`
Expected: 每个 log 尾部有"优化匹配总结"。

- [ ] **Step 3: 汇总与验收判定**

从各 log 提取 (target, best_match, wrap, volume, 耗时)，与 `docs/baseline.csv` 的 `unified-default` 行对比。验收标准：
1. 每个 target 的 best_match wrap ≥ 0.96（tc5 identity 必须达标）
2. winner 与 baseline 一致（tc2 的 B002小、tc3 的同名候选、tc4/tc5 的 002小）
3. 总耗时 ≤ baseline 量级（tc5 ≤ 30min；期望显著下降）
4. 重跑任一 testcase 结果逐位一致（确定性验证）

不达标 → 回到对应 Task 修正后重跑该 testcase。

### Task 9: 文档同步

**Files:**
- Modify: `CLAUDE.md`（参数表：--wrapping-threshold 默认 0.96；num-sample-points 说明"GA 适应度采样，最终指标有 2000 下限"；删除"0.1° 容差校验"表述，改为"PCA 自动对齐+角度记录"；补 --inside-tolerance-mm/--ga-6dof/--icp-warmstart/--containment-refine）
- Modify: `docs/baseline.csv`（追加 pipeline=improved 的 11 行结果）
- Modify: `docs/testcase5_failure_analysis.md`（追加 §12：距离幅值 bug 修复 + 最终指标 BVH 化 + GA 确定性/种子 + 验证数据）
- Modify: `src/biz/matcher.py:3-11`（模块 docstring 的"误差≤0.1度"表述改为与实现一致）

- [ ] **Step 1: 按验证数据更新上述四处**
- [ ] **Step 2: 通读 diff 自查**（`git diff --stat` 确认无预期外文件）

---

## 执行记录（随执行更新）

| Task | 状态 | 备注 |
|---|---|---|
| 0 环境/快照 | ✅ | python3.10 + 全依赖；快照在 scratchpad |
| 1 测试脚手架 | ✅ | 2 RED（距离幅值、暴力对照）+ 2 PASS，符合预期 |
| 2 pointTriangleDistance 修复 | ✅ | Ericson 重写后暴力对照转绿；**额外发现并修复第二个 bug**：射线穿过共面三角形公共边被重复计数致奇偶翻转（立方体中心被判外部）——`rayCastRecursive` 改为收集 t 值、`countUniqueCrossings` 去重后再做奇偶判定（bvh.h/bvh.cpp） |
| 3 最终指标 BVH 化 | ✅ | matcher.cpp 1604→1297 行；KDTree 引用清零（kdtree.h 文件保留但已无使用方）；旧路径误判的"外扩 0.05"容差用例转绿；顺带删除 GA 内无用的"兼容"KD-tree 构建 |
| 4 GA 确定性 | ✅ | 固定种子 20260702；确定性测试绿。副作用：固定种子暴露 GA 在 trivial 用例上 5 代找不到全包含姿态（cube_in_cube 短暂变红），由 Task 5 种子个体修复 |
| 5 GA 种子注入 | ✅ | 质心种子 population[0] + 恒等种子 population[1]；identity-seed 测试与 cube_in_cube 同时转绿 |
| 6 GIL 释放 | ✅ | 心跳测试：修复前匹配 >100ms 期间心跳 1 次 → 修复后 ≥10 次；match_optimized + signed_distance_batch 均释放 |
| 7 refine 自适应预算 | ✅ | 计划中的"无望候选"集成测试断言依赖 scipy 内部求值次数（不稳定），改为提取纯函数 `_refine_should_continue` 单测预算策略 + "起点已达标短路"行为测试；单测 11/11 绿 |
| 8 全量验证 R1 | ✅(废弃) | 第一轮数据（评审修复前代码）：tc5 ✅002大 99.85% 11.5min、tc1 ✅3/3 97.1-98.45% 3min、tc4 ✅002小 98.50% 5.4min、tc2 ✅B002小 97.80% 5.4min；tc3 中途因评审修复中止。数据被 R2 取代 |
| 8.5 双评审 + 修复 | ✅ | **Python 评审**：修复 CRITICAL（ICP 异常静默→无条件 stderr + icp_error 字段）、HIGH（refine 双重下界保护——L-BFGS-B 劣化回退 p0 + FINAL 不劣于 w0；大 σ 前置到 bail-out 窗口内；2 个 spy 行为测试）、MEDIUM（per-seed 异常捕获+全失败告警、函数默认阈值 0.99→0.96、np.radians、docstring 8→16）。**C++ 评审**：修复 CRITICAL C1（GIL 释放后同实例并发数据竞争，实测 SIGSEGV → 实例级 std::mutex，load*/batch/matchOptimized 串行化，异实例不受影响）、CRITICAL C2（退化三角形 NaN × -ffast-math → BVHTree::build 源头过滤 <1e-9 面积）、HIGH H2（5 个连续 double& 出参 → OptimalPose 结构体）、M1（删除死方法 computeWrappingRatio/computeAverageClearance）、M2（server.py 透传 inside_tolerance_mm）、M5（lateral_axis 退化保护 helper）、M6/M7/LOW（mutable 移除、注释修正、ssize_t cast、空 catch 注释）。新增 4 个回归测试（退化三角形、开放网格投票、缓存失效、同实例并发）。**单测 17/17 绿** |
| 8 全量验证 R2 | ✅ | **11/11 target 全部 ≥96%**（96.50–99.55）：tc5 ✅002大 99.20% 8.3min、tc1 ✅3/3 97.45/97.10/99.45 2.1min、tc4 ✅98.25% 1.8min、tc2 ✅97.80% 4.2min、tc3 ✅5/5 96.50–99.55（外部中止两次后按 target 前台拆跑，共 29.4min）。winner 与基线一致（除 tc5，§12.3 论证）；tc1 复跑逐字一致（确定性 ✓）。验收四条全过 |
| 9 文档同步 | ✅ | CLAUDE.md 参数表/算法概要、matcher.py docstring、baseline.csv +12 行（pipeline=improved）、failure_analysis 新增 §12（bug 修复、诚实上限结论、验收表、后续工作） |

**评审后未处理项（记录为后续工作，不阻塞目标）**：H1 超长函数拆分（550 行 GA / 260 行 matchOptimized，行为无关的重构，留待专门迭代）；M3/M4 真实并发下的 OMP 线程预算策略；GenerationState 缺 6-DOF 字段（6-DOF 默认关）；pipeline_used 改 Enum、Protocol 类型标注、行长格式化、argparse 边界校验、GIL 心跳测试在极端受限 CI 的时序余量、`-ffast-math`/`-march=native` 构建标志的取舍评估。

## Round 4（2026-07-03）：tc5 identity 回归 002小（新目标）

用户业务输入推翻了"上限 ≈95%"的旧结论指向：002小 配对必须匹配。系统化诊断
（失败点解剖：非垃圾/非鞋底/非尖刺，是扫描态网格的贴面偏差区块 + 顶点采样对
5× 密度网格的超权 + hinge 最优 ≠ 计数最优）→ 两项对因修复：**面积均匀确定性
采样**（C++ collectSamplePoints 重写 + 最终指标 5000 下限）与 **count_polish
计数抛光级**（软计数多尺度 NM + 小窗口 6-DOF GA + 有望带高精度适应度）。
结果：tc5 winner = 002小 96.40% ✅；全测试集 11/11 ≥96.4%；tc3 两处 winner
变化（004大→004小 97.44%、004小→002小(1) 97.30%）为同机制合规提升（证据：
改动前分别 95.30%/93.45%）。教训记录：① 门槛比较必须同口径（refine 顶点
口径 vs 抛光面积口径差 ~1.5pp，误设 0.92 门槛曾漏掉真实翻盘）；② 早停阈值
过贴线会吃掉真实余量（stop_at 0.975→0.985）；③ 高精度适应度应覆盖全部
潜在过线者而非仅边缘带。详见 failure_analysis §13。单测 18/18。

## Round 5（2026-07-03）：秒级匹配（效率目标）

耗时解剖：refine/polish 优化迭代的精确 BVH 批量查询占 ~90%。两项优化：
① `build_candidate_sdf` 两级窄带 SDF 网格（构建 1.9s，迭代查询 40×，近表面
p90 0.027mm，验收门与最终指标保持精确 BVH）；② 体积升序 + 首个过线者早停
（与全量扫描严格等价，`--no-early-exit` 可关）。结果：全套 ~1-1.5h → **3.6min**，
tc5 19s / tc4 5.2s / tc2 15.6s / tc1 32s / tc3 143s，winner 与 R4 全部一致，
wrap 差异 ±0.4pp 内且全部 ≥96.16%，确定性复跑逐位一致。单测 21/21。
测试断言学习：立方体锐边是 SDF 插值最坏情况（~0.26mm），中轴脊误差
O(半格距) 是几何必然且对 hinge/计数无影响——断言应对齐几何事实。

**R1 期间的关键实验（决定性结论）**：tc5 identity 候选（002小）在无限 refine 预算（25 restarts、绕过 bail-out、404s）下也只能到 refine 口径 95.38% / 最终口径 94.80%——4 月基线的"96.20%"是 500 采样（σ≈0.9pp）的有利抽样 + 带 bug 距离函数轨迹的产物。**该候选在严格 τ=0.1mm 下的诚实几何上限 ≈95%**（target 网格非水密、winding 不一致、Z 被自相交撑到 170mm）。tc5 的正确系统答案是 002大（99.85%，通过阈值候选中体积最小）。预算削减仅损失 0.75pp（94.05 vs 94.80）却省 85% 时间。

## Self-Review

- **Spec 覆盖**：缺陷 1→Task 1/2；缺陷 2(B9)/3(不一致+慢)→Task 3；缺陷 4→Task 4；缺陷 5→Task 5；缺陷 6→Task 6；缺陷 7→Task 7；"全部 testcase ≥96%"验收→Task 8；文档一致性→Task 9。✓
- **占位符扫描**：所有代码块为完整可粘贴内容；无 TBD。✓
- **类型/签名一致性**：`computeWrappingRatio(target_vertices, candidate_bvh, num_samples, inside_tolerance_mm)` 在 Task 3 的 .h/.cpp/调用点三处一致；`computeSampleSignedDistances` 为 static（不触碰成员）；Task 5 测试依赖 Task 3 的 `max_generations=0` 语义与 Task 4 的确定性。✓
- **风险登记**：(a) 最终指标估计器更换后，各 tc 读数会有 ±1pp 级变化——验收以绝对阈值 0.96 判定，Task 5 的恒等种子保证 ICP+refine 路径不回退，预期读数上移；(b) tc3 是 3DM 大网格，BVH 最终指标对其是纯加速；(c) 固定种子改变"平均行为"——若某 tc 恰好因种子变差，调 Task 5 种子策略（种子个体保底）而非回退确定性。
