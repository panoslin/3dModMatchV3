#ifndef MATCHER_H
#define MATCHER_H

#include <vector>
#include <string>
#include <memory>
#include <Eigen/Dense>
#include "kdtree.h"

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
    
    GradientDescentParams() 
        : learning_rate_translation(0.2),
          learning_rate_rotation(0.05),
          learning_rate_vertical(0.2),
          h_translation(0.1),
          h_rotation(0.01),
          h_vertical(0.1),
          max_iterations(50),
          convergence_threshold(0.001),
          num_sample_points(500) {}
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
    double optimal_translation;               // 最优前后位置平移量（沿纵向轴）
    double optimal_rotation_angle_deg;       // 最优绕纵向轴旋转角度（度）
    double optimal_vertical_offset;          // 最优垂直位移（垂直于纵向轴和横向轴，mm）
    bool meets_direction_constraints;         // 是否满足方向约束
    
    MatchResult() : candidate_index(-1), volume(0.0), 
                   normal_alignment_score(0.0), is_fully_wrapped(false),
                   has_penetration(true), match_score(0.0),
                   wrapping_ratio(0.0), optimal_translation(0.0),
                   optimal_rotation_angle_deg(0.0), optimal_vertical_offset(0.0),
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
    MatchResult matchOptimized(double penetration_tolerance = 0.01,
                              double wrapping_threshold = 1.0,
                              const GradientDescentParams& gd_params = GradientDescentParams());
    
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
