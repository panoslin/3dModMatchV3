#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鞋模-粗胚优化匹配脚本（基于生产场景）

双路径匹配 + 体积最小化：
1. 路径 A（PCA）：PCA 轴自动对齐（记录角度、不做容差校验）+ GA 优化
2. 路径 B（默认开启）：ICP 多起点热启动 → containment-refine → GA(skip_align)，
   与路径 A 竞争，保留包裹率高者
3. 完全包裹筛选：包裹率 ≥ wrapping_threshold 的候选为有效
4. 体积最小化：从有效候选中选择体积最小的
"""

import sys
import time
from pathlib import Path
from typing import List, Tuple, Optional
import numpy as np

try:
    from load_mesh import load_mesh_file, MeshFileError
except ImportError as e:
    print(f"❌ 错误: 无法导入 load_mesh 模块: {e}")
    sys.exit(1)

try:
    import mesh_matcher
except ImportError as e:
    print(f"❌ 错误: 无法导入 mesh_matcher 模块: {e}")
    print("请确保已编译C++模块")
    sys.exit(1)


def _pca_axes(V: np.ndarray) -> np.ndarray:
    """返回 3x3 PCA 正交基（列向量按特征值降序），每列都是单位向量。"""
    c = V.mean(axis=0)
    cov = np.cov((V - c).T)
    eigvals, eigvecs = np.linalg.eigh(cov)
    order = np.argsort(eigvals)[::-1]
    return eigvecs[:, order]


def _pca_seed_transforms(
    V_t: np.ndarray, V_c: np.ndarray
) -> List[np.ndarray]:
    """生成 16 个 PCA-based 4x4 初始姿态（target/candidate 各 4 组符号翻转组合）。

    两侧都强制右手系（第三列由前两列叉积现算），故 R = Rc·Rtᵀ 的行列式
    构造上恒为 +1；下方 det 检查仅为防御性保留。

    Returns a list of 4x4 homogeneous transforms representing R|T that
    map target → candidate frame. Used as ICP warm-start seeds.
    """
    Rt = _pca_axes(V_t)
    Rc = _pca_axes(V_c)
    t_c = V_t.mean(axis=0)
    c_c = V_c.mean(axis=0)
    seeds: List[np.ndarray] = []
    for s0 in (1, -1):
        for s1 in (1, -1):
            Rt_signed = Rt.copy()
            Rt_signed[:, 0] *= s0
            Rt_signed[:, 1] *= s1
            # 强制右手系
            Rt_signed[:, 2] = np.cross(Rt_signed[:, 0], Rt_signed[:, 1])
            for s0c in (1, -1):
                for s1c in (1, -1):
                    Rc_signed = Rc.copy()
                    Rc_signed[:, 0] *= s0c
                    Rc_signed[:, 1] *= s1c
                    Rc_signed[:, 2] = np.cross(Rc_signed[:, 0], Rc_signed[:, 1])
                    R = Rc_signed @ Rt_signed.T
                    if np.linalg.det(R) < 0:
                        continue
                    T = c_c - R @ t_c
                    M = np.eye(4)
                    M[:3, :3] = R
                    M[:3, 3] = T
                    seeds.append(M)
    return seeds


def icp_warmstart_alignment(
    target_vertices: np.ndarray,
    target_faces: np.ndarray,
    candidate_vertices: np.ndarray,
    candidate_faces: np.ndarray,
    n_subsample: int = 3000,
    max_iter: int = 30,
    verbose: bool = False,
) -> Tuple[np.ndarray, float]:
    """用 PCA-seeded ICP 多起点找 target 对齐到 candidate 的最优 4x4 刚体变换。

    返回 (best_4x4_matrix, best_icp_cost)。调用方应用该变换到 target 后
    再调用 match_optimized(..., skip_align_directions=True)。

    如果 trimesh 缺少 rtree/scipy 等可选依赖而 ICP 无法运行，则返回 identity。
    """
    try:
        import trimesh  # noqa: F401
        from trimesh.registration import icp as _icp
    except Exception as e:
        if verbose:
            print(f"⚠️  trimesh.registration.icp 不可用: {e}，跳过 ICP 热启动")
        return np.eye(4), float('inf')

    V_t = np.asarray(target_vertices, dtype=np.float64)
    V_c = np.asarray(candidate_vertices, dtype=np.float64)

    # 均匀子采样，加速 ICP
    step_t = max(1, len(V_t) // n_subsample)
    step_c = max(1, len(V_c) // n_subsample)
    sub_t = V_t[::step_t][:n_subsample]
    sub_c = V_c[::step_c][:n_subsample]

    seeds = _pca_seed_transforms(V_t, V_c)

    best_M = np.eye(4)
    best_cost = float('inf')
    first_error: Optional[str] = None
    for M0 in seeds:
        try:
            M, _, cost = _icp(
                sub_t, sub_c, initial=M0,
                max_iterations=max_iter,
                reflection=False, scale=False,
            )
        except Exception as e:
            if first_error is None:
                first_error = f"{type(e).__name__}: {e}"
            continue
        if cost < best_cost:
            best_cost = cost
            best_M = M

    if best_cost == float('inf') and first_error is not None:
        # 全部种子失败通常意味着 trimesh/scipy API 变化等系统性问题，
        # 必须可观测（不受 verbose 门控），否则与"真的没配上"无法区分
        print(f"⚠️  ICP 全部 {len(seeds)} 个种子失败，首个错误: {first_error}",
              file=sys.stderr)
    if verbose:
        print(f"ICP 热启动: 尝试 {len(seeds)} 个 PCA-seeded 起点, 最佳 cost={best_cost:.2f}mm²")
    return best_M, best_cost


def _apply_transform(V: np.ndarray, M: np.ndarray) -> np.ndarray:
    """对 Nx3 顶点应用 4x4 齐次变换。"""
    R = M[:3, :3]
    T = M[:3, 3]
    return (V @ R.T) + T


def _refine_should_continue(
    no_improve: int,
    best_wrap: float,
    early_stop_wrap: float,
    no_improve_limit: int = 3,
    hopeless_gap: float = 0.05,
) -> bool:
    """containment-refine 的 restart 预算决策。

    连续 no_improve_limit 次 restart 无改进、且当前 wrap 距目标还差
    hopeless_gap 以上 → 判为无望候选，停止烧预算（tc5 全集 ~30min 的
    主要构成就是对注定失败的候选磨满全部 restart）。
    差距在 hopeless_gap 以内说明接近达标，继续磨完剩余预算。
    """
    if no_improve < no_improve_limit:
        return True
    return best_wrap >= early_stop_wrap - hopeless_gap


def containment_refine(
    matcher: "mesh_matcher.MeshMatcher",
    target_vertices_current: np.ndarray,
    sample_count: int = 500,
    hinge_eps: float = 0.0,
    jitter_restarts: int = 4,
    early_stop_wrap: float = 0.97,
    nm_maxiter: int = 500,
    verbose: bool = False,
) -> Tuple[np.ndarray, float]:
    """Containment-maximizing SE(3) refine.

    以 target 当前位置为 delta=identity 起点，在 6-DOF 上用 L-BFGS-B + Nelder-Mead
    最小化 "仅外部点二次惩罚" 的代价：
        L(Δ) = Σ max(0, d_i(Δ) + hinge_eps)² / N
    其中 d_i 是 target 第 i 个采样点到 candidate 的 signed distance（d>0 = 外部）。

    返回 (delta_4x4, final_strict_wrap_ratio)。调用方应把 delta 应用到原 target_vertices
    得到最终几何。

    @param matcher 已 load_candidate_mesh 的 MeshMatcher；Python 端通过 signed_distance_batch 评估代价
    @param target_vertices_current 已经被 ICP/PCA 对齐到当前粗略姿态的 target 顶点
    @param sample_count 采样 target 顶点数（500 与最终 wrap 指标一致）
    @param hinge_eps 容差（mm）：允许点戳出粗胚 hinge_eps 内不计入代价（默认 0，strict）
    @param jitter_restarts 在 L-BFGS-B 最优解附近做多少次 jittered Nelder-Mead 精调
    """
    try:
        from scipy.optimize import minimize
        from scipy.spatial.transform import Rotation
    except Exception as e:
        if verbose:
            print(f"⚠️  scipy 不可用，跳过 containment refine: {e}")
        return np.eye(4), float('nan')

    V = np.asarray(target_vertices_current, dtype=np.float64)
    step = max(1, len(V) // sample_count)
    samples_world = V[::step][:sample_count]
    center = samples_world.mean(axis=0)
    samples_local = samples_world - center

    def params_to_RT(p: np.ndarray):
        R = Rotation.from_euler('xyz', p[3:6]).as_matrix()
        return R, p[0:3]

    def transform(p: np.ndarray) -> np.ndarray:
        R, T = params_to_RT(p)
        return (samples_local @ R.T) + center + T

    def loss_hinge(p: np.ndarray) -> float:
        pts = transform(p)
        d = matcher.signed_distance_batch(pts.astype(np.float64))
        penalty = np.maximum(0.0, d + hinge_eps)
        return float(np.sum(penalty * penalty) / len(d))

    def wrap_of(p: np.ndarray, tol: float = 0.1) -> float:
        pts = transform(p)
        d = matcher.signed_distance_batch(pts.astype(np.float64))
        return float((d <= tol).mean())

    p0 = np.zeros(6)
    w0 = wrap_of(p0)
    if verbose:
        print(f"  [containment-refine] 初始 wrap(strict)={w0*100:.2f}%, loss={loss_hinge(p0):.4f}")

    # 短路：起点已达标（例如 ICP 已把 target 完全推入）→ 无需任何优化
    if w0 >= early_stop_wrap:
        if verbose:
            print(f"  [containment-refine] 初始 wrap 已 ≥{early_stop_wrap*100:.1f}%，跳过优化")
        return np.eye(4), w0

    # Step 1: L-BFGS-B with default eps (实测默认步长对 mm/rad 参数范围刚好)
    best = minimize(loss_hinge, p0, method='L-BFGS-B',
                    options={'maxiter': 200, 'ftol': 1e-12, 'gtol': 1e-10})
    best_wrap = wrap_of(best.x)
    if verbose:
        print(f"  [containment-refine] L-BFGS-B: iter={best.nit}, loss={best.fun:.4f}, wrap={best_wrap*100:.2f}%")

    # 选择标准：**wrap 优先，loss 次之**（因为 loss 与最终 strict wrap 之间存在 ~1pp 噪声）
    # tracking variables
    best_x = best.x
    best_loss = best.fun
    # 下界保护：L-BFGS-B 沿连续 loss 走到 wrap（离散指标）反而更差的区域时
    # （实测 tc5 identity：91.00% → 89.75%），回退到 p0 作为 restart 基准，
    # 避免后续 jitter 围着劣化点打转、bail-out 又提前锁死劣化结果。
    if best_wrap < w0:
        if verbose:
            print(f"  [containment-refine] L-BFGS-B 劣化 wrap ({best_wrap*100:.2f}% < {w0*100:.2f}%)，回退 p0 基准")
        best_x = p0
        best_wrap = w0
        best_loss = loss_hinge(p0)

    if best_wrap < early_stop_wrap:
        # Step 2: 多尺度 jittered Nelder-Mead restarts（带自适应预算）
        rng = np.random.default_rng(42)
        # 多尺度 jitter：小窗口微调 + 大窗口逃离 + 极大窗口（针对深陷局部解）。
        # 大 σ（3.0/4.0mm）前置到前 3 位：bail-out 在连续 3 次无改进后才可能触发，
        # 保证放弃之前至少尝试过为"深陷局部解"设计的大尺度逃逸。
        sigmas = [
            (1.0, 0.03), (3.0, 0.10), (0.5, 0.015),
            (4.0, 0.15), (2.0, 0.06), (1.5, 0.05),
            (5.0, 0.20), (2.5, 0.08), (1.0, 0.03), (1.0, 0.03),
        ]
        no_improve = 0
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
                if not _refine_should_continue(no_improve, best_wrap, early_stop_wrap):
                    if verbose:
                        print(f"  [containment-refine] {no_improve} 次 restart 无改进且 "
                              f"wrap={best_wrap*100:.2f}% 距目标过远，放弃精调（省预算）")
                    break

    # Build delta 4x4
    R_best, T_best = params_to_RT(best_x)
    M = np.eye(4)
    M[:3, :3] = R_best
    M[:3, 3] = T_best + center - R_best @ center

    final_wrap = wrap_of(best_x)
    # 最终下界保护：优化结果绝不劣于"什么都不做"（w0）
    if final_wrap < w0:
        if verbose:
            print(f"  [containment-refine] FINAL {final_wrap*100:.2f}% < 初始 {w0*100:.2f}%，返回恒等变换兜底")
        return np.eye(4), w0
    if verbose:
        print(f"  [containment-refine] FINAL wrap(strict 0.1mm)={final_wrap*100:.2f}%, loss={best_loss:.4f}")
    return M, final_wrap


def count_polish(
    matcher: "mesh_matcher.MeshMatcher",
    target_vertices_current: np.ndarray,
    target_faces: np.ndarray,
    inside_tol: float = 0.1,
    sample_count: int = 6000,
    restarts: int = 6,
    nm_maxiter: int = 400,
    stop_at: float = 0.985,
    verbose: bool = False,
) -> Tuple[np.ndarray, float]:
    """计数目标 6-DOF 抛光（containment-refine 之后的第二级精调）。

    refine 的二次 hinge 损失会被少数深违入点（1-6mm）拖住，拒绝
    "牺牲救不回的深区块、拯救大量亚毫米边缘点"的交换；而业务指标
    是计数（d<=tol 的比例）。本函数用 sigmoid 软计数直接优化该指标
    的光滑替身，在 refine 最优附近做局部抛光（tc5 identity 实测 +1.9pp）。

    面积均匀采样（trimesh.sample_surface，固定种子）；优化集与验收集
    用不同种子防过拟合；返回 (delta_4x4, wrap_on_eval_set)，含
    "不劣于起点"下界保护。依赖缺失时返回 (identity, nan)。
    """
    try:
        import trimesh
        from scipy.optimize import minimize
        from scipy.spatial.transform import Rotation
    except Exception as e:
        if verbose:
            print(f"⚠️  count_polish 依赖缺失，跳过: {e}")
        return np.eye(4), float('nan')

    V = np.asarray(target_vertices_current, dtype=np.float64)
    mesh = trimesh.Trimesh(vertices=V, faces=np.asarray(target_faces), process=False)
    opt_pts = np.asarray(trimesh.sample.sample_surface(mesh, sample_count, seed=20260703)[0])
    eval_pts = np.asarray(trimesh.sample.sample_surface(mesh, max(sample_count, 4000), seed=987)[0])
    center = V.mean(axis=0)
    opt_local = opt_pts - center
    eval_local = eval_pts - center

    def _transformed(local_pts, p):
        R = Rotation.from_euler('xyz', p[3:6]).as_matrix()
        return (local_pts @ R.T) + center + p[0:3]

    def soft_fail(p):
        d = matcher.signed_distance_batch(
            np.ascontiguousarray(_transformed(opt_local, p)))
        return float(np.mean(1.0 / (1.0 + np.exp(-(d - inside_tol) / 0.15))))

    def eval_wrap(p):
        d = matcher.signed_distance_batch(
            np.ascontiguousarray(_transformed(eval_local, p)))
        return float((d <= inside_tol).mean())

    p0 = np.zeros(6)
    w0 = eval_wrap(p0)
    if w0 >= stop_at:  # 起点已远超阈值，无需抛光
        return np.eye(4), w0
    best_p, best_w, best_soft = p0, w0, soft_fail(p0)
    rng = np.random.default_rng(20260703)
    # 多尺度抖动：小步微调 + 中/大步跨盆地（计数地形的最优可能与 hinge 盆地不同）
    jitter_sigmas = [(0.4, 0.004), (0.4, 0.004), (1.5, 0.010),
                     (1.5, 0.010), (3.0, 0.020), (3.0, 0.020)]
    for k in range(restarts):
        if k == 0:
            x0 = best_p
        else:
            st, sr = jitter_sigmas[(k - 1) % len(jitter_sigmas)]
            x0 = best_p + rng.normal(0, [st] * 3 + [sr] * 3, 6)
        r = minimize(soft_fail, x0, method='Nelder-Mead',
                     options={'maxiter': nm_maxiter, 'xatol': 1e-4,
                              'fatol': 1e-9, 'adaptive': True})
        w = eval_wrap(r.x)
        # 验收集上 wrap 严格变好；持平时看软损失
        if w > best_w + 1e-4 or (abs(w - best_w) <= 1e-4 and r.fun < best_soft):
            best_p, best_w, best_soft = r.x, w, r.fun
            if verbose:
                print(f"  [count-polish] restart {k}: wrap={w*100:.2f}%")
            if best_w >= stop_at:  # 已明显越线，剩余预算无边际价值
                break

    if best_w < w0:  # 下界保护（理论上不会发生，防御性保留）
        return np.eye(4), w0

    R_best = Rotation.from_euler('xyz', best_p[3:6]).as_matrix()
    M = np.eye(4)
    M[:3, :3] = R_best
    M[:3, 3] = best_p[0:3] + center - R_best @ center
    if verbose:
        print(f"  [count-polish] {w0*100:.2f}% → {best_w*100:.2f}% (eval 集)")
    return M, best_w


def _polish_ga_params(base: "mesh_matcher.GeneticAlgorithmParams",
                      high_precision: bool = False):
    """为"已预对齐姿态"派生小窗口 6-DOF GA 参数（计数适应度的最终抛光）。

    恒等种子 + 精英保留保证结果不劣于送入姿态；小窗口避免大范围随机
    搜索浪费预算。调用方已显式启用 6-DOF 时保留其设置。
    """
    p = mesh_matcher.GeneticAlgorithmParams()
    p.population_size = base.population_size
    p.max_generations = base.max_generations
    p.crossover_rate = base.crossover_rate
    p.mutation_rate = base.mutation_rate
    p.mutation_scale = base.mutation_scale
    p.selection_rate = base.selection_rate
    p.convergence_threshold = base.convergence_threshold
    # "有望带"候选（refine 落在阈值附近）的抛光收益只有零点几 pp，
    # 500 采样 ±0.9pp 的适应度噪声会淹没决策信号 → 提到 2000；
    # 其余候选（大幅过线/明显无望）保持调用方采样数省时
    p.num_sample_points = (max(base.num_sample_points, 2000)
                           if high_precision else base.num_sample_points)
    p.early_stopping_generations = base.early_stopping_generations
    p.target_wrapping_ratio = base.target_wrapping_ratio
    p.inside_tolerance_mm = base.inside_tolerance_mm
    _two_deg = float(np.radians(2.0))
    p.translation_range = min(base.translation_range, 3.0)
    p.rotation_range = min(base.rotation_range, _two_deg)
    p.lateral_range = min(base.lateral_range, 3.0)
    p.vertical_range = base.vertical_range if base.vertical_range > 0 else 2.0
    p.pitch_range = base.pitch_range if base.pitch_range > 0 else _two_deg
    p.yaw_range = base.yaw_range if base.yaw_range > 0 else _two_deg
    return p


def find_optimal_match(
    target_file: Path,
    candidate_files: List[Path],
    wrapping_threshold: float = 0.96,
    verbose: bool = False,
    ga_params: Optional[mesh_matcher.GeneticAlgorithmParams] = None,
    icp_warmstart: bool = True,
    containment_refine_enabled: bool = True,
) -> Tuple[Optional[Path], dict]:
    """遍历所有候选粗胚，返回满足包裹率且体积最小的匹配。

    当 icp_warmstart=True 时，对每个候选额外跑一轮 "Python ICP 多起点 + C++
    skip_align_directions" 路径，与默认 PCA 路径比较，保留 wrap 较高者。
    当 containment_refine_enabled=True 时，在 ICP 路径之后追加 containment-refine
    （scipy L-BFGS-B + Nelder-Mead 多起点，直接以"外部点二次惩罚"为代价），能把
    strict wrap 进一步推到接近几何上限。
    """
    # 加载目标鞋模
    if verbose:
        print(f"加载目标鞋模: {target_file}")

    try:
        target_vertices, target_faces = load_mesh_file(target_file, mesh_quality='high')
    except MeshFileError as e:
        if verbose:
            print(f"❌ 无法加载目标文件: {e}")
        return None, {'error': str(e)}

    if verbose:
        print(f"  顶点数: {len(target_vertices):,}, 面数: {len(target_faces):,}")

    # 创建匹配器
    matcher = mesh_matcher.MeshMatcher()
    matcher.set_verbose(verbose)
    matcher.load_target_mesh(target_vertices, target_faces)

    # 遍历所有候选粗胚
    valid_matches = []
    all_candidate_results = []  # 收集所有候选结果（包括未通过阈值的）

    for idx, candidate_file in enumerate(candidate_files):
        if verbose:
            print(f"\n[{idx+1}/{len(candidate_files)}] 检查候选: {candidate_file.name}")

        try:
            # 加载候选粗胚
            candidate_vertices, candidate_faces = load_mesh_file(
                candidate_file, mesh_quality='high'
            )

            # 加载到匹配器（default 路径）
            if not matcher.load_candidate_mesh(candidate_vertices, candidate_faces):
                if verbose:
                    print("  ⚠️  无法加载网格数据")
                all_candidate_results.append({
                    'candidate_path': str(candidate_file),
                    'candidate_name': candidate_file.name,
                    'error': '无法加载网格数据',
                })
                continue

            # 路径 A: 默认 PCA + GA 流水线
            start_time = time.time()
            result = matcher.match_optimized(
                wrapping_threshold=wrapping_threshold,
                ga_params=ga_params if ga_params else mesh_matcher.GeneticAlgorithmParams(),
                skip_align_directions=False,
            )
            match_time = time.time() - start_time
            pipeline_used = 'pca'

            # 路径 B（可选）: ICP 多起点热启动 + C++ skip_align_directions
            # 优化：若 PCA 已显著超过阈值（≥0.97），跳过 ICP+refine 节省时间（干净 3DM/STL 常见）
            icp_error = None
            _pca_already_excellent = (
                icp_warmstart and result.wrapping_ratio >= 0.97
            )
            if _pca_already_excellent and verbose:
                print(f"  [skip ICP] PCA wrap={result.wrapping_ratio*100:.2f}% ≥97%，跳过 ICP+refine 省时")
            if icp_warmstart and not _pca_already_excellent:
                try:
                    icp_start = time.time()
                    M_icp, icp_cost = icp_warmstart_alignment(
                        target_vertices, target_faces,
                        candidate_vertices, candidate_faces,
                        verbose=verbose,
                    )
                    aligned_target = _apply_transform(target_vertices, M_icp)

                    # 路径 B.2（可选）: containment-refine (scipy L-BFGS-B + NM restarts)
                    # 用已加载 candidate 的 matcher 做 signed_distance_batch 评估
                    refine_wrap = float('nan')
                    if containment_refine_enabled:
                        refine_matcher = mesh_matcher.MeshMatcher()
                        refine_matcher.set_verbose(False)
                        refine_matcher.load_candidate_mesh(candidate_vertices, candidate_faces)
                        refine_start = time.time()
                        M_refine, refine_wrap = containment_refine(
                            refine_matcher,
                            aligned_target,
                            sample_count=800,         # 减小评估方差
                            hinge_eps=0.0,            # strict（与最终 wrap 评估的 inside_tol=0.1 配套）
                            jitter_restarts=10,       # 多尺度 + 持续 retry，wrap 不达标永不 break
                            early_stop_wrap=0.97,     # 推到 0.97 才停，留 ~1pp 余量给 C++ 端不同采样
                            verbose=verbose,
                        )
                        if verbose:
                            print(
                                f"  [containment-refine] wrap(strict)={refine_wrap*100:.2f}%, "
                                f"耗时 {(time.time()-refine_start)*1000:.0f}ms"
                            )
                        aligned_target = _apply_transform(aligned_target, M_refine)

                        # 计数抛光：refine 落在边缘带时最值得——深违入区块救不回，
                        # 但大量亚毫米边缘点可救（hinge 最优 ≠ 计数最优）。
                        # 已 ≥0.97（refine 早停）跳过；<0.90 判无望跳过。
                        # 注意口径差：refine_wrap 是顶点采样，比面积口径低 ~1.5pp；
                        # 顶点 0.90 ≈ 面积 0.92，叠加实测最大提升 ~+4.3pp 恰够到 0.96 线
                        #（曾误设 0.92 门槛，漏掉 refine=91.62% → 抛光后 97.4% 的真实翻盘）。
                        if 0.90 <= refine_wrap < 0.97:
                            M_polish, polish_wrap = count_polish(
                                refine_matcher, aligned_target, target_faces,
                                inside_tol=(ga_params.inside_tolerance_mm
                                            if ga_params else 0.1),
                                verbose=verbose,
                            )
                            if np.isfinite(polish_wrap):
                                aligned_target = _apply_transform(aligned_target, M_polish)

                    base_ga = ga_params if ga_params else mesh_matcher.GeneticAlgorithmParams()
                    # refine 成功后目标已在计数最优附近：给 GA 换小窗口 6-DOF 抛光参数
                    #（恒等种子 + 精英保留保证不劣于送入姿态）；否则沿用调用方参数。
                    # 仅"有望带"候选启用高精度适应度采样（决策信号 vs 成本的权衡）
                    # ≥0.90 的候选（潜在过线者）都值得高精度适应度——它们的最终
                    # 余量最重要；只有 <0.90 的无望候选降采样省时
                    refined_ok = containment_refine_enabled and np.isfinite(refine_wrap)
                    promising = refined_ok and refine_wrap >= 0.90
                    icp_ga = (_polish_ga_params(base_ga, high_precision=promising)
                              if refined_ok else base_ga)
                    matcher_icp = mesh_matcher.MeshMatcher()
                    matcher_icp.set_verbose(False)
                    matcher_icp.load_target_mesh(aligned_target, target_faces)
                    matcher_icp.load_candidate_mesh(candidate_vertices, candidate_faces)
                    result_icp = matcher_icp.match_optimized(
                        wrapping_threshold=wrapping_threshold,
                        ga_params=icp_ga,
                        skip_align_directions=True,
                    )
                    icp_time = time.time() - icp_start
                    tag = 'icp+refine' if containment_refine_enabled else 'icp'
                    if verbose:
                        print(
                            f"  [{tag} 路径] wrap={result_icp.wrapping_ratio:.4f} (vs PCA {result.wrapping_ratio:.4f}), "
                            f"耗时 {icp_time*1000:.0f}ms, icp_cost={icp_cost:.1f}mm²"
                        )
                    # 保留 wrap 较高者；如并列则保留体积较小者
                    if (result_icp.wrapping_ratio > result.wrapping_ratio + 1e-4) or (
                        abs(result_icp.wrapping_ratio - result.wrapping_ratio) <= 1e-4
                        and result_icp.volume < result.volume
                    ):
                        result = result_icp
                        match_time += icp_time
                        pipeline_used = tag
                except Exception as e:
                    icp_error = f"{type(e).__name__}: {e}"
                    # 生产路径（desktop-app 以 verbose=False 调用）也必须可观测：
                    # 静默退化为纯 PCA 结果曾无法与"ICP 正常但没赢"区分
                    print(f"  ⚠️  ICP 热启动/refine 失败，回退到 PCA 结果: {icp_error}",
                          file=sys.stderr)
                    if verbose:
                        import traceback
                        traceback.print_exc()

            result.candidate_index = idx
            result.candidate_path = str(candidate_file)

            if verbose:
                print(f"  方向对齐验证:")
                print(f"    鞋跟-鞋头对齐: {result.direction_alignment.heel_toe_alignment:.4f} "
                      f"(角度: {result.direction_alignment.heel_toe_angle_deg:.2f}°)")
                print(f"    上下方向对齐: {result.direction_alignment.vertical_alignment:.4f} "
                      f"(角度: {result.direction_alignment.vertical_angle_deg:.2f}°)")
                print(f"    方向约束满足: {'✅' if result.meets_direction_constraints else '❌'}")
                print(f"  包裹率: {result.wrapping_ratio:.4f} ({result.wrapping_ratio*100:.2f}%)")
                print(f"  完全包裹: {'✅' if result.is_fully_wrapped else '❌'}")
                print(f"  体积: {result.volume:.2f}")
                print(f"  最优平移: {result.optimal_translation:.4f}")
                print(f"  匹配时间: {match_time*1000:.2f}ms")

            # 记录该候选的完整结果（无论是否通过阈值）
            candidate_result = {
                'candidate_path': str(candidate_file),
                'candidate_name': candidate_file.name,
                'wrapping_ratio': result.wrapping_ratio,
                'percentile96_clearance': result.percentile96_clearance,
                'volume': result.volume,
                'is_fully_wrapped': result.is_fully_wrapped,
                'meets_direction_constraints': result.meets_direction_constraints,
                'optimal_translation': result.optimal_translation,
                'optimal_rotation_angle_deg': result.optimal_rotation_angle_deg,
                'optimal_lateral_offset': result.optimal_lateral_offset,
                'match_time_ms': match_time * 1000,
                'pipeline_used': pipeline_used,
                'icp_error': icp_error,
                'direction_alignment': {
                    'heel_toe_alignment': result.direction_alignment.heel_toe_alignment,
                    'vertical_alignment': result.direction_alignment.vertical_alignment,
                    'heel_toe_angle_deg': result.direction_alignment.heel_toe_angle_deg,
                    'vertical_angle_deg': result.direction_alignment.vertical_angle_deg,
                    'is_valid': result.direction_alignment.is_valid,
                },
            }
            all_candidate_results.append(candidate_result)

            # 检查是否满足所有条件
            if (result.meets_direction_constraints and
                result.is_fully_wrapped):
                valid_matches.append((result, match_time))
                if verbose:
                    print("  ✅ 满足所有匹配条件")
            else:
                if verbose:
                    reasons = []
                    if not result.meets_direction_constraints:
                        reasons.append("方向约束")
                    if not result.is_fully_wrapped:
                        reasons.append("不完全包裹")
                    print(f"  ❌ 不满足匹配条件: {', '.join(reasons)}")

        except MeshFileError as e:
            if verbose:
                print(f"  ❌ 无法加载文件: {e}")
            all_candidate_results.append({
                'candidate_path': str(candidate_file),
                'candidate_name': candidate_file.name,
                'error': str(e),
            })
            continue
        except Exception as e:
            if verbose:
                print(f"  ❌ 匹配过程出错: {e}")
                import traceback
                traceback.print_exc()
            all_candidate_results.append({
                'candidate_path': str(candidate_file),
                'candidate_name': candidate_file.name,
                'error': str(e),
            })
            continue

    # 如果没有有效匹配，返回None（但仍包含所有候选结果数据）
    if not valid_matches:
        return None, {
            'error': 'No valid matches found',
            'total_candidates': len(candidate_files),
            'valid_matches': 0,
            'all_candidate_results': all_candidate_results,
        }
    
    # 选择体积最小的匹配
    best_match = min(valid_matches, key=lambda x: x[0].volume)
    result, match_time = best_match
    
    return Path(result.candidate_path), {
        'candidate_path': result.candidate_path,
        'volume': result.volume,
        'wrapping_ratio': result.wrapping_ratio,
        'percentile96_clearance': result.percentile96_clearance,
        'optimal_translation': result.optimal_translation,
        'optimal_rotation_angle_deg': result.optimal_rotation_angle_deg,
        'optimal_lateral_offset': result.optimal_lateral_offset,
        'is_fully_wrapped': result.is_fully_wrapped,
        'meets_direction_constraints': result.meets_direction_constraints,
        'target_wrapping_ratio': wrapping_threshold,
        'direction_alignment': {
            'heel_toe_alignment': result.direction_alignment.heel_toe_alignment,
            'vertical_alignment': result.direction_alignment.vertical_alignment,
            'heel_toe_angle_deg': result.direction_alignment.heel_toe_angle_deg,
            'vertical_angle_deg': result.direction_alignment.vertical_angle_deg,
            'is_valid': result.direction_alignment.is_valid
        },
        'generation_history': [
            {
                'generation': g.generation,
                'best_fitness': g.best_fitness,
                'avg_fitness': g.avg_fitness,
                'translation': g.translation,
                'rotation_angle_deg': g.rotation_angle_deg,
                'lateral_offset': g.lateral_offset,
            } for g in result.generation_history
        ],
        'match_time_ms': match_time * 1000,
        'total_valid_matches': len(valid_matches),
        'total_candidates': len(candidate_files),
        'all_candidate_results': all_candidate_results,
    }


def match_testcase_optimized(
    testcase_dir: Path,
    wrapping_threshold: float = 0.96,
    verbose: bool = False,
    ga_params: Optional[mesh_matcher.GeneticAlgorithmParams] = None,
    icp_warmstart: bool = True,
    containment_refine_enabled: bool = True,
) -> dict:
    """对 testcase_dir 下所有 target 逐个匹配 candidate_set 中的粗胚。"""
    target_dir = testcase_dir / 'target'
    candidate_dir = testcase_dir / 'candidate_set'
    
    if not target_dir.exists():
        return {'error': f'Target directory not found: {target_dir}'}
    if not candidate_dir.exists():
        return {'error': f'Candidate directory not found: {candidate_dir}'}
    
    # 查找所有目标文件和候选文件（支持 .3dm 和 .stl）
    target_files = sorted(target_dir.glob('*.3dm')) + sorted(target_dir.glob('*.stl'))
    candidate_files = sorted(candidate_dir.glob('*.3dm')) + sorted(candidate_dir.glob('*.stl'))
    
    if not target_files:
        return {'error': 'No target files found'}
    if not candidate_files:
        return {'error': 'No candidate files found'}
    
    results = []
    
    for target_file in target_files:
        if verbose:
            print(f"\n{'='*70}")
            print(f"匹配目标: {target_file.name}")
            print(f"{'='*70}")
        
        best_match, match_info = find_optimal_match(
            target_file, candidate_files,
            wrapping_threshold=wrapping_threshold,
            verbose=verbose,
            ga_params=ga_params,
            icp_warmstart=icp_warmstart,
            containment_refine_enabled=containment_refine_enabled,
        )
        
        result = {
            'target_file': str(target_file),
            'target_name': target_file.name,
            'best_match': str(best_match) if best_match else None,
            'best_match_name': best_match.name if best_match else None,
            **match_info
        }
        results.append(result)
        
        if verbose:
            if best_match:
                print(f"\n✅ 最佳匹配: {best_match.name}")
                print(f"   体积: {match_info.get('volume', 0):.2f}")
                print(f"   包裹率: {match_info.get('wrapping_ratio', 0)*100:.2f}%")
                print(f"   方向对齐: 鞋跟-鞋头 {match_info.get('direction_alignment', {}).get('heel_toe_angle_deg', 0):.2f}°, "
                      f"上下 {match_info.get('direction_alignment', {}).get('vertical_angle_deg', 0):.2f}°")
                print(f"   匹配时间: {match_info.get('match_time_ms', 0):.2f}ms")
            else:
                print(f"\n❌ 未找到匹配")
    
    return {
        'testcase': str(testcase_dir),
        'results': results,
        'total_targets': len(target_files),
        'total_candidates': len(candidate_files)
    }


def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='鞋模-粗胚优化匹配系统（基于生产场景）',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument(
        'testcase_dir',
        type=str,
        help='测试用例目录路径'
    )
    
    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='输出详细信息'
    )
    
    parser.add_argument(
        '--wrapping-threshold',
        type=float,
        default=0.96,
        help='包裹率阈值（默认: 0.96，即 96%%，对应历史上 GA target 的有效值；'
             '过去 CLI 默认 0.99 因被 ga_target_wrapping_ratio=0.96 覆盖而无效）'
    )

    # ICP 热启动 / containment-refine：默认开启（一套算法适配所有数据）；
    # 高级用户可通过 --no-icp-warmstart / --no-containment-refine 关闭以追求速度。
    parser.add_argument(
        '--icp-warmstart',
        dest='icp_warmstart',
        action='store_true',
        default=True,
        help='[默认开启] ICP 多起点热启动（PCA-seeded 16 起点，对非水密/winding 不一致 STL 必需）'
    )
    parser.add_argument(
        '--no-icp-warmstart',
        dest='icp_warmstart',
        action='store_false',
        help='关闭 ICP 热启动（仅在确定数据干净且要求最快速度时使用）'
    )
    parser.add_argument(
        '--containment-refine',
        dest='containment_refine',
        action='store_true',
        default=True,
        help='[默认开启] containment-refine (scipy L-BFGS-B + Nelder-Mead 多起点)。'
             '直接最小化"外部点二次惩罚"代价，把 strict wrap 推到几何上限。'
    )
    parser.add_argument(
        '--no-containment-refine',
        dest='containment_refine',
        action='store_false',
        help='关闭 containment-refine（仅在追求速度时使用，可能让 strict ≥0.96 不达标）'
    )

    parser.add_argument(
        '--inside-tolerance-mm',
        type=float,
        default=0.1,
        help='"Inside" 容差（mm）：signed distance <= 此值视为"在粗胚内部"。'
             '默认 0.1mm（历史行为）；对允许加工余量的鞋模-粗胚场景建议 1-3mm。'
    )
    
    # 遗传算法参数
    parser.add_argument(
        '--ga-population-size',
        type=int,
        default=50,
        help='GA种群大小（默认: 50）'
    )
    parser.add_argument(
        '--ga-max-generations',
        type=int,
        default=30,
        help='GA最大代数（默认: 30）'
    )
    parser.add_argument(
        '--ga-crossover-rate',
        type=float,
        default=0.8,
        help='GA交叉率（默认: 0.8）'
    )
    parser.add_argument(
        '--ga-mutation-rate',
        type=float,
        default=0.1,
        help='GA变异率（默认: 0.1）'
    )
    parser.add_argument(
        '--ga-mutation-scale',
        type=float,
        default=0.1,
        help='GA变异幅度（默认: 0.1）'
    )
    parser.add_argument(
        '--ga-selection-rate',
        type=float,
        default=0.5,
        help='GA选择率（默认: 0.5）'
    )
    parser.add_argument(
        '--ga-translation-range',
        type=float,
        default=50.0,
        help='GA纵向位移搜索范围（mm，默认: ±50）'
    )
    parser.add_argument(
        '--ga-rotation-range',
        type=float,
        default=180.0,
        help='GA旋转角度搜索范围（度，默认: ±180）'
    )
    parser.add_argument(
        '--ga-lateral-range',
        type=float,
        default=30.0,
        help='GA横向位移搜索范围（mm，默认: ±30）'
    )
    parser.add_argument(
        '--ga-vertical-range',
        type=float,
        default=0.0,
        help='GA垂直位移搜索范围（mm，默认: 0 → 3-DOF；典型 10）'
    )
    parser.add_argument(
        '--ga-pitch-range',
        type=float,
        default=0.0,
        help='GA绕横向轴旋转（pitch）搜索范围（度，默认: 0 → 3-DOF；典型 5-10）'
    )
    parser.add_argument(
        '--ga-yaw-range',
        type=float,
        default=0.0,
        help='GA绕垂直轴旋转（yaw）搜索范围（度，默认: 0 → 3-DOF；典型 5-10）'
    )
    parser.add_argument(
        '--ga-6dof',
        action='store_true',
        help='快捷开关：开启 6-DOF 模式（等价于设置 vertical_range=10mm, pitch_range=5°, yaw_range=5°；'
             '若单独已指定 --ga-*-range，则此开关仅在原范围=0 时填充默认值）'
    )
    parser.add_argument(
        '--ga-target-wrapping-ratio',
        type=float,
        default=0.96,
        help='GA目标包裹率（默认: 0.96，达到此值即停止优化，0表示禁用）'
    )
    parser.add_argument(
        '--num-sample-points',
        type=int,
        default=500,
        help='采样点数量（默认: 500）'
    )
    
    args = parser.parse_args()
    
    testcase_dir = Path(args.testcase_dir)
    if not testcase_dir.exists():
        print(f"❌ 错误: 测试用例目录不存在: {testcase_dir}")
        sys.exit(1)
    
    # 创建遗传算法参数对象
    ga_params = mesh_matcher.GeneticAlgorithmParams()
    ga_params.population_size = args.ga_population_size
    ga_params.max_generations = args.ga_max_generations
    ga_params.crossover_rate = args.ga_crossover_rate
    ga_params.mutation_rate = args.ga_mutation_rate
    ga_params.mutation_scale = args.ga_mutation_scale
    ga_params.selection_rate = args.ga_selection_rate
    ga_params.translation_range = args.ga_translation_range
    ga_params.rotation_range = float(np.radians(args.ga_rotation_range))
    ga_params.lateral_range = args.ga_lateral_range
    ga_params.num_sample_points = args.num_sample_points
    ga_params.target_wrapping_ratio = args.ga_target_wrapping_ratio
    ga_params.inside_tolerance_mm = args.inside_tolerance_mm

    # 6-DOF 扩展：默认 0（退化 3-DOF），--ga-6dof 提供一组经验默认
    vert_r = args.ga_vertical_range
    pitch_r = args.ga_pitch_range
    yaw_r = args.ga_yaw_range
    if args.ga_6dof:
        if vert_r <= 0.0:
            vert_r = 10.0
        if pitch_r <= 0.0:
            pitch_r = 5.0
        if yaw_r <= 0.0:
            yaw_r = 5.0
    ga_params.vertical_range = vert_r
    ga_params.pitch_range = float(np.radians(pitch_r))
    ga_params.yaw_range = float(np.radians(yaw_r))
    
    if args.verbose:
        print(f"\n{'='*70}")
        print(f"使用算法: 遗传算法 (GA)")
        print(f"GA参数: 种群={ga_params.population_size}, 代数={ga_params.max_generations}")
        print(f"{'='*70}\n")
    
    result = match_testcase_optimized(
        testcase_dir,
        wrapping_threshold=args.wrapping_threshold,
        verbose=args.verbose,
        ga_params=ga_params,
        icp_warmstart=args.icp_warmstart,
        containment_refine_enabled=args.containment_refine,
    )
    
    if 'error' in result:
        print(f"❌ 错误: {result['error']}")
        sys.exit(1)
    
    # 输出总结
    print(f"\n{'='*70}")
    print("优化匹配总结")
    print(f"{'='*70}")
    print(f"测试用例: {result['testcase']}")
    print(f"目标文件数: {result['total_targets']}")
    print(f"候选文件数: {result['total_candidates']}")
    print(f"\n匹配结果:")
    
    for r in result['results']:
        print(f"  目标: {r['target_name']}")
        if r['best_match']:
            print(f"    ✅ 最佳匹配: {r['best_match_name']}")
            print(f"       体积: {r.get('volume', 0):.2f}")
            print(f"       包裹率: {r.get('wrapping_ratio', 0)*100:.2f}%")
            dir_align = r.get('direction_alignment', {})
            print(f"       方向对齐: 鞋跟-鞋头 {dir_align.get('heel_toe_angle_deg', 0):.2f}°, "
                  f"上下 {dir_align.get('vertical_angle_deg', 0):.2f}°")
        else:
            print(f"    ❌ 未找到匹配")
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
