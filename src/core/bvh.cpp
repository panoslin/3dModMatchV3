#include "bvh.h"
#include <algorithm>
#include <cmath>
#include <limits>

/// @brief 从平铺顶点/面数组构建 BVH 树
void BVHTree::build(const std::vector<double>& vertices,
                    const std::vector<int>& faces) {
    triangles_.clear();
    
    // 从网格数据构建三角形列表
    for (size_t fi = 0; fi + 2 < faces.size(); fi += 3) {
        int idx0 = faces[fi] * 3;
        int idx1 = faces[fi + 1] * 3;
        int idx2 = faces[fi + 2] * 3;
        
        if (idx0 + 2 >= static_cast<int>(vertices.size()) ||
            idx1 + 2 >= static_cast<int>(vertices.size()) ||
            idx2 + 2 >= static_cast<int>(vertices.size())) {
            continue;
        }
        
        Eigen::Vector3d v0(vertices[idx0], vertices[idx0 + 1], vertices[idx0 + 2]);
        Eigen::Vector3d v1(vertices[idx1], vertices[idx1 + 1], vertices[idx1 + 2]);
        Eigen::Vector3d v2(vertices[idx2], vertices[idx2 + 1], vertices[idx2 + 2]);
        
        triangles_.emplace_back(v0, v1, v2, static_cast<int>(fi / 3));
    }
    
    if (triangles_.empty()) {
        root_ = nullptr;
        return;
    }
    
    // 创建所有三角形的索引列表
    std::vector<int> all_indices(triangles_.size());
    for (size_t i = 0; i < triangles_.size(); ++i) {
        all_indices[i] = static_cast<int>(i);
    }
    
    // 递归构建 BVH
    root_ = buildRecursive(all_indices, 0);
}

/// @brief 递归二分三角形集合，构建 BVH 子树
std::unique_ptr<BVHNode> BVHTree::buildRecursive(
    const std::vector<int>& triangle_indices,
    int depth) {
    
    if (triangle_indices.empty()) {
        return nullptr;
    }
    
    // 创建节点
    auto node = std::make_unique<BVHNode>();
    node->bbox = computeBoundingBox(triangle_indices);
    
    // 终止条件：三角形数量少或深度过大
    if (triangle_indices.size() <= static_cast<size_t>(MAX_TRIANGLES_PER_LEAF) ||
        depth >= MAX_DEPTH) {
        node->is_leaf = true;
        node->triangle_indices = triangle_indices;
        return node;
    }
    
    // 选择最优分割轴
    int split_axis = chooseBestSplitAxis(triangle_indices);
    
    // 找到最优分割位置
    double split_pos = findOptimalSplitPosition(triangle_indices, split_axis);
    
    // 分割三角形
    std::vector<int> left_indices, right_indices;
    splitTriangles(triangle_indices, split_axis, split_pos, left_indices, right_indices);
    
    // 如果分割失败（所有三角形在同一侧），创建叶子节点
    if (left_indices.empty() || right_indices.empty()) {
        node->is_leaf = true;
        node->triangle_indices = triangle_indices;
        return node;
    }
    
    // 递归构建左右子树
    node->left = buildRecursive(left_indices, depth + 1);
    node->right = buildRecursive(right_indices, depth + 1);
    
    return node;
}

/// @brief 计算一组三角形的合并 AABB
AABB BVHTree::computeBoundingBox(const std::vector<int>& triangle_indices) const {
    AABB bbox;
    
    for (int idx : triangle_indices) {
        const Triangle& tri = triangles_[idx];
        bbox.expand(tri.v0);
        bbox.expand(tri.v1);
        bbox.expand(tri.v2);
    }
    
    return bbox;
}

/// @brief 选择 AABB 最长轴作为分割轴
int BVHTree::chooseBestSplitAxis(const std::vector<int>& triangle_indices) const {
    AABB bbox = computeBoundingBox(triangle_indices);
    Eigen::Vector3d size = bbox.size();
    
    // 选择最长的轴
    if (size.x() >= size.y() && size.x() >= size.z()) return 0;
    if (size.y() >= size.z()) return 1;
    return 2;
}

/// @brief 用中位数确定分割位置
double BVHTree::findOptimalSplitPosition(
    const std::vector<int>& triangle_indices,
    int axis) const {
    
    // 收集所有三角形中心在该轴上的值
    std::vector<double> centers;
    centers.reserve(triangle_indices.size());
    
    for (int idx : triangle_indices) {
        centers.push_back(triangles_[idx].center()[axis]);
    }
    
    // 使用中位数作为分割位置
    size_t n = centers.size();
    std::nth_element(centers.begin(), centers.begin() + n / 2, centers.end());
    
    if (n % 2 == 0) {
        double median1 = centers[n / 2];
        std::nth_element(centers.begin(), centers.begin() + n / 2 - 1, centers.end());
        double median2 = centers[n / 2 - 1];
        return (median1 + median2) / 2.0;
    } else {
        return centers[n / 2];
    }
}

/// @brief 按分割轴和位置将三角形分到左右两组
void BVHTree::splitTriangles(
    const std::vector<int>& triangle_indices,
    int axis, double split_pos,
    std::vector<int>& left_indices,
    std::vector<int>& right_indices) const {
    
    left_indices.clear();
    right_indices.clear();
    
    for (int idx : triangle_indices) {
        double center = triangles_[idx].center()[axis];
        if (center < split_pos) {
            left_indices.push_back(idx);
        } else {
            right_indices.push_back(idx);
        }
    }
}

/// @brief 射线-AABB 相交测试（slab 方法）
bool BVHTree::rayIntersectsAABB(const Ray& ray, const AABB& bbox) const {
    const double epsilon = 1e-9;
    double tmin = 0.0;
    double tmax = std::numeric_limits<double>::max();
    
    for (int i = 0; i < 3; ++i) {
        if (std::abs(ray.direction[i]) < epsilon) {
            // 射线平行于该轴
            if (ray.origin[i] < bbox.min[i] || ray.origin[i] > bbox.max[i]) {
                return false;  // 射线在包围盒外
            }
        } else {
            double inv_dir = 1.0 / ray.direction[i];
            double t1 = (bbox.min[i] - ray.origin[i]) * inv_dir;
            double t2 = (bbox.max[i] - ray.origin[i]) * inv_dir;
            
            if (t1 > t2) std::swap(t1, t2);
            
            tmin = std::max(tmin, t1);
            tmax = std::min(tmax, t2);
            
            if (tmin > tmax) {
                return false;  // 不相交
            }
        }
    }
    
    return true;  // 相交
}

/// @brief 射线-三角形相交测试（Möller-Trumbore 算法）
bool BVHTree::rayTriangleIntersect(const Ray& ray, const Triangle& tri, double& t) const {
    const Eigen::Vector3d& v0 = tri.v0;
    const Eigen::Vector3d& v1 = tri.v1;
    const Eigen::Vector3d& v2 = tri.v2;
    
    const Eigen::Vector3d edge1 = v1 - v0;
    const Eigen::Vector3d edge2 = v2 - v0;
    
    const Eigen::Vector3d h = ray.direction.cross(edge2);
    const double a = edge1.dot(h);
    
    const double epsilon = 1e-9;
    if (std::abs(a) < epsilon) {
        return false;  // 射线与三角形平行
    }
    
    const double f = 1.0 / a;
    const Eigen::Vector3d s = ray.origin - v0;
    const double u = f * s.dot(h);
    
    if (u < 0.0 || u > 1.0) {
        return false;
    }
    
    const Eigen::Vector3d q = s.cross(edge1);
    const double v = f * ray.direction.dot(q);
    
    if (v < 0.0 || u + v > 1.0) {
        return false;
    }
    
    t = f * edge2.dot(q);
    return t > epsilon;  // t > 0 表示射线从三角形前方相交
}

/// @brief 递归遍历 BVH 统计射线与三角形的交点数
void BVHTree::rayCastRecursive(const Ray& ray, const BVHNode* node,
                               int& intersection_count) const {
    if (!node) return;
    
    // 快速剪枝：检查射线是否与节点包围盒相交
    if (!rayIntersectsAABB(ray, node->bbox)) {
        return;  // 跳过整个子树
    }
    
    if (node->is_leaf) {
        // 叶子节点：检查所有三角形
        for (int idx : node->triangle_indices) {
            double t;
            if (rayTriangleIntersect(ray, triangles_[idx], t)) {
                intersection_count++;
            }
        }
    } else {
        // 递归检查左右子树
        if (node->left) {
            rayCastRecursive(ray, node->left.get(), intersection_count);
        }
        if (node->right) {
            rayCastRecursive(ray, node->right.get(), intersection_count);
        }
    }
}

/// @brief 用射线奇偶法判断点是否在网格内部
bool BVHTree::isPointInside(const Eigen::Vector3d& point) const {
    if (!root_) return false;
    
    // 构建射线（与当前实现一致：+X 方向，带微偏移）
    const Eigen::Vector3d ray_dir(1, 0, 0);
    const Eigen::Vector3d ray_origin = point + ray_dir * 1e-4;
    Ray ray(ray_origin, ray_dir);
    
    int intersection_count = 0;
    rayCastRecursive(ray, root_.get(), intersection_count);
    
    // 奇偶法判断内外
    return (intersection_count % 2 == 1);
}

/// @brief 用重心坐标法计算点到三角形的最短距离
double BVHTree::pointTriangleDistance(const Eigen::Vector3d& point,
                                      const Triangle& tri) const {
    // 使用重心坐标方法计算点到三角形的最短距离
    const Eigen::Vector3d& v0 = tri.v0;
    const Eigen::Vector3d& v1 = tri.v1;
    const Eigen::Vector3d& v2 = tri.v2;
    
    Eigen::Vector3d edge0 = v1 - v0;
    Eigen::Vector3d edge1 = v2 - v0;
    Eigen::Vector3d v0_to_point = point - v0;
    
    double a = edge0.dot(edge0);
    double b = edge0.dot(edge1);
    double c = edge1.dot(edge1);
    double d = edge0.dot(v0_to_point);
    double e = edge1.dot(v0_to_point);
    
    double det = a * c - b * b;
    double s = b * e - c * d;
    double t = b * d - a * e;
    
    if (s + t < det) {
        if (s < 0.0) {
            if (t < 0.0) {
                // 区域 4：最近点是 v0
                return (point - v0).norm();
            } else {
                // 区域 3：最近点在边 v0-v2
                s = 0.0;
                t = std::max(0.0, std::min(1.0, e / c));
            }
        } else if (t < 0.0) {
            // 区域 5：最近点在边 v0-v1
            s = std::max(0.0, std::min(1.0, d / a));
            t = 0.0;
        } else {
            // 区域 0：在三角形内部
            double inv_det = 1.0 / det;
            s *= inv_det;
            t *= inv_det;
        }
    } else {
        if (s < 0.0) {
            // 区域 2：最近点在边 v1-v2
            double tmp0 = b + d;
            double tmp1 = c + e;
            if (tmp1 > tmp0) {
                double numer = tmp1 - tmp0;
                double denom = a - 2 * b + c;
                s = std::max(0.0, std::min(1.0, numer / denom));
                t = 1.0 - s;
            } else {
                t = std::max(0.0, std::min(1.0, tmp1 / c));
                s = 0.0;
            }
        } else if (t < 0.0) {
            // 区域 6：最近点在边 v1-v2
            if (a + d > b + e) {
                double numer = c + e - b - d;
                double denom = a - 2 * b + c;
                s = std::max(0.0, std::min(1.0, numer / denom));
                t = 1.0 - s;
            } else {
                s = std::max(0.0, std::min(1.0, (c + e) / c));
                t = 0.0;
            }
        } else {
            // 区域 1：最近点在边 v1-v2
            double numer = c + e - b - d;
            if (numer <= 0.0) {
                s = 0.0;
            } else {
                double denom = a - 2 * b + c;
                s = (numer >= denom) ? 1.0 : (numer / denom);
            }
            t = 1.0 - s;
        }
    }
    
    Eigen::Vector3d closest_point = v0 + s * edge0 + t * edge1;
    return (point - closest_point).norm();
}

/// @brief 递归遍历 BVH 找最近三角形，用 AABB 距离剪枝
void BVHTree::findClosestPointRecursive(const Eigen::Vector3d& point,
                                       const BVHNode* node,
                                       double& best_dist_sq,
                                       Eigen::Vector3d& best_point) const {
    if (!node) return;
    
    // 计算点到包围盒的最短距离（用于剪枝）
    Eigen::Vector3d bbox_closest;
    for (int i = 0; i < 3; ++i) {
        bbox_closest[i] = std::max(node->bbox.min[i],
                                   std::min(point[i], node->bbox.max[i]));
    }
    double dist_to_bbox_sq = (point - bbox_closest).squaredNorm();
    
    if (dist_to_bbox_sq >= best_dist_sq) {
        return;  // 剪枝：这个节点不可能包含更近的点
    }
    
    if (node->is_leaf) {
        // 叶子节点：检查所有三角形
        for (int idx : node->triangle_indices) {
            double dist = pointTriangleDistance(point, triangles_[idx]);
            double dist_sq = dist * dist;
            if (dist_sq < best_dist_sq) {
                best_dist_sq = dist_sq;
                // 计算最近点（简化版本，使用三角形中心）
                best_point = triangles_[idx].center();
            }
        }
    } else {
        // 递归检查左右子树
        if (node->left) {
            findClosestPointRecursive(point, node->left.get(), best_dist_sq, best_point);
        }
        if (node->right) {
            findClosestPointRecursive(point, node->right.get(), best_dist_sq, best_point);
        }
    }
}

/// @brief 计算点到网格的符号距离（负=内部，正=外部）
double BVHTree::signedDistance(const Eigen::Vector3d& point) const {
    if (!root_) {
        return std::numeric_limits<double>::max();
    }
    
    // 判断内外
    bool inside = isPointInside(point);
    
    // 计算最短距离
    double best_dist_sq = std::numeric_limits<double>::max();
    Eigen::Vector3d best_point;
    findClosestPointRecursive(point, root_.get(), best_dist_sq, best_point);
    
    double distance = std::sqrt(best_dist_sq);
    return inside ? -distance : distance;
}
