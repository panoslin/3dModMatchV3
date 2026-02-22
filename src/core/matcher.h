#ifndef MATCHER_H
#define MATCHER_H

#include <vector>
#include <string>
#include <memory>
#include <Eigen/Dense>
#include "kdtree.h"
#include "bvh.h"

struct DirectionAlignment {
    double heel_toe_alignment;      // 鞋跟-鞋头方向对齐分数 [0, 1]
    double vertical_alignment;       // 上下方向对齐分数 [0, 1]
    bool is_valid;                   // 是否满足严格对齐要求
    double heel_toe_angle_deg;       // 鞋跟-鞋头方向角度差（度）
    double vertical_angle_deg;       // 上下方向角度差（度）
    
    DirectionAlignment() : heel_toe_alignment(0.0), vertical_alignment(0.0),
                          is_valid(false), heel_toe_angle_deg(0.0), vertical_angle_deg(0.0) {}
};

// 遗传算法参数
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
    
    // 搜索范围
    double translation_range;    // 纵向位移搜索范围（mm，默认±50）
    double rotation_range;       // 旋转角度搜索范围（弧度，默认±π）
    double lateral_range;        // 横向位移搜索范围（mm，默认±30）
    
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
          translation_range(50.0),
          rotation_range(3.14159265358979323846),  // M_PI
          lateral_range(30.0) {}
};

// 用于“回放”的每代状态（遗传算法）
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

struct MatchResult {
    int candidate_index;
    std::string candidate_path;
    double volume;
    bool is_fully_wrapped;
    double match_score;
    
    // 新增字段
    DirectionAlignment direction_alignment;  // 方向对齐信息
    double wrapping_ratio;                   // 体积包裹率 [0, 1]
    double percentile96_clearance;           // 96%分位数间隙（mm）：鞋模表面点到粗胚内表面的距离的96%分位数（仅统计在粗胚内的点）
    double optimal_translation;               // 最优前后位置平移量（沿纵向轴）
    double optimal_rotation_angle_deg;       // 最优绕纵向轴旋转角度（度）
    double optimal_vertical_offset;          // 最优垂直位移（垂直于纵向轴和横向轴，mm）
    double optimal_lateral_offset;           // 最优横向位移（沿横向轴，mm）
    bool meets_direction_constraints;         // 是否满足方向约束

    // 回放：遗传算法每代状态（只在使用 GA 时填充）
    std::vector<GenerationState> generation_history;
    
    MatchResult() : candidate_index(-1), volume(0.0), 
                   is_fully_wrapped(false),
                   match_score(0.0),
                   wrapping_ratio(0.0), percentile96_clearance(0.0), optimal_translation(0.0),
                   optimal_rotation_angle_deg(0.0), optimal_vertical_offset(0.0),
                   optimal_lateral_offset(0.0),
                   meets_direction_constraints(false) {}
};

class MeshMatcher {
public:
    MeshMatcher();
    ~MeshMatcher();
    
    // 加载网格数据（从numpy数组）
    bool loadTargetMesh(const std::vector<double>& vertices, 
                       const std::vector<int>& faces);
    bool loadCandidateMesh(const std::vector<double>& vertices, 
                          const std::vector<int>& faces);
    
    // 执行优化匹配（基于生产场景）
    // 注意：方向会自动对齐
    // 使用遗传算法（GA）进行优化
    // 注意：penetration_tolerance 参数已废弃（包裹率100%即无穿模）
    MatchResult matchOptimized(double wrapping_threshold = 1.0,
                              const GeneticAlgorithmParams& ga_params = GeneticAlgorithmParams());
    
    // 计算网格体积
    static double computeVolume(const std::vector<double>& vertices,
                               const std::vector<int>& faces);
    
    // 计算主法线方向
    static Eigen::Vector3d computePrincipalNormal(const std::vector<double>& vertices,
                                                  const std::vector<int>& faces);
    
    // 计算主要方向（纵向轴和垂直轴）
    static Eigen::Vector3d computeLongitudinalAxis(const std::vector<double>& vertices,
                                                   const std::vector<int>& faces);
    static Eigen::Vector3d computeVerticalAxis(const std::vector<double>& vertices,
                                               const std::vector<int>& faces);
    
    // 验证方向对齐（用于记录对齐信息）
    // 注意：方向已经通过 alignDirections 自动对齐，此函数仅用于记录对齐信息
    DirectionAlignment verifyDirectionAlignment(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces);
    
    // 对齐方向（旋转鞋模使其与粗胚对齐）
    // 返回旋转矩阵，并修改target_vertices使其与candidate对齐
    Eigen::Matrix3d alignDirections(
        std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces);
    
    // 计算体积包裹率
    double computeWrappingRatio(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces,
        const KDTree* cached_tree = nullptr,
        const std::vector<Eigen::Vector3d>* cached_face_centers = nullptr,
        const std::vector<Eigen::Vector3d>* cached_face_normals = nullptr);
    
    // 计算96%分位数间隙（对于在内部的点，计算它们到表面的距离的96%分位数）
    double computeAverageClearance(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces,
        const KDTree* cached_tree = nullptr,
        const std::vector<Eigen::Vector3d>* cached_face_centers = nullptr,
        const std::vector<Eigen::Vector3d>* cached_face_normals = nullptr);
    
    // 使用遗传算法优化位置和旋转（全局搜索，避免局部最优）
    // 优势：
    // 1. 全局搜索，不易陷入局部最优
    // 2. 不需要计算梯度，适合非平滑目标函数
    // 3. 可以并行评估多个候选解
    double optimizePositionAndRotationGA(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces,
        const Eigen::Vector3d& longitudinal_axis,
        const Eigen::Vector3d& vertical_axis,
        double& optimal_relative_rotation_angle_rad,
        double& optimal_vertical_offset,
        double& optimal_lateral_offset,
        const GeneticAlgorithmParams& params = GeneticAlgorithmParams());
    
private:
    // 使用KD-tree加速的距离计算
    double signedDistanceToMeshWithKDTree(const Eigen::Vector3d& point,
                                         const std::vector<double>& vertices,
                                         const std::vector<int>& faces,
                                         const KDTree& face_centers_tree,
                                         const std::vector<Eigen::Vector3d>& face_centers,
                                         const std::vector<Eigen::Vector3d>& face_normals);
    
    // 构建面的KD-tree（用于加速）
    void buildFaceKDTree(const std::vector<double>& vertices,
                        const std::vector<int>& faces,
                        KDTree& tree,
                        std::vector<Eigen::Vector3d>& face_centers,
                        std::vector<Eigen::Vector3d>& face_normals);
    
    // 内部数据
    std::vector<double> target_vertices_;
    std::vector<int> target_faces_;
    std::vector<double> candidate_vertices_;
    std::vector<int> candidate_faces_;
};

#endif // MATCHER_H
