#include "matcher.h"
#define _USE_MATH_DEFINES
#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>
#include <iostream>
#include <iomanip>
#include <chrono>
#include <random>
#include <cstdlib>
#include <thread>
#ifdef _OPENMP
#include <omp.h>
#endif

// GA 回放：保存最近一次 GA 的每代历史（线程本地，避免并发互相覆盖）
static thread_local std::vector<GenerationState> g_last_ga_generation_history;

// 日志输出宏：只在 verbose_ 为 true 时输出
#define LOG_IF_VERBOSE(msg) do { if (verbose_) { std::cerr << msg; } } while(0)

MeshMatcher::MeshMatcher() : verbose_(false) {
}

void MeshMatcher::setVerbose(bool verbose) {
    verbose_ = verbose;
}

MeshMatcher::~MeshMatcher() {
}

bool MeshMatcher::loadTargetMesh(const std::vector<double>& vertices,
                                 const std::vector<int>& faces) {
    if (vertices.size() % 3 != 0 || faces.size() % 3 != 0) {
        return false;
    }
    std::lock_guard<std::mutex> lock(state_mutex_);
    target_vertices_ = vertices;
    target_faces_ = faces;
    return true;
}

bool MeshMatcher::loadCandidateMesh(const std::vector<double>& vertices,
                                   const std::vector<int>& faces) {
    if (vertices.size() % 3 != 0 || faces.size() % 3 != 0) {
        return false;
    }
    std::lock_guard<std::mutex> lock(state_mutex_);
    candidate_vertices_ = vertices;
    candidate_faces_ = faces;
    candidate_bvh_cache_valid_ = false;  // 失效缓存
    return true;
}

// ---------------------------------------------------------------------------
// 共享辅助函数
// ---------------------------------------------------------------------------

bool MeshMatcher::getTriangleVertices(const std::vector<double>& vertices,
                                       const std::vector<int>& faces,
                                       size_t face_idx,
                                       Eigen::Vector3d& v0,
                                       Eigen::Vector3d& v1,
                                       Eigen::Vector3d& v2) {
    size_t base = face_idx * 3;
    if (base + 2 >= faces.size()) return false;
    int idx0 = faces[base] * 3;
    int idx1 = faces[base + 1] * 3;
    int idx2 = faces[base + 2] * 3;
    if (idx0 + 2 >= static_cast<int>(vertices.size()) ||
        idx1 + 2 >= static_cast<int>(vertices.size()) ||
        idx2 + 2 >= static_cast<int>(vertices.size())) {
        return false;
    }
    v0 = Eigen::Vector3d(vertices[idx0], vertices[idx0 + 1], vertices[idx0 + 2]);
    v1 = Eigen::Vector3d(vertices[idx1], vertices[idx1 + 1], vertices[idx1 + 2]);
    v2 = Eigen::Vector3d(vertices[idx2], vertices[idx2 + 1], vertices[idx2 + 2]);
    return true;
}

Eigen::Vector3d MeshMatcher::computeCentroid(const std::vector<double>& vertices) {
    Eigen::Vector3d center(0, 0, 0);
    size_t count = vertices.size() / 3;
    if (count == 0) return center;
    for (size_t i = 0; i < vertices.size(); i += 3) {
        center += Eigen::Vector3d(vertices[i], vertices[i + 1], vertices[i + 2]);
    }
    return center / static_cast<double>(count);
}

std::vector<Eigen::Vector3d> MeshMatcher::collectSamplePoints(
    const std::vector<double>& target_vertices,
    const std::vector<int>& target_faces,
    size_t max_samples) {
    std::vector<Eigen::Vector3d> points;
    if (max_samples == 0 || target_vertices.size() < 3) return points;

    // 回退路径：无面数据时按顶点步长采样（历史行为）
    if (target_faces.size() < 3) {
        size_t num_vertices = target_vertices.size() / 3;
        size_t num_to_check = std::min(max_samples, num_vertices);
        if (num_to_check == 0) num_to_check = 1;
        size_t step = num_vertices / num_to_check;
        if (step == 0) step = 1;
        points.reserve(num_to_check);
        for (size_t i = 0; i < target_vertices.size() && points.size() < num_to_check; i += 3 * step) {
            points.emplace_back(target_vertices[i], target_vertices[i + 1], target_vertices[i + 2]);
        }
        return points;
    }

    // 面积加权采样：累计面积 + 二分查找选面，重心坐标均匀取点。
    // 固定种子保证确定性（同网格同采样，与 GA 固定种子同一原则）。
    size_t num_faces = target_faces.size() / 3;
    std::vector<double> cum_area;
    cum_area.reserve(num_faces);
    std::vector<size_t> face_ids;
    face_ids.reserve(num_faces);
    double total = 0.0;
    for (size_t fi = 0; fi < num_faces; ++fi) {
        Eigen::Vector3d v0, v1, v2;
        if (!getTriangleVertices(target_vertices, target_faces, fi, v0, v1, v2)) continue;
        double a = 0.5 * (v1 - v0).cross(v2 - v0).norm();
        if (a < 1e-12) continue;  // 退化面不参与采样
        total += a;
        cum_area.push_back(total);
        face_ids.push_back(fi);
    }
    if (cum_area.empty() || total <= 0.0) return points;

    std::mt19937 rng(0xA5EED123u);
    std::uniform_real_distribution<double> uni(0.0, 1.0);
    points.reserve(max_samples);
    for (size_t i = 0; i < max_samples; ++i) {
        double r = uni(rng) * total;
        size_t k = std::lower_bound(cum_area.begin(), cum_area.end(), r) - cum_area.begin();
        if (k >= face_ids.size()) k = face_ids.size() - 1;
        Eigen::Vector3d v0, v1, v2;
        if (!getTriangleVertices(target_vertices, target_faces, face_ids[k], v0, v1, v2)) continue;
        double u = uni(rng), v = uni(rng);
        if (u + v > 1.0) { u = 1.0 - u; v = 1.0 - v; }  // 折叠到三角形内，保持均匀
        points.emplace_back(v0 + u * (v1 - v0) + v * (v2 - v0));
    }
    return points;
}

// 最终指标的采样数下限：500 采样在 96% 附近的读数标准差约 0.9pp，
// 足以造成阈值边界误判；5000 采样将其压到约 0.28pp（BVH 下每点 ~0.1ms，
// 额外成本 <0.5s/候选）。GA 适应度不受此下限影响（由 num_sample_points 控制）。
static constexpr size_t FINAL_METRIC_MIN_SAMPLES = 5000;

std::vector<double> MeshMatcher::computeSampleSignedDistances(
    const std::vector<double>& target_vertices,
    const std::vector<int>& target_faces,
    const BVHTree& candidate_bvh,
    size_t num_samples) {
    auto points = collectSamplePoints(target_vertices, target_faces, num_samples);
    std::vector<double> distances(points.size(), 0.0);
    #ifdef _OPENMP
    #pragma omp parallel for
    #endif
    for (int i = 0; i < static_cast<int>(points.size()); ++i) {
        distances[i] = candidate_bvh.signedDistance(points[i]);
    }
    return distances;
}

double MeshMatcher::computeVolume(const std::vector<double>& vertices,
                                  const std::vector<int>& faces) {
    if (vertices.size() < 9 || faces.size() < 3) {
        return 0.0;
    }

    Eigen::Vector3d origin = computeCentroid(vertices);
    double volume = 0.0;
    size_t num_faces = faces.size() / 3;
    for (size_t fi = 0; fi < num_faces; ++fi) {
        Eigen::Vector3d v0, v1, v2;
        if (!getTriangleVertices(vertices, faces, fi, v0, v1, v2)) continue;
        v0 -= origin;
        v1 -= origin;
        v2 -= origin;
        volume += std::abs(v0.dot(v1.cross(v2)) / 6.0);
    }
    return volume;
}

Eigen::Vector3d MeshMatcher::computePrincipalNormal(const std::vector<double>& vertices,
                                                    const std::vector<int>& faces) {
    if (faces.size() < 3) {
        return Eigen::Vector3d(0, 0, 1);
    }

    Eigen::Vector3d normal_sum(0, 0, 0);
    int valid_count = 0;
    size_t num_faces = faces.size() / 3;
    for (size_t fi = 0; fi < num_faces; ++fi) {
        Eigen::Vector3d v0, v1, v2;
        if (!getTriangleVertices(vertices, faces, fi, v0, v1, v2)) continue;
        Eigen::Vector3d normal = (v1 - v0).cross(v2 - v0);
        double norm = normal.norm();
        if (norm > 1e-9) {
            normal_sum += normal / norm;
            valid_count++;
        }
    }

    if (valid_count > 0) {
        normal_sum /= valid_count;
        double norm = normal_sum.norm();
        if (norm > 1e-9) return normal_sum / norm;
    }
    return Eigen::Vector3d(0, 0, 1);
}




Eigen::Vector3d MeshMatcher::computeLongitudinalAxis(const std::vector<double>& vertices,
                                                     const std::vector<int>& faces) {
    if (vertices.size() < 9) {
        return Eigen::Vector3d(1, 0, 0);
    }

    size_t num_vertices = vertices.size() / 3;
    Eigen::Vector3d centroid = computeCentroid(vertices);

    // 构建协方差矩阵
    Eigen::Matrix3d covariance = Eigen::Matrix3d::Zero();
    for (size_t i = 0; i < vertices.size(); i += 3) {
        Eigen::Vector3d v(vertices[i], vertices[i+1], vertices[i+2]);
        v -= centroid;
        covariance += v * v.transpose();
    }
    covariance /= num_vertices;
    
    // 3. 特征值分解
    Eigen::SelfAdjointEigenSolver<Eigen::Matrix3d> solver(covariance);
    if (solver.info() != Eigen::Success) {
        // 如果分解失败，回退到边界框方法
        Eigen::Vector3d min_coords(std::numeric_limits<double>::max(),
                                   std::numeric_limits<double>::max(),
                                   std::numeric_limits<double>::max());
        Eigen::Vector3d max_coords(std::numeric_limits<double>::lowest(),
                                   std::numeric_limits<double>::lowest(),
                                   std::numeric_limits<double>::lowest());
        for (size_t i = 0; i < vertices.size(); i += 3) {
            Eigen::Vector3d v(vertices[i], vertices[i+1], vertices[i+2]);
            min_coords = min_coords.cwiseMin(v);
            max_coords = max_coords.cwiseMax(v);
        }
        return (max_coords - min_coords).normalized();
    }
    
    Eigen::Vector3d eigenvalues = solver.eigenvalues();
    Eigen::Matrix3d eigenvectors = solver.eigenvectors();
    
    // 4. 选择最大特征值对应的特征向量（第一主成分）
    int max_idx = 0;
    for (int i = 1; i < 3; ++i) {
        if (eigenvalues[i] > eigenvalues[max_idx]) {
            max_idx = i;
        }
    }
    
    Eigen::Vector3d principal_axis = eigenvectors.col(max_idx).normalized();
    
    // 确保方向一致性（选择指向正方向的分量最大的方向）
    if (principal_axis[0] < 0 || (principal_axis[0] == 0 && principal_axis[1] < 0) ||
        (principal_axis[0] == 0 && principal_axis[1] == 0 && principal_axis[2] < 0)) {
        principal_axis = -principal_axis;
    }
    
    return principal_axis;
}

Eigen::Vector3d MeshMatcher::computeVerticalAxis(const std::vector<double>& vertices,
                                                 const std::vector<int>& faces) {
    // 垂直轴通常是Z轴（上下方向）
    // 可以通过主法线的垂直分量来确定
    Eigen::Vector3d principal_normal = computePrincipalNormal(vertices, faces);
    
    // 如果主法线接近垂直，使用它；否则使用Z轴
    if (std::abs(principal_normal[2]) > 0.7) {
        // 确保方向向上
        if (principal_normal[2] < 0) {
            principal_normal = -principal_normal;
        }
        return principal_normal;
    }
    
    // 默认使用Z轴向上
    return Eigen::Vector3d(0, 0, 1);
}

Eigen::Matrix3d MeshMatcher::alignDirections(
    std::vector<double>& target_vertices,
    const std::vector<int>& target_faces,
    const std::vector<double>& candidate_vertices,
    const std::vector<int>& candidate_faces) {
    
    LOG_IF_VERBOSE( "[LOG] alignDirections: 开始计算方向轴..." << std::endl);
    auto t0 = std::chrono::high_resolution_clock::now();
    
    // 计算鞋模和粗胚的纵向轴和垂直轴
    Eigen::Vector3d target_longitudinal = computeLongitudinalAxis(target_vertices, target_faces);
    auto t1 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "[LOG] alignDirections: 计算目标纵向轴耗时: " 
              << std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count() << "ms" << std::endl);
    
    t0 = std::chrono::high_resolution_clock::now();
    Eigen::Vector3d target_vertical = computeVerticalAxis(target_vertices, target_faces);
    t1 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "[LOG] alignDirections: 计算目标垂直轴耗时: " 
              << std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count() << "ms" << std::endl);
    
    t0 = std::chrono::high_resolution_clock::now();
    Eigen::Vector3d candidate_longitudinal = computeLongitudinalAxis(candidate_vertices, candidate_faces);
    t1 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "[LOG] alignDirections: 计算候选纵向轴耗时: " 
              << std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count() << "ms" << std::endl);
    
    t0 = std::chrono::high_resolution_clock::now();
    Eigen::Vector3d candidate_vertical = computeVerticalAxis(candidate_vertices, candidate_faces);
    t1 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "[LOG] alignDirections: 计算候选垂直轴耗时: " 
              << std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count() << "ms" << std::endl);
    
    // 构建目标坐标系（鞋模）
    Eigen::Matrix3d target_frame;
    target_frame.col(0) = target_longitudinal;
    // 第二个轴：纵向轴和垂直轴的叉积（侧向）
    Eigen::Vector3d target_side = target_longitudinal.cross(target_vertical);
    if (target_side.norm() < 1e-6) {
        // 如果纵向和垂直平行，使用默认侧向
        if (std::abs(target_longitudinal[0]) < 0.9) {
            target_side = target_longitudinal.cross(Eigen::Vector3d(1, 0, 0));
        } else {
            target_side = target_longitudinal.cross(Eigen::Vector3d(0, 1, 0));
        }
    }
    target_frame.col(1) = target_side.normalized();
    // 第三个轴：重新计算垂直轴以确保正交
    target_frame.col(2) = target_frame.col(0).cross(target_frame.col(1)).normalized();
    
    // 构建候选坐标系（粗胚）
    Eigen::Matrix3d candidate_frame;
    candidate_frame.col(0) = candidate_longitudinal;
    Eigen::Vector3d candidate_side = candidate_longitudinal.cross(candidate_vertical);
    if (candidate_side.norm() < 1e-6) {
        if (std::abs(candidate_longitudinal[0]) < 0.9) {
            candidate_side = candidate_longitudinal.cross(Eigen::Vector3d(1, 0, 0));
        } else {
            candidate_side = candidate_longitudinal.cross(Eigen::Vector3d(0, 1, 0));
        }
    }
    candidate_frame.col(1) = candidate_side.normalized();
    candidate_frame.col(2) = candidate_frame.col(0).cross(candidate_frame.col(1)).normalized();
    
    // 计算旋转矩阵：将目标坐标系旋转到候选坐标系
    // R * target_frame = candidate_frame
    // R = candidate_frame * target_frame^T
    Eigen::Matrix3d rotation_matrix = candidate_frame * target_frame.transpose();
    
    Eigen::Vector3d target_center = computeCentroid(target_vertices);

    // 应用旋转矩阵到所有顶点
    t0 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "[LOG] alignDirections: 开始旋转 " << (target_vertices.size() / 3) << " 个顶点..." << std::endl);
    for (size_t i = 0; i < target_vertices.size(); i += 3) {
        Eigen::Vector3d v(target_vertices[i], target_vertices[i+1], target_vertices[i+2]);
        v -= target_center;  // 平移到原点
        v = rotation_matrix * v;  // 旋转
        v += target_center;  // 平移回去
        target_vertices[i] = v[0];
        target_vertices[i+1] = v[1];
        target_vertices[i+2] = v[2];
    }
    t1 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "[LOG] alignDirections: 旋转顶点耗时: " 
              << std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count() << "ms" << std::endl);
    
    return rotation_matrix;
}

DirectionAlignment MeshMatcher::verifyDirectionAlignment(
    const std::vector<double>& target_vertices,
    const std::vector<int>& target_faces,
    const std::vector<double>& candidate_vertices,
    const std::vector<int>& candidate_faces) {
    
    DirectionAlignment alignment;
    
    // 计算纵向轴（鞋跟-鞋头方向）
    Eigen::Vector3d target_longitudinal = computeLongitudinalAxis(target_vertices, target_faces);
    Eigen::Vector3d candidate_longitudinal = computeLongitudinalAxis(candidate_vertices, candidate_faces);
    
    // 计算垂直轴（上下方向）
    Eigen::Vector3d target_vertical = computeVerticalAxis(target_vertices, target_faces);
    Eigen::Vector3d candidate_vertical = computeVerticalAxis(candidate_vertices, candidate_faces);
    
    // 计算鞋跟-鞋头方向对齐
    double heel_toe_dot = target_longitudinal.dot(candidate_longitudinal);
    // 允许方向相反（取绝对值）
    heel_toe_dot = std::abs(heel_toe_dot);
    alignment.heel_toe_alignment = heel_toe_dot;
    alignment.heel_toe_angle_deg = std::acos(std::clamp(heel_toe_dot, -1.0, 1.0)) * 180.0 / M_PI;
    
    // 计算上下方向对齐（必须同向，不能颠倒）
    double vertical_dot = target_vertical.dot(candidate_vertical);
    // 不允许方向相反，如果点积为负，说明上下颠倒
    if (vertical_dot < 0) {
        alignment.vertical_alignment = 0.0;
        alignment.vertical_angle_deg = 180.0 - std::acos(std::abs(vertical_dot)) * 180.0 / M_PI;
    } else {
        alignment.vertical_alignment = vertical_dot;
        alignment.vertical_angle_deg = std::acos(std::clamp(vertical_dot, -1.0, 1.0)) * 180.0 / M_PI;
    }
    
    // 注意：方向已经通过 alignDirections 自动对齐，所以总是满足约束
    // 这里只记录对齐信息，不进行验证
    alignment.is_valid = true;  // 已经自动对齐，所以总是有效
    
    return alignment;
}


std::vector<double> MeshMatcher::computeSignedDistanceBatch(const std::vector<double>& points_flat) {
    // 实例级串行：与 load* / matchOptimized 互斥（GIL 已在 pybind 层释放）
    std::lock_guard<std::mutex> lock(state_mutex_);
    std::vector<double> distances;
    if (points_flat.size() < 3 || points_flat.size() % 3 != 0 ||
        candidate_vertices_.empty() || candidate_faces_.empty()) {
        return distances;
    }
    const size_t n_points = points_flat.size() / 3;
    distances.assign(n_points, 0.0);

    // 用 BVH：isPointInside（3 射线多数投票）+ signedDistance（BVH 最近点）
    // 为了让 Python containment-refine 的 1000+ 次 batch 调用性能可接受，
    // 这里对 candidate BVH 做缓存；loadCandidateMesh 时失效。
    if (!candidate_bvh_cache_valid_ || !candidate_bvh_cache_) {
        candidate_bvh_cache_.reset(new BVHTree());
        candidate_bvh_cache_->build(candidate_vertices_, candidate_faces_);
        candidate_bvh_cache_valid_ = true;
    }
    const BVHTree& bvh = *candidate_bvh_cache_;

    #ifdef _OPENMP
    #pragma omp parallel for
    #endif
    for (int i = 0; i < static_cast<int>(n_points); ++i) {
        Eigen::Vector3d p(points_flat[3*i], points_flat[3*i+1], points_flat[3*i+2]);
        distances[i] = bvh.signedDistance(p);
    }
    return distances;
}



/// @brief 用 Rodrigues 公式计算绕任意轴的旋转矩阵
static Eigen::Matrix3d computeRotationMatrixAroundAxis(const Eigen::Vector3d& axis, double angle_rad) {
    Eigen::Vector3d normalized_axis = axis.normalized();
    double cos_a = std::cos(angle_rad);
    double sin_a = std::sin(angle_rad);
    
    Eigen::Matrix3d K;
    K << 0, -normalized_axis[2], normalized_axis[1],
         normalized_axis[2], 0, -normalized_axis[0],
         -normalized_axis[1], normalized_axis[0], 0;
    
    Eigen::Matrix3d R = Eigen::Matrix3d::Identity() + sin_a * K + (1 - cos_a) * K * K;
    return R;
}

/// @brief 横向轴 = 纵向 × 垂直；两轴接近平行时回退（与 alignDirections 同策略）
///
/// 6-DOF 模式下该轴还是 pitch 的旋转轴，退化会污染全部姿态候选，必须防护。
static Eigen::Vector3d computeLateralAxis(const Eigen::Vector3d& longitudinal,
                                          const Eigen::Vector3d& vertical) {
    Eigen::Vector3d lateral = longitudinal.cross(vertical);
    if (lateral.norm() < 1e-6) {
        lateral = (std::abs(longitudinal[0]) < 0.9)
            ? longitudinal.cross(Eigen::Vector3d(1, 0, 0))
            : longitudinal.cross(Eigen::Vector3d(0, 1, 0));
    }
    return lateral.normalized();
}

/// @brief GA 个体：完整 6-DOF SE(3) 参数化
///
/// 设计说明：
///   - translation / rotation / lateral：与历史 3-DOF 等价（legacy 字段）
///   - vertical_offset：沿垂直轴的位移，3-DOF 模式下固定 0
///   - pitch / yaw：绕横向轴 / 垂直轴的旋转（弧度），3-DOF 模式下固定 0
///
/// 旋转组合顺序（右乘）：R = R_yaw(垂直轴) · R_pitch(横向轴) · R_roll(纵向轴)
/// 这保证 roll（沿脚长方向的旋转）是最内层，与前端/业务直观一致。
struct Individual {
    double translation;      // 纵向位移（沿 longitudinal_axis，mm）
    double rotation;         // 绕纵向轴旋转（弧度，legacy "roll"）
    double lateral;          // 横向位移（沿 lateral_axis，mm）
    double vertical_offset;  // 垂直位移（沿 vertical_axis，mm，6-DOF 扩展）
    double pitch;            // 绕横向轴旋转（弧度，6-DOF 扩展）
    double yaw;              // 绕垂直轴旋转（弧度，6-DOF 扩展）
    double fitness;          // 适应度（包裹率，越高越好）

    Individual() : translation(0.0), rotation(0.0), lateral(0.0),
                   vertical_offset(0.0), pitch(0.0), yaw(0.0), fitness(0.0) {}
    Individual(double t, double r, double l)
        : translation(t), rotation(r), lateral(l),
          vertical_offset(0.0), pitch(0.0), yaw(0.0), fitness(0.0) {}
};

OptimalPose MeshMatcher::optimizePositionAndRotationGA(
    const std::vector<double>& target_vertices,
    const std::vector<int>& target_faces,
    const std::vector<double>& candidate_vertices,
    const std::vector<int>& candidate_faces,
    const Eigen::Vector3d& longitudinal_axis,
    const Eigen::Vector3d& vertical_axis,
    const GeneticAlgorithmParams& params) {
    
    // 设置 OpenMP 默认线程数为 CPU 核心数 * 2（利用超线程）
    // 注意：如果用户通过环境变量 OMP_NUM_THREADS 设置了线程数，则优先使用环境变量的值
    #ifdef _OPENMP
    {
        // 检查是否已通过环境变量设置线程数
        const char* env_threads = std::getenv("OMP_NUM_THREADS");
        if (env_threads == nullptr) {
            // 未设置环境变量，使用默认值：核心数 * 2
            unsigned int num_cores = std::thread::hardware_concurrency();
            if (num_cores > 0) {
                int num_threads = static_cast<int>(num_cores * 2);
                omp_set_num_threads(num_threads);
                LOG_IF_VERBOSE("[GA] 设置 OpenMP 线程数: " << num_threads 
                          << " (CPU 核心数: " << num_cores << " × 2，利用超线程)" << std::endl);
            } else {
                // 如果无法检测核心数，使用默认值（通常是 8）
                int num_threads = 8;
                omp_set_num_threads(num_threads);
                LOG_IF_VERBOSE("[GA] 无法检测 CPU 核心数，设置 OpenMP 线程数为默认值: " << num_threads << std::endl);
            }
        } else {
            // 已通过环境变量设置，使用环境变量的值
            int env_threads_val = std::atoi(env_threads);
            LOG_IF_VERBOSE("[GA] 使用环境变量 OMP_NUM_THREADS=" << env_threads_val << " 设置的线程数" << std::endl);
        }
    }
    #endif
    
    // 计算横向轴（纵向轴 × 垂直轴）
    Eigen::Vector3d lateral_axis = computeLateralAxis(longitudinal_axis, vertical_axis);

    // 判断是否启用 6-DOF 模式（任一额外范围 > 0 即启用）
    const bool use_6dof = (params.vertical_range > 1e-9) ||
                         (params.pitch_range > 1e-9) ||
                         (params.yaw_range > 1e-9);

    LOG_IF_VERBOSE("\n" << std::string(70, '=') << std::endl);
    LOG_IF_VERBOSE("[GA] ========== 遗传算法优化开始（"
                   << (use_6dof ? "6-DOF SE(3)" : "3-DOF") << "）==========" << std::endl);
    LOG_IF_VERBOSE("[GA] 参数配置:" << std::endl);
    LOG_IF_VERBOSE("[GA]   种群大小: " << params.population_size << std::endl);
    LOG_IF_VERBOSE("[GA]   最大代数: " << params.max_generations << std::endl);
    LOG_IF_VERBOSE("[GA]   交叉率: " << params.crossover_rate << std::endl);
    LOG_IF_VERBOSE("[GA]   变异率: " << params.mutation_rate << std::endl);
    LOG_IF_VERBOSE("[GA]   选择率: " << params.selection_rate << std::endl);
    LOG_IF_VERBOSE("[GA]   采样点数: " << params.num_sample_points << std::endl);
    LOG_IF_VERBOSE("[GA]   提前终止: " << (params.early_stopping_generations > 0 ?
              std::to_string(params.early_stopping_generations) + "代无改进" : "禁用") << std::endl);
    LOG_IF_VERBOSE("[GA]   搜索范围:" << std::endl);
    LOG_IF_VERBOSE("[GA]     纵向位移: ±" << params.translation_range << "mm" << std::endl);
    LOG_IF_VERBOSE("[GA]     绕纵旋转: ±" << (params.rotation_range * 180.0 / M_PI) << "°" << std::endl);
    LOG_IF_VERBOSE("[GA]     横向位移: ±" << params.lateral_range << "mm" << std::endl);
    if (use_6dof) {
        LOG_IF_VERBOSE("[GA]     垂直位移: ±" << params.vertical_range << "mm (6-DOF)" << std::endl);
        LOG_IF_VERBOSE("[GA]     Pitch  : ±" << (params.pitch_range * 180.0 / M_PI) << "° (6-DOF)" << std::endl);
        LOG_IF_VERBOSE("[GA]     Yaw    : ±" << (params.yaw_range * 180.0 / M_PI) << "° (6-DOF)" << std::endl);
    }
    LOG_IF_VERBOSE("[GA]   方向轴:" << std::endl);
    LOG_IF_VERBOSE("[GA]     纵向轴: (" << longitudinal_axis[0] << ", " 
              << longitudinal_axis[1] << ", " << longitudinal_axis[2] << ")" << std::endl);
    LOG_IF_VERBOSE("[GA]     垂直轴: (" << vertical_axis[0] << ", " 
              << vertical_axis[1] << ", " << vertical_axis[2] << ")" << std::endl);
    LOG_IF_VERBOSE("[GA]     横向轴: (" << lateral_axis[0] << ", " 
              << lateral_axis[1] << ", " << lateral_axis[2] << ")" << std::endl);
    LOG_IF_VERBOSE(std::string(70, '=') << std::endl);
    
    // 计算质心（用于变换）
    Eigen::Vector3d target_center = computeCentroid(target_vertices);
    Eigen::Vector3d candidate_center = computeCentroid(candidate_vertices);

    Eigen::Vector3d center_diff = target_center - candidate_center;
    double initial_translation = center_diff.dot(longitudinal_axis);
    double initial_lateral = center_diff.dot(lateral_axis);

    // 固定采样点
    auto fixed_sample_points = collectSamplePoints(target_vertices, target_faces, params.num_sample_points);
    
    
    // ========== BVH 优化：构建 BVH 树（只构建一次）==========
    auto bvh_build_start = std::chrono::high_resolution_clock::now();
    BVHTree candidate_bvh;
    candidate_bvh.build(candidate_vertices, candidate_faces);
    auto bvh_build_end = std::chrono::high_resolution_clock::now();
    auto bvh_build_time = std::chrono::duration_cast<std::chrono::milliseconds>(
        bvh_build_end - bvh_build_start).count();
    LOG_IF_VERBOSE("[GA] BVH 构建完成，耗时: " << bvh_build_time << "ms" << std::endl);
    
    // 适应度函数：计算包裹率（BVH 加速 + 6-DOF SE(3)）
    //
    // 6-DOF 姿态语义：将 candidate 网格变换为
    //   v' = R · (v - candidate_center) + candidate_center + T
    //   其中 R = R_yaw(vertical_axis, yaw) · R_pitch(lateral_axis, pitch) · R_roll(longitudinal_axis, rotation)
    //         T = longitudinal*translation + lateral*lateral_offset + vertical*vertical_offset
    // 为避免变换整张 candidate 网格，我们反向变换 target 采样点（BVH 查 candidate 是原始坐标）：
    //   sample' = R^T · (sample - T - candidate_center) + candidate_center
    //
    // 3-DOF 兼容性：当 pitch=yaw=vertical_offset=0 时，R 退化为原 computeRotationMatrixAroundAxis(longitudinal, rotation)，
    // T 退化为原 longitudinal*translation + lateral*lateral_offset；数值与历史完全一致。
    auto computeFitness = [&](const Individual& ind) -> double {
        Eigen::Matrix3d R_roll  = computeRotationMatrixAroundAxis(longitudinal_axis, ind.rotation);
        Eigen::Matrix3d R_pitch = computeRotationMatrixAroundAxis(lateral_axis, ind.pitch);
        Eigen::Matrix3d R_yaw   = computeRotationMatrixAroundAxis(vertical_axis, ind.yaw);
        Eigen::Matrix3d rotation = R_yaw * R_pitch * R_roll;
        Eigen::Matrix3d rotation_T = rotation.transpose();  // R 是正交阵，R^-1 = R^T（原代码 .inverse() 是 4x SIMD 浪费）

        Eigen::Vector3d translation = longitudinal_axis * ind.translation
                                     + lateral_axis * ind.lateral
                                     + vertical_axis * ind.vertical_offset;

        int inside_count = 0;
        #ifdef _OPENMP
        #pragma omp parallel for reduction(+:inside_count)
        #endif
        for (int idx = 0; idx < static_cast<int>(fixed_sample_points.size()); ++idx) {
            Eigen::Vector3d sample = fixed_sample_points[idx];
            sample -= translation;
            sample -= candidate_center;
            sample = rotation_T * sample;
            sample += candidate_center;

            if (candidate_bvh.isPointInside(sample)) {
                inside_count++;
            }
        }

        return static_cast<double>(inside_count) / fixed_sample_points.size();
    };
    
    // 随机数生成器：固定种子保证同输入同输出（回归可复现、winner 不随 run 漂移）。
    // 搜索多样性由种群规模与变异保证，不依赖熵源。
    std::mt19937 gen(20260702u);
    std::uniform_real_distribution<double> trans_dist(-params.translation_range, params.translation_range);
    std::uniform_real_distribution<double> rot_dist(-params.rotation_range, params.rotation_range);
    std::uniform_real_distribution<double> lat_dist(-params.lateral_range, params.lateral_range);
    std::uniform_real_distribution<double> prob_dist(0.0, 1.0);
    // 6-DOF 额外维度（若范围为 0 → 永远返回 0，天然退化为 3-DOF）
    const double vert_r  = std::max(0.0, params.vertical_range);
    const double pitch_r = std::max(0.0, params.pitch_range);
    const double yaw_r   = std::max(0.0, params.yaw_range);
    auto draw_sym = [&](double r) -> double {
        if (r <= 0.0) return 0.0;
        std::uniform_real_distribution<double> d(-r, r);
        return d(gen);
    };

    // 1. 初始化种群
    //    - 3-DOF 兼容模式：Individual(translation, rotation, lateral)，6-DOF 字段默认 0
    //    - 6-DOF 模式：额外在 vertical / pitch / yaw 上采样
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
    // 种子个体（精英保留保证 GA 结果永不差于这两个基准姿态）：
    //   种子0（质心对齐）：质心差投影 + 零旋转 —— PCA 路径的自然起点
    //   种子1（恒等变换）：全零 —— 外部预对齐（ICP/containment-refine）后的
    //     当前姿态；修复"refine 已达 0.97 而 GA 随机搜索反而回退"的问题
    if (params.population_size >= 1) {
        population[0] = Individual(initial_translation, 0.0, initial_lateral);
    }
    if (params.population_size >= 2) {
        population[1] = Individual(0.0, 0.0, 0.0);
    }
    
    // 2. 评估初始种群
    auto eval_start = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE("\n[GA] 阶段1: 评估初始种群 (" << params.population_size << " 个个体)..." << std::endl);
    
    auto t_fitness_start = std::chrono::high_resolution_clock::now();
    #ifdef _OPENMP
    #pragma omp parallel for
    #endif
    for (int i = 0; i < static_cast<int>(population.size()); ++i) {
        population[i].fitness = computeFitness(population[i]);
    }
    auto t_fitness_end = std::chrono::high_resolution_clock::now();
    auto t_fitness_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t_fitness_end - t_fitness_start).count();
    
    // 排序（适应度从高到低）
    auto t_sort_start = std::chrono::high_resolution_clock::now();
    std::sort(population.begin(), population.end(), 
              [](const Individual& a, const Individual& b) { return a.fitness > b.fitness; });
    auto t_sort_end = std::chrono::high_resolution_clock::now();
    auto t_sort_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t_sort_end - t_sort_start).count();
    
    auto eval_end = std::chrono::high_resolution_clock::now();
    auto eval_time = std::chrono::duration_cast<std::chrono::milliseconds>(eval_end - eval_start).count();
    
    double best_fitness = population[0].fitness;
    Individual best_individual = population[0];
    double avg_fitness = std::accumulate(population.begin(), population.end(), 0.0,
        [](double sum, const Individual& ind) { return sum + ind.fitness; }) / params.population_size;
    
    LOG_IF_VERBOSE("[GA] ✓ 初始种群评估完成，总耗时: " << eval_time << "ms" << std::endl);
    LOG_IF_VERBOSE("[GA]   性能分析:" << std::endl);
    LOG_IF_VERBOSE("[GA]     - 适应度计算: " << t_fitness_ms << "ms (" << params.population_size 
              << "次, 平均: " << std::fixed << std::setprecision(2) 
              << (t_fitness_ms / static_cast<double>(params.population_size)) << "ms/次)" << std::endl);
    LOG_IF_VERBOSE("[GA]     - 排序: " << t_sort_ms << "ms" << std::endl);
    LOG_IF_VERBOSE("[GA]   最佳适应度: " << std::fixed << std::setprecision(4) << best_fitness 
              << " (包裹率: " << (best_fitness * 100) << "%)" << std::endl);
    LOG_IF_VERBOSE("[GA]   平均适应度: " << avg_fitness 
              << " (包裹率: " << (avg_fitness * 100) << "%)" << std::endl);
    LOG_IF_VERBOSE("[GA]   最佳个体: 纵向=" << std::fixed << std::setprecision(2) 
              << best_individual.translation << "mm, 旋转=" 
              << (best_individual.rotation * 180.0 / M_PI) << "°, 横向=" 
              << best_individual.lateral << "mm" << std::endl);
    
    // 检查初始种群是否已达到目标包裹率
    if (params.target_wrapping_ratio > 0.0 && best_fitness >= params.target_wrapping_ratio) {
        LOG_IF_VERBOSE("\n[GA] ✓ 初始种群已达到目标包裹率 (" << std::fixed << std::setprecision(2) 
                  << (params.target_wrapping_ratio * 100) << "%)，当前包裹率: " 
                  << (best_fitness * 100) << "%，无需继续进化" << std::endl);
        
        // 保存初始状态到历史记录
        std::vector<GenerationState> history;
        double std_dev = 0.0;
        for (const auto& ind : population) {
            double diff = ind.fitness - avg_fitness;
            std_dev += diff * diff;
        }
        std_dev = std::sqrt(std_dev / params.population_size);
        
        GenerationState s;
        s.generation = 0;
        s.best_fitness = best_fitness;
        s.avg_fitness = avg_fitness;
        s.std_dev = std_dev;
        s.translation = best_individual.translation;
        s.rotation_angle_deg = best_individual.rotation * 180.0 / M_PI;
        s.lateral_offset = best_individual.lateral;
        s.crossover_count = 0;
        s.mutation_count = 0;
        s.time_ms = static_cast<double>(eval_time);
        history.push_back(s);
        
        // 保存到线程本地变量（用于回放）
        #ifdef _OPENMP
        #pragma omp critical
        #endif
        {
            g_last_ga_generation_history = history;
        }
        
        return OptimalPose{best_individual.translation, best_individual.rotation,
                           best_individual.lateral, best_individual.vertical_offset,
                           best_individual.pitch, best_individual.yaw};
    }

    // ========= 回放：保存 generation 0（初始种群评估完成）=========
    // 说明：这里不把“每个个体”保存下来，只保存“每代最优解”等统计量，用于前端回放。
    std::vector<GenerationState> history;
    history.reserve(static_cast<size_t>(params.max_generations) + 1);
    {
        // 初始种群的 std_dev
        double std_dev = 0.0;
        for (const auto& ind : population) {
            double diff = ind.fitness - avg_fitness;
            std_dev += diff * diff;
        }
        std_dev = std::sqrt(std_dev / params.population_size);

        GenerationState s;
        s.generation = 0;
        s.best_fitness = best_fitness;
        s.avg_fitness = avg_fitness;
        s.std_dev = std_dev;
        s.translation = best_individual.translation;
        s.rotation_angle_deg = best_individual.rotation * 180.0 / M_PI;
        s.lateral_offset = best_individual.lateral;
        s.crossover_count = 0;
        s.mutation_count = 0;
        s.time_ms = static_cast<double>(eval_time);
        history.push_back(s);
    }
    
    // 3. 进化循环
    LOG_IF_VERBOSE("\n[GA] 阶段2: 开始进化循环..." << std::endl);
    int improvement_count = 0;
    int no_improvement_count = 0;  // 连续未改进的代数
    
    // 性能统计：累计适应度计算时间（包含初始种群）
    long long total_fitness_time_ms = t_fitness_ms;
    long long total_fitness_calls = params.population_size;
    
    for (int generation = 0; generation < params.max_generations; ++generation) {
        auto gen_start = std::chrono::high_resolution_clock::now();
        
        // 选择：保留前selection_rate的个体
        auto t_selection_start = std::chrono::high_resolution_clock::now();
        int elite_count = static_cast<int>(params.population_size * params.selection_rate);
        std::vector<Individual> new_population;
        new_population.reserve(params.population_size);
        
        // 保留精英
        for (int i = 0; i < elite_count; ++i) {
            new_population.push_back(population[i]);
        }
        auto t_selection_end = std::chrono::high_resolution_clock::now();
        auto t_selection_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t_selection_end - t_selection_start).count();
        
        // 生成新个体（交叉和变异）- 分两阶段：先生成，再并行评估
        auto t_evolution_start = std::chrono::high_resolution_clock::now();
        int crossover_count = 0;
        int mutation_count = 0;
        
        // 阶段1：生成所有新个体（不计算适应度）
        std::vector<Individual> new_individuals;
        int num_new_needed = params.population_size - elite_count;
        new_individuals.reserve(num_new_needed);
        
        while (new_individuals.size() < static_cast<size_t>(num_new_needed)) {
            // 选择父代（从精英中选择）
            std::uniform_int_distribution<int> elite_dist(0, elite_count - 1);
            Individual parent1 = population[elite_dist(gen)];
            Individual parent2 = population[elite_dist(gen)];
            
            // 交叉（均匀算术平均，同步 6 维）
            Individual child;
            if (prob_dist(gen) < params.crossover_rate) {
                child.translation     = (parent1.translation     + parent2.translation)     / 2.0;
                child.rotation        = (parent1.rotation        + parent2.rotation)        / 2.0;
                child.lateral         = (parent1.lateral         + parent2.lateral)         / 2.0;
                child.vertical_offset = (parent1.vertical_offset + parent2.vertical_offset) / 2.0;
                child.pitch           = (parent1.pitch           + parent2.pitch)           / 2.0;
                child.yaw             = (parent1.yaw             + parent2.yaw)             / 2.0;
                crossover_count++;
            } else {
                child = parent1;  // 直接复制
            }

            // 变异：6 维同步高斯扰动（由 mutation_scale 控制）；若某维范围为 0 则不变
            if (prob_dist(gen) < params.mutation_rate) {
                child.translation     += trans_dist(gen) * params.mutation_scale;
                child.rotation        += rot_dist(gen)   * params.mutation_scale;
                child.lateral         += lat_dist(gen)   * params.mutation_scale;
                child.vertical_offset += draw_sym(vert_r)  * params.mutation_scale;
                child.pitch           += draw_sym(pitch_r) * params.mutation_scale;
                child.yaw             += draw_sym(yaw_r)   * params.mutation_scale;

                // 旋转 wrap 到 [-π, π]
                child.rotation = std::fmod(child.rotation + M_PI, 2 * M_PI) - M_PI;
                child.pitch    = std::fmod(child.pitch    + M_PI, 2 * M_PI) - M_PI;
                child.yaw      = std::fmod(child.yaw      + M_PI, 2 * M_PI) - M_PI;
                mutation_count++;
            }
            
            // 暂不计算适应度，先收集
            new_individuals.push_back(child);
        }
        
        // 阶段2：并行评估所有新个体的适应度
        auto t_fitness_start = std::chrono::high_resolution_clock::now();
        long long gen_fitness_time_ms = 0;
        int gen_fitness_calls = new_individuals.size();
        
        #ifdef _OPENMP
        #pragma omp parallel for
        #endif
        for (int i = 0; i < static_cast<int>(new_individuals.size()); ++i) {
            auto t_fit_start = std::chrono::high_resolution_clock::now();
            new_individuals[i].fitness = computeFitness(new_individuals[i]);
            auto t_fit_end = std::chrono::high_resolution_clock::now();
            
            // 累加时间（使用 critical 保护，避免竞争）
            #ifdef _OPENMP
            #pragma omp critical
            #endif
            {
                gen_fitness_time_ms += std::chrono::duration_cast<std::chrono::microseconds>(t_fit_end - t_fit_start).count();
            }
        }
        auto t_fitness_end = std::chrono::high_resolution_clock::now();
        gen_fitness_time_ms = gen_fitness_time_ms / 1000;  // 转换为毫秒
        
        // 将新个体添加到种群
        for (const auto& ind : new_individuals) {
            new_population.push_back(ind);
        }
        
        auto t_evolution_end = std::chrono::high_resolution_clock::now();
        auto t_evolution_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t_evolution_end - t_evolution_start).count();
        total_fitness_time_ms += gen_fitness_time_ms;
        total_fitness_calls += gen_fitness_calls;
        
        // 更新种群
        auto t_sort_start = std::chrono::high_resolution_clock::now();
        population = new_population;
        std::sort(population.begin(), population.end(),
                  [](const Individual& a, const Individual& b) { return a.fitness > b.fitness; });
        auto t_sort_end = std::chrono::high_resolution_clock::now();
        auto t_sort_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t_sort_end - t_sort_start).count();
        
        // 更新最佳个体
        bool improved = false;
        if (population[0].fitness > best_fitness) {
            double improvement = population[0].fitness - best_fitness;
            best_fitness = population[0].fitness;
            best_individual = population[0];
            improved = true;
            improvement_count++;
            no_improvement_count = 0;  // 重置未改进计数
        } else {
            no_improvement_count++;  // 增加未改进计数
        }
        
        auto gen_end = std::chrono::high_resolution_clock::now();
        auto gen_time = std::chrono::duration_cast<std::chrono::milliseconds>(gen_end - gen_start).count();
        
        double avg_fitness = std::accumulate(population.begin(), population.end(), 0.0,
            [](double sum, const Individual& ind) { return sum + ind.fitness; }) / params.population_size;
        double std_dev = 0.0;
        for (const auto& ind : population) {
            double diff = ind.fitness - avg_fitness;
            std_dev += diff * diff;
        }
        std_dev = std::sqrt(std_dev / params.population_size);
        
        // 详细日志
        LOG_IF_VERBOSE("[GA] ┌─ 代数 " << std::setw(2) << (generation + 1) << "/" << params.max_generations << std::endl);
        LOG_IF_VERBOSE("[GA] │  最佳适应度: " << std::fixed << std::setprecision(4) << best_fitness 
                  << " (" << (best_fitness * 100) << "%)" 
                  << (improved ? " ⬆️ 提升!" : "") << std::endl);
        LOG_IF_VERBOSE("[GA] │  平均适应度: " << avg_fitness << " (" << (avg_fitness * 100) << "%)" << std::endl);
        LOG_IF_VERBOSE("[GA] │  标准差: " << std::setprecision(4) << std_dev << std::endl);
        if (use_6dof) {
            LOG_IF_VERBOSE("[GA] │  最佳个体: 纵向=" << std::setprecision(2) << best_individual.translation
                      << "mm, roll=" << (best_individual.rotation * 180.0 / M_PI)
                      << "°, 横向=" << best_individual.lateral << "mm"
                      << ", 垂直=" << best_individual.vertical_offset << "mm"
                      << ", pitch=" << (best_individual.pitch * 180.0 / M_PI) << "°"
                      << ", yaw=" << (best_individual.yaw * 180.0 / M_PI) << "°" << std::endl);
        } else {
            LOG_IF_VERBOSE("[GA] │  最佳个体: 纵向=" << std::setprecision(2) << best_individual.translation
                      << "mm, 旋转=" << (best_individual.rotation * 180.0 / M_PI)
                      << "°, 横向=" << best_individual.lateral << "mm" << std::endl);
        }
        LOG_IF_VERBOSE("[GA] │  操作统计: 交叉=" << crossover_count 
                  << ", 变异=" << mutation_count << std::endl);
        LOG_IF_VERBOSE("[GA] │  性能分析:" << std::endl);
        LOG_IF_VERBOSE("[GA] │    选择耗时: " << t_selection_ms << "ms" << std::endl);
        LOG_IF_VERBOSE("[GA] │    进化耗时: " << t_evolution_ms << "ms" << std::endl);
        LOG_IF_VERBOSE("[GA] │      其中适应度计算: " << gen_fitness_time_ms << "ms ("
                  << gen_fitness_calls << "次, 平均: " << std::fixed << std::setprecision(1)
                  << (gen_fitness_calls > 0 ? (static_cast<double>(gen_fitness_time_ms) / gen_fitness_calls) : 0.0)
                  << "ms/次)" << std::endl);
        LOG_IF_VERBOSE("[GA] │    排序耗时: " << t_sort_ms << "ms" << std::endl);
        LOG_IF_VERBOSE("[GA] │    总耗时: " << gen_time << "ms" << std::endl);
        LOG_IF_VERBOSE("[GA] └" << std::endl);

        // ========= 回放：保存本代状态 =========
        {
            GenerationState s;
            s.generation = generation + 1;
            s.best_fitness = best_fitness;
            s.avg_fitness = avg_fitness;
            s.std_dev = std_dev;
            s.translation = best_individual.translation;
            s.rotation_angle_deg = best_individual.rotation * 180.0 / M_PI;
            s.lateral_offset = best_individual.lateral;
            s.crossover_count = crossover_count;
            s.mutation_count = mutation_count;
            s.time_ms = static_cast<double>(gen_time);
            history.push_back(s);
        }
        
        // 检查目标包裹率：达到目标包裹率即停止
        if (params.target_wrapping_ratio > 0.0 && best_fitness >= params.target_wrapping_ratio) {
            LOG_IF_VERBOSE("\n[GA] ✓ 达到目标包裹率 (" << std::fixed << std::setprecision(2) 
                      << (params.target_wrapping_ratio * 100) << "%)，当前包裹率: " 
                      << (best_fitness * 100) << "%，提前退出" << std::endl);
            break;
        }
        
        // 检查收敛
        if (best_fitness >= 1.0 - params.convergence_threshold) {
            LOG_IF_VERBOSE("\n[GA] ✓ 达到目标适应度 (" << (best_fitness * 100) << "%)，提前退出" << std::endl);
            break;
        }
        
        // 检查提前终止：连续N代无改进
        if (params.early_stopping_generations > 0 && 
            no_improvement_count >= params.early_stopping_generations) {
            LOG_IF_VERBOSE("\n[GA] ✓ 连续 " << no_improvement_count 
                      << " 代无改进，提前终止（当前最佳适应度: " 
                      << std::fixed << std::setprecision(4) << (best_fitness * 100) << "%）" << std::endl);
            break;
        }
    }
    

    LOG_IF_VERBOSE("\n" << std::string(70, '=') << std::endl);
    LOG_IF_VERBOSE("[GA] ========== 遗传算法优化完成（"
                   << (use_6dof ? "6-DOF SE(3)" : "3-DOF") << "）==========" << std::endl);
    LOG_IF_VERBOSE("[GA] 最终结果:" << std::endl);
    LOG_IF_VERBOSE("[GA]   最佳适应度: " << std::fixed << std::setprecision(4) << best_fitness
              << " (包裹率: " << (best_fitness * 100) << "%)" << std::endl);
    LOG_IF_VERBOSE("[GA]   最优参数:" << std::endl);
    LOG_IF_VERBOSE("[GA]     纵向位移: " << std::setprecision(2) << best_individual.translation << " mm" << std::endl);
    LOG_IF_VERBOSE("[GA]     绕纵旋转: " << (best_individual.rotation * 180.0 / M_PI) << " °" << std::endl);
    LOG_IF_VERBOSE("[GA]     横向位移: " << best_individual.lateral << " mm" << std::endl);
    if (use_6dof) {
        LOG_IF_VERBOSE("[GA]     垂直位移: " << best_individual.vertical_offset << " mm" << std::endl);
        LOG_IF_VERBOSE("[GA]     Pitch  : " << (best_individual.pitch * 180.0 / M_PI) << " °" << std::endl);
        LOG_IF_VERBOSE("[GA]     Yaw    : " << (best_individual.yaw   * 180.0 / M_PI) << " °" << std::endl);
    }
    LOG_IF_VERBOSE("[GA]   改进次数: " << improvement_count << " 次" << std::endl);
    LOG_IF_VERBOSE("[GA]   性能统计:" << std::endl);
    LOG_IF_VERBOSE("[GA]     适应度计算总耗时: " << total_fitness_time_ms << "ms" << std::endl);
    LOG_IF_VERBOSE("[GA]     适应度计算总次数: " << total_fitness_calls << " 次" << std::endl);
    if (total_fitness_calls > 0) {
        LOG_IF_VERBOSE("[GA]     平均每次适应度计算: " << std::setprecision(2) 
                  << (static_cast<double>(total_fitness_time_ms) / total_fitness_calls) << "ms" << std::endl);
    }
    LOG_IF_VERBOSE(std::string(70, '=') << "\n" << std::endl);

    // 保存到线程本地，供 matchOptimized 填充到 MatchResult.generation_history
    g_last_ga_generation_history = std::move(history);

    return OptimalPose{best_individual.translation, best_individual.rotation,
                       best_individual.lateral, best_individual.vertical_offset,
                       best_individual.pitch, best_individual.yaw};
}

MatchResult MeshMatcher::matchOptimized(double wrapping_threshold,
                                       const GeneticAlgorithmParams& ga_params,
                                       bool skip_align_directions) {
    // 实例级串行：GIL 已在 pybind 层释放，防止同实例并发调用竞争共享网格数据
    std::lock_guard<std::mutex> lock(state_mutex_);
    // 注意：penetration_tolerance 参数已移除，包裹率100%即无穿模
    auto start_total = std::chrono::high_resolution_clock::now();
    MatchResult result;
    
    if (target_vertices_.empty() || candidate_vertices_.empty()) {
        LOG_IF_VERBOSE("[LOG] matchOptimized: Empty vertices, returning early" << std::endl);
        return result;
    }
    
    // 总是先计算体积（用于分析）
    auto t0 = std::chrono::high_resolution_clock::now();
    result.volume = computeVolume(candidate_vertices_, candidate_faces_);
    auto t1 = std::chrono::high_resolution_clock::now();
    auto dt_volume = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    LOG_IF_VERBOSE("[LOG] Step 0: 计算体积耗时: " << dt_volume << "ms" << std::endl);
    
    // 1. 对齐方向（旋转鞋模使其与粗胚对齐）
    //    若 skip_align_directions=true，则假设 target 已被外部预对齐（ICP 热启动），直接复用
    t0 = std::chrono::high_resolution_clock::now();
    std::vector<double> aligned_target = target_vertices_;
    long long dt_align;
    if (skip_align_directions) {
        LOG_IF_VERBOSE( "[LOG] Step 1: 跳过方向对齐（外部已预对齐）" << std::endl);
        t1 = std::chrono::high_resolution_clock::now();
        dt_align = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    } else {
        LOG_IF_VERBOSE( "[LOG] Step 1: 开始方向对齐..." << std::endl);
        Eigen::Matrix3d rotation_matrix = alignDirections(
            aligned_target, target_faces_,
            candidate_vertices_, candidate_faces_
        );
        (void)rotation_matrix; // 当前流水线未使用，保留是为了兼容旧调用点
        t1 = std::chrono::high_resolution_clock::now();
        dt_align = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
        LOG_IF_VERBOSE( "[LOG] Step 1: 方向对齐耗时: " << dt_align << "ms" << std::endl);
    }
    
    // 2. 验证方向对齐（用于记录对齐信息）
    // 注意：方向已经通过 alignDirections 自动对齐，所以总是满足约束
    t0 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "[LOG] Step 2: 开始验证方向对齐..." << std::endl);
    result.direction_alignment = verifyDirectionAlignment(
        aligned_target, target_faces_,
        candidate_vertices_, candidate_faces_
    );
    result.meets_direction_constraints = true;  // 已经对齐，所以总是满足
    t1 = std::chrono::high_resolution_clock::now();
    auto dt_verify = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    LOG_IF_VERBOSE( "[LOG] Step 2: 验证方向对齐耗时: " << dt_verify << "ms" << std::endl);
    
    // 3. 计算纵向轴和垂直轴（使用粗胚的轴）
    t0 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "[LOG] Step 3: 开始计算方向轴..." << std::endl);
    Eigen::Vector3d longitudinal_axis = computeLongitudinalAxis(candidate_vertices_, candidate_faces_);
    Eigen::Vector3d vertical_axis = computeVerticalAxis(candidate_vertices_, candidate_faces_);
    t1 = std::chrono::high_resolution_clock::now();
    auto dt_axis = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    LOG_IF_VERBOSE( "[LOG] Step 3: 计算方向轴耗时: " << dt_axis << "ms" << std::endl);
    LOG_IF_VERBOSE( "[LOG]   纵向轴: (" << longitudinal_axis[0] << ", " 
              << longitudinal_axis[1] << ", " << longitudinal_axis[2] << ")" << std::endl);
    LOG_IF_VERBOSE( "[LOG]   垂直轴: (" << vertical_axis[0] << ", " 
              << vertical_axis[1] << ", " << vertical_axis[2] << ")" << std::endl);
    
    // 4. 优化位置和旋转（使用遗传算法；可能是 6-DOF 模式）
    t0 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "\n[LOG] Step 4: 使用遗传算法优化 SE(3) 刚体变换..." << std::endl);
    const OptimalPose pose = optimizePositionAndRotationGA(
        aligned_target, target_faces_,
        candidate_vertices_, candidate_faces_,
        longitudinal_axis,
        vertical_axis,
        ga_params
    );
    result.optimal_translation = pose.translation;
    // 下游沿用原局部变量名（避免大范围改动）；const 防误写
    const double optimal_relative_rotation_angle_rad = pose.rotation_rad;
    const double optimal_vertical_offset = pose.vertical_offset;
    const double optimal_lateral_offset  = pose.lateral;
    const double optimal_pitch_rad = pose.pitch_rad;
    const double optimal_yaw_rad   = pose.yaw_rad;
    // 回放：复制 GA 每代历史到结果里（供前端回放）
    result.generation_history = g_last_ga_generation_history;

    t1 = std::chrono::high_resolution_clock::now();
    auto dt_optimize = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    LOG_IF_VERBOSE( "[LOG] Step 4: 优化完成，耗时: " << dt_optimize << "ms" << std::endl);
    LOG_IF_VERBOSE( "[LOG]   最优参数: 纵向=" << std::fixed << std::setprecision(2)
              << result.optimal_translation << "mm, roll="
              << (optimal_relative_rotation_angle_rad * 180.0 / M_PI) << "°, 横向="
              << optimal_lateral_offset << "mm, 垂直="
              << optimal_vertical_offset << "mm, pitch="
              << (optimal_pitch_rad * 180.0 / M_PI) << "°, yaw="
              << (optimal_yaw_rad * 180.0 / M_PI) << "°" << std::endl);

    // 5. 应用最优 SE(3) 变换到 candidate 网格
    t0 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "[LOG] Step 5: 开始应用最优 SE(3) 变换..." << std::endl);

    // 横向轴
    Eigen::Vector3d lateral_axis = computeLateralAxis(longitudinal_axis, vertical_axis);

    // 组合旋转矩阵：R = R_yaw · R_pitch · R_roll （与 GA computeFitness 一致）
    Eigen::Matrix3d R_roll  = computeRotationMatrixAroundAxis(longitudinal_axis, optimal_relative_rotation_angle_rad);
    Eigen::Matrix3d R_pitch = computeRotationMatrixAroundAxis(lateral_axis,      optimal_pitch_rad);
    Eigen::Matrix3d R_yaw   = computeRotationMatrixAroundAxis(vertical_axis,     optimal_yaw_rad);
    Eigen::Matrix3d final_rotation_matrix = R_yaw * R_pitch * R_roll;

    Eigen::Vector3d candidate_center = computeCentroid(candidate_vertices_);
    std::vector<double> optimized_candidate = candidate_vertices_;
    // 应用平移：纵向+横向+垂直
    Eigen::Vector3d translation = longitudinal_axis * result.optimal_translation
                                  + lateral_axis    * optimal_lateral_offset
                                  + vertical_axis   * optimal_vertical_offset;

    for (size_t i = 0; i < optimized_candidate.size(); i += 3) {
        Eigen::Vector3d v(optimized_candidate[i],
                         optimized_candidate[i+1],
                         optimized_candidate[i+2]);

        // 先平移到质心，旋转，再平移回去，最后平移
        v -= candidate_center;
        v = final_rotation_matrix * v;
        v += candidate_center;
        v += translation;

        optimized_candidate[i] = v[0];
        optimized_candidate[i+1] = v[1];
        optimized_candidate[i+2] = v[2];
    }

    result.optimal_rotation_angle_deg = optimal_relative_rotation_angle_rad * 180.0 / M_PI;
    result.optimal_vertical_offset    = optimal_vertical_offset;
    result.optimal_lateral_offset     = optimal_lateral_offset;
    result.optimal_pitch_deg          = optimal_pitch_rad * 180.0 / M_PI;
    result.optimal_yaw_deg            = optimal_yaw_rad   * 180.0 / M_PI;

    t1 = std::chrono::high_resolution_clock::now();
    auto dt_translate = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    LOG_IF_VERBOSE( "[LOG] Step 5: 应用 SE(3) 变换耗时: " << dt_translate << "ms" << std::endl);
    
    // 6. 计算体积包裹率和96%分位数间隙
    t0 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "\n[LOG] Step 6: 开始计算最终包裹率和96%分位数间隙..." << std::endl);
    
    BVHTree final_bvh;
    final_bvh.build(optimized_candidate, candidate_faces_);

    const size_t final_samples = std::max(ga_params.num_sample_points,
                                          FINAL_METRIC_MIN_SAMPLES);
    auto final_dists = computeSampleSignedDistances(
        aligned_target, target_faces_, final_bvh, final_samples);
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
            size_t idx96 = static_cast<size_t>(std::ceil(clearances.size() * 0.96) - 1);
            if (idx96 >= clearances.size()) idx96 = clearances.size() - 1;
            result.percentile96_clearance = clearances[idx96];
        } else {
            result.percentile96_clearance = 0.0;
        }
        LOG_IF_VERBOSE("[LOG]   最终指标采样数: " << final_dists.size()
                  << " (inside_tol=" << ga_params.inside_tolerance_mm << "mm)" << std::endl);
    }
    
    t1 = std::chrono::high_resolution_clock::now();
    auto dt_wrapping = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    LOG_IF_VERBOSE( "[LOG] Step 6: 包裹率和96%分位数间隙计算完成，耗时: " << dt_wrapping << "ms" << std::endl);
    LOG_IF_VERBOSE( "[LOG]   包裹率: " << std::fixed << std::setprecision(4) << result.wrapping_ratio 
              << " (" << (result.wrapping_ratio * 100) << "%)" << std::endl);
    LOG_IF_VERBOSE( "[LOG]   96%分位数间隙: " << std::setprecision(4) << result.percentile96_clearance << " mm" << std::endl);
    
    // 目标包裹率（用于决定 is_fully_wrapped）：以 wrapping_threshold 为权威
    //   ga_params.target_wrapping_ratio 仅用于 GA 早停，不再参与最终判定
    //   （历史上两者曾被 OR 串联导致 UX 混乱：CLI --wrapping-threshold 被 GA 默认 0.96 覆盖）
    double target_wrapping = wrapping_threshold;
    result.is_fully_wrapped = (result.wrapping_ratio >= target_wrapping);
    
    if (!result.is_fully_wrapped) {
        LOG_IF_VERBOSE( "[LOG] ⚠️  包裹率未达到目标值 (" << std::fixed << std::setprecision(2) 
                  << (target_wrapping * 100) << "%)，当前包裹率: " 
                  << (result.wrapping_ratio * 100) << "%，不满足匹配条件" << std::endl);
        auto end_total = std::chrono::high_resolution_clock::now();
        auto total_time = std::chrono::duration_cast<std::chrono::milliseconds>(end_total - start_total).count();
        LOG_IF_VERBOSE( "[LOG] 总耗时: " << total_time << "ms" << std::endl);
        return result;  // 未达到目标包裹率，不满足条件
    }
    
    // 7. 计算体积和匹配分数
    t0 = std::chrono::high_resolution_clock::now();
    LOG_IF_VERBOSE( "\n[LOG] Step 7: 计算最终体积和匹配分数..." << std::endl);
    
    result.volume = computeVolume(optimized_candidate, candidate_faces_);
    
    // 计算综合匹配分数（体积越小，包裹率越高，分数越高）
    if (result.volume > 0) {
        double volume_score = 1.0 / (1.0 + result.volume / 1000000.0);  // 归一化
        double wrapping_score = result.wrapping_ratio;
        result.match_score = 0.6 * volume_score + 0.4 * wrapping_score;
    }
    t1 = std::chrono::high_resolution_clock::now();
    auto dt_score = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    
    auto end_total = std::chrono::high_resolution_clock::now();
    auto total_time = std::chrono::duration_cast<std::chrono::milliseconds>(end_total - start_total).count();
    
    // 输出最终结果摘要
    LOG_IF_VERBOSE( "\n" << std::string(70, '=') << std::endl);
    LOG_IF_VERBOSE( "[LOG] ========== 匹配结果摘要 ==========" << std::endl);
    LOG_IF_VERBOSE( "[LOG] 包裹率: " << std::fixed << std::setprecision(4) << result.wrapping_ratio 
              << " (" << (result.wrapping_ratio * 100) << "%) ✅" << std::endl);
    LOG_IF_VERBOSE( "[LOG] 96%分位数间隙: " << std::setprecision(4) << result.percentile96_clearance << " mm" << std::endl);
    LOG_IF_VERBOSE( "[LOG] 体积: " << std::setprecision(2) << result.volume << " mm³" << std::endl);
    LOG_IF_VERBOSE( "[LOG] 匹配分数: " << std::setprecision(4) << result.match_score << std::endl);
    LOG_IF_VERBOSE( "[LOG] 最优参数:" << std::endl);
    LOG_IF_VERBOSE( "[LOG]   纵向位移: " << std::setprecision(2) << result.optimal_translation << " mm" << std::endl);
    LOG_IF_VERBOSE( "[LOG]   绕纵旋转: " << result.optimal_rotation_angle_deg << " °" << std::endl);
    LOG_IF_VERBOSE( "[LOG]   横向位移: " << result.optimal_lateral_offset << " mm" << std::endl);
    LOG_IF_VERBOSE( "[LOG]   垂直位移: " << result.optimal_vertical_offset << " mm" << std::endl);
    LOG_IF_VERBOSE( "[LOG]   Pitch    : " << result.optimal_pitch_deg << " °" << std::endl);
    LOG_IF_VERBOSE( "[LOG]   Yaw      : " << result.optimal_yaw_deg << " °" << std::endl);
    LOG_IF_VERBOSE( "[LOG] ========== 性能分析 ==========" << std::endl);
    LOG_IF_VERBOSE( "[LOG] 各步骤耗时及占比:" << std::endl);
    if (total_time > 0) {
        LOG_IF_VERBOSE( "[LOG]   Step 0 (计算体积): " << dt_volume << "ms (" 
                  << std::setprecision(1) << (100.0 * dt_volume / total_time) << "%)" << std::endl);
        LOG_IF_VERBOSE( "[LOG]   Step 1 (方向对齐): " << dt_align << "ms (" 
                  << (100.0 * dt_align / total_time) << "%)" << std::endl);
        LOG_IF_VERBOSE( "[LOG]   Step 2 (验证对齐): " << dt_verify << "ms (" 
                  << (100.0 * dt_verify / total_time) << "%)" << std::endl);
        LOG_IF_VERBOSE( "[LOG]   Step 3 (计算轴): " << dt_axis << "ms (" 
                  << (100.0 * dt_axis / total_time) << "%)" << std::endl);
        LOG_IF_VERBOSE( "[LOG]   Step 4 (优化): " << dt_optimize << "ms (" 
                  << (100.0 * dt_optimize / total_time) << "%)" << std::endl);
        LOG_IF_VERBOSE( "[LOG]   Step 5 (应用变换): " << dt_translate << "ms (" 
                  << (100.0 * dt_translate / total_time) << "%)" << std::endl);
        LOG_IF_VERBOSE( "[LOG]   Step 6 (包裹率): " << dt_wrapping << "ms (" 
                  << (100.0 * dt_wrapping / total_time) << "%)" << std::endl);
        LOG_IF_VERBOSE( "[LOG]   Step 7 (最终计算): " << dt_score << "ms (" 
                  << (100.0 * dt_score / total_time) << "%)" << std::endl);
    }
    LOG_IF_VERBOSE( "[LOG]   总耗时: " << total_time << "ms" << std::endl);
    LOG_IF_VERBOSE( std::string(70, '=') << "\n" << std::endl);
    
    return result;
}
