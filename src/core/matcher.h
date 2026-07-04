#ifndef MATCHER_H
#define MATCHER_H

#include <vector>
#include <string>
#include <memory>
#include <mutex>
#include <tuple>
#include <Eigen/Dense>
#include "bvh.h"

/// @brief 方向对齐信息（鞋跟-鞋头 & 上下方向）
struct DirectionAlignment {
    double heel_toe_alignment;      // 鞋跟-鞋头方向对齐分数 [0, 1]
    double vertical_alignment;       // 上下方向对齐分数 [0, 1]
    bool is_valid;                   // 是否满足严格对齐要求
    double heel_toe_angle_deg;       // 鞋跟-鞋头方向角度差（度）
    double vertical_angle_deg;       // 上下方向角度差（度）

    DirectionAlignment() : heel_toe_alignment(0.0), vertical_alignment(0.0),
                          is_valid(false), heel_toe_angle_deg(0.0), vertical_angle_deg(0.0) {}
};

/// @brief GA 输出的最优 6-DOF 姿态（平移 mm / 旋转弧度）
///
/// 用结构体替代 5 个连续同类型 double& 输出参数：位置错配（如 pitch/yaw
/// 传反）在纯位置参数下编译器无法发现，结构体字段名从根本上消除该风险。
struct OptimalPose {
    double translation = 0.0;      // 纵向位移（沿 longitudinal_axis，mm）
    double rotation_rad = 0.0;     // 绕纵向轴 roll（弧度）
    double lateral = 0.0;          // 横向位移（mm）
    double vertical_offset = 0.0;  // 垂直位移（mm，3-DOF 模式下为 0）
    double pitch_rad = 0.0;        // 绕横向轴（弧度，3-DOF 模式下为 0）
    double yaw_rad = 0.0;          // 绕垂直轴（弧度，3-DOF 模式下为 0）
};

/// @brief 遗传算法参数配置
struct GeneticAlgorithmParams {
    int population_size;        // 种群大小（默认50）
    int max_generations;        // 最大代数（默认30）
    double crossover_rate;      // 交叉率（默认0.8）
    double mutation_rate;        // 变异率（默认0.1）
    double mutation_scale;       // 变异幅度（默认0.1）
    double selection_rate;       // 选择率（保留前N%）（默认0.5）
    double convergence_threshold; // 收敛阈值（默认1e-4）
    size_t num_sample_points;    // 采样点数量（默认500）
    int early_stopping_generations; // 提前终止：连续N代无改进时退出（默认4，0表示禁用）
    double target_wrapping_ratio;   // 目标包裹率（默认0.96，达到此值即停止优化，0表示禁用）

    // "Inside" 容差（mm）：最终 wrap / clearance 计算时，signed distance <= 该值视为"在内部"
    // 默认 0.1mm（历史行为）；对允许加工余量的场景（如鞋模-粗胚）可调至 1-3mm
    double inside_tolerance_mm;

    // 搜索范围（3-DOF 经典参数；6-DOF 模式下仍然生效，作为纵向/横向/绕纵向旋转维度的范围）
    double translation_range;    // 纵向位移搜索范围（mm，默认±50）
    double rotation_range;       // 绕纵向轴旋转搜索范围（弧度，默认±π）
    double lateral_range;        // 横向位移搜索范围（mm，默认±30）

    // 6-DOF 扩展：额外的 pitch / yaw / 垂直位移搜索范围
    //   默认 0 → GA 退化为 3-DOF（与历史行为数值兼容）
    //   典型使用：ICP 热启动后，仅在 ±small 窗口内精调，例如 5°/10mm
    double vertical_range;       // 垂直位移搜索范围（mm，默认 0 = 不搜索；典型 10）
    double pitch_range;          // 绕横向轴旋转搜索范围（弧度，默认 0；典型 π/36 ≈ 5°）
    double yaw_range;            // 绕垂直轴旋转搜索范围（弧度，默认 0；典型 π/36）
    
    GeneticAlgorithmParams()
        : population_size(50),
          max_generations(30),
          crossover_rate(0.8),
          mutation_rate(0.1),
          mutation_scale(0.1),
          selection_rate(0.5),
          convergence_threshold(1e-4),
          num_sample_points(500),
          early_stopping_generations(4),  // 默认连续4代无改进时提前终止
          target_wrapping_ratio(0.96),    // 默认目标包裹率96%，达到即停止
          inside_tolerance_mm(0.1),       // 默认 0.1mm（历史行为）；鞋模-粗胚场景建议 1-3mm
          translation_range(50.0),
          rotation_range(3.14159265358979323846),  // M_PI
          lateral_range(30.0),
          vertical_range(0.0),   // 默认 0：退化为 3-DOF
          pitch_range(0.0),      // 默认 0：退化为 3-DOF
          yaw_range(0.0)         // 默认 0：退化为 3-DOF
          {}
};

/// @brief 遗传算法每代统计快照（用于前端回放）
struct GenerationState {
    int generation;            // 代数（从 0 开始：0表示初始种群评估完成）
    double best_fitness;       // 最佳适应度（= 包裹率近似值）
    double avg_fitness;        // 平均适应度
    double std_dev;            // 适应度标准差
    double translation;        // 纵向位移（mm）
    double rotation_angle_deg; // 旋转角度（度）
    double lateral_offset;     // 横向位移（mm）
    int crossover_count;       // 本代交叉次数
    int mutation_count;        // 本代变异次数
    double time_ms;            // 本代耗时（ms）

    GenerationState()
        : generation(0),
          best_fitness(0.0),
          avg_fitness(0.0),
          std_dev(0.0),
          translation(0.0),
          rotation_angle_deg(0.0),
          lateral_offset(0.0),
          crossover_count(0),
          mutation_count(0),
          time_ms(0.0) {}
};

/// @brief 单次匹配的完整结果
struct MatchResult {
    int candidate_index;
    std::string candidate_path;
    double volume;
    bool is_fully_wrapped;
    double match_score;

    DirectionAlignment direction_alignment;  // 方向对齐信息
    double wrapping_ratio;                   // 体积包裹率 [0, 1]
    double percentile96_clearance;           // 96%分位数间隙（mm）：鞋模表面点到粗胚内表面的距离的96%分位数（仅统计在粗胚内的点）
    double optimal_translation;               // 最优前后位置平移量（沿纵向轴）
    double optimal_rotation_angle_deg;       // 最优绕纵向轴旋转角度（度）
    double optimal_vertical_offset;          // 最优垂直位移（沿垂直轴，mm；6-DOF 模式下真实填充，3-DOF 模式下 0）
    double optimal_lateral_offset;           // 最优横向位移（沿横向轴，mm）
    double optimal_pitch_deg;                 // 最优绕横向轴旋转（度；6-DOF 模式下填充，否则 0）
    double optimal_yaw_deg;                   // 最优绕垂直轴旋转（度；6-DOF 模式下填充，否则 0）
    bool meets_direction_constraints;         // 是否满足方向约束

    // 回放：遗传算法每代状态（只在使用 GA 时填充）
    std::vector<GenerationState> generation_history;
    
    MatchResult() : candidate_index(-1), volume(0.0),
                   is_fully_wrapped(false),
                   match_score(0.0),
                   wrapping_ratio(0.0), percentile96_clearance(0.0), optimal_translation(0.0),
                   optimal_rotation_angle_deg(0.0), optimal_vertical_offset(0.0),
                   optimal_lateral_offset(0.0),
                   optimal_pitch_deg(0.0), optimal_yaw_deg(0.0),
                   meets_direction_constraints(false) {}
};

class MeshMatcher {
public:
    MeshMatcher();
    ~MeshMatcher();

    /// @brief 加载目标鞋模网格（从 numpy 平铺数组）
    bool loadTargetMesh(const std::vector<double>& vertices,
                       const std::vector<int>& faces);
    /// @brief 加载候选粗胚网格（从 numpy 平铺数组）
    bool loadCandidateMesh(const std::vector<double>& vertices,
                          const std::vector<int>& faces);

    /// @brief 设置是否输出详细日志
    void setVerbose(bool verbose);

    /// @brief 执行完整的优化匹配流水线（对齐→GA优化→包裹率→评分）
    /// @param skip_align_directions 若为 true，则跳过内部的 PCA 方向对齐
    ///        （假设 target 已在外部被预对齐，例如通过 Python 端的 ICP 多起点）
    MatchResult matchOptimized(double wrapping_threshold = 1.0,
                              const GeneticAlgorithmParams& ga_params = GeneticAlgorithmParams(),
                              bool skip_align_directions = false);

    /// @brief 用有符号体积公式计算网格体积（mm³）
    static double computeVolume(const std::vector<double>& vertices,
                               const std::vector<int>& faces);

    /// @brief 计算面积加权平均法线方向
    static Eigen::Vector3d computePrincipalNormal(const std::vector<double>& vertices,
                                                  const std::vector<int>& faces);

    /// @brief 用 PCA 第一主成分计算纵向轴（鞋跟→鞋头）
    static Eigen::Vector3d computeLongitudinalAxis(const std::vector<double>& vertices,
                                                   const std::vector<int>& faces);
    /// @brief 用主法线方向推断垂直轴（脚面→脚底）
    static Eigen::Vector3d computeVerticalAxis(const std::vector<double>& vertices,
                                               const std::vector<int>& faces);

    /// @brief 记录对齐后的方向角度信息（仅用于日志，不做校验）
    DirectionAlignment verifyDirectionAlignment(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces);

    /// @brief 旋转鞋模使其坐标系与粗胚对齐，返回旋转矩阵
    Eigen::Matrix3d alignDirections(
        std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces);

    /// @brief 对已加载的 candidate mesh，批量计算一组外部点到该 mesh 的 signed distance
    ///
    /// 供 Python 端做 containment-refine 优化器使用（scipy L-BFGS-B 直接以 signed
    /// distance 作为代价）。返回 N 维 signed distance 向量：
    ///   d < 0 → 点在 candidate 内部；d > 0 → 点在 candidate 外部。
    ///
    /// 基于 BVH：精确最近距离 + 3 正交射线多数投票（与最终指标同一路径）。
    /// OpenMP 并行，每点约 50μs–200μs 视 mesh 规模而定。
    std::vector<double> computeSignedDistanceBatch(const std::vector<double>& points_flat);

    /// @brief 遗传算法全局优化 SE(3) 刚体变换
    ///
    /// 6-DOF 模式（当 params.pitch_range / yaw_range / vertical_range > 0 时启用）：
    /// 决策变量 = (Δtx_long, Δt_vert, Δtx_lat, Δr_long, Δr_pitch, Δr_yaw)
    /// 搜索的是相对于当前 target 坐标系的 **增量**刚体变换。
    ///
    /// 3-DOF 兼容模式（默认，pitch_range=yaw_range=vertical_range=0）：
    /// 行为与原 3-DOF GA 完全一致（纵向 + 绕纵向旋转 + 横向），返回值也兼容。
    ///
    /// @return 最优 6-DOF 姿态（3-DOF 模式下 vertical/pitch/yaw 为 0）
    OptimalPose optimizePositionAndRotationGA(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces,
        const Eigen::Vector3d& longitudinal_axis,
        const Eigen::Vector3d& vertical_axis,
        const GeneticAlgorithmParams& params = GeneticAlgorithmParams());

private:
    /// @brief 从平铺顶点和面数组中取出第 face_idx 个三角形的三个顶点
    static bool getTriangleVertices(const std::vector<double>& vertices,
                                    const std::vector<int>& faces,
                                    size_t face_idx,
                                    Eigen::Vector3d& v0,
                                    Eigen::Vector3d& v1,
                                    Eigen::Vector3d& v2);

    /// @brief 计算平铺顶点数组的几何质心
    static Eigen::Vector3d computeCentroid(const std::vector<double>& vertices);

    /// @brief 按表面积均匀采样固定数量的点（确定性：固定 RNG 种子）
    ///
    /// 之前按"顶点数组步长"采样：三角化密度不均匀的网格（如局部修补被
    /// 重新致密化的扫描件，tc5 target 面密度是同族 CAD 件的 ~6 倍）会让
    /// 密集区域被系统性超权，包裹率读数偏离真实的"表面包含比例"（实测
    /// tc5 偏差约 -1.3pp）。面积均匀采样是该量的正确估计器。
    /// faces 为空时回退到顶点步长采样（兼容仅点云的调用）。
    static std::vector<Eigen::Vector3d> collectSamplePoints(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        size_t max_samples);

    /// @brief 对 target 表面均匀采样 num_samples 点，返回每点到 candidate BVH
    ///        的 signed distance（OpenMP 并行；负=内部，正=外部）
    static std::vector<double> computeSampleSignedDistances(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const BVHTree& candidate_bvh,
        size_t num_samples);

    std::vector<double> target_vertices_;
    std::vector<int> target_faces_;
    std::vector<double> candidate_vertices_;
    std::vector<int> candidate_faces_;
    bool verbose_;

    // computeSignedDistanceBatch 专用的 BVH 缓存：
    // 由 loadCandidateMesh 置失效，首次 batch 调用时构建。
    std::unique_ptr<BVHTree> candidate_bvh_cache_;
    bool candidate_bvh_cache_valid_ = false;

    // 实例级互斥：pybind 层在 C++ 计算期间释放 GIL 后，同一实例可能被多个
    // Python 线程并发调用（load* 写网格数据 / batch 惰性建缓存 / matchOptimized
    // 长时间读）。此锁使同一实例上的调用互相串行（不同实例互不影响，
    // 并发匹配请为每任务创建独立实例——desktop-app/matcher.py 均如此）。
    std::mutex state_mutex_;
};

#endif // MATCHER_H
