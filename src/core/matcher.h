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

struct GradientDescentParams {
    double learning_rate_translation;  // 纵向位移学习率
    double learning_rate_rotation;     // 旋转角度学习率（弧度）
    double learning_rate_vertical;     // 垂直位移学习率
    double h_translation;              // 纵向位移梯度计算步长（mm）
    double h_rotation;                 // 旋转角度梯度计算步长（弧度）
    double h_vertical;                 // 垂直位移梯度计算步长（mm）
    int max_iterations;                // 最大迭代次数
    double convergence_threshold;      // 收敛阈值
    size_t num_sample_points;          // 采样点数量
    
    // Adam优化器参数
    bool use_adam;                     // 是否使用Adam优化器
    double beta1;                      // Adam动量衰减率（默认0.9）
    double beta2;                      // Adam二阶矩衰减率（默认0.999）
    double epsilon;                    // Adam数值稳定性参数（默认1e-8）
    
    GradientDescentParams() 
        : learning_rate_translation(0.2),
          learning_rate_rotation(0.05),
          learning_rate_vertical(0.2),
          h_translation(0.1),
          h_rotation(0.01),
          h_vertical(0.1),
          max_iterations(50),
          convergence_threshold(0.001),
          num_sample_points(500),
          use_adam(true),              // 默认使用Adam
          beta1(0.9),
          beta2(0.999),
          epsilon(1e-8) {}
};

// 优化算法类型
enum class OptimizationAlgorithm {
    GRADIENT_DESCENT,  // 梯度下降（当前方法）
    GENETIC_ALGORITHM, // 遗传算法（推荐）
    PARTICLE_SWARM,    // 粒子群优化
    MULTI_START        // 多起点优化
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
    double vertical_range;       // 垂直位移搜索范围（mm，默认±20）
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
          vertical_range(20.0),
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
    double normal_alignment_score;
    bool is_fully_wrapped;
    bool has_penetration;
    double match_score;
    
    // 新增字段
    DirectionAlignment direction_alignment;  // 方向对齐信息
    double wrapping_ratio;                   // 体积包裹率 [0, 1]
    double avg_clearance;                    // 平均间隙（mm）：鞋模表面点到粗胚内表面的平均距离（仅统计在粗胚内的点）
    double optimal_translation;               // 最优前后位置平移量（沿纵向轴）
    double optimal_rotation_angle_deg;       // 最优绕纵向轴旋转角度（度）
    double optimal_vertical_offset;          // 最优垂直位移（垂直于纵向轴和横向轴，mm）
    double optimal_lateral_offset;           // 最优横向位移（沿横向轴，mm）
    bool meets_direction_constraints;         // 是否满足方向约束

    // 回放：遗传算法每代状态（只在使用 GA 时填充）
    std::vector<GenerationState> generation_history;
    
    MatchResult() : candidate_index(-1), volume(0.0), 
                   normal_alignment_score(0.0), is_fully_wrapped(false),
                   has_penetration(true), match_score(0.0),
                   wrapping_ratio(0.0), avg_clearance(0.0), optimal_translation(0.0),
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
    // 注意：方向会自动对齐，不需要 angle_tolerance_deg 参数
    // 默认使用遗传算法（GA）进行优化
    MatchResult matchOptimized(double penetration_tolerance = 0.01,
                              double wrapping_threshold = 1.0,
                              const GradientDescentParams& gd_params = GradientDescentParams(),
                              const GeneticAlgorithmParams& ga_params = GeneticAlgorithmParams(),
                              bool use_genetic_algorithm = true);  // 默认使用GA
    
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
    
    // 验证方向对齐（严格约束）- 保留用于兼容
    DirectionAlignment verifyDirectionAlignment(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces,
        double angle_tolerance_deg = 0.1);
    
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
    
    // 计算平均间隙（对于在内部的点，计算它们到表面的平均距离）
    double computeAverageClearance(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces,
        const KDTree* cached_tree = nullptr,
        const std::vector<Eigen::Vector3d>* cached_face_centers = nullptr,
        const std::vector<Eigen::Vector3d>* cached_face_normals = nullptr);
    
    // 优化位置和旋转（同时优化沿纵向轴平移、绕纵向轴旋转、垂直方向平移）
    // 在纵向轴已对齐的前提下，优化：
    // 1. 沿纵向轴的相对前后位移
    // 2. 绕纵向轴的相对旋转角度（鞋模和粗胚之间的角度差）
    // 3. 垂直于纵向轴和横向轴的上下位移
    // 返回：最优纵向平移量，并通过引用返回最优相对旋转角度（弧度）和最优垂直位移（mm）
    double optimizePositionAndRotation(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces,
        const Eigen::Vector3d& longitudinal_axis,
        double& optimal_relative_rotation_angle_rad,
        double& optimal_vertical_offset,
        const GradientDescentParams& params = GradientDescentParams());
    
    // 使用遗传算法优化位置和旋转（推荐：全局搜索，避免局部最优）
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
    
    // 使用粒子群优化（PSO）优化位置和旋转
    // 优势：收敛速度快，适合连续优化问题
    double optimizePositionAndRotationPSO(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces,
        const Eigen::Vector3d& longitudinal_axis,
        const Eigen::Vector3d& vertical_axis,
        double& optimal_relative_rotation_angle_rad,
        double& optimal_vertical_offset,
        int max_iterations = 30,
        int swarm_size = 30,
        size_t num_sample_points = 500);
    
private:
    // 计算法线对齐分数
    double computeNormalAlignment(const Eigen::Vector3d& target_normal,
                                  const Eigen::Vector3d& candidate_normal);
    
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
