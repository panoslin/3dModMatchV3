// 3D可视化组件（基于Three.js）
class Viewer3D {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      console.error(`容器 ${containerId} 不存在`);
      return;
    }

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.meshes = [];
    this.animationId = null;

    this.init();
  }

  init() {
    // 创建场景
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a1a);

    // 创建相机
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    this.camera.position.set(0, 0, 500);

    // 创建渲染器
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.container.appendChild(this.renderer.domElement);

    // 添加轨道控制器
    // 尝试加载OrbitControls（可能需要动态导入）
    this.setupControls();

    // 添加灯光
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight1.position.set(1, 1, 1);
    this.scene.add(directionalLight1);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight2.position.set(-1, -1, -1);
    this.scene.add(directionalLight2);

    // 添加坐标轴辅助线
    const axesHelper = new THREE.AxesHelper(100);
    this.scene.add(axesHelper);

    // 处理窗口大小变化
    window.addEventListener('resize', () => this.onWindowResize());

    // 开始渲染循环
    this.animate();
  }

  onWindowResize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  async setupControls() {
    // 等待OrbitControls加载
    if (typeof window.OrbitControls !== 'undefined') {
      this.controls = new window.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
      this.controls.minDistance = 50;
      this.controls.maxDistance = 2000;
      return;
    }
    
    // 等待OrbitControls加载事件
    const waitForOrbitControls = new Promise((resolve) => {
      const checkOrbitControls = () => {
        if (typeof window.OrbitControls !== 'undefined') {
          resolve();
        } else {
          setTimeout(checkOrbitControls, 100);
        }
      };
      checkOrbitControls();
      
      // 超时后使用简单控制
      setTimeout(() => {
        console.warn('OrbitControls加载超时，使用简单控制');
        resolve();
      }, 2000);
    });
    
    await waitForOrbitControls;
    
    if (typeof window.OrbitControls !== 'undefined') {
      this.controls = new window.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
      this.controls.minDistance = 50;
      this.controls.maxDistance = 2000;
    } else {
      // 使用简单的鼠标控制
      this.setupSimpleControls();
    }
  }

  setupSimpleControls() {
    // 简单的鼠标控制实现
    let isDragging = false;
    let previousMousePosition = { x: 0, y: 0 };

    this.renderer.domElement.addEventListener('mousedown', (e) => {
      isDragging = true;
      previousMousePosition = { x: e.clientX, y: e.clientY };
    });

    this.renderer.domElement.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      const deltaX = e.clientX - previousMousePosition.x;
      const deltaY = e.clientY - previousMousePosition.y;
      
      // 旋转相机
      const spherical = new THREE.Spherical();
      spherical.setFromVector3(this.camera.position);
      spherical.theta -= deltaX * 0.01;
      spherical.phi += deltaY * 0.01;
      spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi));
      
      this.camera.position.setFromSpherical(spherical);
      this.camera.lookAt(0, 0, 0);
      
      previousMousePosition = { x: e.clientX, y: e.clientY };
    });

    this.renderer.domElement.addEventListener('mouseup', () => {
      isDragging = false;
    });

    this.renderer.domElement.addEventListener('wheel', (e) => {
      e.preventDefault();
      const distance = this.camera.position.length();
      const newDistance = distance + e.deltaY * 0.1;
      this.camera.position.normalize().multiplyScalar(Math.max(50, Math.min(2000, newDistance)));
    });
  }

  animate() {
    this.animationId = requestAnimationFrame(() => this.animate());
    if (this.controls && this.controls.update) {
      this.controls.update();
    }
    this.renderer.render(this.scene, this.camera);
  }

  clear() {
    this.meshes.forEach(mesh => {
      this.scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    });
    this.meshes = [];
  }

  loadMesh(vertices, faces, options = {}) {
    const {
      color = 0x007AFF,
      opacity = 1.0,
      wireframe = false,
      transparent = false,
    } = options;

    // 验证和清理数据
    if (!vertices || vertices.length === 0) {
      console.error('无效的顶点数据');
      return null;
    }

    // 清理顶点数据：移除NaN和Inf值
    // 支持两种格式：
    // 1. 嵌套数组：[[x1, y1, z1], [x2, y2, z2], ...]
    // 2. 扁平数组：[x1, y1, z1, x2, y2, z2, ...]
    const cleanedVertices = [];
    
    if (vertices.length > 0 && Array.isArray(vertices[0])) {
      // 嵌套数组格式
      for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        if (Array.isArray(v) && v.length >= 3) {
          const x = isNaN(v[0]) || !isFinite(v[0]) ? 0 : Number(v[0]);
          const y = isNaN(v[1]) || !isFinite(v[1]) ? 0 : Number(v[1]);
          const z = isNaN(v[2]) || !isFinite(v[2]) ? 0 : Number(v[2]);
          cleanedVertices.push(x, y, z);
        } else {
          cleanedVertices.push(0, 0, 0);
        }
      }
    } else {
      // 扁平数组格式
      for (let i = 0; i < vertices.length; i++) {
        const val = vertices[i];
        if (typeof val === 'number' && !isNaN(val) && isFinite(val)) {
          cleanedVertices.push(Number(val));
        } else {
          cleanedVertices.push(0);
        }
      }
      
      // 确保是3的倍数（x, y, z三元组）
      while (cleanedVertices.length % 3 !== 0) {
        cleanedVertices.push(0);
      }
    }

    if (cleanedVertices.length === 0 || cleanedVertices.length % 3 !== 0) {
      console.error('顶点数据格式错误');
      return null;
    }

    // 创建几何体
    const geometry = new THREE.BufferGeometry();
    
    // 转换顶点数据
    const positionArray = new Float32Array(cleanedVertices);
    geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));

    // 验证和清理面数据
    if (faces && faces.length > 0) {
      const cleanedFaces = [];
      const maxIndex = (positionArray.length / 3) - 1;
      
      for (let i = 0; i < faces.length; i++) {
        const face = faces[i];
        if (Array.isArray(face) && face.length >= 3) {
          // 验证索引是否在有效范围内
          const idx0 = Math.max(0, Math.min(maxIndex, Math.floor(face[0])));
          const idx1 = Math.max(0, Math.min(maxIndex, Math.floor(face[1])));
          const idx2 = Math.max(0, Math.min(maxIndex, Math.floor(face[2])));
          
          // 确保索引不同（避免退化三角形）
          if (idx0 !== idx1 && idx1 !== idx2 && idx0 !== idx2) {
            cleanedFaces.push(idx0, idx1, idx2);
          }
        } else if (typeof face === 'number' && !isNaN(face) && isFinite(face)) {
          // 如果是扁平数组格式
          const idx = Math.max(0, Math.min(maxIndex, Math.floor(face)));
          cleanedFaces.push(idx);
        }
      }

      if (cleanedFaces.length > 0) {
        const indexArray = new Uint32Array(cleanedFaces);
        geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
      }
    }

    // 验证几何体
    if (geometry.attributes.position.count === 0) {
      console.error('几何体没有顶点');
      return null;
    }

    // 计算法线和边界球
    try {
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      
      // 如果边界球无效，手动计算
      if (!geometry.boundingSphere || !geometry.boundingSphere.radius || 
          isNaN(geometry.boundingSphere.radius) || !isFinite(geometry.boundingSphere.radius)) {
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        if (box) {
          const center = new THREE.Vector3();
          box.getCenter(center);
          const size = new THREE.Vector3();
          box.getSize(size);
          const radius = size.length() * 0.5;
          geometry.boundingSphere = new THREE.Sphere(center, radius);
        }
      }
    } catch (e) {
      console.warn('计算几何体属性时出错:', e);
      // 继续执行，即使计算失败
    }

    // 创建材质
    const material = new THREE.MeshPhongMaterial({
      color,
      opacity,
      transparent: transparent || opacity < 1.0,
      wireframe,
      side: THREE.DoubleSide,
    });

    // 创建网格
    const mesh = new THREE.Mesh(geometry, material);
    this.scene.add(mesh);
    this.meshes.push(mesh);

    // 自动调整相机位置
    this.fitToView();

    return mesh;
  }

  loadMatchResult(targetData, candidateData, transformedData) {
    this.clear();

    // 加载鞋模（目标）- 使用透明蓝色
    if (targetData.vertices && targetData.faces) {
      this.loadMesh(targetData.vertices, targetData.faces, {
        color: 0x007AFF,
        opacity: 0.6,
        transparent: true,
      });
    }

    // 加载粗胚（候选）- 使用半透明灰色
    if (candidateData.vertices && candidateData.faces) {
      this.loadMesh(candidateData.vertices, candidateData.faces, {
        color: 0x888888,
        opacity: 0.4,
        transparent: true,
      });
    }

    // 加载变换后的粗胚 - 使用绿色
    if (transformedData.vertices && transformedData.faces) {
      this.loadMesh(transformedData.vertices, transformedData.faces, {
        color: 0x34C759,
        opacity: 0.7,
        transparent: true,
      });
    }

    this.fitToView();
  }

  fitToView() {
    if (this.meshes.length === 0) return;

    const box = new THREE.Box3();
    this.meshes.forEach(mesh => {
      box.expandByObject(mesh);
    });

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = maxDim * 2;

    this.camera.position.set(
      center.x + distance,
      center.y + distance,
      center.z + distance
    );
    this.camera.lookAt(center);
    if (this.controls) {
      if (this.controls.target) {
        this.controls.target.copy(center);
      }
      if (this.controls.update) {
        this.controls.update();
      }
    }
  }

  dispose() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    this.clear();
    if (this.renderer) {
      this.renderer.dispose();
    }
    if (this.controls) {
      this.controls.dispose();
    }
  }
}

// 全局Three.js库加载检查
if (typeof THREE === 'undefined') {
  console.error('Three.js未加载，请确保已引入Three.js库');
}
