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

        // 过滤退化三角形（零/极小面积，如两顶点重合）：其边投影分母为 0，
        // pointTriangleDistance 会产生 NaN；Release 构建的 -ffast-math 下
        // NaN 比较行为不可预测（实测既可能输出 nan 也可能污染 best 值）。
        // 从源头剔除，与 computePrincipalNormal 的 1e-9 防御一致。
        if ((v1 - v0).cross(v2 - v0).norm() < 1e-9) {
            continue;
        }

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

/// @brief 递归遍历 BVH 收集射线与三角形交点的 t 值
///
/// 收集 t 而不是直接计数：射线恰好穿过两个三角形的公共边/顶点时，
/// 同一几何交点会被相邻三角形各命中一次（Möller-Trumbore 的 u,v 边界
/// 是闭区间），直接计数会导致奇偶翻转。调用方对 t 去重后再做奇偶判定。
void BVHTree::rayCastRecursive(const Ray& ray, const BVHNode* node,
                               std::vector<double>& hit_ts) const {
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
                hit_ts.push_back(t);
            }
        }
    } else {
        // 递归检查左右子树
        if (node->left) {
            rayCastRecursive(ray, node->left.get(), hit_ts);
        }
        if (node->right) {
            rayCastRecursive(ray, node->right.get(), hit_ts);
        }
    }
}

/// @brief 对射线交点 t 值排序去重后返回穿越次数
///
/// 去重容差：同一几何交点被多个共边三角形命中时 t 相差 <1e-12；
/// 真实的两次独立穿越至少间隔网格特征尺寸（mm 量级）。取 1e-6mm。
static int countUniqueCrossings(std::vector<double>& hit_ts) {
    if (hit_ts.empty()) return 0;
    std::sort(hit_ts.begin(), hit_ts.end());
    int unique_count = 1;
    for (size_t i = 1; i < hit_ts.size(); ++i) {
        if (hit_ts[i] - hit_ts[i - 1] > 1e-6) {
            ++unique_count;
        }
    }
    return unique_count;
}

/// @brief 用 3 条正交射线的奇偶投票法判断点是否在网格内部
///
/// 单射线奇偶法（+X）在以下情形下不稳定：
/// - 射线恰好穿过三角形边或顶点（数值边界），导致交点计数偶偶翻转
/// - 网格非水密（存在开口），射线从开口穿入后无出射面 → 判为"外"
/// - 网格 winding 不一致，相邻三角形翻转法线不影响交点数，但影响贴面点稳定性
///
/// 多射线投票（+X / +Y / +Z 三个正交方向，简单多数，≥2 为内）显著提升对
/// 非水密、winding 不一致、surface-coincident 点的鲁棒性。
bool BVHTree::isPointInside(const Eigen::Vector3d& point) const {
    if (!root_) return false;

    static const Eigen::Vector3d directions[3] = {
        Eigen::Vector3d(1.0, 0.0, 0.0),
        Eigen::Vector3d(0.0, 1.0, 0.0),
        Eigen::Vector3d(0.0, 0.0, 1.0)
    };

    int inside_votes = 0;
    std::vector<double> hit_ts;
    hit_ts.reserve(16);
    for (int d = 0; d < 3; ++d) {
        const Eigen::Vector3d& dir = directions[d];
        // 射线起点沿射线方向做一个极小偏移，避免"恰好在表面"导致奇偶翻转
        Ray ray(point + dir * 1e-4, dir);
        hit_ts.clear();
        rayCastRecursive(ray, root_.get(), hit_ts);
        // t 去重：射线穿过公共边/顶点时相邻三角形会重复命中同一交点
        if (countUniqueCrossings(hit_ts) % 2 == 1) ++inside_votes;
    }

    return inside_votes >= 2;
}

/// @brief 计算点到三角形的最短距离
///
/// Reference: Real-Time Collision Detection (Christer Ericson),
/// ClosestPtPointTriangle。与旧实现（Eberly 变体）相比修复了
/// d/e 采用 point-v0 约定但 s/t 判别式未同步取反导致的区域误判
/// （实测：点到 [0,10]³ 立方体中心距离 5 被算成 7.071）。
double BVHTree::pointTriangleDistance(const Eigen::Vector3d& point,
                                      const Triangle& tri) const {
    const Eigen::Vector3d& a = tri.v0;
    const Eigen::Vector3d& b = tri.v1;
    const Eigen::Vector3d& c = tri.v2;

    Eigen::Vector3d ab = b - a;
    Eigen::Vector3d ac = c - a;
    Eigen::Vector3d ap = point - a;

    double d1 = ab.dot(ap);
    double d2 = ac.dot(ap);
    if (d1 <= 0.0 && d2 <= 0.0) return (point - a).norm();  // 顶点 A

    Eigen::Vector3d bp = point - b;
    double d3 = ab.dot(bp);
    double d4 = ac.dot(bp);
    if (d3 >= 0.0 && d4 <= d3) return (point - b).norm();   // 顶点 B

    double vc = d1 * d4 - d3 * d2;
    if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {              // 边 AB
        double v = d1 / (d1 - d3);
        return (point - (a + v * ab)).norm();
    }

    Eigen::Vector3d cp = point - c;
    double d5 = ab.dot(cp);
    double d6 = ac.dot(cp);
    if (d6 >= 0.0 && d5 <= d6) return (point - c).norm();   // 顶点 C

    double vb = d5 * d2 - d1 * d6;
    if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {              // 边 AC
        double w = d2 / (d2 - d6);
        return (point - (a + w * ac)).norm();
    }

    double va = d3 * d6 - d5 * d4;
    if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) { // 边 BC
        double w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return (point - (b + w * (c - b))).norm();
    }

    // 面内投影
    double denom = 1.0 / (va + vb + vc);
    double v = vb * denom;
    double w = vc * denom;
    return (point - (a + ab * v + ac * w)).norm();
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
