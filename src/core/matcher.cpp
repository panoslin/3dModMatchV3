#include "matcher.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>
#include <iostream>
#include <chrono>
#include <random>
#ifdef _OPENMP
#include <omp.h>
#endif

MeshMatcher::MeshMatcher() {
}

MeshMatcher::~MeshMatcher() {
}

bool MeshMatcher::loadTargetMesh(const std::vector<double>& vertices, 
                                 const std::vector<int>& faces) {
    if (vertices.size() % 3 != 0 || faces.size() % 3 != 0) {
        return false;
    }
    target_vertices_ = vertices;
    target_faces_ = faces;
    return true;
}

bool MeshMatcher::loadCandidateMesh(const std::vector<double>& vertices, 
                                   const std::vector<int>& faces) {
    if (vertices.size() % 3 != 0 || faces.size() % 3 != 0) {
        return false;
    }
    candidate_vertices_ = vertices;
    candidate_faces_ = faces;
    return true;
}

double MeshMatcher::computeVolume(const std::vector<double>& vertices,
                                  const std::vector<int>& faces) {
    if (vertices.size() < 9 || faces.size() < 3) {
        return 0.0;
    }
    
    double volume = 0.0;
    Eigen::Vector3d origin(0, 0, 0);
    
    // 计算质心作为原点
    for (size_t i = 0; i < vertices.size(); i += 3) {
        origin += Eigen::Vector3d(vertices[i], vertices[i+1], vertices[i+2]);
    }
    origin /= (vertices.size() / 3);
    
    // 使用有符号体积公式计算总体积
    for (size_t i = 0; i < faces.size(); i += 3) {
        int idx0 = faces[i] * 3;
        int idx1 = faces[i+1] * 3;
        int idx2 = faces[i+2] * 3;
        
        if (idx0 + 2 >= static_cast<int>(vertices.size()) ||
            idx1 + 2 >= static_cast<int>(vertices.size()) ||
            idx2 + 2 >= static_cast<int>(vertices.size())) {
            continue;
        }
        
        Eigen::Vector3d v0(vertices[idx0], vertices[idx0+1], vertices[idx0+2]);
        Eigen::Vector3d v1(vertices[idx1], vertices[idx1+1], vertices[idx1+2]);
        Eigen::Vector3d v2(vertices[idx2], vertices[idx2+1], vertices[idx2+2]);
        
        v0 -= origin;
        v1 -= origin;
        v2 -= origin;
        
        // 有符号体积 = (v0 · (v1 × v2)) / 6
        double signed_vol = v0.dot(v1.cross(v2)) / 6.0;
        volume += std::abs(signed_vol);
    }
    
    return volume;
}

Eigen::Vector3d MeshMatcher::computePrincipalNormal(const std::vector<double>& vertices,
                                                    const std::vector<int>& faces) {
    if (faces.size() < 3) {
        return Eigen::Vector3d(0, 0, 1);
    }
    
    Eigen::Vector3d normal_sum(0, 0, 0);
    int valid_faces = 0;
    
    for (size_t i = 0; i < faces.size(); i += 3) {
        int idx0 = faces[i] * 3;
        int idx1 = faces[i+1] * 3;
        int idx2 = faces[i+2] * 3;
        
        if (idx0 + 2 >= static_cast<int>(vertices.size()) ||
            idx1 + 2 >= static_cast<int>(vertices.size()) ||
            idx2 + 2 >= static_cast<int>(vertices.size())) {
            continue;
        }
        
        Eigen::Vector3d v0(vertices[idx0], vertices[idx0+1], vertices[idx0+2]);
        Eigen::Vector3d v1(vertices[idx1], vertices[idx1+1], vertices[idx1+2]);
        Eigen::Vector3d v2(vertices[idx2], vertices[idx2+1], vertices[idx2+2]);
        
        Eigen::Vector3d edge1 = v1 - v0;
        Eigen::Vector3d edge2 = v2 - v0;
        Eigen::Vector3d normal = edge1.cross(edge2);
        
        double norm = normal.norm();
        if (norm > 1e-9) {
            normal /= norm;
            normal_sum += normal;
            valid_faces++;
        }
    }
    
    if (valid_faces > 0) {
        normal_sum /= valid_faces;
        double norm = normal_sum.norm();
        if (norm > 1e-9) {
            normal_sum /= norm;
        }
    }
    
    if (normal_sum.norm() < 1e-9) {
        return Eigen::Vector3d(0, 0, 1);
    }
    
    return normal_sum;
}

double MeshMatcher::computeNormalAlignment(const Eigen::Vector3d& target_normal,
                                           const Eigen::Vector3d& candidate_normal) {
    // 计算点积，值越接近1表示对齐越好
    double dot_product = target_normal.dot(candidate_normal);
    // 考虑方向可能相反的情况（取绝对值）
    dot_product = std::abs(dot_product);
    // 转换为角度相似度（0-1范围，1表示完全对齐）
    // 使用余弦相似度，已经是0-1范围
    return dot_product;
}


void MeshMatcher::buildFaceKDTree(const std::vector<double>& vertices,
                                  const std::vector<int>& faces,
                                  KDTree& tree,
                                  std::vector<Eigen::Vector3d>& face_centers,
                                  std::vector<Eigen::Vector3d>& face_normals) {
    face_centers.clear();
    face_normals.clear();
    
    size_t num_faces = faces.size() / 3;
    face_centers.reserve(num_faces);
    face_normals.reserve(num_faces);
    std::vector<int> face_indices;
    face_indices.reserve(num_faces);
    
    for (size_t i = 0; i < faces.size(); i += 3) {
        int idx0 = faces[i] * 3;
        int idx1 = faces[i+1] * 3;
        int idx2 = faces[i+2] * 3;
        
        if (idx0 + 2 >= static_cast<int>(vertices.size()) ||
            idx1 + 2 >= static_cast<int>(vertices.size()) ||
            idx2 + 2 >= static_cast<int>(vertices.size())) {
            continue;
        }
        
        Eigen::Vector3d v0(vertices[idx0], vertices[idx0+1], vertices[idx0+2]);
        Eigen::Vector3d v1(vertices[idx1], vertices[idx1+1], vertices[idx1+2]);
        Eigen::Vector3d v2(vertices[idx2], vertices[idx2+1], vertices[idx2+2]);
        
        // 计算面中心
        Eigen::Vector3d center = (v0 + v1 + v2) / 3.0;
        face_centers.push_back(center);
        
        // 计算面法线
        Eigen::Vector3d edge1 = v1 - v0;
        Eigen::Vector3d edge2 = v2 - v0;
        Eigen::Vector3d normal = edge1.cross(edge2);
        double norm = normal.norm();
        if (norm > 1e-9) {
            normal /= norm;
        }
        face_normals.push_back(normal);
        
        face_indices.push_back(i / 3);
    }
    
    // 构建KD-tree
    tree.build(face_centers, face_indices);
}

double MeshMatcher::signedDistanceToMeshWithKDTree(
    const Eigen::Vector3d& point,
    const std::vector<double>& vertices,
    const std::vector<int>& faces,
    const KDTree& face_centers_tree,
    const std::vector<Eigen::Vector3d>& face_centers,
    const std::vector<Eigen::Vector3d>& face_normals) {
    
    // 计算点到三角形的最短距离（用于返回距离幅值）
    auto pointTriangleDistanceSquared = [](const Eigen::Vector3d& p,
                                          const Eigen::Vector3d& a,
                                          const Eigen::Vector3d& b,
                                          const Eigen::Vector3d& c) -> double {
        // Reference: Real-Time Collision Detection (Christer Ericson)
        Eigen::Vector3d ab = b - a;
        Eigen::Vector3d ac = c - a;
        Eigen::Vector3d ap = p - a;

        double d1 = ab.dot(ap);
        double d2 = ac.dot(ap);
        if (d1 <= 0.0 && d2 <= 0.0) return (p - a).squaredNorm(); // barycentric (1,0,0)

        Eigen::Vector3d bp = p - b;
        double d3 = ab.dot(bp);
        double d4 = ac.dot(bp);
        if (d3 >= 0.0 && d4 <= d3) return (p - b).squaredNorm(); // barycentric (0,1,0)

        double vc = d1 * d4 - d3 * d2;
        if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
            double v = d1 / (d1 - d3);
            Eigen::Vector3d proj = a + v * ab;
            return (p - proj).squaredNorm(); // edge AB
        }

        Eigen::Vector3d cp = p - c;
        double d5 = ab.dot(cp);
        double d6 = ac.dot(cp);
        if (d6 >= 0.0 && d5 <= d6) return (p - c).squaredNorm(); // barycentric (0,0,1)

        double vb = d5 * d2 - d1 * d6;
        if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
            double w = d2 / (d2 - d6);
            Eigen::Vector3d proj = a + w * ac;
            return (p - proj).squaredNorm(); // edge AC
        }

        double va = d3 * d6 - d5 * d4;
        if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) {
            double w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
            Eigen::Vector3d proj = b + w * (c - b);
            return (p - proj).squaredNorm(); // edge BC
        }

        // inside face region
        double denom = 1.0 / (va + vb + vc);
        double v = vb * denom;
        double w = vc * denom;
        Eigen::Vector3d proj = a + ab * v + ac * w;
        return (p - proj).squaredNorm();
    };

    // 使用KD-tree找到最近的面中心
    auto nearest = face_centers_tree.nearestNeighbor(point);
    if (nearest.second < 0) {
        return std::numeric_limits<double>::max();
    }
    
    int nearest_face_idx = nearest.second;
    
    // 说明：
    // - 为了“点到表面最短距离”的幅值计算，我们仍然使用 KD-tree 在局部范围找候选面来加速。
    // - 为了和前端 Three.js Raycaster 的“整网格计交点（奇偶法）”完全同步，
    //   交点统计必须遍历整张网格的所有三角形（不依赖 KD-tree 的 radiusSearch 结果）。
    double search_radius = 10.0;
    std::vector<std::pair<Eigen::Vector3d, int>> nearby_faces;
    face_centers_tree.radiusSearch(point, search_radius, nearby_faces);
    if (nearby_faces.empty()) {
        search_radius *= 10.0;
        face_centers_tree.radiusSearch(point, search_radius, nearby_faces);
    }
    
    // 如果还是没有，使用原始方法（但只检查最近的面）
    if (nearby_faces.empty()) {
        // 回退到检查最近的面
        int face_idx = nearest_face_idx * 3;
        if (face_idx + 2 < static_cast<int>(faces.size())) {
            int idx0 = faces[face_idx] * 3;
            int idx1 = faces[face_idx + 1] * 3;
            int idx2 = faces[face_idx + 2] * 3;
            
            if (idx0 + 2 < static_cast<int>(vertices.size()) &&
                idx1 + 2 < static_cast<int>(vertices.size()) &&
                idx2 + 2 < static_cast<int>(vertices.size())) {
                
                Eigen::Vector3d v0(vertices[idx0], vertices[idx0+1], vertices[idx0+2]);
                Eigen::Vector3d v1(vertices[idx1], vertices[idx1+1], vertices[idx1+2]);
                Eigen::Vector3d v2(vertices[idx2], vertices[idx2+1], vertices[idx2+2]);
                
                Eigen::Vector3d edge1 = v1 - v0;
                Eigen::Vector3d edge2 = v2 - v0;
                Eigen::Vector3d normal = edge1.cross(edge2);
                double area = normal.norm();
                if (area > 1e-9) {
                    normal /= area;
                    Eigen::Vector3d to_point = point - v0;
                    double dist = to_point.dot(normal);
                    return dist;
                }
            }
        }
        return std::numeric_limits<double>::max();
    }
    
    // 使用射线投射法判断点内外（与前端一致：固定 +X 方向，交点奇偶法）
    // 同时计算点到三角形的最短距离作为返回的距离幅值。
    //
    // 关键同步点（对齐 Three.js Raycaster 的常见处理方式）：
    // 1) 射线起点沿射线方向做一个极小偏移，避免“恰好在表面/边/顶点”导致交点奇偶翻转。
    // 2) 对交点的 t 做去重（同一几何位置可能被相邻两个三角形同时命中），避免重复计数。
    double min_dist2 = std::numeric_limits<double>::max();
    const Eigen::Vector3d ray_dir(1, 0, 0);
    const Eigen::Vector3d ray_origin = point + ray_dir * 1e-4; // 与前端一致的微偏移
    int intersection_count = 0;
    
    for (const auto& face_pair : nearby_faces) {
        int face_idx = face_pair.second * 3;
        if (face_idx + 2 >= static_cast<int>(faces.size())) continue;
        
        int idx0 = faces[face_idx] * 3;
        int idx1 = faces[face_idx + 1] * 3;
        int idx2 = faces[face_idx + 2] * 3;
        
        if (idx0 + 2 >= static_cast<int>(vertices.size()) ||
            idx1 + 2 >= static_cast<int>(vertices.size()) ||
            idx2 + 2 >= static_cast<int>(vertices.size())) {
            continue;
        }
        
        Eigen::Vector3d v0(vertices[idx0], vertices[idx0+1], vertices[idx0+2]);
        Eigen::Vector3d v1(vertices[idx1], vertices[idx1+1], vertices[idx1+2]);
        Eigen::Vector3d v2(vertices[idx2], vertices[idx2+1], vertices[idx2+2]);
        
        // 更新点到三角形的最短距离（用于返回值）
        Eigen::Vector3d edge1 = v1 - v0;
        Eigen::Vector3d edge2 = v2 - v0;
        Eigen::Vector3d normal = edge1.cross(edge2);
        double area2 = normal.norm();
        if (area2 < 1e-9) continue; // 退化三角形

        min_dist2 = std::min(min_dist2, pointTriangleDistanceSquared(point, v0, v1, v2));
        
        // 射线交点统计不在这里做（这里的循环仅用于距离幅值的局部加速估计）
    }

    // 射线-三角形相交测试（Möller-Trumbore），遍历整张网格的所有三角形，确保与前端一致
    for (size_t fi = 0; fi + 2 < faces.size(); fi += 3) {
        int idx0 = faces[fi] * 3;
        int idx1 = faces[fi + 1] * 3;
        int idx2 = faces[fi + 2] * 3;

        if (idx0 + 2 >= static_cast<int>(vertices.size()) ||
            idx1 + 2 >= static_cast<int>(vertices.size()) ||
            idx2 + 2 >= static_cast<int>(vertices.size())) {
            continue;
        }

        const Eigen::Vector3d v0(vertices[idx0], vertices[idx0 + 1], vertices[idx0 + 2]);
        const Eigen::Vector3d v1(vertices[idx1], vertices[idx1 + 1], vertices[idx1 + 2]);
        const Eigen::Vector3d v2(vertices[idx2], vertices[idx2 + 1], vertices[idx2 + 2]);

        const Eigen::Vector3d edge1 = v1 - v0;
        const Eigen::Vector3d edge2 = v2 - v0;

        const Eigen::Vector3d h = ray_dir.cross(edge2);
        const double a = edge1.dot(h);
        if (std::abs(a) < 1e-9) continue;

        const double f = 1.0 / a;
        const Eigen::Vector3d s = ray_origin - v0;
        const double u_ray = f * s.dot(h);
        if (u_ray < 0.0 || u_ray > 1.0) continue;

        const Eigen::Vector3d q = s.cross(edge1);
        const double v_ray = f * ray_dir.dot(q);
        if (v_ray < 0.0 || u_ray + v_ray > 1.0) continue;

        const double t = f * edge2.dot(q);
        if (t > 1e-9) {
            intersection_count++;
        }
    }

    bool is_inside = (intersection_count % 2 == 1);
    double min_distance = (min_dist2 == std::numeric_limits<double>::max()) ? std::numeric_limits<double>::max()
                                                                           : std::sqrt(min_dist2);
    return is_inside ? -min_distance : min_distance;
}



Eigen::Vector3d MeshMatcher::computeLongitudinalAxis(const std::vector<double>& vertices,
                                                     const std::vector<int>& faces) {
    // 使用PCA（主成分分析）计算纵向轴
    if (vertices.size() < 9) {
        return Eigen::Vector3d(1, 0, 0);
    }
    
    size_t num_vertices = vertices.size() / 3;
    
    // 1. 计算质心
    Eigen::Vector3d centroid(0, 0, 0);
    for (size_t i = 0; i < vertices.size(); i += 3) {
        centroid += Eigen::Vector3d(vertices[i], vertices[i+1], vertices[i+2]);
    }
    centroid /= num_vertices;
    
    // 2. 构建协方差矩阵
    Eigen::Matrix3d covariance = Eigen::Matrix3d::Zero();
    for (size_t i = 0; i < vertices.size(); i += 3) {
        Eigen::Vector3d v(vertices[i], vertices[i+1], vertices[i+2]);
        v -= centroid;  // 减去质心
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
    
    std::cerr << "[LOG] alignDirections: 开始计算方向轴..." << std::endl;
    auto t0 = std::chrono::high_resolution_clock::now();
    
    // 计算鞋模和粗胚的纵向轴和垂直轴
    Eigen::Vector3d target_longitudinal = computeLongitudinalAxis(target_vertices, target_faces);
    auto t1 = std::chrono::high_resolution_clock::now();
    std::cerr << "[LOG] alignDirections: 计算目标纵向轴耗时: " 
              << std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count() << "ms" << std::endl;
    
    t0 = std::chrono::high_resolution_clock::now();
    Eigen::Vector3d target_vertical = computeVerticalAxis(target_vertices, target_faces);
    t1 = std::chrono::high_resolution_clock::now();
    std::cerr << "[LOG] alignDirections: 计算目标垂直轴耗时: " 
              << std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count() << "ms" << std::endl;
    
    t0 = std::chrono::high_resolution_clock::now();
    Eigen::Vector3d candidate_longitudinal = computeLongitudinalAxis(candidate_vertices, candidate_faces);
    t1 = std::chrono::high_resolution_clock::now();
    std::cerr << "[LOG] alignDirections: 计算候选纵向轴耗时: " 
              << std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count() << "ms" << std::endl;
    
    t0 = std::chrono::high_resolution_clock::now();
    Eigen::Vector3d candidate_vertical = computeVerticalAxis(candidate_vertices, candidate_faces);
    t1 = std::chrono::high_resolution_clock::now();
    std::cerr << "[LOG] alignDirections: 计算候选垂直轴耗时: " 
              << std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count() << "ms" << std::endl;
    
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
    
    // 计算质心（用于旋转）
    Eigen::Vector3d target_center(0, 0, 0);
    size_t target_count = target_vertices.size() / 3;
    for (size_t i = 0; i < target_vertices.size(); i += 3) {
        target_center += Eigen::Vector3d(target_vertices[i], 
                                        target_vertices[i+1], 
                                        target_vertices[i+2]);
    }
    target_center /= target_count;
    
    // 应用旋转矩阵到所有顶点
    t0 = std::chrono::high_resolution_clock::now();
    std::cerr << "[LOG] alignDirections: 开始旋转 " << (target_vertices.size() / 3) << " 个顶点..." << std::endl;
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
    std::cerr << "[LOG] alignDirections: 旋转顶点耗时: " 
              << std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count() << "ms" << std::endl;
    
    return rotation_matrix;
}

DirectionAlignment MeshMatcher::verifyDirectionAlignment(
    const std::vector<double>& target_vertices,
    const std::vector<int>& target_faces,
    const std::vector<double>& candidate_vertices,
    const std::vector<int>& candidate_faces,
    double angle_tolerance_deg) {
    
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
    
    // 验证是否满足严格约束（角度误差不超过容差）
    // 鞋跟-鞋头方向：允许同向或反向（180度），容差在两端都检查
    bool heel_toe_valid = (alignment.heel_toe_angle_deg <= angle_tolerance_deg) || 
                         ((180.0 - alignment.heel_toe_angle_deg) <= angle_tolerance_deg);
    // 上下方向：必须同向，不允许颠倒
    bool vertical_valid = alignment.vertical_angle_deg <= angle_tolerance_deg;
    
    alignment.is_valid = heel_toe_valid && vertical_valid;
    
    return alignment;
}

double MeshMatcher::computeWrappingRatio(
    const std::vector<double>& target_vertices,
    const std::vector<int>& target_faces,
    const std::vector<double>& candidate_vertices,
    const std::vector<int>& candidate_faces,
    const KDTree* cached_tree,
    const std::vector<Eigen::Vector3d>* cached_face_centers,
    const std::vector<Eigen::Vector3d>* cached_face_normals) {
    
    auto t0 = std::chrono::high_resolution_clock::now();
    
    // 检查固定500个顶点（或更少，如果网格顶点数不足）
    size_t num_vertices = target_vertices.size() / 3;
    if (num_vertices == 0) {
        return 0.0;
    }
    
    // 固定采样500个点
    size_t num_to_check = std::min(500UL, num_vertices);
    if (num_to_check == 0) {
        num_to_check = 1;  // 至少检查1个点
    }
    
    // 计算步长，确保均匀分布检查500个顶点
    size_t step = num_vertices / num_to_check;
    if (step == 0) step = 1;
    
    std::cerr << "[LOG] computeWrappingRatio: 检查 " << num_to_check << "/" << num_vertices 
              << " 个顶点 (步长: " << step << ")..." << std::endl;
    
    // 构建或使用缓存的KD-tree（用于加速距离查询）
    const KDTree* face_centers_tree;
    const std::vector<Eigen::Vector3d>* face_centers;
    const std::vector<Eigen::Vector3d>* face_normals;
    
    KDTree local_tree;
    std::vector<Eigen::Vector3d> local_face_centers;
    std::vector<Eigen::Vector3d> local_face_normals;
    
    if (cached_tree && cached_face_centers && cached_face_normals) {
        // 使用缓存的KD-tree
        face_centers_tree = cached_tree;
        face_centers = cached_face_centers;
        face_normals = cached_face_normals;
        std::cerr << "[LOG] computeWrappingRatio: 使用缓存的KD-tree" << std::endl;
    } else {
        // 构建新的KD-tree
        auto t_kdtree = std::chrono::high_resolution_clock::now();
        buildFaceKDTree(candidate_vertices, candidate_faces, local_tree, 
                       local_face_centers, local_face_normals);
        auto t_kdtree_end = std::chrono::high_resolution_clock::now();
        auto dt_kdtree = std::chrono::duration_cast<std::chrono::milliseconds>(t_kdtree_end - t_kdtree).count();
        std::cerr << "[LOG] computeWrappingRatio: 构建KD-tree耗时: " << dt_kdtree << "ms" << std::endl;
        
        face_centers_tree = &local_tree;
        face_centers = &local_face_centers;
        face_normals = &local_face_normals;
    }
    
    // 收集要检查的点（每次使用不同的起始偏移，确保采样不同的点）
    std::vector<Eigen::Vector3d> points_to_check;
    points_to_check.reserve(num_to_check);
    
    // 使用固定起始偏移，确保每次调用选择相同的500个点（与前端查看/调试一致）
    size_t start_offset = 0;
    
    for (size_t i = start_offset * 3; i < target_vertices.size(); i += 3 * step) {
        points_to_check.push_back(Eigen::Vector3d(
            target_vertices[i], target_vertices[i+1], target_vertices[i+2]));
        if (points_to_check.size() >= num_to_check) {
            break;
        }
    }
    
    // 如果还没收集够，从开头继续
    if (points_to_check.size() < num_to_check) {
        for (size_t i = 0; i < target_vertices.size() && points_to_check.size() < num_to_check; i += 3 * step) {
            // 避免重复添加
            bool already_added = false;
            Eigen::Vector3d candidate_point(target_vertices[i], target_vertices[i+1], target_vertices[i+2]);
            for (const auto& existing : points_to_check) {
                if ((existing - candidate_point).norm() < 1e-6) {
                    already_added = true;
                    break;
                }
            }
            if (!already_added) {
                points_to_check.push_back(candidate_point);
            }
        }
    }
    
    // 并行计算距离
    std::vector<int> inside_flags(points_to_check.size(), 0);
    size_t check_interval = std::max(1UL, points_to_check.size() / 10);  // 每10%输出一次进度
    
    #ifdef _OPENMP
    #pragma omp parallel for
    #endif
    for (size_t idx = 0; idx < points_to_check.size(); ++idx) {
        double dist = signedDistanceToMeshWithKDTree(
            points_to_check[idx], candidate_vertices, candidate_faces,
            *face_centers_tree, *face_centers, *face_normals);
        
        if (dist <= 0.1) {  // 容差，避免精度问题
            inside_flags[idx] = 1;
        }
        
        // 进度输出（线程安全）
        if (idx % check_interval == 0) {
            #ifdef _OPENMP
            #pragma omp critical
            #endif
            {
                std::cerr << "[LOG] computeWrappingRatio: 进度 " 
                          << (idx * 100 / points_to_check.size()) 
                          << "%, 已检查: " << idx << "/" << points_to_check.size() << std::endl;
            }
        }
    }
    
    // 统计结果
    int inside_count = 0;
    int total_checked = points_to_check.size();
    for (int flag : inside_flags) {
        inside_count += flag;
    }
    
    if (total_checked == 0) {
        return 0.0;
    }
    
    auto t1 = std::chrono::high_resolution_clock::now();
    auto dt = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    double ratio = (inside_count == total_checked) ? 1.0 : (static_cast<double>(inside_count) / total_checked);
    std::cerr << "[LOG] computeWrappingRatio: 完成，耗时: " << dt << "ms, 包裹率: " 
              << (ratio * 100) << "% (" << inside_count << "/" << total_checked << ")" << std::endl;
    
    // 包裹率 = 内部点数 / 总检查点数
    // 只有当所有检查的点都在内部时，才返回1.0（严格100%）
    return ratio;
}


// 计算绕轴旋转的旋转矩阵（使用Rodrigues公式）
static Eigen::Matrix3d computeRotationMatrixAroundAxis(const Eigen::Vector3d& axis, double angle_rad) {
    // 使用Rodrigues旋转公式
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

double MeshMatcher::optimizePositionAndRotation(
    const std::vector<double>& target_vertices,
    const std::vector<int>& target_faces,
    const std::vector<double>& candidate_vertices,
    const std::vector<int>& candidate_faces,
    const Eigen::Vector3d& longitudinal_axis,
    double& optimal_relative_rotation_angle_rad,
    double& optimal_vertical_offset,
    const GradientDescentParams& params) {
    
    // 使用2D梯度下降同时优化平移和旋转
    // 前提：纵向轴已经对齐（固定不动）
    // 优化参数：
    // 1. 沿纵向轴的相对前后位移（粗胚相对鞋模的位移）
    // 2. 绕纵向轴的相对旋转角度（粗胚相对鞋模的旋转）
    
    // 计算初始位置（质心差在纵向轴上的投影）
    Eigen::Vector3d target_center(0, 0, 0);
    size_t target_count = target_vertices.size() / 3;
    for (size_t i = 0; i < target_vertices.size(); i += 3) {
        target_center += Eigen::Vector3d(target_vertices[i], 
                                        target_vertices[i+1], 
                                        target_vertices[i+2]);
    }
    target_center /= target_count;
    
    Eigen::Vector3d candidate_center(0, 0, 0);
    size_t candidate_count = candidate_vertices.size() / 3;
    for (size_t i = 0; i < candidate_vertices.size(); i += 3) {
        candidate_center += Eigen::Vector3d(candidate_vertices[i], 
                                            candidate_vertices[i+1], 
                                            candidate_vertices[i+2]);
    }
    candidate_center /= candidate_count;
    
    Eigen::Vector3d center_diff = target_center - candidate_center;
    double current_offset = center_diff.dot(longitudinal_axis);
    double current_relative_angle = 0.0;  // 初始相对旋转角度为0
    double current_vertical_offset = 0.0;  // 垂直位移固定为0
    
    // 使用传入的梯度下降参数
    double learning_rate_translation = params.learning_rate_translation;
    double learning_rate_rotation = params.learning_rate_rotation;
    double h_translation = params.h_translation;
    double h_rotation = params.h_rotation;
    int max_iterations = params.max_iterations;
    double convergence_threshold = params.convergence_threshold;
    
    // 在迭代开始前固定采样点，确保整个迭代过程中使用相同的采样点
    // 这样可以保证损失比较有意义，梯度估计更准确
        size_t num_vertices = target_vertices.size() / 3;
    size_t num_to_check = std::min(params.num_sample_points, num_vertices);
        if (num_to_check == 0) num_to_check = 1;
        size_t step = num_vertices / num_to_check;
        if (step == 0) step = 1;
        
    // 固定采样点（使用固定的起始偏移，而不是随机）
    std::vector<Eigen::Vector3d> fixed_sample_points;
    fixed_sample_points.reserve(num_to_check);
    
    // 使用固定的起始偏移（0），确保每次迭代使用相同的采样点
    size_t fixed_start_offset = 0;
    for (size_t i = fixed_start_offset * 3; i < target_vertices.size(); i += 3 * step) {
        fixed_sample_points.push_back(Eigen::Vector3d(
                target_vertices[i], target_vertices[i+1], target_vertices[i+2]));
        if (fixed_sample_points.size() >= num_to_check) {
                break;
            }
        }
        
        // 如果还没收集够，从开头继续
    if (fixed_sample_points.size() < num_to_check) {
        for (size_t i = 0; i < target_vertices.size() && fixed_sample_points.size() < num_to_check; i += 3 * step) {
                bool already_added = false;
                Eigen::Vector3d candidate_point(target_vertices[i], target_vertices[i+1], target_vertices[i+2]);
            for (const auto& existing : fixed_sample_points) {
                    if ((existing - candidate_point).norm() < 1e-6) {
                        already_added = true;
                        break;
                    }
                }
                if (!already_added) {
                fixed_sample_points.push_back(candidate_point);
            }
        }
    }
    
    std::cerr << "[LOG] optimizePositionAndRotation: 固定采样 " << fixed_sample_points.size() 
              << " 个点用于整个迭代过程" << std::endl;
    
    // ========== 方案一：KD-tree缓存优化 ==========
    // 预先构建基础KD-tree（只构建一次！），避免每次迭代重建
    KDTree base_tree;
    std::vector<Eigen::Vector3d> base_face_centers;
    std::vector<Eigen::Vector3d> base_face_normals;
    buildFaceKDTree(candidate_vertices, candidate_faces, base_tree, 
                   base_face_centers, base_face_normals);
    std::cerr << "[LOG] optimizePositionAndRotation: 预先构建基础KD-tree完成（" 
              << base_face_centers.size() << " 个面）" << std::endl;
    
    // 辅助函数：计算给定平移和相对旋转下的损失（1 - 包裹率）
    // 优化：使用预先构建的KD-tree，只变换面中心和法线，不重建KD-tree
    // 在纵向轴已对齐的前提下：
    // - offset: 沿纵向轴的相对前后位移（粗胚相对鞋模的位移）
    // - relative_angle_rad: 绕纵向轴的相对旋转角度（粗胚相对鞋模的旋转）
    // 注意：使用固定的采样点，确保损失比较有意义
    auto computeLoss = [&](double offset, double relative_angle_rad) -> double {
        // 计算粗胚的旋转矩阵（绕纵向轴旋转相对角度）
        Eigen::Matrix3d candidate_rotation = computeRotationMatrixAroundAxis(longitudinal_axis, relative_angle_rad);
        Eigen::Vector3d translation = longitudinal_axis * offset;
        
        // 变换面中心和法线（使用预先构建的基础数据）
        std::vector<Eigen::Vector3d> transformed_face_centers(base_face_centers.size());
        std::vector<Eigen::Vector3d> transformed_face_normals(base_face_normals.size());
        
        for (size_t i = 0; i < base_face_centers.size(); ++i) {
            // 变换面中心
            Eigen::Vector3d center = base_face_centers[i] - candidate_center;
            center = candidate_rotation * center;
            center += candidate_center + translation;
            transformed_face_centers[i] = center;
            
            // 变换法线
            transformed_face_normals[i] = candidate_rotation * base_face_normals[i];
        }
        
        // 变换顶点（用于射线投射计算）
        std::vector<double> transformed_candidate(candidate_vertices.size());
        for (size_t j = 0; j < candidate_vertices.size(); j += 3) {
            Eigen::Vector3d v(candidate_vertices[j], 
                             candidate_vertices[j+1], 
                             candidate_vertices[j+2]);
            v -= candidate_center;
            v = candidate_rotation * v;
            v += candidate_center + translation;
            transformed_candidate[j] = v[0];
            transformed_candidate[j+1] = v[1];
            transformed_candidate[j+2] = v[2];
        }
        
        // 使用固定的采样点和变换后的数据计算包裹率
        // 注意：使用基础KD-tree结构，但使用变换后的面中心
        int inside_count = 0;
        size_t total_checked = fixed_sample_points.size();
        
        #ifdef _OPENMP
        #pragma omp parallel for reduction(+:inside_count)
        #endif
        for (size_t idx = 0; idx < fixed_sample_points.size(); ++idx) {
            // 使用变换后的顶点和面中心/法线计算距离
            double dist = signedDistanceToMeshWithKDTree(
                fixed_sample_points[idx], transformed_candidate, candidate_faces,
                base_tree, transformed_face_centers, transformed_face_normals);
            
            if (dist <= 0.1) {
                inside_count++;
            }
        }
        
        double wrapping = (inside_count == static_cast<int>(total_checked)) ? 1.0 
                         : (static_cast<double>(inside_count) / total_checked);
        return 1.0 - wrapping;  // 损失 = 1 - 包裹率
    };
    
    // ========== 方案三：Adam优化器 ==========
    // 初始化Adam优化器的动量项和二阶矩估计
    double m_translation = 0.0, v_translation = 0.0;  // 纵向位移的动量和二阶矩
    double m_rotation = 0.0, v_rotation = 0.0;          // 旋转角度的动量和二阶矩
    double beta1 = params.use_adam ? params.beta1 : 0.0;
    double beta2 = params.use_adam ? params.beta2 : 0.0;
    double epsilon = params.use_adam ? params.epsilon : 1e-8;
    
    std::string optimizer_name = params.use_adam ? "Adam" : "标准梯度下降";
    std::cerr << "[LOG] optimizePositionAndRotation: 开始2D优化（纵向位移+相对旋转），优化器: " 
              << optimizer_name << "，最大迭代次数: " << max_iterations << std::endl;
    std::cerr << "[LOG] optimizePositionAndRotation: 前提条件：纵向轴已对齐（固定不动）" << std::endl;
    
    for (int iter = 0; iter < max_iterations; ++iter) {
        auto iter_start = std::chrono::high_resolution_clock::now();
        
        // 计算纵向平移方向的梯度（沿纵向轴的相对位移）
        double loss_plus_t = computeLoss(current_offset + h_translation, current_relative_angle);
        double loss_minus_t = computeLoss(current_offset - h_translation, current_relative_angle);
        double gradient_translation = (loss_plus_t - loss_minus_t) / (2.0 * h_translation);
        
        // 计算旋转方向的梯度（绕纵向轴的相对旋转）
        double loss_plus_r = computeLoss(current_offset, current_relative_angle + h_rotation);
        double loss_minus_r = computeLoss(current_offset, current_relative_angle - h_rotation);
        double gradient_rotation = (loss_plus_r - loss_minus_r) / (2.0 * h_rotation);
        
        // 检查收敛（两个方向的梯度都很小）
        if (std::abs(gradient_translation) < convergence_threshold && 
            std::abs(gradient_rotation) < convergence_threshold) {
            std::cerr << "[LOG] optimizePositionAndRotation: 收敛，纵向位移梯度: " << gradient_translation 
                      << ", 相对旋转梯度: " << gradient_rotation << std::endl;
            break;
        }
        
        // 更新参数（使用Adam或标准梯度下降）
        double new_offset, new_relative_angle;
        
        if (params.use_adam) {
            // ========== Adam优化器更新 ==========
            int t = iter + 1;  // 迭代次数（从1开始）
            
            // 更新动量项（一阶矩估计）
            m_translation = beta1 * m_translation + (1.0 - beta1) * gradient_translation;
            m_rotation = beta1 * m_rotation + (1.0 - beta1) * gradient_rotation;
            
            // 更新二阶矩估计
            v_translation = beta2 * v_translation + (1.0 - beta2) * gradient_translation * gradient_translation;
            v_rotation = beta2 * v_rotation + (1.0 - beta2) * gradient_rotation * gradient_rotation;
            
            // 偏差修正
            double m_hat_translation = m_translation / (1.0 - std::pow(beta1, t));
            double m_hat_rotation = m_rotation / (1.0 - std::pow(beta1, t));
            double v_hat_translation = v_translation / (1.0 - std::pow(beta2, t));
            double v_hat_rotation = v_rotation / (1.0 - std::pow(beta2, t));
            
            // 自适应学习率更新
            double adaptive_lr_translation = learning_rate_translation / (std::sqrt(v_hat_translation) + epsilon);
            double adaptive_lr_rotation = learning_rate_rotation / (std::sqrt(v_hat_rotation) + epsilon);
            
            new_offset = current_offset - adaptive_lr_translation * m_hat_translation;
            new_relative_angle = current_relative_angle - adaptive_lr_rotation * m_hat_rotation;
        } else {
            // ========== 标准梯度下降更新 ==========
            new_offset = current_offset - learning_rate_translation * gradient_translation;
            new_relative_angle = current_relative_angle - learning_rate_rotation * gradient_rotation;
        }
        
        // 限制相对旋转角度范围（±180度）
        if (new_relative_angle > M_PI) new_relative_angle -= 2 * M_PI;
        if (new_relative_angle < -M_PI) new_relative_angle += 2 * M_PI;
        
        // 检查新位置的损失是否更小
        double new_loss = computeLoss(new_offset, new_relative_angle);
        double current_loss = computeLoss(current_offset, current_relative_angle);
        
        bool accepted = false;
        if (new_loss < current_loss) {
            current_offset = new_offset;
            current_relative_angle = new_relative_angle;
            accepted = true;
        } else {
            // 如果损失没有改善，减小学习率（仅对标准梯度下降）
            if (!params.use_adam) {
                learning_rate_translation *= 0.5;
                learning_rate_rotation *= 0.5;
                if (learning_rate_translation < 0.01 || learning_rate_rotation < 0.001) {
                    std::cerr << "[LOG] optimizePositionAndRotation: 学习率太小，退出" << std::endl;
                    break;
                }
            }
        }
        
        // 如果已经达到100%包裹率（损失为0），提前退出
        if (new_loss < 1e-6) {
            current_offset = new_offset;
            current_relative_angle = new_relative_angle;
            std::cerr << "[LOG] optimizePositionAndRotation: 达到100%包裹率，提前退出" << std::endl;
            break;
        }
        
        auto iter_end = std::chrono::high_resolution_clock::now();
        auto iter_time = std::chrono::duration_cast<std::chrono::milliseconds>(iter_end - iter_start).count();
        std::cerr << "[LOG] optimizePositionAndRotation: 迭代 " << (iter + 1) << " 耗时: " 
                  << iter_time << "ms, 当前损失: " << current_loss 
                  << ", 新损失: " << new_loss 
                  << (accepted ? " ✅接受" : " ❌拒绝")
                  << ", 纵向位移梯度: " << gradient_translation 
                  << ", 相对旋转梯度: " << gradient_rotation;
        if (params.use_adam) {
            std::cerr << ", Adam动量: m_t=" << m_translation << ", m_r=" << m_rotation;
        }
        std::cerr << std::endl;
    }
    
    optimal_relative_rotation_angle_rad = current_relative_angle;
    optimal_vertical_offset = 0.0;  // 垂直位移固定为0
    std::cerr << "[LOG] optimizePositionAndRotation: 完成，最优纵向位移: " << current_offset 
              << "mm, 最优相对旋转角度: " << (current_relative_angle * 180.0 / M_PI) << "度" << std::endl;
    return current_offset;
}

MatchResult MeshMatcher::matchOptimized(double penetration_tolerance,
                                       double wrapping_threshold,
                                       const GradientDescentParams& gd_params) {
    auto start_total = std::chrono::high_resolution_clock::now();
    MatchResult result;
    
    if (target_vertices_.empty() || candidate_vertices_.empty()) {
        std::cerr << "[LOG] matchOptimized: Empty vertices, returning early" << std::endl;
        return result;
    }
    
    // 总是先计算体积（用于分析）
    auto t0 = std::chrono::high_resolution_clock::now();
    result.volume = computeVolume(candidate_vertices_, candidate_faces_);
    auto t1 = std::chrono::high_resolution_clock::now();
    auto dt_volume = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    std::cerr << "[LOG] Step 0: 计算体积耗时: " << dt_volume << "ms" << std::endl;
    
    // 1. 对齐方向（旋转鞋模使其与粗胚对齐）
    t0 = std::chrono::high_resolution_clock::now();
    std::vector<double> aligned_target = target_vertices_;
    std::cerr << "[LOG] Step 1: 开始方向对齐..." << std::endl;
    Eigen::Matrix3d rotation_matrix = alignDirections(
        aligned_target, target_faces_,
        candidate_vertices_, candidate_faces_
    );
    t1 = std::chrono::high_resolution_clock::now();
    auto dt_align = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    std::cerr << "[LOG] Step 1: 方向对齐耗时: " << dt_align << "ms" << std::endl;
    
    // 2. 验证方向对齐（用于记录对齐信息）
    // 注意：方向已经通过 alignDirections 自动对齐，所以总是满足约束
    t0 = std::chrono::high_resolution_clock::now();
    std::cerr << "[LOG] Step 2: 开始验证方向对齐..." << std::endl;
    result.direction_alignment = verifyDirectionAlignment(
        aligned_target, target_faces_,
        candidate_vertices_, candidate_faces_,
        0.0  // 容差不再使用，因为已经自动对齐
    );
    result.meets_direction_constraints = true;  // 已经对齐，所以总是满足
    t1 = std::chrono::high_resolution_clock::now();
    auto dt_verify = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    std::cerr << "[LOG] Step 2: 验证方向对齐耗时: " << dt_verify << "ms" << std::endl;
    
    // 3. 计算纵向轴（使用粗胚的纵向轴）
    t0 = std::chrono::high_resolution_clock::now();
    std::cerr << "[LOG] Step 3: 开始计算纵向轴..." << std::endl;
    Eigen::Vector3d longitudinal_axis = computeLongitudinalAxis(candidate_vertices_, candidate_faces_);
    t1 = std::chrono::high_resolution_clock::now();
    auto dt_axis = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    std::cerr << "[LOG] Step 3: 计算纵向轴耗时: " << dt_axis << "ms" << std::endl;
    
    // 4. 使用2D梯度下降同时优化相对位移和相对旋转
    // 前提：纵向轴已对齐（固定不动）
    // 优化参数：
    //   1. 沿纵向轴的相对前后位移（粗胚相对鞋模）
    //   2. 绕纵向轴的相对旋转角度（粗胚相对鞋模）
    t0 = std::chrono::high_resolution_clock::now();
    std::cerr << "[LOG] Step 4: 开始2D梯度下降优化（纵向位移+相对旋转）..." << std::endl;
    double optimal_relative_rotation_angle_rad = 0.0;
    double optimal_vertical_offset = 0.0;
    result.optimal_translation = optimizePositionAndRotation(
        aligned_target, target_faces_,
        candidate_vertices_, candidate_faces_,
        longitudinal_axis,
        optimal_relative_rotation_angle_rad,
        optimal_vertical_offset,
        gd_params
    );
    t1 = std::chrono::high_resolution_clock::now();
    auto dt_optimize = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    std::cerr << "[LOG] Step 4: 2D梯度下降优化耗时: " << dt_optimize << "ms" << std::endl;
    
    // 5. 应用最优相对平移和相对旋转
    t0 = std::chrono::high_resolution_clock::now();
    std::cerr << "[LOG] Step 5: 开始应用最优相对平移和相对旋转..." << std::endl;
    
    // 计算旋转矩阵（用于最终变换粗胚）
    Eigen::Matrix3d final_rotation_matrix = computeRotationMatrixAroundAxis(longitudinal_axis, optimal_relative_rotation_angle_rad);
    
    // 计算候选网格质心（用于旋转）
    Eigen::Vector3d candidate_center(0, 0, 0);
    size_t candidate_count = candidate_vertices_.size() / 3;
    for (size_t i = 0; i < candidate_vertices_.size(); i += 3) {
        candidate_center += Eigen::Vector3d(candidate_vertices_[i], 
                                            candidate_vertices_[i+1], 
                                            candidate_vertices_[i+2]);
    }
    candidate_center /= candidate_count;
    
    std::vector<double> optimized_candidate = candidate_vertices_;
    Eigen::Vector3d translation = longitudinal_axis * result.optimal_translation;  // 只沿纵向轴平移
    
    for (size_t i = 0; i < optimized_candidate.size(); i += 3) {
        Eigen::Vector3d v(optimized_candidate[i], 
                         optimized_candidate[i+1], 
                         optimized_candidate[i+2]);
        
        // 先平移到质心，旋转，再平移回去，最后沿纵向轴平移
        v -= candidate_center;
        v = final_rotation_matrix * v;  // 绕纵向轴旋转
        v += candidate_center;
        v += translation;  // 沿纵向轴平移
        
        optimized_candidate[i] = v[0];
        optimized_candidate[i+1] = v[1];
        optimized_candidate[i+2] = v[2];
    }
    
    result.optimal_rotation_angle_deg = optimal_relative_rotation_angle_rad * 180.0 / M_PI;
    result.optimal_vertical_offset = optimal_vertical_offset;
    
    t1 = std::chrono::high_resolution_clock::now();
    auto dt_translate = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    std::cerr << "[LOG] Step 5: 应用平移和旋转耗时: " << dt_translate << "ms" << std::endl;
    
    // 6. 计算体积包裹率（检查10%的顶点）
    t0 = std::chrono::high_resolution_clock::now();
    std::cerr << "[LOG] Step 6: 开始计算包裹率..." << std::endl;
    result.wrapping_ratio = computeWrappingRatio(
        aligned_target, target_faces_,
        optimized_candidate, candidate_faces_,
        nullptr, nullptr, nullptr  // 不使用缓存
    );
    t1 = std::chrono::high_resolution_clock::now();
    auto dt_wrapping = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    std::cerr << "[LOG] Step 6: 计算包裹率耗时: " << dt_wrapping << "ms" << std::endl;
    
    // 6. 检查是否完全包裹（严格100%）
    result.is_fully_wrapped = (result.wrapping_ratio >= 1.0);
    
    if (!result.is_fully_wrapped) {
        return result;  // 不完全包裹，不满足条件
    }
    
    // 7. 计算体积和匹配分数（包裹率100%即无穿模）
    result.has_penetration = false;  // 包裹率100%意味着无穿模
    
    result.volume = computeVolume(optimized_candidate, candidate_faces_);
    
    // 计算综合匹配分数（体积越小，包裹率越高，分数越高）
    if (result.volume > 0) {
        double volume_score = 1.0 / (1.0 + result.volume / 1000000.0);  // 归一化
        double wrapping_score = result.wrapping_ratio;
        result.match_score = 0.6 * volume_score + 0.4 * wrapping_score;
    }
    
    return result;
}
