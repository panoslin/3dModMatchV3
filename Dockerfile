# Dockerfile for 3DM file processing and C++ mesh matching
# Supports Python 3DM loading and high-performance C++ matching algorithm

FROM python:3.10-slim

# 设置工作目录
WORKDIR /app

# 设置环境变量
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    CMAKE_BUILD_TYPE=Release

# 安装系统依赖（包括C++编译工具和CMake）
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    cmake \
    make \
    libeigen3-dev \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# 安装 Python 依赖
RUN pip install --no-cache-dir \
    rhino3dm==8.17.0 \
    numpy==1.26.4 \
    pybind11==2.11.1 \
    Flask>=2.0.0 \
    Flask-CORS>=3.0.0 \
    trimesh>=4.0

# 复制源代码
COPY src/biz/load_3dm.py /app/src/biz/
COPY src/biz/load_mesh.py /app/src/biz/
COPY src/biz/matcher.py /app/src/biz/
COPY src/biz/test_all_matches.py /app/src/biz/
COPY src/biz/transform_utils.py /app/src/biz/
COPY src/core/ /app/src/core/
# 复制网页查看器
COPY src/viz/web_viewer.py /app/src/viz/
COPY src/viz/static/ /app/src/viz/static/

# 构建C++模块
WORKDIR /app/src/core
RUN mkdir -p build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j$(nproc)

# 复制构建的模块到/app目录
# 模块被编译到 /app/src/biz/mesh_matcher，需要复制到 /app
RUN if [ -f "/app/src/biz/mesh_matcher" ]; then \
        cp /app/src/biz/mesh_matcher /app/mesh_matcher.so; \
    elif [ -f "/app/src/biz/mesh_matcher.so" ]; then \
        cp /app/src/biz/mesh_matcher.so /app/; \
    else \
        find build -type f -name "mesh_matcher*" -exec cp {} /app/ \; || \
        (echo "Warning: Could not find built module" && ls -la build/ && ls -la /app/src/biz/ || true); \
    fi

# 清理构建目录（可选，保留以便调试）
# RUN rm -rf build

# 验证模块是否构建成功（可选，如果模块不存在也不阻止构建）
# 注意：网页查看器不需要 C++ 模块，所以这里允许失败
RUN python3 -c "import sys; sys.path.insert(0, '/app'); import mesh_matcher; print('C++ module loaded successfully')" 2>/dev/null || \
    echo "Warning: C++ module not found, continuing without it (web viewer doesn't need it)"

# 返回工作目录
WORKDIR /app

# 设置 testcases 目录（将通过 volume 挂载）
VOLUME ["/app/testcases"]

# 暴露网页查看器端口
EXPOSE 5000

# 默认命令（可以在docker-compose中覆盖）
# 默认启动网页查看器，可以通过 docker-compose 覆盖为其他命令
CMD ["python", "src/viz/web_viewer.py"]
