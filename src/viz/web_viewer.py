#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
3DM 文件网页查看器后端服务

提供 RESTful API 用于上传和读取 3DM 文件，返回顶点和面数据供前端显示。
"""

import os
import sys
import math
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import tempfile
import json
import numpy as np

# 添加项目根目录到路径
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root / 'src' / 'biz'))

from load_3dm import load_3dm_file, get_3dm_file_info, ThreeDMFileError

# 尝试导入匹配模块（可选）
try:
    import mesh_matcher
    MATCHER_AVAILABLE = True
except ImportError:
    MATCHER_AVAILABLE = False
    print("警告: mesh_matcher 模块不可用，匹配功能将被禁用")

# 设置静态文件目录（兼容本地和 Docker 环境）
static_folder = Path(__file__).parent / 'static'
app = Flask(__name__, static_folder=str(static_folder), static_url_path='')
CORS(app)  # 允许跨域请求

# 配置
UPLOAD_FOLDER = tempfile.gettempdir()
ALLOWED_EXTENSIONS = {'3dm'}
MAX_FILE_SIZE = 100 * 1024 * 1024  # 100MB


def allowed_file(filename):
    """检查文件扩展名是否允许"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


@app.route('/')
def index():
    """返回主页面"""
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/api/upload', methods=['POST'])
def upload_file():
    """处理文件上传"""
    if 'file' not in request.files:
        return jsonify({'error': '没有文件被上传'}), 400
    
    file = request.files['file']
    
    if file.filename == '':
        return jsonify({'error': '没有选择文件'}), 400
    
    if not allowed_file(file.filename):
        return jsonify({'error': '不支持的文件格式，请上传 .3dm 文件'}), 400
    
    try:
        # 保存临时文件
        temp_path = os.path.join(UPLOAD_FOLDER, file.filename)
        file.save(temp_path)
        
        # 检查文件大小
        file_size = os.path.getsize(temp_path)
        if file_size > MAX_FILE_SIZE:
            os.remove(temp_path)
            return jsonify({'error': f'文件太大，最大允许 {MAX_FILE_SIZE / 1024 / 1024}MB'}), 400
        
        # 获取文件信息
        info = get_3dm_file_info(temp_path)
        
        # 读取网格质量参数（从请求中获取，默认为 'medium'）
        mesh_quality = request.form.get('mesh_quality', 'medium')
        
        # 加载 3DM 文件
        vertices, faces = load_3dm_file(temp_path, mesh_quality=mesh_quality)
        
        # 计算三个轴（与C++算法保持一致）
        axes_data = None
        if MATCHER_AVAILABLE:
            try:
                # 计算纵向轴
                longitudinal_axis = np.array(mesh_matcher.MeshMatcher.compute_longitudinal_axis(
                    vertices.flatten().tolist(), faces.flatten().tolist()
                ))
                longitudinal_axis = longitudinal_axis / np.linalg.norm(longitudinal_axis)
                
                # 计算垂直轴
                vertical_axis = np.array(mesh_matcher.MeshMatcher.compute_vertical_axis(
                    vertices.flatten().tolist(), faces.flatten().tolist()
                ))
                vertical_axis = vertical_axis / np.linalg.norm(vertical_axis)
                
                # 计算横向轴（纵向轴和垂直轴的叉积）
                lateral_axis = np.cross(longitudinal_axis, vertical_axis)
                lateral_axis = lateral_axis / np.linalg.norm(lateral_axis)
                
                # 计算质心
                center = np.mean(vertices, axis=0)
                
                axes_data = {
                    'center': center.tolist(),
                    'longitudinal_axis': longitudinal_axis.tolist(),
                    'vertical_axis': vertical_axis.tolist(),
                    'lateral_axis': lateral_axis.tolist()
                }
            except Exception as e:
                print(f"警告: 计算轴时出错: {str(e)}")
        
        # 清理临时文件
        os.remove(temp_path)
        
        # 转换为列表格式（JSON 序列化）
        result = {
            'success': True,
            'info': info,
            'vertices': vertices.tolist(),
            'faces': faces.tolist(),
            'stats': {
                'vertex_count': len(vertices),
                'face_count': len(faces),
                'bounds': {
                    'x': [float(vertices[:, 0].min()), float(vertices[:, 0].max())],
                    'y': [float(vertices[:, 1].min()), float(vertices[:, 1].max())],
                    'z': [float(vertices[:, 2].min()), float(vertices[:, 2].max())]
                }
            }
        }
        
        # 如果计算了轴，添加到结果中
        if axes_data:
            result['axes'] = axes_data
        
        return jsonify(result)
        
    except ThreeDMFileError as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({'error': f'处理文件时发生错误: {str(e)}'}), 500


@app.route('/api/info', methods=['POST'])
def get_file_info():
    """获取文件信息（不加载完整数据）"""
    if 'file' not in request.files:
        return jsonify({'error': '没有文件被上传'}), 400
    
    file = request.files['file']
    
    if file.filename == '':
        return jsonify({'error': '没有选择文件'}), 400
    
    if not allowed_file(file.filename):
        return jsonify({'error': '不支持的文件格式，请上传 .3dm 文件'}), 400
    
    try:
        # 保存临时文件
        temp_path = os.path.join(UPLOAD_FOLDER, file.filename)
        file.save(temp_path)
        
        # 获取文件信息
        info = get_3dm_file_info(temp_path)
        
        # 清理临时文件
        os.remove(temp_path)
        
        return jsonify({'success': True, 'info': info})
        
    except ThreeDMFileError as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({'error': f'处理文件时发生错误: {str(e)}'}), 500


@app.route('/api/match', methods=['POST'])
def match_files():
    """执行匹配算法并返回转换矩阵和匹配结果"""
    if not MATCHER_AVAILABLE:
        return jsonify({'error': '匹配模块不可用，请确保已编译 C++ 模块'}), 503
    
    if 'target_file' not in request.files or 'candidate_file' not in request.files:
        return jsonify({'error': '需要上传两个文件：target_file (鞋模) 和 candidate_file (粗胚)'}), 400
    
    target_file = request.files['target_file']
    candidate_file = request.files['candidate_file']
    
    if target_file.filename == '' or candidate_file.filename == '':
        return jsonify({'error': '请选择两个文件'}), 400
    
    if not allowed_file(target_file.filename) or not allowed_file(candidate_file.filename):
        return jsonify({'error': '不支持的文件格式，请上传 .3dm 文件'}), 400
    
    target_path = None
    candidate_path = None
    
    try:
        # 保存临时文件
        target_path = os.path.join(UPLOAD_FOLDER, f'target_{target_file.filename}')
        candidate_path = os.path.join(UPLOAD_FOLDER, f'candidate_{candidate_file.filename}')
        
        target_file.save(target_path)
        candidate_file.save(candidate_path)
        
        # 读取网格质量参数
        mesh_quality = request.form.get('mesh_quality', 'high')
        
        # 加载文件
        target_vertices, target_faces = load_3dm_file(target_path, mesh_quality=mesh_quality)
        candidate_vertices, candidate_faces = load_3dm_file(candidate_path, mesh_quality=mesh_quality)
        
        # 创建匹配器
        matcher = mesh_matcher.MeshMatcher()
        matcher.load_target_mesh(target_vertices, target_faces)
        
        if not matcher.load_candidate_mesh(candidate_vertices, candidate_faces):
            return jsonify({'error': '无法加载网格数据'}), 400
        
        # 执行匹配
        wrapping_threshold = float(request.form.get('wrapping_threshold', 0.99))
        
        # 创建 GA 参数，使用目标包裹率（默认96%）
        ga_params = mesh_matcher.GeneticAlgorithmParams()
        ga_params.target_wrapping_ratio = wrapping_threshold  # 使用前端传入的目标包裹率
        
        result = matcher.match_optimized(
            wrapping_threshold=wrapping_threshold,
            ga_params=ga_params
        )
        
        # =========================
        # 同步 C++ alignDirections：旋转鞋模（target）以与粗胚（candidate）方向对齐
        # 注意：match_optimized 内部会对齐方向并在对齐后的坐标系里计算包裹率/优化；
        # 前端若仍显示“未对齐的鞋模 + 已优化粗胚”，会造成肉眼判断与后端数值不一致。
        # 这里在 API 层复刻 C++ alignDirections 的旋转矩阵并应用到 target_vertices，
        # 使可视化与后端包裹率计算的坐标系一致。
        # =========================
        def _normalize(v: np.ndarray) -> np.ndarray:
            n = np.linalg.norm(v)
            return v if n == 0 else (v / n)

        def _build_frame(longitudinal: np.ndarray, vertical: np.ndarray) -> np.ndarray:
            # 对齐 matcher.cpp::alignDirections 的 frame 构建逻辑
            x = _normalize(longitudinal)
            side = np.cross(x, vertical)
            if np.linalg.norm(side) < 1e-6:
                if abs(x[0]) < 0.9:
                    side = np.cross(x, np.array([1.0, 0.0, 0.0]))
                else:
                    side = np.cross(x, np.array([0.0, 1.0, 0.0]))
            y = _normalize(side)
            z = _normalize(np.cross(x, y))
            return np.column_stack([x, y, z])

        target_longitudinal_axis = np.array(mesh_matcher.MeshMatcher.compute_longitudinal_axis(
            target_vertices.flatten().tolist(), target_faces.flatten().tolist()
        ), dtype=float)
        target_longitudinal_axis = _normalize(target_longitudinal_axis)

        target_vertical_axis = np.array(mesh_matcher.MeshMatcher.compute_vertical_axis(
            target_vertices.flatten().tolist(), target_faces.flatten().tolist()
        ), dtype=float)
        target_vertical_axis = _normalize(target_vertical_axis)

        candidate_longitudinal_axis = np.array(mesh_matcher.MeshMatcher.compute_longitudinal_axis(
            candidate_vertices.flatten().tolist(), candidate_faces.flatten().tolist()
        ), dtype=float)
        candidate_longitudinal_axis = _normalize(candidate_longitudinal_axis)

        candidate_vertical_axis = np.array(mesh_matcher.MeshMatcher.compute_vertical_axis(
            candidate_vertices.flatten().tolist(), candidate_faces.flatten().tolist()
        ), dtype=float)
        candidate_vertical_axis = _normalize(candidate_vertical_axis)

        target_frame = _build_frame(target_longitudinal_axis, target_vertical_axis)
        candidate_frame = _build_frame(candidate_longitudinal_axis, candidate_vertical_axis)
        rotation_matrix_align = candidate_frame @ target_frame.T

        # 旋转 target 顶点（绕 target 质心旋转）
        target_center = np.mean(target_vertices, axis=0)
        target_vertices_aligned = target_vertices - target_center
        target_vertices_aligned = (rotation_matrix_align @ target_vertices_aligned.T).T + target_center

        # 计算纵向轴和质心（用于构建转换矩阵）
        longitudinal_axis = np.array(mesh_matcher.MeshMatcher.compute_longitudinal_axis(
            candidate_vertices.flatten().tolist(), candidate_faces.flatten().tolist()
        ))
        longitudinal_axis = longitudinal_axis / np.linalg.norm(longitudinal_axis)  # 归一化
        
        # 计算候选网格质心
        candidate_center = np.mean(candidate_vertices, axis=0)
        
        # 重新计算目标（鞋模）在“对齐后坐标系”下的轴与质心（用于可视化同步）
        target_longitudinal_axis_aligned = np.array(mesh_matcher.MeshMatcher.compute_longitudinal_axis(
            target_vertices_aligned.flatten().tolist(), target_faces.flatten().tolist()
        ), dtype=float)
        target_longitudinal_axis_aligned = target_longitudinal_axis_aligned / np.linalg.norm(target_longitudinal_axis_aligned)

        target_vertical_axis_aligned = np.array(mesh_matcher.MeshMatcher.compute_vertical_axis(
            target_vertices_aligned.flatten().tolist(), target_faces.flatten().tolist()
        ), dtype=float)
        target_vertical_axis_aligned = target_vertical_axis_aligned / np.linalg.norm(target_vertical_axis_aligned)

        target_center_aligned = np.mean(target_vertices_aligned, axis=0)
        
        # 计算候选（粗胚）的纵向轴和垂直轴（原始）
        candidate_vertical_axis = np.array(mesh_matcher.MeshMatcher.compute_vertical_axis(
            candidate_vertices.flatten().tolist(), candidate_faces.flatten().tolist()
        ))
        candidate_vertical_axis = candidate_vertical_axis / np.linalg.norm(candidate_vertical_axis)
        
        # 构建转换矩阵
        # match_optimized 内部已经进行了方向对齐，所以我们只需要：
        # 1. 绕纵向轴旋转（optimal_rotation_angle_deg）
        # 2. 沿纵向轴平移（optimal_translation）
        
        # 构建绕纵向轴的旋转矩阵
        angle_rad = math.radians(result.optimal_rotation_angle_deg)
        cos_a = math.cos(angle_rad)
        sin_a = math.sin(angle_rad)
        
        K = np.array([
            [0, -longitudinal_axis[2], longitudinal_axis[1]],
            [longitudinal_axis[2], 0, -longitudinal_axis[0]],
            [-longitudinal_axis[1], longitudinal_axis[0], 0]
        ])
        
        R_rotate = np.eye(3) + sin_a * K + (1 - cos_a) * np.dot(K, K)
        
        # 计算平移向量（沿纵向轴 + 横向轴）
        # 注意：当前 GA 优化维度 = 纵向位移 + 旋转角度 + 横向位移（垂直位移固定为0）
        candidate_lateral_axis = np.cross(longitudinal_axis, candidate_vertical_axis)
        if np.linalg.norm(candidate_lateral_axis) > 0:
            candidate_lateral_axis = candidate_lateral_axis / np.linalg.norm(candidate_lateral_axis)
        translation_vec = longitudinal_axis * result.optimal_translation + candidate_lateral_axis * float(getattr(result, 'optimal_lateral_offset', 0.0))
        
        # 构建 4x4 齐次变换矩阵
        # 注意：match_optimized 内部已经对齐了方向，所以这里只需要旋转和平移
        T = np.eye(4)
        T[:3, :3] = R_rotate
        T[:3, 3] = translation_vec
        
        transformation_matrix = T.tolist()
        
        # 应用转换矩阵到候选网格
        # 先平移到质心，旋转，再平移回去，最后沿纵向轴平移
        candidate_vertices_transformed = candidate_vertices.copy()
        for i in range(len(candidate_vertices_transformed)):
            v = candidate_vertices_transformed[i] - candidate_center
            v = R_rotate @ v
            v = v + candidate_center + translation_vec
            candidate_vertices_transformed[i] = v
        
        # 计算变换后的候选网格的纵向轴和垂直轴
        # 注意：变换后的纵向轴应该和原始的一样（因为只绕纵向轴旋转）
        # 但垂直轴会发生变化
        candidate_longitudinal_axis_transformed = longitudinal_axis.copy()  # 纵向轴不变
        candidate_vertical_axis_transformed = R_rotate @ candidate_vertical_axis  # 垂直轴会旋转
        candidate_vertical_axis_transformed = candidate_vertical_axis_transformed / np.linalg.norm(candidate_vertical_axis_transformed)
        candidate_center_transformed = candidate_center + translation_vec  # 质心会平移
        
        # 计算横向轴（纵向轴和垂直轴的叉积）
        # 目标（鞋模）的横向轴
        target_lateral_axis = np.cross(target_longitudinal_axis, target_vertical_axis)
        target_lateral_axis = target_lateral_axis / np.linalg.norm(target_lateral_axis)
        
        # 候选（粗胚）原始横向轴
        candidate_lateral_axis = np.cross(longitudinal_axis, candidate_vertical_axis)
        candidate_lateral_axis = candidate_lateral_axis / np.linalg.norm(candidate_lateral_axis)
        
        # 变换后的候选（粗胚）横向轴
        candidate_lateral_axis_transformed = np.cross(candidate_longitudinal_axis_transformed, candidate_vertical_axis_transformed)
        candidate_lateral_axis_transformed = candidate_lateral_axis_transformed / np.linalg.norm(candidate_lateral_axis_transformed)
        
        # 返回结果
        # 生成 GA 每代历史（用于前端回放）
        generation_history = []
        if hasattr(result, 'generation_history') and result.generation_history is not None:
            try:
                for s in result.generation_history:
                    generation_history.append({
                        'generation': int(getattr(s, 'generation', 0)),
                        'best_fitness': float(getattr(s, 'best_fitness', 0.0)),
                        'avg_fitness': float(getattr(s, 'avg_fitness', 0.0)),
                        'std_dev': float(getattr(s, 'std_dev', 0.0)),
                        'translation': float(getattr(s, 'translation', 0.0)),
                        'rotation_angle_deg': float(getattr(s, 'rotation_angle_deg', 0.0)),
                        'lateral_offset': float(getattr(s, 'lateral_offset', 0.0)),
                        'crossover_count': int(getattr(s, 'crossover_count', 0)),
                        'mutation_count': int(getattr(s, 'mutation_count', 0)),
                        'time_ms': float(getattr(s, 'time_ms', 0.0)),
                    })
            except Exception as e:
                print(f"警告: 读取 generation_history 失败: {e}")

        return jsonify({
            'success': True,
            'match_result': {
                'volume': result.volume,
                'wrapping_ratio': result.wrapping_ratio,
                'target_wrapping_ratio': wrapping_threshold,  # 添加目标包裹率
                'avg_clearance': float(getattr(result, 'avg_clearance', 0.0)),  # 平均间隙
                'optimal_translation': result.optimal_translation,
                'optimal_rotation_angle_deg': result.optimal_rotation_angle_deg,
                'optimal_lateral_offset': float(getattr(result, 'optimal_lateral_offset', 0.0)),
                'is_fully_wrapped': result.is_fully_wrapped,
                'meets_direction_constraints': result.meets_direction_constraints,
                'optimization_algorithm': 'ga',
                'generation_history': generation_history,
                'direction_alignment': {
                    'heel_toe_alignment': result.direction_alignment.heel_toe_alignment,
                    'vertical_alignment': result.direction_alignment.vertical_alignment,
                    'heel_toe_angle_deg': result.direction_alignment.heel_toe_angle_deg,
                    'vertical_angle_deg': result.direction_alignment.vertical_angle_deg
                }
            },
            'transformation_matrix': transformation_matrix,
            'longitudinal_axis': longitudinal_axis.tolist(),
            'candidate_center': candidate_center.tolist(),
            # 返回“已对齐”的鞋模顶点，使前端可视化与后端包裹率计算一致
            'target_vertices': target_vertices_aligned.tolist(),
            'target_faces': target_faces.tolist(),
            'candidate_vertices': candidate_vertices.tolist(),
            'candidate_faces': candidate_faces.tolist(),
            'candidate_vertices_transformed': candidate_vertices_transformed.tolist(),
            # 添加轴信息（包含三个轴：纵向轴、垂直轴、横向轴）
            'axes': {
                'target': {
                    'center': target_center_aligned.tolist(),
                    'longitudinal_axis': target_longitudinal_axis_aligned.tolist(),
                    'vertical_axis': target_vertical_axis_aligned.tolist(),
                    'lateral_axis': target_lateral_axis.tolist()
                },
                'candidate_original': {
                    'center': candidate_center.tolist(),
                    'longitudinal_axis': longitudinal_axis.tolist(),
                    'vertical_axis': candidate_vertical_axis.tolist(),
                    'lateral_axis': candidate_lateral_axis.tolist()
                },
                'candidate_transformed': {
                    'center': candidate_center_transformed.tolist(),
                    'longitudinal_axis': candidate_longitudinal_axis_transformed.tolist(),
                    'vertical_axis': candidate_vertical_axis_transformed.tolist(),
                    'lateral_axis': candidate_lateral_axis_transformed.tolist()
                }
            }
        })
        
    except ThreeDMFileError as e:
        return jsonify({'error': f'文件读取错误: {str(e)}'}), 400
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'匹配过程出错: {str(e)}'}), 500
    finally:
        # 清理临时文件
        if target_path and os.path.exists(target_path):
            os.remove(target_path)
        if candidate_path and os.path.exists(candidate_path):
            os.remove(candidate_path)


@app.route('/api/health', methods=['GET'])
def health():
    """健康检查端点"""
    return jsonify({
        'status': 'ok',
        'message': '3DM Viewer API is running',
        'matcher_available': MATCHER_AVAILABLE
    })


if __name__ == '__main__':
    # 确保静态文件目录存在
    static_dir = Path(__file__).parent / 'static'
    static_dir.mkdir(exist_ok=True)
    
    # 检查静态文件是否存在
    index_file = static_dir / 'index.html'
    if not index_file.exists():
        print(f"警告: 静态文件目录不存在或为空: {static_dir}")
        print(f"请确保 index.html 文件存在于 {static_dir}")
    
    print("=" * 60)
    print("3DM 文件网页查看器")
    print("=" * 60)
    print(f"静态文件目录: {static_dir}")
    print(f"访问地址: http://localhost:5000")
    print("=" * 60)
    
    # 在生产环境中关闭 debug 模式
    debug_mode = os.getenv('FLASK_ENV') != 'production'
    app.run(debug=debug_mode, host='0.0.0.0', port=5000)
