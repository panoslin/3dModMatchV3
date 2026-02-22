#ifndef BVH_H
#define BVH_H

#include <vector>
#include <memory>
#include <limits>
#include <Eigen/Dense>

// 轴对齐包围盒（AABB）
struct AABB {
    Eigen::Vector3d min;
    Eigen::Vector3d max;
    
    AABB() : min(Eigen::Vector3d::Constant(std::numeric_limits<double>::max())),
             max(Eigen::Vector3d::Constant(std::numeric_limits<double>::lowest())) {}
    
    AABB(const Eigen::Vector3d& min_val, const Eigen::Vector3d& max_val)
        : min(min_val), max(max_val) {}
    
    // 扩展包围盒以包含点
    void expand(const Eigen::Vector3d& point) {
        min = min.cwiseMin(point);
        max = max.cwiseMax(point);
    }
    
    // 扩展包围盒以包含另一个包围盒
    void expand(const AABB& other) {
        min = min.cwiseMin(other.min);
        max = max.cwiseMax(other.max);
    }
    
    // 计算包围盒中心
    Eigen::Vector3d center() const {
        return (min + max) * 0.5;
    }
    
    // 计算包围盒尺寸
    Eigen::Vector3d size() const {
        return max - min;
    }
    
    // 计算包围盒表面积（用于表面积启发式）
    double surfaceArea() const {
        Eigen::Vector3d s = size();
        return 2.0 * (s.x() * s.y() + s.y() * s.z() + s.z() * s.x());
    }
};

// 射线结构
struct Ray {
    Eigen::Vector3d origin;
    Eigen::Vector3d direction;
    
    Ray() {}
    Ray(const Eigen::Vector3d& o, const Eigen::Vector3d& d)
        : origin(o), direction(d.normalized()) {}
};

// 三角形结构（用于 BVH）
struct Triangle {
    Eigen::Vector3d v0, v1, v2;
    int face_index;  // 原始面索引
    
    Triangle() : face_index(-1) {}
    Triangle(const Eigen::Vector3d& a, const Eigen::Vector3d& b, const Eigen::Vector3d& c, int idx)
        : v0(a), v1(b), v2(c), face_index(idx) {}
    
    // 计算三角形中心
    Eigen::Vector3d center() const {
        return (v0 + v1 + v2) / 3.0;
    }
    
    // 计算三角形包围盒
    AABB boundingBox() const {
        AABB bbox;
        bbox.expand(v0);
        bbox.expand(v1);
        bbox.expand(v2);
        return bbox;
    }
};

// BVH 节点
struct BVHNode {
    AABB bbox;                              // 包围盒
    std::vector<int> triangle_indices;       // 叶子节点：三角形索引
    std::unique_ptr<BVHNode> left;          // 左子树
    std::unique_ptr<BVHNode> right;          // 右子树
    bool is_leaf;                           // 是否为叶子节点
    
    BVHNode() : is_leaf(false) {}
};

// BVH 树类
class BVHTree {
public:
    BVHTree() : root_(nullptr) {}
    
    // 从网格构建 BVH
    void build(const std::vector<double>& vertices,
               const std::vector<int>& faces);
    
    // 判断点是否在网格内部（使用射线投射法）
    bool isPointInside(const Eigen::Vector3d& point) const;
    
    // 计算点到网格的符号距离
    double signedDistance(const Eigen::Vector3d& point) const;
    
    // 获取根节点（用于调试）
    const BVHNode* getRoot() const { return root_.get(); }
    
private:
    std::unique_ptr<BVHNode> root_;
    std::vector<Triangle> triangles_;  // 存储所有三角形
    
    // 构建 BVH 的递归函数
    std::unique_ptr<BVHNode> buildRecursive(
        const std::vector<int>& triangle_indices,
        int depth = 0);
    
    // 计算一组三角形的包围盒
    AABB computeBoundingBox(const std::vector<int>& triangle_indices) const;
    
    // 选择最优分割轴和位置（使用表面积启发式 SAH）
    int chooseBestSplitAxis(const std::vector<int>& triangle_indices) const;
    double findOptimalSplitPosition(const std::vector<int>& triangle_indices,
                                     int axis) const;
    
    // 分割三角形索引
    void splitTriangles(const std::vector<int>& triangle_indices,
                       int axis, double split_pos,
                       std::vector<int>& left_indices,
                       std::vector<int>& right_indices) const;
    
    // 射线-包围盒相交测试
    bool rayIntersectsAABB(const Ray& ray, const AABB& bbox) const;
    
    // 射线-三角形相交测试（Möller-Trumbore 算法）
    bool rayTriangleIntersect(const Ray& ray, const Triangle& tri, double& t) const;
    
    // BVH 射线投射（递归）
    void rayCastRecursive(const Ray& ray, const BVHNode* node,
                         int& intersection_count) const;
    
    // 计算点到三角形的最短距离
    double pointTriangleDistance(const Eigen::Vector3d& point,
                                const Triangle& tri) const;
    
    // BVH 最近点查询（递归）
    void findClosestPointRecursive(const Eigen::Vector3d& point,
                                   const BVHNode* node,
                                   double& best_dist_sq,
                                   Eigen::Vector3d& best_point) const;
    
    // 常量
    static const int MAX_TRIANGLES_PER_LEAF = 10;  // 叶子节点最大三角形数
    static const int MAX_DEPTH = 20;                // 最大树深度
};

#endif // BVH_H
