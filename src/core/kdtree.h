#ifndef KDTREE_H
#define KDTREE_H

#include <vector>
#include <memory>
#include <algorithm>
#include <limits>
#include <Eigen/Dense>

// 简单的KD-tree实现，用于加速最近邻搜索
class KDTree {
public:
    struct Node {
        Eigen::Vector3d point;
        int face_index;  // 面的索引
        std::shared_ptr<Node> left;
        std::shared_ptr<Node> right;
        int axis;  // 分割轴 (0=x, 1=y, 2=z)
        
        Node(const Eigen::Vector3d& p, int idx, int ax) 
            : point(p), face_index(idx), left(nullptr), right(nullptr), axis(ax) {}
    };
    
    KDTree() : root_(nullptr) {}
    
    // 构建KD-tree
    void build(const std::vector<Eigen::Vector3d>& points, const std::vector<int>& face_indices) {
        if (points.empty()) return;
        
        // 创建点-索引对
        std::vector<std::pair<Eigen::Vector3d, int>> points_with_indices;
        for (size_t i = 0; i < points.size(); ++i) {
            points_with_indices.push_back({points[i], face_indices[i]});
        }
        
        root_ = buildRecursive(points_with_indices, 0);
    }
    
    // 查找最近邻
    std::pair<Eigen::Vector3d, int> nearestNeighbor(const Eigen::Vector3d& query) const {
        if (!root_) {
            return {Eigen::Vector3d::Zero(), -1};
        }
        
        double best_dist = std::numeric_limits<double>::max();
        Eigen::Vector3d best_point;
        int best_index = -1;
        
        nearestNeighborRecursive(root_, query, 0, best_dist, best_point, best_index);
        
        return {best_point, best_index};
    }
    
    // 查找半径内的所有点
    void radiusSearch(const Eigen::Vector3d& query, double radius,
                     std::vector<std::pair<Eigen::Vector3d, int>>& results) const {
        results.clear();
        if (!root_) return;
        
        radiusSearchRecursive(root_, query, radius, 0, results);
    }
    
private:
    std::shared_ptr<Node> root_;
    
    std::shared_ptr<Node> buildRecursive(
        std::vector<std::pair<Eigen::Vector3d, int>>& points, int depth) {
        
        if (points.empty()) return nullptr;
        
        int axis = depth % 3;
        
        // 按当前轴排序
        std::sort(points.begin(), points.end(),
                 [axis](const std::pair<Eigen::Vector3d, int>& a,
                        const std::pair<Eigen::Vector3d, int>& b) {
                     return a.first[axis] < b.first[axis];
                 });
        
        // 选择中位数作为分割点
        size_t median = points.size() / 2;
        auto node = std::make_shared<Node>(points[median].first, 
                                          points[median].second, axis);
        
        // 递归构建左右子树
        if (median > 0) {
            std::vector<std::pair<Eigen::Vector3d, int>> left_points(
                points.begin(), points.begin() + median);
            node->left = buildRecursive(left_points, depth + 1);
        }
        
        if (median + 1 < points.size()) {
            std::vector<std::pair<Eigen::Vector3d, int>> right_points(
                points.begin() + median + 1, points.end());
            node->right = buildRecursive(right_points, depth + 1);
        }
        
        return node;
    }
    
    void nearestNeighborRecursive(
        const std::shared_ptr<Node>& node, const Eigen::Vector3d& query,
        int depth, double& best_dist, Eigen::Vector3d& best_point, int& best_index) const {
        
        if (!node) return;
        
        // 计算当前节点距离
        double dist = (node->point - query).squaredNorm();
        if (dist < best_dist) {
            best_dist = dist;
            best_point = node->point;
            best_index = node->face_index;
        }
        
        int axis = node->axis;
        double diff = query[axis] - node->point[axis];
        
        // 决定搜索哪个子树
        std::shared_ptr<Node> near = (diff < 0) ? node->left : node->right;
        std::shared_ptr<Node> far = (diff < 0) ? node->right : node->left;
        
        if (near) {
            nearestNeighborRecursive(near, query, depth + 1, best_dist, best_point, best_index);
        }
        
        // 如果分割平面可能包含更近的点，也搜索另一侧
        if (far && diff * diff < best_dist) {
            nearestNeighborRecursive(far, query, depth + 1, best_dist, best_point, best_index);
        }
    }
    
    void radiusSearchRecursive(
        const std::shared_ptr<Node>& node, const Eigen::Vector3d& query, double radius,
        int depth, std::vector<std::pair<Eigen::Vector3d, int>>& results) const {
        
        if (!node) return;
        
        double dist_sq = (node->point - query).squaredNorm();
        if (dist_sq <= radius * radius) {
            results.push_back({node->point, node->face_index});
        }
        
        int axis = node->axis;
        double diff = query[axis] - node->point[axis];
        
        // 决定搜索顺序
        std::shared_ptr<Node> near = (diff < 0) ? node->left : node->right;
        std::shared_ptr<Node> far = (diff < 0) ? node->right : node->left;
        
        if (near) {
            radiusSearchRecursive(near, query, radius, depth + 1, results);
        }
        
        if (far && std::abs(diff) <= radius) {
            radiusSearchRecursive(far, query, radius, depth + 1, results);
        }
    }
};

#endif // KDTREE_H
