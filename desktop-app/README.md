# 3D模型匹配桌面应用程序

基于Electron框架开发的跨平台桌面应用程序，用于3D模型（鞋模和粗胚）的智能匹配。

## 功能特性

### 1. 粗胚管理
- ✅ 拖拽上传功能，支持STL、3DM格式
- ✅ 3D预览窗口，支持旋转、缩放查看
- ✅ 分类管理系统，支持多级分类
- ✅ 批量操作：批量上传、批量分类、批量删除
- ✅ 搜索和筛选功能

### 2. 鞋模上传匹配
- ✅ 多文件上传支持
- ✅ 粗胚分类多选器（树形结构）
- ✅ 匹配参数配置面板
- ✅ 实时进度条显示
- ✅ 匹配结果3D可视化预览

### 3. 历史匹配记录
- ✅ 数据表格展示，支持分页
- ✅ 详细匹配结果数据展示
- ✅ CSV/Excel导出功能
- ✅ 记录对比功能

## 技术架构

- **前端**: Electron + HTML/CSS/JavaScript + Three.js
- **后端**: Python Flask + SQLite
- **3D可视化**: Three.js
- **匹配算法**: C++核心算法（通过Python包装）

## 系统要求

- Windows 10/11 或 macOS 12+
- Python 3.8+（用于后端服务）
- Node.js 16+（用于Electron）

## 安装步骤

### 1. 安装依赖

```bash
cd desktop-app

# 安装Node.js依赖
npm install

# 安装Python依赖
cd backend
pip install -r requirements.txt
```

### 2. 编译C++匹配模块

确保项目根目录下的C++模块已编译：

```bash
cd ../../src/core
mkdir build && cd build
cmake ..
make
```

### 3. 运行应用

开发模式：
```bash
npm run dev
```

生产模式：
```bash
npm start
```

## 打包应用

### Windows
```bash
npm run build:win
```

### macOS
```bash
npm run build:mac
```

打包后的安装包位于 `dist/` 目录。

## 项目结构

```
desktop-app/
├── main.js              # Electron主进程
├── preload.js           # 预加载脚本
├── index.html           # 主页面
├── package.json         # 项目配置
├── styles/
│   └── main.css         # 主样式文件
├── js/
│   ├── api.js           # API客户端
│   ├── app.js           # 应用入口
│   ├── 3d-viewer.js     # 3D可视化组件
│   ├── blank-manager.js # 粗胚管理
│   ├── match-manager.js # 匹配管理
│   ├── history-manager.js # 历史记录管理
│   └── category-manager.js  # 分类管理
├── backend/
│   ├── server.py        # Flask后端服务
│   └── requirements.txt # Python依赖
└── data/                # 数据目录（自动创建）
    ├── app.db           # SQLite数据库
    └── uploads/         # 上传文件存储
```

## 配置说明

### 匹配参数默认值

- 目标包裹率: 0.96 (96%)
- GA种群大小: 50
- GA最大代数: 30
- GA交叉率: 0.8
- GA变异率: 0.1
- 纵向位移范围: ±50mm
- 旋转角度范围: ±180°
- 横向位移范围: ±30mm
- 采样点数量: 500
- 默认并发匹配数: 2

### 自动保存

应用每30秒自动保存一次状态（可在设置中调整）。

## 使用说明

### 首次使用

1. 启动应用后，系统会自动显示引导教程
2. 在"粗胚管理"页面，上传粗胚文件并创建分类
3. 在"鞋模匹配"页面，上传鞋模文件，选择粗胚分类，配置参数后开始匹配
4. 在"历史记录"页面查看所有匹配结果

### 粗胚管理

1. 点击"上传粗胚"按钮或拖拽文件到上传区域
2. 选择分类（可先创建分类）
3. 点击粗胚卡片可预览3D模型
4. 使用搜索和筛选功能快速找到目标粗胚

### 鞋模匹配

1. 上传一个或多个鞋模文件
2. 在分类树中选择要匹配的粗胚分类
3. 调整匹配参数（可选）
4. 点击"开始匹配"按钮
5. 查看实时进度和匹配结果

### 历史记录

1. 使用搜索和筛选功能查找记录
2. 选择多条记录进行对比
3. 导出为CSV或Excel格式

## 开发说明

### API端点

后端服务运行在 `http://127.0.0.1:5000`，主要API端点：

- `GET /api/health` - 健康检查
- `GET /api/categories` - 获取分类列表
- `POST /api/categories` - 创建分类
- `GET /api/blanks` - 获取粗胚列表
- `POST /api/blanks` - 上传粗胚
- `POST /api/shoes` - 上传鞋模
- `POST /api/match/start` - 开始匹配任务
- `GET /api/match/task/:id` - 获取匹配任务状态
- `GET /api/history` - 获取历史记录

### 数据库结构

- `categories` - 分类表
- `blanks` - 粗胚表
- `shoes` - 鞋模表
- `match_records` - 匹配记录表
- `match_tasks` - 匹配任务表

## 故障排除

### 后端服务无法启动

1. 检查Python版本（需要3.8+）
2. 确保所有Python依赖已安装
3. 检查C++匹配模块是否已编译

### 3D预览无法显示

1. 检查网络连接（Three.js从CDN加载）
2. 检查浏览器控制台错误信息
3. 确保文件格式正确（STL或3DM）

### 匹配任务失败

1. 检查文件格式是否正确
2. 查看后端日志输出
3. 确保匹配参数设置合理

## 许可证

MIT License

## 更新日志

### v1.0.0
- 初始版本发布
- 实现所有核心功能
- 支持Windows和macOS平台
