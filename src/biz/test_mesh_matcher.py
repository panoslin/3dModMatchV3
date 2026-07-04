#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mesh_matcher C++ 模块的单元测试（pytest）。

合成几何（轴对齐立方体）给出解析真值，秒级运行；
与 testcases/ 的分钟级集成验证互补。

运行: cd src/biz && /opt/homebrew/bin/python3.10 -m pytest test_mesh_matcher.py -v
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


def _final_metrics(target_lo, target_hi, tol):
    """锁死姿态搜索（范围全零 + 0 代进化），只考察最终指标计算。"""
    m = mesh_matcher.MeshMatcher()
    cv, cf = make_cube(0.0, 10.0)
    assert m.load_candidate_mesh(cv, cf)
    tv, tf = make_cube(target_lo, target_hi)
    assert m.load_target_mesh(tv, tf)
    p = mesh_matcher.GeneticAlgorithmParams()
    p.max_generations = 0
    p.rotation_range = 0.0
    p.translation_range = 0.0
    p.lateral_range = 0.0
    p.target_wrapping_ratio = 0.0
    p.inside_tolerance_mm = tol
    r = m.match_optimized(wrapping_threshold=0.0, ga_params=p,
                          skip_align_directions=True)
    return r


def test_wrap_tolerance_semantics():
    """inside_tolerance_mm 语义：略微戳出 ≤τ 记内部，>τ 记外部。

    同心立方体质心差为零 → 搜索范围全零时所有个体都是恒等姿态。
    外扩 0.05 的立方体顶点到 [0,10]³ 表面（角点）距离 = 0.05·√3 ≈ 0.087。
    """
    assert _final_metrics(2.0, 8.0, 0.1).wrapping_ratio == pytest.approx(1.0)
    assert _final_metrics(-0.05, 10.05, 0.1).wrapping_ratio == pytest.approx(1.0)
    assert _final_metrics(-0.5, 10.5, 0.1).wrapping_ratio == pytest.approx(0.0)


def test_clearance_analytic():
    """[2,8]³ 在 [0,10]³ 内：每个顶点到表面 2.0mm → 96 分位间隙 = 2.0。"""
    r = _final_metrics(2.0, 8.0, 0.1)
    assert r.percentile96_clearance == pytest.approx(2.0, abs=1e-6)


def test_degenerate_triangle_no_nan():
    """[C2 回归] 含退化三角形（两顶点重合）的网格不得产出 NaN 距离。

    退化三角形的边投影分母为 0 → NaN；-ffast-math 下 NaN 比较不可预测。
    BVHTree::build 应在源头过滤退化三角形。
    """
    cv, cf = make_cube(0.0, 10.0)
    cv2 = np.vstack([cv, [[5.0, 5.0, 20.0]], [[5.0, 5.0, 20.0]]])   # 顶点 8、9 重合
    cf2 = np.vstack([cf, [[8, 9, 0]]]).astype(np.int32)             # 零面积三角形
    m = mesh_matcher.MeshMatcher()
    assert m.load_candidate_mesh(
        np.ascontiguousarray(cv2), np.ascontiguousarray(cf2))
    pts = np.array([[5.0, 5.0, 5.0], [5.0, 5.0, 19.0], [20.0, 5.0, 5.0]])
    d = m.signed_distance_batch(pts)
    assert not np.any(np.isnan(d)), f"出现 NaN: {d}"
    assert d[0] == pytest.approx(-5.0)   # 立方体中心不受退化三角形影响
    assert d[1] == pytest.approx(9.0)    # 退化三角形被过滤，最近面是 z=10


def test_open_mesh_majority_voting():
    """非水密网格（去掉顶面）：3 射线多数投票仍能正确判定内部点。

    +Z 射线从缺口穿出（0 交点 → 外票），+X/+Y 各 1 交点 → 2/3 票 → 内部。
    单射线（+X 时代）对这类网格的鲁棒性正是 P2a 改造的目标，固化为回归。
    """
    cv, cf = make_cube(0.0, 10.0)
    m = mesh_matcher.MeshMatcher()
    assert m.load_candidate_mesh(cv, np.ascontiguousarray(cf[:10]))  # 去掉 z=10 面
    d = m.signed_distance_batch(np.array([[5.0, 5.0, 5.0]]))
    assert d[0] == pytest.approx(-5.0)


def test_reload_candidate_invalidates_bvh_cache():
    """同一实例二次 load_candidate_mesh 后，batch 距离必须反映新网格。"""
    m = mesh_matcher.MeshMatcher()
    cv1, cf1 = make_cube(0.0, 10.0)
    assert m.load_candidate_mesh(cv1, cf1)
    d1 = m.signed_distance_batch(np.array([[15.0, 5.0, 5.0]]))
    assert d1[0] == pytest.approx(5.0)          # [0,10]³ 外 5mm

    cv2, cf2 = make_cube(0.0, 20.0)
    assert m.load_candidate_mesh(cv2, cf2)      # 缓存应失效
    d2 = m.signed_distance_batch(np.array([[15.0, 5.0, 5.0]]))
    assert d2[0] == pytest.approx(-5.0)         # [0,20]³ 内 5mm


def test_same_instance_concurrent_calls_safe():
    """[C1 回归] GIL 释放后同一实例被多线程并发读写不得崩溃/竞争。

    实例级互斥使同实例调用串行化；此前该场景可复现 SIGSEGV/SIGABRT。
    """
    import threading

    m = mesh_matcher.MeshMatcher()
    cv_a, cf_a = make_cube(0.0, 10.0)
    cv_b, cf_b = make_cube(0.0, 20.0)
    m.load_candidate_mesh(cv_a, cf_a)
    pts = np.array([[15.0, 5.0, 5.0], [5.0, 5.0, 5.0], [25.0, 5.0, 5.0]])
    errors = []

    def writer():
        try:
            for i in range(30):
                if i % 2 == 0:
                    m.load_candidate_mesh(cv_b, cf_b)
                else:
                    m.load_candidate_mesh(cv_a, cf_a)
        except Exception as e:            # noqa: BLE001 —— 测试线程收集一切异常
            errors.append(e)

    def reader():
        try:
            for _ in range(60):
                d = m.signed_distance_batch(pts)
                assert len(d) == 3 and not np.any(np.isnan(d))
        except Exception as e:            # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=writer) for _ in range(2)] + \
              [threading.Thread(target=reader) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not errors, f"并发调用出错: {errors}"

    m.load_candidate_mesh(cv_a, cf_a)
    d = m.signed_distance_batch(np.array([[15.0, 5.0, 5.0]]))
    assert d[0] == pytest.approx(5.0)


def test_volume_cube():
    cv, cf = make_cube(0.0, 10.0)
    vol = mesh_matcher.MeshMatcher.compute_volume(cv, cf)
    assert abs(vol - 1000.0) < 1e-6


class _FakeDistanceMatcher:
    """signed_distance_batch 的确定性假实现：记录调用次数。"""

    def __init__(self, distance_fn):
        self.calls = 0
        self._fn = distance_fn

    def signed_distance_batch(self, pts):
        self.calls += 1
        return self._fn(np.asarray(pts))


def test_refine_skips_when_already_wrapped():
    """起点已全内含（d 恒 -1）→ 应直接短路返回，不进入 L-BFGS-B/NM 循环。"""
    from matcher import containment_refine

    fake = _FakeDistanceMatcher(lambda pts: np.full(len(pts), -1.0))
    tv, _ = make_cube(2.0, 8.0)
    M, wrap = containment_refine(fake, tv, verbose=False)
    assert wrap == pytest.approx(1.0)
    np.testing.assert_allclose(M, np.eye(4))
    assert fake.calls <= 3, f"应短路返回，实际 batch 调用 {fake.calls} 次"


def test_refine_bails_out_and_never_worse_than_start(monkeypatch):
    """无望候选（d 恒 +2，怎么移都在外面）：

    1. 连续 3 次 restart 无改进且 wrap 距目标 >5pp → bail-out 触发（省预算）
    2. 返回的 wrap 不劣于起点 w0（下界保护）
    """
    import matcher as M

    calls = []
    real = M._refine_should_continue

    def spy(no_improve, best_wrap, early_stop_wrap, **kw):
        r = real(no_improve, best_wrap, early_stop_wrap, **kw)
        calls.append((no_improve, r))
        return r

    monkeypatch.setattr(M, "_refine_should_continue", spy)
    fake = _FakeDistanceMatcher(lambda pts: np.full(len(pts), 2.0))
    tv, _ = make_cube(2.0, 8.0)
    _, wrap = M.containment_refine(fake, tv, jitter_restarts=10, verbose=False)

    assert wrap == pytest.approx(0.0)          # 不劣于 w0=0
    assert len(calls) == 3                     # 第 3 次无改进即放弃，没烧满 10 次
    assert calls == [(1, True), (2, True), (3, False)]


def test_refine_keeps_grinding_when_close(monkeypatch):
    """距目标 <5pp 的候选（7% 采样点在外）：连续无改进也不 bail，跑满全部 restart。"""
    import matcher as M

    calls = []
    real = M._refine_should_continue

    def spy(no_improve, best_wrap, early_stop_wrap, **kw):
        r = real(no_improve, best_wrap, early_stop_wrap, **kw)
        calls.append((no_improve, r))
        return r

    monkeypatch.setattr(M, "_refine_should_continue", spy)

    def seven_pct_outside(pts):
        d = np.full(len(pts), -1.0)
        d[: int(0.07 * len(pts))] = 1.0        # 按点序固定 7% 在外，与位姿无关
        return d

    fake = _FakeDistanceMatcher(seven_pct_outside)
    tv, _ = make_grid_cube(2.0, 8.0, 6)        # 294 顶点 → w0 ≈ 0.932
    _, wrap = M.containment_refine(fake, tv, jitter_restarts=4, verbose=False)

    assert wrap == pytest.approx(1.0 - int(0.07 * 294) / 294)
    assert len(calls) == 4                     # 跑满 4 次 restart，全部判"继续"
    assert all(r for _, r in calls)


def test_count_polish_floor():
    """count_polish 下界保护：结果不劣于起点；全内含时保持 1.0。"""
    from matcher import count_polish

    tv, tf = make_cube(2.0, 8.0)
    fake_out = _FakeDistanceMatcher(lambda pts: np.full(len(pts), 2.0))  # 无望候选
    _, w1 = count_polish(fake_out, tv, tf, restarts=2, nm_maxiter=50)
    assert w1 == pytest.approx(0.0)

    fake_in = _FakeDistanceMatcher(lambda pts: np.full(len(pts), -1.0))  # 全内含
    _, w2 = count_polish(fake_in, tv, tf, restarts=2, nm_maxiter=50)
    assert w2 == pytest.approx(1.0)


def test_refine_budget_decision():
    """restart 预算策略：连续 3 次无改进且 wrap 距目标 >5pp → 放弃。"""
    from matcher import _refine_should_continue

    assert _refine_should_continue(0, 0.50, 0.97)        # 刚开始，继续
    assert _refine_should_continue(2, 0.00, 0.97)        # 未到无改进上限，继续
    assert not _refine_should_continue(3, 0.50, 0.97)    # 3 次无改进且差 47pp → 放弃
    assert _refine_should_continue(3, 0.93, 0.97)        # 差 4pp（<5pp），值得继续磨
    assert _refine_should_continue(10, 0.925, 0.97)      # 0.925 ≥ 0.97-0.05，继续
    assert not _refine_should_continue(3, 0.9199, 0.97)  # 差 >5pp → 放弃


def make_grid_cube(lo: float, hi: float, n: int):
    """每面 n×n 细分的立方体网格：6(n+1)² 顶点、12n² 三角形。"""
    lin = np.linspace(lo, hi, n + 1)
    vs, fs, base = [], [], 0
    for axis in range(3):
        for side in (lo, hi):
            a, b = [i for i in range(3) if i != axis]
            A, B = np.meshgrid(lin, lin, indexing="ij")
            V = np.zeros(((n + 1) * (n + 1), 3))
            V[:, axis] = side
            V[:, a] = A.ravel()
            V[:, b] = B.ravel()
            vs.append(V)
            idx = np.arange((n + 1) * (n + 1)).reshape(n + 1, n + 1)
            q00 = idx[:-1, :-1].ravel()
            q10 = idx[1:, :-1].ravel()
            q01 = idx[:-1, 1:].ravel()
            q11 = idx[1:, 1:].ravel()
            fs.append(np.vstack([
                np.stack([q00, q10, q11], axis=1),
                np.stack([q00, q11, q01], axis=1),
            ]) + base)
            base += (n + 1) * (n + 1)
    return (
        np.ascontiguousarray(np.vstack(vs), dtype=np.float64),
        np.ascontiguousarray(np.vstack(fs), dtype=np.int32),
    )


def test_gil_released_during_match():
    """match_optimized 执行期间其他 Python 线程必须能运行。

    GIL 未释放时心跳线程被完全冻结（计数≈0）；释放后 5ms 间隔的心跳
    在 >100ms 的匹配期间应累计 ≥10 次。

    配置要点：target 比 candidate 大（fitness 恒 0，永不触发目标/收敛早停）、
    early_stopping_generations=0（禁用无改进早停）→ GA 必然跑满 60 代。
    candidate 用细分网格（6912 三角形）加重 BVH 查询保证耗时 >100ms。
    """
    import threading
    import time

    m = mesh_matcher.MeshMatcher()
    cv, cf = make_grid_cube(0.0, 10.0, 24)   # 6912 三角形
    tv, tf = make_grid_cube(-2.0, 12.0, 12)  # 比 candidate 大 → 永远包不住
    m.load_candidate_mesh(cv, cf)
    m.load_target_mesh(tv, tf)
    p = mesh_matcher.GeneticAlgorithmParams()
    p.max_generations = 60
    p.population_size = 300
    p.early_stopping_generations = 0
    p.target_wrapping_ratio = 0.0

    beats = [0]
    stop = threading.Event()

    def heartbeat():
        while not stop.is_set():
            beats[0] += 1
            time.sleep(0.005)

    t = threading.Thread(target=heartbeat, daemon=True)
    t.start()
    time.sleep(0.05)                        # 心跳先行，确认线程活着
    baseline = beats[0]
    t0 = time.time()
    m.match_optimized(wrapping_threshold=0.99, ga_params=p)
    elapsed = time.time() - t0
    during = beats[0] - baseline
    stop.set()
    t.join(timeout=1)
    assert elapsed > 0.1, f"匹配仅 {elapsed*1000:.0f}ms，测试配置需要加重"
    assert during >= 10, f"match 期间心跳仅 {during} 次 → GIL 未释放"


def test_ga_identity_seed_no_regression():
    """预对齐（skip_align_directions=True）时，GA 结果不得差于恒等变换。

    把已完美嵌套的 target/candidate 交给 GA 且给足大搜索范围：
    若种群含恒等种子 + 精英保留，最优个体适应度必然 ≥ 恒等姿态 → wrap=1.0
    且最优变换就是零变换。无种子时初始种群全随机（±50mm/±180°），
    gen=0 大概率达不到精确 1.0/零变换。
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
    assert abs(r.optimal_lateral_offset) < 1e-9


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
