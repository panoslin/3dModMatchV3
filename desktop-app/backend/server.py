#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
3D模型匹配桌面应用后端服务
提供RESTful API接口
"""

import os
import sys

# Windows 中文系统默认 console 编码为 GBK，无法输出 emoji 等 Unicode 字符。
# 强制将 stdout/stderr 设为 UTF-8 以避免 UnicodeEncodeError。
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
import json
import struct
import sqlite3  # Python标准库，无需额外安装
import uuid
import threading
import queue
import time as _time
from pathlib import Path
from datetime import datetime, timezone, timedelta

try:
    import psutil as _psutil
    _PSUTIL_OK = True
except ImportError:
    _psutil = None
    _PSUTIL_OK = False

_SERVER_START_TIME = _time.time()

print(f"Python {sys.version}")
print(f"Executable: {sys.executable}")
print(f"Prefix: {sys.prefix}")
print(f"PYTHONHOME: {os.environ.get('PYTHONHOME', '(unset)')}")
sys.stdout.flush()

# 中国标准时间 UTC+8
_CST = timezone(timedelta(hours=8))


def now_cst() -> str:
    """返回当前中国标准时间的 ISO 格式字符串（含时区偏移）"""
    return datetime.now(_CST).strftime('%Y-%m-%dT%H:%M:%S+08:00')

print("导入 Flask...")
sys.stdout.flush()
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
print("Flask 导入成功")
sys.stdout.flush()

print("导入 numpy...")
sys.stdout.flush()
import tempfile
import re
import unicodedata


def safe_filename(filename: str) -> str:
    """Like secure_filename but preserves CJK characters.

    werkzeug's secure_filename strips all non-ASCII, which mangles Chinese
    filenames (e.g. 'B004小.3dm' → 'B004.3dm').  This version keeps CJK
    unified ideographs plus common CJK punctuation while still removing
    dangerous path components.
    """
    # Normalise unicode
    filename = unicodedata.normalize('NFC', filename)
    # Strip path separators
    for sep in (os.sep, os.altsep or '', '/', '\\'):
        if sep:
            filename = filename.replace(sep, '_')
    # Keep: word chars (includes CJK in Python \w), dots, hyphens, spaces
    filename = re.sub(r'[^\w.\- ]', '_', filename)
    # Collapse whitespace / underscores
    filename = re.sub(r'[\s_]+', '_', filename).strip('_. ')
    return filename or 'unnamed'
import numpy as np
print("numpy 导入成功")
sys.stdout.flush()

# 添加项目根目录到路径
# 在打包后的应用中，路径可能不同
backend_dir = Path(__file__).parent
project_root = backend_dir.parent.parent

# 尝试多个可能的路径
possible_paths = [
    project_root / 'src' / 'biz',  # 开发环境
    Path(__file__).parent.parent / 'src' / 'biz',  # 打包环境（resources/src/biz）
    backend_dir / '..' / 'src' / 'biz',  # 相对路径
]

for biz_path in possible_paths:
    biz_path = biz_path.resolve()
    if biz_path.exists():
        sys.path.insert(0, str(biz_path))
        print(f"添加Python路径: {biz_path}")
        break
else:
    # 如果都找不到，使用默认路径
    default_path = project_root / 'src' / 'biz'
    sys.path.insert(0, str(default_path))
    print(f"使用默认Python路径: {default_path}")

# 导入匹配模块
mesh_matcher = None
find_optimal_match = None
load_mesh_file = None
get_mesh_file_info = None
MATCHER_AVAILABLE = False
MATCHER_LOAD_ERROR = None

# Python 3.8+ restricts DLL search on Windows — native .pyd extensions can
# only resolve dependencies from: app dir, System32, and os.add_dll_directory().
# Explicitly register python.exe's dir (bundled vcruntime/vcomp/msvcp DLLs)
# and the src/biz dir (where the .pyd lives) so LoadLibrary finds them.
if sys.platform == 'win32' and hasattr(os, 'add_dll_directory'):
    for _dll_dir in [os.path.dirname(os.path.abspath(sys.executable))] + \
                     [str(p.resolve()) for p in possible_paths if p.resolve().exists()]:
        try:
            os.add_dll_directory(_dll_dir)
        except OSError:
            pass

try:
    print("导入 load_mesh..."); sys.stdout.flush()
    from load_mesh import load_mesh_file, get_mesh_file_info
    print("导入 mesh_matcher..."); sys.stdout.flush()
    import mesh_matcher
    print("导入 matcher..."); sys.stdout.flush()
    from matcher import find_optimal_match
    from transform_utils import normalize as _tf_normalize, compute_alignment_rotation, rodrigues_rotation
    MATCHER_AVAILABLE = True
    print("[OK] 匹配模块导入成功")
except ImportError as e:
    import traceback
    MATCHER_LOAD_ERROR = f"{type(e).__name__}: {e}"
    print(f"[WARN]  匹配模块导入失败: {MATCHER_LOAD_ERROR}")
    traceback.print_exc()


def _try_load_matcher():
    """重新尝试导入匹配模块（用于 /api/match/reload 端点）"""
    global mesh_matcher, find_optimal_match, load_mesh_file, get_mesh_file_info
    global MATCHER_AVAILABLE, MATCHER_LOAD_ERROR
    try:
        import importlib
        if load_mesh_file is None:
            from load_mesh import load_mesh_file as _l, get_mesh_file_info as _g
            load_mesh_file = _l
            get_mesh_file_info = _g
        if 'mesh_matcher' in sys.modules:
            mesh_matcher = importlib.reload(sys.modules['mesh_matcher'])
        else:
            mesh_matcher = importlib.import_module('mesh_matcher')
        if 'matcher' in sys.modules:
            _mod = importlib.reload(sys.modules['matcher'])
        else:
            _mod = importlib.import_module('matcher')
        find_optimal_match = getattr(_mod, 'find_optimal_match')
        MATCHER_AVAILABLE = True
        MATCHER_LOAD_ERROR = None
        print("[OK] 匹配模块重新加载成功")
        return True, None
    except Exception as e:
        import traceback
        err_msg = f"{type(e).__name__}: {e}"
        MATCHER_LOAD_ERROR = err_msg
        MATCHER_AVAILABLE = False
        print(f"[ERR] 匹配模块重新加载失败: {err_msg}")
        traceback.print_exc()
        return False, err_msg

app = Flask(__name__)
# 配置CORS，允许所有来源（开发环境）
CORS(app, resources={
    r"/api/*": {
        "origins": "*",
        "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"]
    }
})

# ── 测试模式：FLASK_SERVE_STATIC=1 时从 Flask 提供前端静态文件 ──
if os.getenv('FLASK_SERVE_STATIC') == '1':
    _FRONTEND_DIR = Path(__file__).resolve().parent.parent  # desktop-app/

    @app.route('/')
    def _serve_index():
        return send_from_directory(str(_FRONTEND_DIR), 'index.html')

    @app.route('/js/<path:filename>')
    def _serve_js(filename):
        return send_from_directory(str(_FRONTEND_DIR / 'js'), filename)

    @app.route('/styles/<path:filename>')
    def _serve_styles(filename):
        return send_from_directory(str(_FRONTEND_DIR / 'styles'), filename)

# 配置数据目录
# 在打包后的应用中，使用用户可写的目录
# 在开发环境中，使用项目目录
def get_data_dir():
    """获取数据目录路径"""
    backend_dir = Path(__file__).parent
    
    # 检查是否在打包后的应用中（路径包含.app/Contents/Resources）
    if '.app/Contents/Resources' in str(backend_dir) or 'Contents/Resources' in str(backend_dir):
        # 打包后的应用：使用用户目录
        home = Path.home()
        app_data_dir = home / 'Library' / 'Application Support' / '3D模型匹配系统'
        return app_data_dir
    else:
        # 开发环境：使用项目目录
        return backend_dir.parent / 'data'

DATA_DIR = get_data_dir()
UPLOAD_DIR = DATA_DIR / 'uploads'
DB_PATH = DATA_DIR / 'app.db'

# 确保目录存在
try:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / 'blanks').mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / 'shoes').mkdir(parents=True, exist_ok=True)
    print(f"数据目录: {DATA_DIR}")
except OSError as e:
    print(f"[ERR] 错误: 无法创建数据目录 {DATA_DIR}: {e}")
    # 如果无法创建，尝试使用临时目录作为后备
    temp_data = Path(tempfile.gettempdir()) / '3d_mod_match_data'
    DATA_DIR = temp_data
    UPLOAD_DIR = DATA_DIR / 'uploads'
    DB_PATH = DATA_DIR / 'app.db'
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / 'blanks').mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / 'shoes').mkdir(parents=True, exist_ok=True)
    print(f"[WARN]  使用临时目录: {DATA_DIR}")

ALLOWED_EXTENSIONS = {'stl', '3dm'}
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500MB

# ─── 二进制预览缓存 ───────────────────────────────────────────────
CACHE_DIR = DATA_DIR / 'preview_cache'
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# 二进制预览文件格式 (.binprev):
#   Header (固定 32 字节):
#     magic       4B   b'BPV1'
#     version     u16  1
#     reserved    2B
#     n_tv        u32  target_vertices count (Nx3 floats)
#     n_tf        u32  target_faces count (Mx3 uint32)
#     n_cv        u32  candidate_vertices count
#     n_cf        u32  candidate_faces count
#     meta_len    u32  metadata JSON 字节长度
#     reserved2   4B
#   Body:
#     target_vertices   n_tv*3 float32
#     target_faces      n_tf*3 uint32
#     candidate_verts   n_cv*3 float32
#     candidate_faces   n_cf*3 uint32
#     metadata_json     meta_len bytes (UTF-8)

_BPV_MAGIC = b'BPV1'
_BPV_HEADER_FMT = '<4sHxx5I4x'  # 32 bytes
_BPV_HEADER_SIZE = struct.calcsize(_BPV_HEADER_FMT)


class PreviewCache:
    """LRU + TTL 二进制预览缓存"""

    def __init__(self, cache_dir: Path, max_entries: int = 200, ttl_hours: int = 72):
        self._dir = cache_dir
        self._max = max_entries
        self._ttl_sec = ttl_hours * 3600
        self._lock = threading.Lock()

    def _path(self, record_id: int) -> Path:
        return self._dir / f'{record_id}.binprev'

    # ── 读取 ──

    def get(self, record_id: int) -> bytes | None:
        p = self._path(record_id)
        if not p.exists():
            return None
        age = datetime.now().timestamp() - p.stat().st_mtime
        if age > self._ttl_sec:
            p.unlink(missing_ok=True)
            return None
        # touch atime 用于 LRU 排序
        p.touch()
        return p.read_bytes()

    # ── 写入 ──

    def put(self, record_id: int, data: bytes) -> None:
        with self._lock:
            self._path(record_id).write_bytes(data)
            self._evict()

    # ── 删除 ──

    def delete(self, record_id: int) -> None:
        self._path(record_id).unlink(missing_ok=True)

    # ── LRU 淘汰 ──

    def _evict(self) -> None:
        files = sorted(self._dir.glob('*.binprev'), key=lambda f: f.stat().st_mtime)
        now = datetime.now().timestamp()
        # 先淘汰过期
        for f in files:
            if now - f.stat().st_mtime > self._ttl_sec:
                f.unlink(missing_ok=True)
        # 再按 LRU 淘汰超额
        files = sorted(self._dir.glob('*.binprev'), key=lambda f: f.stat().st_mtime)
        while len(files) > self._max:
            files[0].unlink(missing_ok=True)
            files.pop(0)


preview_cache = PreviewCache(CACHE_DIR, max_entries=200, ttl_hours=72)


def pack_preview_binary(
    target_vertices: np.ndarray, target_faces: np.ndarray,
    candidate_vertices: np.ndarray, candidate_faces: np.ndarray,
    metadata: dict,
) -> bytes:
    """将预览数据打包为紧凑二进制格式"""
    tv = target_vertices.astype(np.float32)
    tf = target_faces.astype(np.uint32)
    cv = candidate_vertices.astype(np.float32)
    cf = candidate_faces.astype(np.uint32)
    meta_bytes = json.dumps(metadata, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

    header = struct.pack(
        _BPV_HEADER_FMT,
        _BPV_MAGIC,
        1,  # version
        len(tv), len(tf), len(cv), len(cf),
        len(meta_bytes),
    )
    return header + tv.tobytes() + tf.tobytes() + cv.tobytes() + cf.tobytes() + meta_bytes


def unpack_preview_binary(data: bytes) -> tuple:
    """解包二进制预览数据，返回 (tv, tf, cv, cf, metadata)"""
    magic, ver, n_tv, n_tf, n_cv, n_cf, meta_len = struct.unpack(_BPV_HEADER_FMT, data[:_BPV_HEADER_SIZE])
    if magic != _BPV_MAGIC:
        raise ValueError('invalid preview cache magic')
    off = _BPV_HEADER_SIZE
    tv = np.frombuffer(data, dtype=np.float32, count=n_tv * 3, offset=off).reshape(-1, 3)
    off += n_tv * 3 * 4
    tf = np.frombuffer(data, dtype=np.uint32, count=n_tf * 3, offset=off).reshape(-1, 3)
    off += n_tf * 3 * 4
    cv = np.frombuffer(data, dtype=np.float32, count=n_cv * 3, offset=off).reshape(-1, 3)
    off += n_cv * 3 * 4
    cf = np.frombuffer(data, dtype=np.uint32, count=n_cf * 3, offset=off).reshape(-1, 3)
    off += n_cf * 3 * 4
    meta = json.loads(data[off:off + meta_len].decode('utf-8'))
    return tv, tf, cv, cf, meta

# ─── END 二进制预览缓存 ──────────────────────────────────────────

# 任务队列
match_queue = queue.Queue()
match_tasks = {}  # task_id -> task_info
match_lock = threading.Lock()

# 并发控制
_max_concurrent = 2
_active_count = 0
_concurrency_condition = threading.Condition()

# 数据库初始化
def init_db():
    """初始化数据库"""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    
    # 分类表
    c.execute('''
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER,
            path TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (parent_id) REFERENCES categories(id)
        )
    ''')
    
    # 粗胚表
    c.execute('''
        CREATE TABLE IF NOT EXISTS blanks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER,
            category_id INTEGER,
            upload_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            metadata TEXT,
            FOREIGN KEY (category_id) REFERENCES categories(id)
        )
    ''')
    
    # 鞋模表
    c.execute('''
        CREATE TABLE IF NOT EXISTS shoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER,
            upload_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # 匹配记录表
    c.execute('''
        CREATE TABLE IF NOT EXISTS match_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            shoe_id INTEGER NOT NULL,
            blank_id INTEGER NOT NULL,
            category_id INTEGER,
            operator TEXT,
            match_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            wrapping_ratio REAL,
            percentile96_clearance REAL,
            optimal_translation REAL,
            optimal_rotation_angle_deg REAL,
            optimal_lateral_offset REAL,
            volume REAL,
            is_fully_wrapped INTEGER,
            meets_direction_constraints INTEGER,
            result_data TEXT,
            FOREIGN KEY (shoe_id) REFERENCES shoes(id),
            FOREIGN KEY (blank_id) REFERENCES blanks(id),
            FOREIGN KEY (category_id) REFERENCES categories(id)
        )
    ''')
    
    # 匹配任务表
    c.execute('''
        CREATE TABLE IF NOT EXISTS match_tasks (
            id TEXT PRIMARY KEY,
            shoe_id INTEGER NOT NULL,
            shoe_name TEXT,
            category_ids TEXT,
            status TEXT,
            progress REAL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP,
            result_data TEXT,
            FOREIGN KEY (shoe_id) REFERENCES shoes(id)
        )
    ''')

    # 采纳记录表
    c.execute('''
        CREATE TABLE IF NOT EXISTS adoptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL UNIQUE,
            record_id INTEGER,
            blank_id INTEGER,
            blank_name TEXT,
            shoe_name TEXT,
            notes TEXT DEFAULT '',
            tags TEXT DEFAULT '[]',
            adopted_at TIMESTAMP NOT NULL,
            FOREIGN KEY (task_id) REFERENCES match_tasks(id)
        )
    ''')

    # 迁移：为已有数据库添加 shoe_name 列
    try:
        c.execute('ALTER TABLE match_tasks ADD COLUMN shoe_name TEXT')
    except sqlite3.OperationalError:
        pass  # 列已存在

    # 迁移：添加 started_at 列（任务实际开始执行的时间）
    try:
        c.execute('ALTER TABLE match_tasks ADD COLUMN started_at TEXT')
    except sqlite3.OperationalError:
        pass  # 列已存在

    conn.commit()
    conn.close()

def allowed_file(filename):
    """检查文件扩展名"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# API路由

@app.route('/api/health', methods=['GET', 'OPTIONS'])
def health():
    """健康检查"""
    if request.method == 'OPTIONS':
        return '', 200
    
    return jsonify({
        'status': 'ok',
        'matcher_available': MATCHER_AVAILABLE,
        'matcher_error': MATCHER_LOAD_ERROR,
    })

# 添加OPTIONS请求处理和响应头
@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS')
    return response

@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        response = jsonify({})
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add('Access-Control-Allow-Headers', "Content-Type,Authorization")
        response.headers.add('Access-Control-Allow-Methods', "GET,PUT,POST,DELETE,OPTIONS")
        return response

# 分类管理API
@app.route('/api/categories', methods=['GET', 'OPTIONS'])
def get_categories():
    """获取所有分类（含每个分类的粗胚数量）"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    c.execute('''
        SELECT c.*, COALESCE(cnt.blank_count, 0) AS blank_count
        FROM categories c
        LEFT JOIN (
            SELECT category_id, COUNT(*) AS blank_count
            FROM blanks
            GROUP BY category_id
        ) cnt ON cnt.category_id = c.id
        ORDER BY c.path
    ''')
    categories = [dict(row) for row in c.fetchall()]

    # Also return total blank count (including uncategorized)
    c.execute('SELECT COUNT(*) FROM blanks')
    total_blanks = c.fetchone()[0]
    c.execute('SELECT COUNT(*) FROM blanks WHERE category_id IS NULL')
    uncategorized_count = c.fetchone()[0]

    conn.close()
    return jsonify({
        'categories': categories,
        'total_blanks': total_blanks,
        'uncategorized_count': uncategorized_count,
    })

@app.route('/api/categories', methods=['POST'])
def create_category():
    """创建分类"""
    data = request.json
    name = data.get('name')
    parent_id = data.get('parent_id')
    
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    
    # 构建路径
    if parent_id:
        c.execute('SELECT path FROM categories WHERE id = ?', (parent_id,))
        parent_path = c.fetchone()[0]
        path = f"{parent_path}/{name}"
    else:
        path = name
    
    c.execute('INSERT INTO categories (name, parent_id, path) VALUES (?, ?, ?)',
              (name, parent_id, path))
    category_id = c.lastrowid
    conn.commit()
    conn.close()
    
    return jsonify({'id': category_id, 'name': name, 'parent_id': parent_id, 'path': path})

@app.route('/api/categories/<int:category_id>', methods=['PUT'])
def rename_category(category_id):
    """重命名分类"""
    data = request.json
    new_name = (data.get('name') or '').strip()
    if not new_name:
        return jsonify({'error': '分类名称不能为空'}), 400

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    c.execute('SELECT id, name, parent_id, path FROM categories WHERE id = ?', (category_id,))
    cat = c.fetchone()
    if not cat:
        conn.close()
        return jsonify({'error': '分类不存在'}), 404

    old_path = cat['path']
    # 构建新路径
    if cat['parent_id']:
        c.execute('SELECT path FROM categories WHERE id = ?', (cat['parent_id'],))
        parent_path = c.fetchone()['path']
        new_path = f"{parent_path}/{new_name}"
    else:
        new_path = new_name

    # 更新自身
    c.execute('UPDATE categories SET name = ?, path = ? WHERE id = ?',
              (new_name, new_path, category_id))

    # 更新所有后代的 path 前缀
    c.execute('SELECT id, path FROM categories WHERE path LIKE ?', (old_path + '/%',))
    for row in c.fetchall():
        updated_path = new_path + row['path'][len(old_path):]
        c.execute('UPDATE categories SET path = ? WHERE id = ?', (updated_path, row['id']))

    conn.commit()
    conn.close()
    return jsonify({'id': category_id, 'name': new_name, 'path': new_path})


@app.route('/api/categories/<int:category_id>', methods=['DELETE'])
def delete_category(category_id):
    """删除分类"""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    
    # 检查是否有子分类或粗胚
    c.execute('SELECT COUNT(*) FROM categories WHERE parent_id = ?', (category_id,))
    if c.fetchone()[0] > 0:
        return jsonify({'error': '该分类下有子分类，无法删除'}), 400
    
    c.execute('SELECT COUNT(*) FROM blanks WHERE category_id = ?', (category_id,))
    if c.fetchone()[0] > 0:
        return jsonify({'error': '该分类下有粗胚，无法删除'}), 400
    
    c.execute('DELETE FROM categories WHERE id = ?', (category_id,))
    conn.commit()
    conn.close()
    
    return jsonify({'success': True})

# 粗胚管理API
@app.route('/api/blanks', methods=['GET'])
def get_blanks():
    """获取粗胚列表"""
    search = request.args.get('search', '')
    category_id = request.args.get('category_id')
    sort = request.args.get('sort', 'time-desc')
    page = int(request.args.get('page', 1))
    per_page = int(request.args.get('per_page', 50))
    
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    query = 'SELECT b.*, c.name as category_name FROM blanks b LEFT JOIN categories c ON b.category_id = c.id WHERE 1=1'
    params = []
    
    if search:
        query += ' AND b.name LIKE ?'
        params.append(f'%{search}%')
    
    if category_id == 'uncategorized':
        query += ' AND b.category_id IS NULL'
    elif category_id:
        query += ' AND b.category_id = ?'
        params.append(category_id)

    # 排序
    if sort == 'time-desc':
        query += ' ORDER BY b.upload_time DESC'
    elif sort == 'time-asc':
        query += ' ORDER BY b.upload_time ASC'
    elif sort == 'name-asc':
        query += ' ORDER BY b.name ASC'

    # 分页
    offset = (page - 1) * per_page
    query += ' LIMIT ? OFFSET ?'
    params.extend([per_page, offset])

    c.execute(query, params)
    blanks = [dict(row) for row in c.fetchall()]

    # 总数
    count_query = 'SELECT COUNT(*) FROM blanks b WHERE 1=1'
    count_params = []
    if search:
        count_query += ' AND b.name LIKE ?'
        count_params.append(f'%{search}%')
    if category_id == 'uncategorized':
        count_query += ' AND b.category_id IS NULL'
    elif category_id:
        count_query += ' AND b.category_id = ?'
        count_params.append(category_id)
    
    c.execute(count_query, count_params)
    total = c.fetchone()[0]
    
    conn.close()
    return jsonify({
        'items': blanks,
        'total': total,
        'page': page,
        'per_page': per_page
    })

@app.route('/api/blanks', methods=['POST'])
def upload_blank():
    """上传粗胚"""
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': '没有选择文件'}), 400
    
    if not allowed_file(file.filename):
        return jsonify({'error': '不支持的文件格式'}), 400
    
    # 保存文件（保留中文文件名，用 UUID 短码防冲突）
    filename = safe_filename(file.filename)
    file_path = UPLOAD_DIR / 'blanks' / filename

    if file_path.exists():
        name, ext = os.path.splitext(filename)
        filename = f"{name}_{uuid.uuid4().hex[:8]}{ext}"
        file_path = UPLOAD_DIR / 'blanks' / filename
    
    file.save(str(file_path))
    file_size = file_path.stat().st_size
    
    if file_size > MAX_FILE_SIZE:
        file_path.unlink()
        return jsonify({'error': f'文件太大，最大允许 {MAX_FILE_SIZE / 1024 / 1024}MB'}), 400
    
    # 获取文件信息
    try:
        info = get_mesh_file_info(str(file_path)) if get_mesh_file_info else {}
    except Exception as e:
        import traceback
        traceback.print_exc()
        info = {'error': str(e)}
    
    # 保存到数据库
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    
    name = request.form.get('name', filename)
    category_id = request.form.get('category_id')
    
    c.execute('''
        INSERT INTO blanks (name, filename, file_path, file_size, category_id, metadata, upload_time)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (name, filename, str(file_path), file_size, category_id, json.dumps(info), now_cst()))
    
    blank_id = c.lastrowid
    conn.commit()
    conn.close()
    
    return jsonify({
        'id': blank_id,
        'name': name,
        'filename': filename,
        'file_path': str(file_path),
        'file_size': file_size
    })

@app.route('/api/blanks/<int:blank_id>', methods=['PUT'])
def update_blank(blank_id):
    """更新粗胚信息（如分类）"""
    data = request.json
    category_id = data.get('category_id')
    
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    
    c.execute('UPDATE blanks SET category_id = ? WHERE id = ?', (category_id, blank_id))
    conn.commit()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/api/blanks/batch', methods=['POST'])
def batch_update_blanks():
    """批量更新粗胚"""
    data = request.json
    blank_ids = data.get('blank_ids', [])
    category_id = data.get('category_id')
    
    if not blank_ids:
        return jsonify({'error': '没有选择粗胚'}), 400
    
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    
    placeholders = ','.join(['?'] * len(blank_ids))
    c.execute(f'UPDATE blanks SET category_id = ? WHERE id IN ({placeholders})',
              [category_id] + blank_ids)
    conn.commit()
    conn.close()
    
    return jsonify({'success': True, 'updated': len(blank_ids)})

@app.route('/api/blanks/<int:blank_id>', methods=['DELETE'])
def delete_blank(blank_id):
    """删除粗胚"""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    
    c.execute('SELECT file_path FROM blanks WHERE id = ?', (blank_id,))
    row = c.fetchone()
    if row:
        file_path = Path(row[0])
        if file_path.exists():
            file_path.unlink()
    
    c.execute('DELETE FROM blanks WHERE id = ?', (blank_id,))
    conn.commit()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/api/blanks/<int:blank_id>/preview', methods=['GET'])
def get_blank_preview(blank_id):
    """获取粗胚预览数据"""
    if load_mesh_file is None:
        return jsonify({'error': 'Mesh加载模块不可用，请检查 rhino3dm / trimesh 是否已安装'}), 503
    try:
        conn = sqlite3.connect(str(DB_PATH))
        c = conn.cursor()
        
        c.execute('SELECT file_path FROM blanks WHERE id = ?', (blank_id,))
        row = c.fetchone()
        conn.close()
        
        if not row:
            print(f"[ERR] 粗胚ID {blank_id} 不存在")
            return jsonify({'error': '粗胚不存在'}), 404
        
        file_path_str = row[0]
        file_path = Path(file_path_str)
        
        # 检查文件是否存在
        if not file_path.exists():
            # 尝试相对路径（从上传目录）
            if not file_path.is_absolute():
                file_path = UPLOAD_DIR / 'blanks' / file_path_str
            else:
                # 如果是绝对路径但不存在，尝试从上传目录查找
                file_path = UPLOAD_DIR / 'blanks' / Path(file_path_str).name
            
            if not file_path.exists():
                print(f"[ERR] 文件不存在: 原始路径={file_path_str}, 尝试路径={file_path}")
                return jsonify({'error': f'文件不存在: {file_path_str}'}), 404
        
        print(f"[INFO] 加载文件: {file_path}")
        
        mesh_quality = request.args.get('mesh_quality', 'medium')
        
        try:
            vertices, faces = load_mesh_file(str(file_path), mesh_quality=mesh_quality)
            print(f"[OK] 文件加载成功: {len(vertices)} 顶点, {len(faces)} 面")
        except Exception as e:
            print(f"[ERR] 加载Mesh文件失败: {e}")
            import traceback
            traceback.print_exc()
            return jsonify({'error': f'加载Mesh文件失败: {str(e)}'}), 500
        
        # 验证和清理数据（参考web_viewer.py的处理方式）
        # 检查NaN和Inf值
        if np.any(np.isnan(vertices)) or np.any(np.isinf(vertices)):
            # 替换NaN和Inf为0
            vertices = np.nan_to_num(vertices, nan=0.0, posinf=0.0, neginf=0.0)
            print(f"[WARN]  警告: 顶点数据包含NaN或Inf值，已替换为0")
        
        # 确保顶点是有效的浮点数
        vertices = vertices.astype(np.float32)
        
        # 验证面索引
        if len(faces) > 0:
            max_vertex_index = len(vertices) - 1
            # 过滤掉超出范围的索引
            valid_faces = []
            for face in faces:
                if len(face) >= 3:
                    # 检查索引是否有效
                    try:
                        if all(0 <= int(idx) <= max_vertex_index for idx in face[:3]):
                            valid_faces.append([int(face[0]), int(face[1]), int(face[2])])
                        else:
                            print(f"[WARN]  警告: 跳过无效面索引: {face}")
                    except (ValueError, TypeError) as e:
                        print(f"[WARN]  警告: 面索引格式错误: {face}, 错误: {e}")
            faces = np.array(valid_faces, dtype=np.int32) if valid_faces else np.array([], dtype=np.int32)
        else:
            faces = np.array([], dtype=np.int32)
        
        # 计算边界框（用于验证数据有效性）
        if len(vertices) > 0:
            try:
                bounds = {
                    'x': [float(vertices[:, 0].min()), float(vertices[:, 0].max())],
                    'y': [float(vertices[:, 1].min()), float(vertices[:, 1].max())],
                    'z': [float(vertices[:, 2].min()), float(vertices[:, 2].max())]
                }
                
                # 检查边界是否有效
                if any(np.isnan(b) or np.isinf(b) for b in bounds['x'] + bounds['y'] + bounds['z']):
                    print(f"[WARN]  警告: 边界框包含无效值，使用默认值")
                    bounds = {'x': [0, 0], 'y': [0, 0], 'z': [0, 0]}
            except Exception as e:
                print(f"[WARN]  警告: 计算边界框失败: {e}")
                bounds = {'x': [0, 0], 'y': [0, 0], 'z': [0, 0]}
        else:
            bounds = {'x': [0, 0], 'y': [0, 0], 'z': [0, 0]}
        
        # 转换为列表格式（确保是有效的Python数值）
        try:
            vertices_list = []
            for v in vertices:
                vertices_list.append([float(v[0]), float(v[1]), float(v[2])])
            
            faces_list = []
            for f in faces:
                if len(f) >= 3:
                    faces_list.append([int(f[0]), int(f[1]), int(f[2])])
            
            print(f"[OK] 数据转换完成: {len(vertices_list)} 顶点, {len(faces_list)} 面")
            
            return jsonify({
                'vertices': vertices_list,
                'faces': faces_list,
                'stats': {
                    'vertex_count': len(vertices_list),
                    'face_count': len(faces_list),
                    'bounds': bounds
                }
            })
        except Exception as e:
            print(f"[ERR] 数据转换失败: {e}")
            import traceback
            traceback.print_exc()
            return jsonify({'error': f'数据转换失败: {str(e)}'}), 500
            
    except sqlite3.Error as e:
        print(f"[ERR] 数据库错误: {e}")
        return jsonify({'error': f'数据库错误: {str(e)}'}), 500
    except Exception as e:
        print(f"[ERR] 预览API错误: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'加载模型失败: {str(e)}'}), 500

# 鞋模管理API
@app.route('/api/shoes', methods=['POST'])
def upload_shoe():
    """上传鞋模"""
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': '没有选择文件'}), 400
    
    if not allowed_file(file.filename):
        return jsonify({'error': '不支持的文件格式'}), 400
    
    filename = safe_filename(file.filename)
    file_path = UPLOAD_DIR / 'shoes' / filename

    if file_path.exists():
        name, ext = os.path.splitext(filename)
        filename = f"{name}_{uuid.uuid4().hex[:8]}{ext}"
        file_path = UPLOAD_DIR / 'shoes' / filename
    
    file.save(str(file_path))
    file_size = file_path.stat().st_size
    
    if file_size > MAX_FILE_SIZE:
        file_path.unlink()
        return jsonify({'error': f'文件太大'}), 400
    
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    
    name = request.form.get('name', filename)
    
    c.execute('''
        INSERT INTO shoes (name, filename, file_path, file_size, upload_time)
        VALUES (?, ?, ?, ?, ?)
    ''', (name, filename, str(file_path), file_size, now_cst()))
    
    shoe_id = c.lastrowid
    conn.commit()
    conn.close()
    
    return jsonify({
        'id': shoe_id,
        'name': name,
        'filename': filename,
        'file_path': str(file_path)
    })

# 匹配API
@app.route('/api/match/reload', methods=['POST'])
def reload_matcher():
    """手动重新加载匹配模块（用于编译后无需重启服务器）"""
    success, err = _try_load_matcher()
    return jsonify({'success': success, 'error': err, 'matcher_available': MATCHER_AVAILABLE})


@app.route('/api/match/start', methods=['POST'])
def start_match():
    """开始匹配任务"""
    global _max_concurrent

    if not MATCHER_AVAILABLE:
        hint = '请先编译C++模块: cd src/core && mkdir -p build && cd build && cmake .. && make'
        return jsonify({
            'error': '匹配模块不可用',
            'detail': MATCHER_LOAD_ERROR or '未知错误',
            'hint': hint,
        }), 503

    data = request.json
    shoe_id = data.get('shoe_id')
    category_ids = data.get('category_ids', [])
    params = data.get('params', {})
    max_concurrent = data.get('max_concurrent', 2)

    # 更新全局并发上限（1-10）
    _max_concurrent = max(1, min(10, int(max_concurrent)))

    # 创建任务
    task_id = str(uuid.uuid4())

    with match_lock:
        match_tasks[task_id] = {
            'id': task_id,
            'shoe_id': shoe_id,
            'category_ids': category_ids,
            'status': 'queued',
            'progress': 0.0,
            'results': [],
            'started_at': None,
            'error': None,
        }

    # 添加到队列
    match_queue.put({
        'task_id': task_id,
        'shoe_id': shoe_id,
        'category_ids': category_ids,
        'params': params
    })

    return jsonify({'task_id': task_id})

@app.route('/api/match/task/<task_id>', methods=['GET'])
def get_match_task(task_id):
    """获取匹配任务状态"""
    with match_lock:
        task = match_tasks.get(task_id)
        if not task:
            return jsonify({'error': '任务不存在'}), 404
        return jsonify(task)

@app.route('/api/match/task/<task_id>', methods=['DELETE'])
def cancel_match_task(task_id):
    """取消匹配任务"""
    with match_lock:
        if task_id in match_tasks:
            match_tasks[task_id]['status'] = 'cancelled'
        return jsonify({'success': True})

# 匹配结果3D数据API
def _compute_preview_data(record_id: int) -> bytes:
    """计算预览数据并打包为二进制格式，供缓存和响应使用"""
    import math

    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute('''
        SELECT m.*, s.file_path as shoe_path, b.file_path as blank_path
        FROM match_records m
        LEFT JOIN shoes s ON m.shoe_id = s.id
        LEFT JOIN blanks b ON m.blank_id = b.id
        WHERE m.id = ?
    ''', (record_id,))
    record = c.fetchone()
    if not record:
        conn.close()
        raise ValueError('记录不存在')

    record_dict = dict(zip([col[0] for col in c.description], record))
    result_data = json.loads(record_dict.get('result_data', '{}'))
    shoe_path = Path(record_dict['shoe_path'])
    blank_path = Path(record_dict['blank_path'])
    optimal_translation = record_dict.get('optimal_translation', 0.0)
    optimal_rotation_angle_deg = record_dict.get('optimal_rotation_angle_deg', 0.0)
    optimal_lateral_offset = record_dict.get('optimal_lateral_offset', 0.0)
    wrapping_threshold = result_data.get('target_wrapping_ratio', 0.96)
    conn.close()

    target_vertices, target_faces = load_mesh_file(str(shoe_path), mesh_quality='high')
    candidate_vertices, candidate_faces = load_mesh_file(str(blank_path), mesh_quality='high')

    _normalize = _tf_normalize  # alias for local readability

    rotation_matrix_align = compute_alignment_rotation(
        target_vertices, target_faces,
        candidate_vertices, candidate_faces,
        mesh_matcher,
    )

    # Still need individual axes for downstream transformation
    candidate_longitudinal_axis = _normalize(np.array(
        mesh_matcher.MeshMatcher.compute_longitudinal_axis(
            candidate_vertices.flatten().tolist(), candidate_faces.flatten().tolist()),
        dtype=float))
    candidate_vertical_axis = _normalize(np.array(
        mesh_matcher.MeshMatcher.compute_vertical_axis(
            candidate_vertices.flatten().tolist(), candidate_faces.flatten().tolist()),
        dtype=float))

    target_center = np.mean(target_vertices, axis=0)
    target_vertices_aligned = (rotation_matrix_align @ (target_vertices - target_center).T).T + target_center

    longitudinal_axis = candidate_longitudinal_axis.copy()
    candidate_center = np.mean(candidate_vertices, axis=0)

    target_longitudinal_axis_aligned = _normalize(np.array(
        mesh_matcher.MeshMatcher.compute_longitudinal_axis(
            target_vertices_aligned.flatten().tolist(), target_faces.flatten().tolist()),
        dtype=float))
    target_vertical_axis_aligned = _normalize(np.array(
        mesh_matcher.MeshMatcher.compute_vertical_axis(
            target_vertices_aligned.flatten().tolist(), target_faces.flatten().tolist()),
        dtype=float))
    target_center_aligned = np.mean(target_vertices_aligned, axis=0)

    target_lateral_axis = _normalize(np.cross(target_longitudinal_axis_aligned, target_vertical_axis_aligned))
    candidate_lateral_axis = _normalize(np.cross(longitudinal_axis, candidate_vertical_axis))

    angle_rad = math.radians(optimal_rotation_angle_deg)
    R_rotate = rodrigues_rotation(longitudinal_axis, angle_rad)
    translation_vec = longitudinal_axis * optimal_translation + candidate_lateral_axis * optimal_lateral_offset

    candidate_vertices_transformed = (
        (R_rotate @ (candidate_vertices - candidate_center).T).T
        + candidate_center + translation_vec
    )

    candidate_longitudinal_axis_transformed = longitudinal_axis.copy()
    candidate_vertical_axis_transformed = _normalize(R_rotate @ candidate_vertical_axis)
    candidate_center_transformed = candidate_center + translation_vec
    candidate_lateral_axis_transformed = _normalize(
        np.cross(candidate_longitudinal_axis_transformed, candidate_vertical_axis_transformed))

    # metadata: 除顶点/面以外的所有数据（轴、匹配结果、参数）
    metadata = {
        'match_result': {
            'volume': record_dict.get('volume', 0),
            'wrapping_ratio': record_dict.get('wrapping_ratio', 0),
            'target_wrapping_ratio': wrapping_threshold,
            'percentile96_clearance': record_dict.get('percentile96_clearance', 0.0),
            'optimal_translation': optimal_translation,
            'optimal_rotation_angle_deg': optimal_rotation_angle_deg,
            'optimal_lateral_offset': optimal_lateral_offset,
            'is_fully_wrapped': bool(record_dict.get('is_fully_wrapped', 0)),
            'meets_direction_constraints': bool(record_dict.get('meets_direction_constraints', 0)),
            'optimization_algorithm': 'ga',
            'generation_history': result_data.get('generation_history', []),
            'direction_alignment': result_data.get('direction_alignment', {}),
        },
        'longitudinal_axis': longitudinal_axis.tolist(),
        'candidate_center': candidate_center.tolist(),
        'axes': {
            'target': {
                'center': target_center_aligned.tolist(),
                'longitudinal_axis': target_longitudinal_axis_aligned.tolist(),
                'vertical_axis': target_vertical_axis_aligned.tolist(),
                'lateral_axis': target_lateral_axis.tolist(),
            },
            'candidate_original': {
                'center': candidate_center.tolist(),
                'longitudinal_axis': longitudinal_axis.tolist(),
                'vertical_axis': candidate_vertical_axis.tolist(),
                'lateral_axis': candidate_lateral_axis.tolist(),
            },
            'candidate_transformed': {
                'center': candidate_center_transformed.tolist(),
                'longitudinal_axis': candidate_longitudinal_axis_transformed.tolist(),
                'vertical_axis': candidate_vertical_axis_transformed.tolist(),
                'lateral_axis': candidate_lateral_axis_transformed.tolist(),
            },
        },
    }

    return pack_preview_binary(
        target_vertices_aligned, target_faces,
        candidate_vertices, candidate_faces,
        metadata,
    )


@app.route('/api/match/result/<int:record_id>/preview', methods=['GET'])
def get_match_result_preview(record_id):
    """获取匹配结果的3D预览数据（二进制格式，带 LRU 缓存）"""
    if not MATCHER_AVAILABLE or mesh_matcher is None:
        return jsonify({'error': '匹配模块不可用，无法生成3D预览'}), 503

    try:
        # 尝试从缓存读取
        cached = preview_cache.get(record_id)
        if cached:
            print(f'[preview cache] HIT  record_id={record_id} size={len(cached)} bytes')
            return app.response_class(cached, mimetype='application/octet-stream')

        # 缓存未命中：计算 + 缓存
        print(f'[preview cache] MISS record_id={record_id}, computing...')
        data = _compute_preview_data(record_id)
        preview_cache.put(record_id, data)
        print(f'[preview cache] STORED record_id={record_id} size={len(data)} bytes')
        return app.response_class(data, mimetype='application/octet-stream')

    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'加载预览失败: {str(e)}'}), 500

@app.route('/api/match/record/<int:record_id>', methods=['DELETE'])
def delete_match_record(record_id):
    """删除匹配记录并清理预览缓存"""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute('SELECT id FROM match_records WHERE id = ?', (record_id,))
    if not c.fetchone():
        conn.close()
        return jsonify({'error': '记录不存在'}), 404
    c.execute('DELETE FROM match_records WHERE id = ?', (record_id,))
    conn.commit()
    conn.close()
    preview_cache.delete(record_id)
    return jsonify({'success': True})


# 历史记录API
@app.route('/api/history', methods=['GET'])
def get_history():
    """获取历史记录"""
    search = request.args.get('search', '')
    date_from = request.args.get('date_from')
    date_to = request.args.get('date_to')
    page = int(request.args.get('page', 1))
    per_page = int(request.args.get('per_page', 50))
    
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    query = '''
        SELECT m.*, s.name as shoe_name, b.name as blank_name, c.name as category_name
        FROM match_records m
        LEFT JOIN shoes s ON m.shoe_id = s.id
        LEFT JOIN blanks b ON m.blank_id = b.id
        LEFT JOIN categories c ON m.category_id = c.id
        WHERE 1=1
    '''
    params = []
    
    if search:
        query += ' AND s.name LIKE ?'
        params.append(f'%{search}%')
    
    if date_from:
        query += ' AND m.match_time >= ?'
        params.append(date_from)
    
    if date_to:
        query += ' AND m.match_time <= ?'
        params.append(date_to)
    
    query += ' ORDER BY m.match_time DESC LIMIT ? OFFSET ?'
    params.extend([per_page, (page - 1) * per_page])
    
    c.execute(query, params)
    records = [dict(row) for row in c.fetchall()]
    
    # 总数
    count_query = '''
        SELECT COUNT(*) FROM match_records m
        LEFT JOIN shoes s ON m.shoe_id = s.id
        WHERE 1=1
    '''
    count_params = []
    if search:
        count_query += ' AND s.name LIKE ?'
        count_params.append(f'%{search}%')
    if date_from:
        count_query += ' AND m.match_time >= ?'
        count_params.append(date_from)
    if date_to:
        count_query += ' AND m.match_time <= ?'
        count_params.append(date_to)
    c.execute(count_query, count_params)
    total = c.fetchone()[0]
    
    conn.close()
    return jsonify({
        'items': records,
        'total': total,
        'page': page,
        'per_page': per_page
    })


@app.route('/api/history/tasks', methods=['GET'])
def get_history_tasks():
    """获取按鞋模分组的历史记录（基于 match_tasks 表）"""
    search = request.args.get('search', '')
    date_from = request.args.get('date_from')
    date_to = request.args.get('date_to')
    page = int(request.args.get('page', 1))
    per_page = int(request.args.get('per_page', 50))

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    where_clauses = ["status = 'completed'"]
    params = []

    if search:
        where_clauses.append('shoe_name LIKE ?')
        params.append(f'%{search}%')
    if date_from:
        where_clauses.append('completed_at >= ?')
        params.append(date_from)
    if date_to:
        where_clauses.append('completed_at <= ?')
        params.append(date_to)

    where_sql = ' AND '.join(where_clauses)

    # 查询总数
    c.execute(f'SELECT COUNT(*) FROM match_tasks WHERE {where_sql}', params)
    total = c.fetchone()[0]

    # 查询分页数据
    c.execute(
        f'SELECT * FROM match_tasks WHERE {where_sql} ORDER BY completed_at DESC LIMIT ? OFFSET ?',
        params + [per_page, (page - 1) * per_page],
    )
    rows = c.fetchall()
    conn.close()

    items = []
    for row in rows:
        row_dict = dict(row)
        results = json.loads(row_dict.get('result_data') or '[]')

        matched = [r for r in results if r.get('matched')]
        # 最佳匹配 = 体积最小的成功匹配
        best = min(matched, key=lambda r: (r.get('match_info') or {}).get('volume', float('inf'))) if matched else None
        best_info = (best.get('match_info') or {}) if best else {}

        items.append({
            'task_id': row_dict['id'],
            'shoe_id': row_dict['shoe_id'],
            'shoe_name': row_dict.get('shoe_name', ''),
            'matched_count': len(matched),
            'total_count': len(results),
            'best_wrapping_ratio': best_info.get('wrapping_ratio', 0),
            'best_blank_name': best_info.get('blank_name', ''),
            'completed_at': row_dict.get('completed_at', ''),
            'results': results,
        })

    # 批量查询采纳数据
    task_ids = [item['task_id'] for item in items]
    adoptions_map = {}
    if task_ids:
        conn2 = sqlite3.connect(str(DB_PATH))
        conn2.row_factory = sqlite3.Row
        c2 = conn2.cursor()
        placeholders = ','.join('?' * len(task_ids))
        c2.execute(f'SELECT * FROM adoptions WHERE task_id IN ({placeholders})', task_ids)
        for a_row in c2.fetchall():
            a = dict(a_row)
            a['tags'] = json.loads(a.get('tags') or '[]')
            adoptions_map[a['task_id']] = a
        conn2.close()

    for item in items:
        item['adoption'] = adoptions_map.get(item['task_id'])

    return jsonify({
        'items': items,
        'total': total,
        'page': page,
        'per_page': per_page,
    })


# 采纳记录API
@app.route('/api/adoptions', methods=['POST'])
def create_adoption():
    """采纳匹配结果"""
    data = request.get_json()
    if not data:
        return jsonify({'error': '请求数据无效'}), 400

    task_id = data.get('task_id')
    record_id = data.get('record_id')
    blank_name = data.get('blank_name', '')
    shoe_name = data.get('shoe_name', '')
    notes = data.get('notes', '').strip()
    tags = data.get('tags', [])
    if not isinstance(tags, list):
        tags = []
    # 标签清洗：去空白、去重、限长
    tags = list(dict.fromkeys(t.strip()[:20] for t in tags if t and t.strip()))[:10]

    if not task_id:
        return jsonify({'error': '缺少 task_id'}), 400

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    # 确认任务存在
    c.execute('SELECT id FROM match_tasks WHERE id = ?', (task_id,))
    if not c.fetchone():
        conn.close()
        return jsonify({'error': '匹配任务不存在'}), 404

    adopted_at = now_cst()
    try:
        c.execute(
            '''INSERT INTO adoptions (task_id, record_id, blank_id, blank_name, shoe_name, notes, tags, adopted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
            (task_id, record_id, data.get('blank_id'), blank_name, shoe_name,
             notes, json.dumps(tags, ensure_ascii=False), adopted_at)
        )
        adoption_id = c.lastrowid
        conn.commit()
    except sqlite3.IntegrityError:
        # 已有采纳记录，执行更新
        c.execute(
            '''UPDATE adoptions SET record_id=?, blank_id=?, blank_name=?, shoe_name=?,
               notes=?, tags=?, adopted_at=? WHERE task_id=?''',
            (record_id, data.get('blank_id'), blank_name, shoe_name,
             notes, json.dumps(tags, ensure_ascii=False), adopted_at, task_id)
        )
        c.execute('SELECT id FROM adoptions WHERE task_id = ?', (task_id,))
        adoption_id = c.fetchone()['id']
        conn.commit()

    c.execute('SELECT * FROM adoptions WHERE id = ?', (adoption_id,))
    row = dict(c.fetchone())
    conn.close()
    row['tags'] = json.loads(row.get('tags') or '[]')
    return jsonify(row), 201


@app.route('/api/adoptions/<task_id>', methods=['GET'])
def get_adoption(task_id):
    """获取指定任务的采纳记录"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute('SELECT * FROM adoptions WHERE task_id = ?', (task_id,))
    row = c.fetchone()
    conn.close()
    if not row:
        return jsonify({'adoption': None})
    result = dict(row)
    result['tags'] = json.loads(result.get('tags') or '[]')
    return jsonify({'adoption': result})


@app.route('/api/adoptions/<task_id>', methods=['DELETE'])
def delete_adoption(task_id):
    """撤销采纳"""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute('SELECT id FROM adoptions WHERE task_id = ?', (task_id,))
    if not c.fetchone():
        conn.close()
        return jsonify({'error': '采纳记录不存在'}), 404
    c.execute('DELETE FROM adoptions WHERE task_id = ?', (task_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/api/dashboard', methods=['GET'])
def get_dashboard():
    """数据看板：返回所有模块所需的统计数据"""
    days = int(request.args.get('days', 30))

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    # ── 时间范围 ────────────────────────────────────────────────
    now_dt = datetime.now(_CST)
    today_str = now_dt.strftime('%Y-%m-%d')
    yesterday_str = (now_dt - timedelta(days=1)).strftime('%Y-%m-%d')

    # ── 模块一：概览卡片 ────────────────────────────────────────
    # 今日任务数（创建时间 >= 今天 00:00）
    c.execute(
        "SELECT COUNT(*) FROM match_tasks WHERE status='completed' AND substr(created_at,1,10)=?",
        (today_str,)
    )
    today_count = c.fetchone()[0]

    # 昨日任务数（对比用）
    c.execute(
        "SELECT COUNT(*) FROM match_tasks WHERE status='completed' AND substr(created_at,1,10)=?",
        (yesterday_str,)
    )
    yesterday_count = c.fetchone()[0]

    # 所有已完成任务（用于命中率、包裹率、P99）
    c.execute(
        "SELECT id, result_data, created_at, started_at, completed_at FROM match_tasks WHERE status='completed'"
    )
    all_tasks = [dict(r) for r in c.fetchall()]

    total_tasks = len(all_tasks)
    hit_count = 0
    wrapping_ratios = []     # 每任务最佳包裹率
    per_pair_times = []      # 每粗胚-鞋模对耗时（秒）

    for t in all_tasks:
        try:
            results = json.loads(t['result_data'] or '[]')
        except Exception:
            results = []
        n_blanks = len(results)

        # 命中：至少一个粗胚匹配成功
        if any(r.get('matched') for r in results):
            hit_count += 1
            # 最佳包裹率（成功记录中最高的）
            best_ratio = max(
                (r.get('match_info', {}).get('wrapping_ratio', 0) for r in results if r.get('matched')),
                default=0,
            )
            wrapping_ratios.append(best_ratio)

        # P99 每对耗时：使用 started_at（任务实际开始执行）到 completed_at 的差值
        # 两者均为 now_cst() 格式："%Y-%m-%dT%H:%M:%S+08:00"
        if n_blanks > 0 and t.get('started_at') and t.get('completed_at'):
            try:
                fmt = '%Y-%m-%dT%H:%M:%S+08:00'
                t_start = datetime.strptime(t['started_at'], fmt)
                t_end = datetime.strptime(t['completed_at'], fmt)
                duration = (t_end - t_start).total_seconds()
                if duration > 0:
                    per_pair_times.append(duration / n_blanks)
            except Exception:
                pass

    hit_rate = round(hit_count / total_tasks * 100, 1) if total_tasks > 0 else 0
    avg_wrapping = round(sum(wrapping_ratios) / len(wrapping_ratios) * 100, 1) if wrapping_ratios else 0

    # P99 单对耗时
    p99_pair_time = 0
    if per_pair_times:
        sorted_times = sorted(per_pair_times)
        idx = int(len(sorted_times) * 0.99)
        p99_pair_time = round(sorted_times[min(idx, len(sorted_times) - 1)], 1)

    # 今日命中率 & 今日平均包裹率
    today_tasks = [t for t in all_tasks if t.get('created_at', '').startswith(today_str)]
    today_hit = 0
    today_ratios = []
    for t in today_tasks:
        try:
            results = json.loads(t['result_data'] or '[]')
        except Exception:
            results = []
        if any(r.get('matched') for r in results):
            today_hit += 1
            best = max(
                (r.get('match_info', {}).get('wrapping_ratio', 0) for r in results if r.get('matched')),
                default=0,
            )
            today_ratios.append(best)
    today_hit_rate = round(today_hit / len(today_tasks) * 100, 1) if today_tasks else 0
    today_avg_wrapping = round(sum(today_ratios) / len(today_ratios) * 100, 1) if today_ratios else 0

    overview = {
        'today_count': today_count,
        'yesterday_count': yesterday_count,
        'hit_rate': today_hit_rate,
        'hit_rate_all': hit_rate,
        'avg_wrapping_ratio': today_avg_wrapping,
        'avg_wrapping_ratio_all': avg_wrapping,
        'p99_pair_time_s': p99_pair_time,
    }

    # ── 模块二：每日任务数量趋势（最近 N 天）──────────────────────
    trend = []
    for i in range(days - 1, -1, -1):
        day = (now_dt - timedelta(days=i)).strftime('%Y-%m-%d')
        c.execute(
            "SELECT COUNT(*) FROM match_tasks WHERE status='completed' AND substr(created_at,1,10)=?",
            (day,)
        )
        total_day = c.fetchone()[0]
        # 命中任务（result_data 中至少一个 matched=true）
        c.execute(
            "SELECT result_data FROM match_tasks WHERE status='completed' AND substr(created_at,1,10)=?",
            (day,)
        )
        hit_day = 0
        for row in c.fetchall():
            try:
                rs = json.loads(row[0] or '[]')
                if any(r.get('matched') for r in rs):
                    hit_day += 1
            except Exception:
                pass
        trend.append({'date': day, 'total': total_day, 'hit': hit_day, 'miss': total_day - hit_day})

    # ── 粗胚→分类名映射 ──────────────────────────────────────────
    c.execute('''
        SELECT b.id, COALESCE(cat.path, '') AS category_path
        FROM blanks b LEFT JOIN categories cat ON b.category_id = cat.id
    ''')
    blank_category_map = {row[0]: row[1] for row in c.fetchall()}

    # ── 模块三：粗胚使用热力图 ──────────────────────────────────
    blank_usage: dict = {}  # blank_id -> {name, total, hit, last_used, category}
    for t in all_tasks:
        try:
            results = json.loads(t['result_data'] or '[]')
        except Exception:
            results = []
        for r in results:
            bid = r.get('blank_id')
            if bid is None:
                continue
            if bid not in blank_usage:
                blank_usage[bid] = {
                    'blank_id': bid,
                    'blank_name': r.get('blank_name', str(bid)),
                    'category': blank_category_map.get(bid, ''),
                    'total': 0,
                    'hit': 0,
                    'volume': None,
                    'last_used': t.get('completed_at') or t.get('created_at') or '',
                }
            blank_usage[bid]['total'] += 1
            if r.get('matched'):
                blank_usage[bid]['hit'] += 1
            # 记录粗胚体积（取最小匹配体积）
            vol = (r.get('match_info') or {}).get('volume')
            if vol and vol > 0:
                prev = blank_usage[bid]['volume']
                if prev is None or vol < prev:
                    blank_usage[bid]['volume'] = vol
            # 最近使用时间
            task_time = t.get('completed_at') or t.get('created_at') or ''
            if task_time > blank_usage[bid]['last_used']:
                blank_usage[bid]['last_used'] = task_time

    heatmap = sorted(blank_usage.values(), key=lambda x: x['total'], reverse=True)[:20]
    for item in heatmap:
        item['hit_rate'] = round(item['hit'] / item['total'] * 100, 1) if item['total'] > 0 else 0

    # ── 模块四：包裹率分布 ──────────────────────────────────────
    # 从 match_tasks.result_data 中提取所有粗胚的包裹率（含未命中），
    # 不能只查 match_records，因为 match_records 仅写入命中记录。
    all_ratios = []
    for t in all_tasks:
        try:
            results = json.loads(t['result_data'] or '[]')
        except Exception:
            results = []
        for r in results:
            ratio = (r.get('match_info') or {}).get('wrapping_ratio')
            if ratio is not None and ratio > 0:
                all_ratios.append(ratio)
    dist_gte96 = sum(1 for r in all_ratios if r >= 0.96)
    dist_90_96 = sum(1 for r in all_ratios if 0.90 <= r < 0.96)
    dist_lt90 = sum(1 for r in all_ratios if r < 0.90)
    distribution = {
        'gte96': dist_gte96,
        'range_90_96': dist_90_96,
        'lt90': dist_lt90,
        'total': len(all_ratios),
    }

    # ── 模块五：粗胚排行榜（复用 blank_usage） ──────────────────
    blanks_list = [dict(b) for b in blank_usage.values()]
    for b in blanks_list:
        b['hit_rate'] = round(b['hit'] / b['total'] * 100, 1) if b['total'] > 0 else 0
    # 至少被匹配过 1 次
    top_blank_hit = sorted(blanks_list, key=lambda x: (x['hit_rate'], x['total']), reverse=True)[:5]
    top_blank_miss = sorted(
        [b for b in blanks_list if b['hit_rate'] < 100],
        key=lambda x: (x['hit_rate'], -x['total'])
    )[:5]
    leaderboard = {'top_hit': top_blank_hit, 'top_miss': top_blank_miss}

    # ── 模块六：系统资源 ────────────────────────────────────────
    cpu_now = None
    cpu_1h_avg = None
    cpu_1h_peak = None
    if _PSUTIL_OK:
        try:
            cpu_now = round(_psutil.cpu_percent(interval=0.2), 1)
        except Exception:
            cpu_now = None

    queue_size = match_queue.qsize()
    uptime_s = int(_time.time() - _SERVER_START_TIME)

    system = {
        'active_tasks': _active_count,
        'max_concurrent': _max_concurrent,
        'queue_waiting': queue_size,
        'cpu_percent': cpu_now,
        'cpu_1h_avg': cpu_1h_avg,
        'cpu_1h_peak': cpu_1h_peak,
        'uptime_s': uptime_s,
        'matcher_available': MATCHER_AVAILABLE,
    }

    conn.close()
    return jsonify({
        'overview': overview,
        'trend': trend,
        'heatmap': heatmap,
        'distribution': distribution,
        'leaderboard': leaderboard,
        'system': system,
    })


@app.route('/api/system-status')
def api_system_status():
    """轻量级系统状态接口，用于高频轮询 CPU 等实时指标"""
    cpu_now = None
    if _PSUTIL_OK:
        try:
            cpu_now = round(_psutil.cpu_percent(interval=0.2), 1)
        except Exception:
            pass
    queue_size = match_queue.qsize()
    uptime_s = int(_time.time() - _SERVER_START_TIME)
    return jsonify({
        'active_tasks': _active_count,
        'max_concurrent': _max_concurrent,
        'queue_waiting': queue_size,
        'cpu_percent': cpu_now,
        'uptime_s': uptime_s,
        'matcher_available': MATCHER_AVAILABLE,
    })


# 匹配工作线程
def match_worker():
    """匹配调度线程：每个入队任务立即启动一个线程，
    实际并发由 execute_match 内部的条件变量节流。"""
    while True:
        try:
            task_data = match_queue.get(timeout=1)
        except queue.Empty:
            continue
        except Exception as e:
            print(f"匹配工作线程错误: {e}")
            continue

        thread = threading.Thread(target=execute_match, args=(task_data,))
        thread.daemon = True
        thread.start()

def execute_match(task_data):
    """执行匹配任务（并发受 _concurrency_condition 节流）"""
    global _active_count, _max_concurrent

    task_id = task_data['task_id']
    shoe_id = task_data['shoe_id']
    category_ids = task_data['category_ids']
    params = task_data['params']

    # 等待并发槽位
    with _concurrency_condition:
        while _active_count >= _max_concurrent:
            _concurrency_condition.wait()
        _active_count += 1

    try:
        with match_lock:
            if task_id not in match_tasks:
                return   # finally below will still release the slot
            match_tasks[task_id]['status'] = 'running'
            match_tasks[task_id]['progress'] = 0.0
            match_tasks[task_id]['started_at'] = now_cst()

        # 获取鞋模文件
        conn = sqlite3.connect(str(DB_PATH))
        c = conn.cursor()
        c.execute('SELECT file_path, name FROM shoes WHERE id = ?', (shoe_id,))
        shoe_row = c.fetchone()
        if not shoe_row:
            raise Exception('鞋模不存在')

        shoe_path = Path(shoe_row[0])
        shoe_name = shoe_row[1] or shoe_path.name
        
        # 获取粗胚文件
        if category_ids:
            placeholders = ','.join(['?'] * len(category_ids))
            c.execute(f'''
                SELECT id, file_path, category_id, name FROM blanks WHERE category_id IN ({placeholders})
            ''', category_ids)
        else:
            c.execute('SELECT id, file_path, category_id, name FROM blanks')

        blank_rows = c.fetchall()
        conn.close()
        
        if not blank_rows:
            raise Exception('没有找到粗胚')
        
        # 准备匹配参数
        ga_params = None
        if MATCHER_AVAILABLE and mesh_matcher is not None:
            try:
                ga_params = mesh_matcher.GeneticAlgorithmParams()
                ga_params.population_size = params.get('ga_population', 50)
                ga_params.max_generations = params.get('ga_generations', 30)
                ga_params.crossover_rate = params.get('ga_crossover', 0.8)
                ga_params.mutation_rate = params.get('ga_mutation', 0.1)
                ga_params.translation_range = params.get('translation_range', 50.0)
                ga_params.rotation_range = params.get('rotation_range', 180.0) * np.pi / 180.0
                ga_params.lateral_range = params.get('lateral_range', 30.0)
                ga_params.num_sample_points = params.get('sample_points', 500)
                ga_params.target_wrapping_ratio = params.get('wrapping_threshold', 0.96)
            except Exception as e:
                print(f"[WARN]  创建GA参数失败: {e}")
                ga_params = None
        
        wrapping_threshold = params.get('wrapping_threshold', 0.96)

        results = []
        total = len(blank_rows)

        # 在循环前检查匹配函数是否可用
        if not MATCHER_AVAILABLE or mesh_matcher is None or find_optimal_match is None:
            raise Exception('匹配模块不可用，请确保mesh_matcher和matcher已正确导入')

        # 在循环前检查鞋模文件是否存在
        if not shoe_path.exists():
            raise Exception(f'鞋模文件不存在: {shoe_path}')

        for idx, (blank_id, blank_path, category_id, blank_db_name) in enumerate(blank_rows):
            with match_lock:
                if task_id not in match_tasks or match_tasks[task_id]['status'] == 'cancelled':
                    break

            # 在try块外定义，确保except块中始终可用
            blank_name = blank_db_name or Path(blank_path).stem

            try:
                # 执行匹配
                best_match, match_info = find_optimal_match(
                    shoe_path,
                    [Path(blank_path)],
                    wrapping_threshold=wrapping_threshold,
                    verbose=False,
                    ga_params=ga_params
                )
                matched = best_match is not None
                record_id = None

                # 从 all_candidate_results 中取该粗胚的实际匹配数据（包括未通过阈值的）
                candidate_data = {}
                all_cr = match_info.get('all_candidate_results', [])
                if all_cr:
                    candidate_data = all_cr[0]

                # 构建本次粗胚的完整 match_info
                blank_match_info = {
                    **candidate_data,
                    'blank_name': blank_name,
                    'blank_id': blank_id,
                    'category_id': category_id,
                    'matched': matched,
                    'target_wrapping_ratio': wrapping_threshold,
                }
                if matched:
                    # 成功匹配：补充 generation_history 等仅在成功时返回的字段
                    blank_match_info['generation_history'] = match_info.get('generation_history', [])

                if matched:
                    # 仅对成功匹配写入数据库
                    conn = sqlite3.connect(str(DB_PATH))
                    c = conn.cursor()
                    c.execute('''
                        INSERT INTO match_records
                        (shoe_id, blank_id, category_id, wrapping_ratio, percentile96_clearance,
                         optimal_translation, optimal_rotation_angle_deg, optimal_lateral_offset,
                         volume, is_fully_wrapped, meets_direction_constraints, result_data, match_time)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (
                        shoe_id, blank_id, category_id,
                        blank_match_info.get('wrapping_ratio', 0),
                        blank_match_info.get('percentile96_clearance', 0),
                        blank_match_info.get('optimal_translation', 0),
                        blank_match_info.get('optimal_rotation_angle_deg', 0),
                        blank_match_info.get('optimal_lateral_offset', 0),
                        blank_match_info.get('volume', 0),
                        1 if blank_match_info.get('is_fully_wrapped') else 0,
                        1 if blank_match_info.get('meets_direction_constraints') else 0,
                        json.dumps(blank_match_info),
                        now_cst(),
                    ))
                    record_id = c.lastrowid
                    conn.commit()
                    conn.close()

                    # 异步预生成二进制预览缓存
                    _rid = record_id
                    def _precache(rid=_rid):
                        try:
                            data = _compute_preview_data(rid)
                            preview_cache.put(rid, data)
                            print(f'[preview cache] PRE-BUILT record_id={rid} size={len(data)} bytes')
                        except Exception as ex:
                            print(f'[preview cache] pre-build failed for record_id={rid}: {ex}')
                    threading.Thread(target=_precache, daemon=True).start()

                # 无论是否匹配成功，都加入结果列表
                results.append({
                    'blank_id': blank_id,
                    'blank_name': blank_name,
                    'record_id': record_id,
                    'matched': matched,
                    'match_info': blank_match_info,
                })

            except Exception as e:
                print(f"匹配错误: {e}")
                import traceback
                traceback.print_exc()
                # 即使出错，也记录该粗胚（标记为错误）
                results.append({
                    'blank_id': blank_id,
                    'blank_name': blank_name,
                    'record_id': None,
                    'matched': False,
                    'match_info': {
                        'blank_name': blank_name,
                        'blank_id': blank_id,
                        'category_id': category_id,
                        'matched': False,
                        'error': str(e),
                    },
                })
            
            # 更新进度
            with match_lock:
                if task_id in match_tasks:
                    match_tasks[task_id]['progress'] = (idx + 1) / total * 100
                    match_tasks[task_id]['results'] = results
        
        # 完成任务
        with match_lock:
            if task_id in match_tasks:
                match_tasks[task_id]['status'] = 'completed'
                match_tasks[task_id]['progress'] = 100.0

        # 持久化到 SQLite（历史记录按鞋模分组展示）
        try:
            conn = sqlite3.connect(str(DB_PATH))
            c = conn.cursor()
            task_started_at = match_tasks.get(task_id, {}).get('started_at')
            c.execute('''
                INSERT OR REPLACE INTO match_tasks
                (id, shoe_id, shoe_name, category_ids, status, progress, started_at, completed_at, result_data)
                VALUES (?, ?, ?, ?, 'completed', 100.0, ?, ?, ?)
            ''', (
                task_id, shoe_id, shoe_name,
                json.dumps(category_ids),
                task_started_at,
                now_cst(),
                json.dumps(results),
            ))
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"持久化匹配任务失败: {e}")
    
    except Exception as e:
        with match_lock:
            if task_id in match_tasks:
                match_tasks[task_id]['status'] = 'error'
                match_tasks[task_id]['error'] = str(e)
        import traceback
        traceback.print_exc()
    finally:
        # 释放并发槽位
        with _concurrency_condition:
            _active_count -= 1
            _concurrency_condition.notify_all()

if __name__ == '__main__':
    # 初始化数据库
    init_db()
    
    # 启动匹配工作线程
    worker_thread = threading.Thread(target=match_worker)
    worker_thread.daemon = True
    worker_thread.start()
    
    # 启动Flask服务
    port = int(os.getenv('PORT', 5000))
    print("=" * 60)
    print("3D模型匹配系统 - 后端服务")
    print("=" * 60)
    print(f"启动后端服务在 http://127.0.0.1:{port}")
    print(f"匹配模块可用: {MATCHER_AVAILABLE}")
    print("=" * 60)
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)
