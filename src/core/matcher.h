#ifndef MATCHER_H
#define MATCHER_H

#include <vector>
#include <string>
#include <memory>
#include <tuple>
#include <Eigen/Dense>
#include "kdtree.h"
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

    /// @brief 加载目标鞋模网格（从 numpy 平铺数组）
    bool loadTargetMesh(const std::vector<double>& vertices,
                       const std::vector<int>& faces);
    /// @brief 加载候选粗胚网格（从 numpy 平铺数组）
    bool loadCandidateMesh(const std::vector<double>& vertices,
                          const std::vector<int>& faces);

    /// @brief 设置是否输出详细日志
    void setVerbose(bool verbose);

    /// @brief 执行完整的优化匹配流水线（对齐→GA优化→包裹率→评分）
    MatchResult matchOptimized(double wrapping_threshold = 1.0,
                              const GeneticAlgorithmParams& ga_params = GeneticAlgorithmParams());

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

    /// @brief 计算鞋模在粗胚内的体积包裹率 [0,1]
    double computeWrappingRatio(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces,
        const KDTree* cached_tree = nullptr,
        const std::vector<Eigen::Vector3d>* cached_face_centers = nullptr,
        const std::vector<Eigen::Vector3d>* cached_face_normals = nullptr);

    /// @brief 计算在粗胚内的鞋模采样点到粗胚表面距离的96%分位数（mm）
    double computeAverageClearance(
        const std::vector<double>& target_vertices,
        const std::vector<int>& target_faces,
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces,
        const KDTree* cached_tree = nullptr,
        const std::vector<Eigen::Vector3d>* cached_face_centers = nullptr,
        const std::vector<Eigen::Vector3d>* cached_face_normals = nullptr);

    /// @brief 遗传算法全局优化纵向位移、旋转角度、横向位移
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
    /// @brief 用 KD-tree 加速的符号距离：负=在网格内，正=在网格外
    double signedDistanceToMeshWithKDTree(const Eigen::Vector3d& point,
                                         const std::vector<double>& vertices,
                                         const std::vector<int>& faces,
                                         const KDTree& face_centers_tree,
                                         const std::vector<Eigen::Vector3d>& face_centers,
                                         const std::vector<Eigen::Vector3d>& face_normals);

    /// @brief 构建面中心 KD-tree（加速最近面查询）
    void buildFaceKDTree(const std::vector<double>& vertices,
                        const std::vector<int>& faces,
                        KDTree& tree,
                        std::vector<Eigen::Vector3d>& face_centers,
                        std::vector<Eigen::Vector3d>& face_normals);

    /// @brief 从平铺顶点和面数组中取出第 face_idx 个三角形的三个顶点
    static bool getTriangleVertices(const std::vector<double>& vertices,
                                    const std::vector<int>& faces,
                                    size_t face_idx,
                                    Eigen::Vector3d& v0,
                                    Eigen::Vector3d& v1,
                                    Eigen::Vector3d& v2);

    /// @brief 计算平铺顶点数组的几何质心
    static Eigen::Vector3d computeCentroid(const std::vector<double>& vertices);

    /// @brief 从目标顶点中均匀采样固定数量的点
    static std::vector<Eigen::Vector3d> collectSamplePoints(
        const std::vector<double>& target_vertices,
        size_t max_samples);

    /// @brief 若提供缓存则返回缓存指针，否则就地构建 KD-tree 并返回指针
    struct KDTreeCache {
        const KDTree* tree;
        const std::vector<Eigen::Vector3d>* face_centers;
        const std::vector<Eigen::Vector3d>* face_normals;
    };
    KDTreeCache resolveKDTreeCache(
        const std::vector<double>& candidate_vertices,
        const std::vector<int>& candidate_faces,
        const KDTree* cached_tree,
        const std::vector<Eigen::Vector3d>* cached_face_centers,
        const std::vector<Eigen::Vector3d>* cached_face_normals,
        KDTree& local_tree,
        std::vector<Eigen::Vector3d>& local_face_centers,
        std::vector<Eigen::Vector3d>& local_face_normals);

    std::vector<double> target_vertices_;
    std::vector<int> target_faces_;
    std::vector<double> candidate_vertices_;
    std::vector<int> candidate_faces_;
    bool verbose_;
};

#endif // MATCHER_H
