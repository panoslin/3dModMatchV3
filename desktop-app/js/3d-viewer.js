/** Three.js 3D viewer: dual-mesh overlay, GA replay, axis visualization, outside-point detection. */
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

    // 匹配模式专用
    this.targetMesh = null;
    this.candidateMesh = null;
    this.targetAxisGroup = null;
    this.candidateAxisGroup = null;
    this.outsidePointsGroup = null;

    // GA 回放
    this.replayDataCache = null;
    this.generationHistory = null;
    this.replayTimer = null;
    this.replayIsPlaying = false;

    // 手动位姿试探（方向键移动/旋转鞋模 + 后端实时回评包裹率）
    this.manualOffset = { dl: 0, dlat: 0, dv: 0 };
    this.manualRotation = { rl: 0, rlat: 0, rv: 0 };  // 度：绕 L(滚转)/Lat(俯仰)/V(偏航)
    this.moveStep = 0.5;                 // mm（平移）与 °（旋转）共用，-/= 键循环调节
    this._probePivot = null;             // 旋转枢轴（后端返回，保证所见即所测）
    this._probeRecordId = null;
    this._probeTimer = null;
    this._probeBusy = false;
    this._baseFinalMatrix = null;        // 算法输出位姿（手动偏移的基准）
    this._probeHud = null;
    this._probeKeyHandler = null;
    this._lastProbe = null;

    this.init();
  }

  _getSceneBgColor() {
    return document.documentElement.dataset.theme === 'dark' ? 0x1a1a1a : 0xf0f0f2;
  }

  init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this._getSceneBgColor());

    this._themeHandler = () => {
      if (this.scene) this.scene.background.set(this._getSceneBgColor());
    };
    window.addEventListener('themechange', this._themeHandler);

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 10000);
    this.camera.position.set(0, 0, 100);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.setupControls();

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight1.position.set(1, 1, 1);
    this.scene.add(directionalLight1);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight2.position.set(-1, -1, -1);
    this.scene.add(directionalLight2);

    const axesHelper = new THREE.AxesHelper(50);
    this.scene.add(axesHelper);

    this._resizeHandler = () => this.onWindowResize();
    window.addEventListener('resize', this._resizeHandler);
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
    if (typeof window.OrbitControls !== 'undefined') {
      this.controls = new window.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.05;
      return;
    }

    const waitForOrbitControls = new Promise((resolve) => {
      const checkOrbitControls = () => {
        if (typeof window.OrbitControls !== 'undefined') {
          resolve();
        } else {
          setTimeout(checkOrbitControls, 100);
        }
      };
      checkOrbitControls();
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
    } else {
      this.setupSimpleControls();
    }
  }

  setupSimpleControls() {
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
      const spherical = new THREE.Spherical();
      spherical.setFromVector3(this.camera.position);
      spherical.theta -= deltaX * 0.01;
      spherical.phi -= deltaY * 0.01;
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
    if (!this.renderer) return;
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
    this._clearMatchObjects();
  }

  _clearMatchObjects() {
    this.stopReplay();
    this.disableManualProbe();

    if (this._outsidePointsPending) {
      cancelAnimationFrame(this._outsidePointsPending);
      this._outsidePointsPending = null;
    }

    if (this.targetMesh) {
      this.scene.remove(this.targetMesh);
      this.targetMesh.geometry.dispose();
      this.targetMesh.material.dispose();
      this.targetMesh = null;
    }
    if (this.candidateMesh) {
      this.scene.remove(this.candidateMesh);
      this.candidateMesh.geometry.dispose();
      this.candidateMesh.material.dispose();
      this.candidateMesh = null;
    }
    this._clearAxes();
    this._clearOutsidePoints();
  }

  _clearAxes() {
    const disposeGroup = (group) => {
      if (!group) return;
      group.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (child.material.map) child.material.map.dispose();
          child.material.dispose();
        }
      });
      this.scene.remove(group);
    };
    disposeGroup(this.targetAxisGroup);
    disposeGroup(this.candidateAxisGroup);
    this.targetAxisGroup = null;
    this.candidateAxisGroup = null;
  }

  _clearOutsidePoints() {
    if (this.outsidePointsGroup) {
      if (this.outsidePointsGroup.geometry) this.outsidePointsGroup.geometry.dispose();
      if (this.outsidePointsGroup.material) this.outsidePointsGroup.material.dispose();
      this.scene.remove(this.outsidePointsGroup);
      this.outsidePointsGroup = null;
    }
  }

  // ─── 单模型加载（粗胚预览等） ───

  loadMesh(vertices, faces, options = {}) {
    const {
      color = 0x667eea,
      opacity = 1.0,
      wireframe = false,
      transparent = false,
      shininess = 100,
    } = options;

    if (!vertices || vertices.length === 0) {
      console.error('无效的顶点数据');
      return null;
    }

    const cleanedVertices = this._cleanVertices(vertices);
    if (cleanedVertices.length === 0 || cleanedVertices.length % 3 !== 0) {
      console.error('顶点数据格式错误');
      return null;
    }

    const geometry = new THREE.BufferGeometry();
    const positionArray = new Float32Array(cleanedVertices);
    geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));

    if (faces && faces.length > 0) {
      const cleanedFaces = this._cleanFaces(faces, positionArray.length / 3);
      if (cleanedFaces.length > 0) {
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(cleanedFaces), 1));
      }
    }

    if (geometry.attributes.position.count === 0) {
      console.error('几何体没有顶点');
      return null;
    }

    try {
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      if (!geometry.boundingSphere || !geometry.boundingSphere.radius ||
          isNaN(geometry.boundingSphere.radius) || !isFinite(geometry.boundingSphere.radius)) {
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        if (box) {
          const center = new THREE.Vector3();
          box.getCenter(center);
          const size = new THREE.Vector3();
          box.getSize(size);
          geometry.boundingSphere = new THREE.Sphere(center, size.length() * 0.5);
        }
      }
    } catch (e) {
      console.warn('计算几何体属性时出错:', e);
    }

    const material = new THREE.MeshPhongMaterial({
      color,
      opacity,
      transparent: transparent || opacity < 1.0,
      wireframe,
      shininess,
      side: THREE.DoubleSide,
      flatShading: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    this.scene.add(mesh);
    this.meshes.push(mesh);
    this.fitToView();
    return mesh;
  }

  // ─── 匹配结果加载（复刻 src/viz） ───

  loadMatchResult(data) {
    const _t = { start: performance.now() };

    this._clearMatchObjects();
    this.meshes.forEach(mesh => {
      this.scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    });
    this.meshes = [];
    _t.clear = performance.now();

    // 加载目标（鞋模）- 灰色不透明（与 src/viz 一致）
    const targetGeometry = this._buildGeometry(data.target_vertices, data.target_faces);
    if (!targetGeometry) return;
    _t.targetGeom = performance.now();

    const targetMaterial = new THREE.MeshLambertMaterial({
      color: 0x808080,
      transparent: false,
      opacity: 1.0,
      side: THREE.DoubleSide,
    });

    this.targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
    this.targetMesh.renderOrder = 1;
    this.targetMesh.material.depthWrite = true;
    this.scene.add(this.targetMesh);

    // 加载候选（粗胚）- 蓝色半透明（与 src/viz 一致）
    const candidateGeometry = this._buildGeometry(data.candidate_vertices, data.candidate_faces);
    if (!candidateGeometry) return;
    _t.candidateGeom = performance.now();

    const candidateMaterial = new THREE.MeshLambertMaterial({
      color: 0x4080FF,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });

    this.candidateMesh = new THREE.Mesh(candidateGeometry, candidateMaterial);
    this.candidateMesh.renderOrder = 2;
    this.candidateMesh.material.depthWrite = false;
    this.scene.add(this.candidateMesh);

    // 设置 GA 回放（应用变换矩阵到鞋模）
    this.setupReplay(data);
    _t.replay = performance.now();

    // 计算相机位置
    targetGeometry.computeBoundingBox();
    candidateGeometry.computeBoundingBox();
    const tBox = targetGeometry.boundingBox;
    const cBox = candidateGeometry.boundingBox;
    const min = new THREE.Vector3(
      Math.min(tBox.min.x, cBox.min.x),
      Math.min(tBox.min.y, cBox.min.y),
      Math.min(tBox.min.z, cBox.min.z)
    );
    const max = new THREE.Vector3(
      Math.max(tBox.max.x, cBox.max.x),
      Math.max(tBox.max.y, cBox.max.y),
      Math.max(tBox.max.z, cBox.max.z)
    );
    const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(max, min);
    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = maxDim * 2;

    this.camera.position.set(
      center.x + distance * 0.7,
      center.y + distance * 0.7,
      center.z + distance * 0.7
    );
    this.camera.lookAt(center);
    if (this.controls) {
      if (this.controls.target) this.controls.target.copy(center);
      if (this.controls.update) this.controls.update();
    }

    // 可视化轴
    if (data.axes) {
      this._visualizeAxes(data.axes, maxDim);
    }
    _t.axes = performance.now();

    console.log(
      `[3D perf] loadMatchResult breakdown — clear: ${(_t.clear - _t.start).toFixed(1)}ms, ` +
      `targetGeom: ${(_t.targetGeom - _t.clear).toFixed(1)}ms, ` +
      `candidateGeom: ${(_t.candidateGeom - _t.targetGeom).toFixed(1)}ms, ` +
      `replay: ${(_t.replay - _t.candidateGeom).toFixed(1)}ms, ` +
      `axes: ${(_t.axes - _t.replay).toFixed(1)}ms, ` +
      `sync total: ${(_t.axes - _t.start).toFixed(1)}ms`
    );

    // 延迟计算外点，先让模型和轴立即渲染出来
    this._outsidePointsPending = requestAnimationFrame(() => {
      this._outsidePointsPending = null;
      const t0 = performance.now();
      this._visualizeOutsidePoints(maxDim);
      const t1 = performance.now();
      console.log(`[3D perf] outsidePoints (deferred): ${(t1 - t0).toFixed(1)}ms`);
    });
  }

  // ─── GA 回放 ───

  stopReplay() {
    this.replayIsPlaying = false;
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
    }
    const btn = document.getElementById('replayPlayBtn');
    if (btn) btn.textContent = '播放';
  }

  // 6-DOF 相对位姿矩阵：R = R_yaw(垂直轴)·R_pitch(横向轴)·R_roll(纵向轴)，
  // 绕 pivot（候选质心）旋转后平移——与后端 C++ matchOptimized Step 5 一致。
  // GA 回放历史只记录 3-DOF（vertical/pitch/yaw 传 0 时严格退化为旧行为）。
  _buildRelativeMatrix(pivot, axisLong, lateralAxis, translationMm, rotationDeg, lateralMm,
                       verticalAxis = null, verticalMm = 0, pitchDeg = 0, yawDeg = 0) {
    const angleRad = rotationDeg * Math.PI / 180.0;
    const tVec = axisLong.clone().multiplyScalar(translationMm)
      .add(lateralAxis.clone().multiplyScalar(lateralMm));
    if (verticalAxis && verticalMm) {
      tVec.add(verticalAxis.clone().multiplyScalar(verticalMm));
    }
    const T1 = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    let R = new THREE.Matrix4().makeRotationAxis(axisLong, angleRad);
    if (verticalAxis && (pitchDeg || yawDeg)) {
      const Rp = new THREE.Matrix4().makeRotationAxis(lateralAxis, pitchDeg * Math.PI / 180.0);
      const Ry = new THREE.Matrix4().makeRotationAxis(verticalAxis, yawDeg * Math.PI / 180.0);
      R = new THREE.Matrix4().multiplyMatrices(Ry, Rp).multiply(R);
    }
    const T2 = new THREE.Matrix4().makeTranslation(
      pivot.x + tVec.x, pivot.y + tVec.y, pivot.z + tVec.z
    );
    const M = new THREE.Matrix4();
    M.multiplyMatrices(T2, R);
    M.multiply(T1);
    return M;
  }

  applyReplayState(idx) {
    if (!this.replayDataCache || !this.generationHistory || !this.targetMesh) return;
    const state = this.generationHistory[idx];
    if (!state) return;

    const pivot = new THREE.Vector3(...this.replayDataCache.candidate_center);
    const axisLong = new THREE.Vector3(...this.replayDataCache.longitudinal_axis).normalize();
    const lateralAxis = new THREE.Vector3(
      ...this.replayDataCache.axes.candidate_original.lateral_axis
    ).normalize();

    const M = this._buildRelativeMatrix(
      pivot, axisLong, lateralAxis,
      Number(state.translation || 0),
      Number(state.rotation_angle_deg || 0),
      Number(state.lateral_offset || 0)
    );

    // 对鞋模应用 M 的逆矩阵，粗胚保持不动
    const Minv = new THREE.Matrix4().copy(M).invert();
    this.targetMesh.matrixAutoUpdate = false;
    this.targetMesh.matrix.copy(Minv);
    this.targetMesh.updateMatrixWorld(true);
    this._setManualBase(Minv);

    // 更新 UI
    const setText = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    setText('replayGenLabel', String(state.generation ?? idx));
    setText('replayBest', ((state.best_fitness ?? 0) * 100).toFixed(2) + '%');
    setText('replayAvg', ((state.avg_fitness ?? 0) * 100).toFixed(2) + '%');
    setText('replayStd', (state.std_dev ?? 0).toFixed(4));
    setText('replayT', (state.translation ?? 0).toFixed(2));
    setText('replayRot', (state.rotation_angle_deg ?? 0).toFixed(2));
    setText('replayLat', (state.lateral_offset ?? 0).toFixed(2));
    setText('replayXover', String(state.crossover_count ?? 0));
    setText('replayMut', String(state.mutation_count ?? 0));
    setText('replayTime', (state.time_ms ?? 0).toFixed(1));
  }

  setupReplay(data) {
    this.stopReplay();
    this.replayDataCache = data;
    this.generationHistory = (data.match_result && data.match_result.generation_history)
      ? data.match_result.generation_history : null;

    // 没有 history 时，按最终结果设置一次矩阵
    if (!this.generationHistory || this.generationHistory.length === 0) {
      if (!data.longitudinal_axis || !data.candidate_center || !data.axes) return;
      const pivot = new THREE.Vector3(...data.candidate_center);
      const axisLong = new THREE.Vector3(...data.longitudinal_axis).normalize();
      const lateralAxis = new THREE.Vector3(
        ...data.axes.candidate_original.lateral_axis
      ).normalize();
      const mr = data.match_result || {};
      const verticalAxis = new THREE.Vector3(
        ...data.axes.candidate_original.vertical_axis
      ).normalize();
      const M = this._buildRelativeMatrix(
        pivot, axisLong, lateralAxis,
        Number(mr.optimal_translation || 0),
        Number(mr.optimal_rotation_angle_deg || 0),
        Number(mr.optimal_lateral_offset || 0),
        verticalAxis,
        Number(mr.optimal_vertical_offset || 0),
        Number(mr.optimal_pitch_deg || 0),
        Number(mr.optimal_yaw_deg || 0)
      );
      const Minv = new THREE.Matrix4().copy(M).invert();
      this.targetMesh.matrixAutoUpdate = false;
      this.targetMesh.matrix.copy(Minv);
      this.targetMesh.updateMatrixWorld(true);
      this._setManualBase(Minv);
      return;
    }

    const slider = document.getElementById('replaySlider');
    const playBtn = document.getElementById('replayPlayBtn');
    if (!slider || !playBtn) {
      this.applyReplayState(this.generationHistory.length - 1);
      return;
    }

    const maxIdx = this.generationHistory.length - 1;
    slider.min = '0';
    slider.max = String(maxIdx);
    slider.value = String(maxIdx);
    this.applyReplayState(maxIdx);

    // 更新总代数标签
    const totalLabel = document.getElementById('replayTotalGen');
    if (totalLabel) totalLabel.textContent = String(maxIdx);

    slider.oninput = () => {
      this.stopReplay();
      this.applyReplayState(Number(slider.value));
    };

    playBtn.onclick = () => {
      if (this.replayIsPlaying) {
        this.stopReplay();
        return;
      }
      this.replayIsPlaying = true;
      playBtn.textContent = '暂停';
      this.replayTimer = setInterval(() => {
        let v = Number(slider.value);
        v = (v >= maxIdx) ? 0 : (v + 1);
        slider.value = String(v);
        this.applyReplayState(v);
      }, 250);
    };
  }

  // ─── 轴可视化 ───

  _createAxis(origin, direction, color, label, axisLength, axisRadius) {
    const originVec = new THREE.Vector3(...origin);
    const dirVec = new THREE.Vector3(...direction).normalize();

    const geometry = new THREE.CylinderGeometry(axisRadius, axisRadius, axisLength, 32);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
    });
    const cylinder = new THREE.Mesh(geometry, material);

    const defaultDir = new THREE.Vector3(0, 1, 0);
    const rotAxis = new THREE.Vector3().crossVectors(defaultDir, dirVec);
    const rotAngle = Math.acos(Math.max(-1, Math.min(1, defaultDir.dot(dirVec))));

    if (rotAxis.length() > 0.001) {
      rotAxis.normalize();
      cylinder.rotateOnAxis(rotAxis, rotAngle);
    } else if (dirVec.dot(defaultDir) < -0.99) {
      cylinder.rotateX(Math.PI);
    }

    cylinder.position.copy(originVec);

    // 文本标签（Canvas Sprite）
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256;
    canvas.height = 64;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    ctx.font = 'Bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(axisLength * 0.3, axisLength * 0.1, 1);
    const labelPos = originVec.clone().add(
      dirVec.clone().multiplyScalar(axisLength / 2 + axisLength * 0.2)
    );
    sprite.position.copy(labelPos);

    const group = new THREE.Group();
    group.add(cylinder);
    group.add(sprite);
    group.userData.label = label;
    return group;
  }

  _visualizeAxes(axesData, maxDim) {
    this._clearAxes();

    const axisLength = maxDim * 1.5;
    const axisRadius = maxDim * 0.01;

    this.targetAxisGroup = new THREE.Group();
    this.candidateAxisGroup = new THREE.Group();

    // 目标（鞋模）三轴：红/绿/蓝
    if (axesData.target) {
      const c = axesData.target.center;
      this.targetAxisGroup.add(
        this._createAxis(c, axesData.target.longitudinal_axis, 0xff0000, '纵向轴', axisLength, axisRadius)
      );
      this.targetAxisGroup.add(
        this._createAxis(c, axesData.target.vertical_axis, 0x00ff00, '垂直轴', axisLength, axisRadius)
      );
      if (axesData.target.lateral_axis) {
        this.targetAxisGroup.add(
          this._createAxis(c, axesData.target.lateral_axis, 0x0000ff, '横向轴', axisLength, axisRadius)
        );
      }
    }

    // 变换后的候选（粗胚）三轴：浅红/浅绿/浅蓝
    if (axesData.candidate_transformed) {
      const c = axesData.candidate_transformed.center;
      this.candidateAxisGroup.add(
        this._createAxis(c, axesData.candidate_transformed.longitudinal_axis, 0xff6666, '纵向轴', axisLength, axisRadius)
      );
      this.candidateAxisGroup.add(
        this._createAxis(c, axesData.candidate_transformed.vertical_axis, 0x66ff66, '垂直轴', axisLength, axisRadius)
      );
      if (axesData.candidate_transformed.lateral_axis) {
        this.candidateAxisGroup.add(
          this._createAxis(c, axesData.candidate_transformed.lateral_axis, 0x6666ff, '横向轴', axisLength, axisRadius)
        );
      }
    }

    this.scene.add(this.targetAxisGroup);
    this.scene.add(this.candidateAxisGroup);
    this._updateAxisVisibility();
  }

  _updateAxisVisibility() {
    const showTarget = document.getElementById('showTargetAxis');
    const showCandidate = document.getElementById('showCandidateAxis');
    if (this.targetAxisGroup) {
      this.targetAxisGroup.visible = showTarget ? showTarget.checked : true;
    }
    if (this.candidateAxisGroup) {
      this.candidateAxisGroup.visible = showCandidate ? showCandidate.checked : true;
    }
  }

  setTargetAxisVisible(visible) {
    if (this.targetAxisGroup) this.targetAxisGroup.visible = visible;
  }

  setCandidateAxisVisible(visible) {
    if (this.candidateAxisGroup) this.candidateAxisGroup.visible = visible;
  }

  setOutsidePointsVisible(visible) {
    if (this.outsidePointsGroup) this.outsidePointsGroup.visible = visible;
  }

  // ─── 粗胚外采样点（ray-casting） ───

  _visualizeOutsidePoints(maxDim) {
    this._clearOutsidePoints();
    if (!this.targetMesh || !this.candidateMesh) return;

    const positionAttr = this.targetMesh.geometry.getAttribute('position');
    if (!positionAttr) return;

    const vertexCount = positionAttr.count;
    if (vertexCount === 0) return;

    // 为 candidateMesh 计算 BVH 加速结构（首次 raycast 前）
    this.candidateMesh.geometry.computeBoundingBox();
    this.candidateMesh.geometry.computeBoundingSphere();

    const maxSamples = 200;
    const step = Math.max(1, Math.floor(vertexCount / maxSamples));

    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = false;
    const rayDir = new THREE.Vector3(1, 0, 0);
    const outsidePositions = [];
    const local = new THREE.Vector3();
    const worldPoint = new THREE.Vector3();

    for (let i = 0; i < vertexCount && outsidePositions.length < maxSamples; i += step) {
      local.fromBufferAttribute(positionAttr, i);
      worldPoint.copy(local);
      this.targetMesh.localToWorld(worldPoint);

      const origin = worldPoint.clone().addScaledVector(rayDir, 1e-4);
      raycaster.set(origin, rayDir);
      const intersects = raycaster.intersectObject(this.candidateMesh, false);
      const isInside = (intersects.length % 2 === 1);

      if (!isInside) {
        outsidePositions.push(worldPoint.clone());
      }
    }

    if (outsidePositions.length === 0) return;

    const ptsGeom = new THREE.BufferGeometry();
    const ptsArray = new Float32Array(outsidePositions.length * 3);
    for (let i = 0; i < outsidePositions.length; i++) {
      ptsArray[i * 3] = outsidePositions[i].x;
      ptsArray[i * 3 + 1] = outsidePositions[i].y;
      ptsArray[i * 3 + 2] = outsidePositions[i].z;
    }
    ptsGeom.setAttribute('position', new THREE.BufferAttribute(ptsArray, 3));

    const ptSize = Math.max(maxDim * 0.01, 0.5);
    const ptsMaterial = new THREE.PointsMaterial({
      color: 0xff00ff,
      size: ptSize,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
    });

    this.outsidePointsGroup = new THREE.Points(ptsGeom, ptsMaterial);
    const showOutside = document.getElementById('showOutsidePoints');
    this.outsidePointsGroup.visible = showOutside ? showOutside.checked : true;
    this.scene.add(this.outsidePointsGroup);
  }

  // ─── 手动位姿试探（方向键移动鞋模，后端实时回评包裹率） ───
  //
  // ← / → 沿纵向轴，↑ / ↓ 沿垂直轴，[ / ]（或 Shift+↑↓）沿横向轴；
  // - / = 调步长；R 复位到算法位姿。每次移动后防抖请求
  // /api/match/result/<id>/probe，用后端精确 BVH 口径重算包裹率与外点云。

  enableManualProbe(recordId) {
    this._probeRecordId = recordId;
    this.manualOffset = { dl: 0, dlat: 0, dv: 0 };
    this.manualRotation = { rl: 0, rlat: 0, rv: 0 };
    this._probePivot = null;
    this._ensureProbeHud();
    if (!this._probeKeyHandler) {
      this._probeKeyHandler = (e) => this._onProbeKey(e);
      window.addEventListener('keydown', this._probeKeyHandler);
    }
    this._scheduleProbe(80);   // 初始请求：以后端口径重绘外点云 + 基线包裹率
  }

  disableManualProbe() {
    if (this._probeKeyHandler) {
      window.removeEventListener('keydown', this._probeKeyHandler);
      this._probeKeyHandler = null;
    }
    if (this._probeTimer) {
      clearTimeout(this._probeTimer);
      this._probeTimer = null;
    }
    if (this._probeHud && this._probeHud.parentNode) {
      this._probeHud.parentNode.removeChild(this._probeHud);
    }
    this._probeHud = null;
    this._probeRecordId = null;
    this._baseFinalMatrix = null;
    this._lastProbe = null;
    this._probePivot = null;
  }

  _setManualBase(matrix) {
    this._baseFinalMatrix = matrix.clone();
    this.manualOffset = { dl: 0, dlat: 0, dv: 0 };
    this.manualRotation = { rl: 0, rlat: 0, rv: 0 };
    this._updateProbeHud();
    if (this._probeRecordId) this._scheduleProbe(300);
  }

  _onProbeKey(e) {
    if (!this._probeRecordId || !this.targetMesh || !this._baseFinalMatrix) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;

    const s = this.moveStep;
    // Shift + 移动键 = 绕对应轴旋转（度）；旋转需要后端返回的枢轴（首个 probe 响应）
    const rotReady = !!this._probePivot;
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
        if (e.shiftKey) { if (rotReady) this.manualRotation.rv += s; }
        else this.manualOffset.dl += s;
        break;
      case 'ArrowLeft':
        if (e.shiftKey) { if (rotReady) this.manualRotation.rv -= s; }
        else this.manualOffset.dl -= s;
        break;
      case 'ArrowUp':
        if (e.shiftKey) { if (rotReady) this.manualRotation.rlat += s; }
        else this.manualOffset.dv += s;
        break;
      case 'ArrowDown':
        if (e.shiftKey) { if (rotReady) this.manualRotation.rlat -= s; }
        else this.manualOffset.dv -= s;
        break;
      case ']': this.manualOffset.dlat += s; break;
      case '[': this.manualOffset.dlat -= s; break;
      case '}': if (rotReady) this.manualRotation.rl += s; break;   // Shift+]
      case '{': if (rotReady) this.manualRotation.rl -= s; break;   // Shift+[
      case '-': case '_': {
        const steps = [0.1, 0.5, 1, 2];
        const i = steps.indexOf(this.moveStep);
        this.moveStep = steps[Math.max(0, i - 1)];
        break;
      }
      case '=': case '+': {
        const steps = [0.1, 0.5, 1, 2];
        const i = steps.indexOf(this.moveStep);
        this.moveStep = steps[Math.min(steps.length - 1, i + 1)];
        break;
      }
      case 'r': case 'R':
        this.manualOffset = { dl: 0, dlat: 0, dv: 0 };
        this.manualRotation = { rl: 0, rlat: 0, rv: 0 };
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    this._applyManualOffset();
  }

  _manualAxes() {
    const ax = this.replayDataCache && this.replayDataCache.axes
      ? this.replayDataCache.axes.candidate_original : null;
    if (!ax) return null;
    return {
      L: new THREE.Vector3(...ax.longitudinal_axis).normalize(),
      Lat: new THREE.Vector3(...ax.lateral_axis).normalize(),
      V: new THREE.Vector3(...ax.vertical_axis).normalize(),
    };
  }

  _applyManualOffset() {
    const axes = this._manualAxes();
    if (!axes || !this.targetMesh || !this._baseFinalMatrix) return;
    // 与后端限制一致（±200mm / ±45°），避免 400
    const cl = (v, m) => Math.max(-m, Math.min(m, v));
    this.manualOffset.dl = cl(this.manualOffset.dl, 200);
    this.manualOffset.dlat = cl(this.manualOffset.dlat, 200);
    this.manualOffset.dv = cl(this.manualOffset.dv, 200);
    this.manualRotation.rl = cl(this.manualRotation.rl, 45);
    this.manualRotation.rlat = cl(this.manualRotation.rlat, 45);
    this.manualRotation.rv = cl(this.manualRotation.rv, 45);
    const { dl, dlat, dv } = this.manualOffset;
    const { rl, rlat, rv } = this.manualRotation;
    const off = new THREE.Vector3()
      .addScaledVector(axes.L, dl)
      .addScaledVector(axes.Lat, dlat)
      .addScaledVector(axes.V, dv);
    const M = new THREE.Matrix4().makeTranslation(off.x, off.y, off.z);
    if ((rl || rlat || rv) && this._probePivot) {
      // 与后端同一约定：R = R_yaw(V)·R_pitch(Lat)·R_roll(L)，绕鞋模质心（渲染帧）
      const d2r = Math.PI / 180;
      const R = new THREE.Matrix4().makeRotationAxis(axes.V, rv * d2r)
        .multiply(new THREE.Matrix4().makeRotationAxis(axes.Lat, rlat * d2r))
        .multiply(new THREE.Matrix4().makeRotationAxis(axes.L, rl * d2r));
      const P = this._probePivot;
      M.multiply(new THREE.Matrix4().makeTranslation(P.x, P.y, P.z))
        .multiply(R)
        .multiply(new THREE.Matrix4().makeTranslation(-P.x, -P.y, -P.z));
    }
    M.multiply(this._baseFinalMatrix);
    this.targetMesh.matrixAutoUpdate = false;
    this.targetMesh.matrix.copy(M);
    this.targetMesh.updateMatrixWorld(true);
    this._updateProbeHud();
    this._scheduleProbe(280);
  }

  _scheduleProbe(delayMs) {
    if (!this._probeRecordId) return;
    if (this._probeTimer) clearTimeout(this._probeTimer);
    this._probeTimer = setTimeout(() => this._runProbe(), delayMs);
  }

  async _runProbe() {
    if (!this._probeRecordId || this._probeBusy) {
      // 忙碌时顺延，保证最后一次按键的状态最终会被评估
      if (this._probeBusy) this._scheduleProbe(200);
      return;
    }
    this._probeBusy = true;
    const { dl, dlat, dv } = this.manualOffset;
    const { rl, rlat, rv } = this.manualRotation;
    try {
      const base = (typeof API_BASE_URL !== 'undefined')
        ? API_BASE_URL : 'http://127.0.0.1:5000/api';
      const resp = await fetch(
        `${base}/match/result/${this._probeRecordId}/probe`
        + `?dl=${dl}&dlat=${dlat}&dv=${dv}&rl=${rl}&rlat=${rlat}&rv=${rv}`);
      if (!resp.ok) throw new Error(`probe ${resp.status}`);
      const data = await resp.json();
      // 记录旋转枢轴（首个响应即到位；此后 Shift 旋转键生效）
      if (data.pivot && !this._probePivot) {
        this._probePivot = new THREE.Vector3(data.pivot[0], data.pivot[1], data.pivot[2]);
      }
      // 丢弃过期响应（期间用户又按了键）
      const cur = this.manualOffset;
      const curR = this.manualRotation;
      const rot = data.rotations || { rl: 0, rlat: 0, rv: 0 };
      if (data.offsets.dl === cur.dl && data.offsets.dlat === cur.dlat && data.offsets.dv === cur.dv
          && rot.rl === curR.rl && rot.rlat === curR.rlat && rot.rv === curR.rv) {
        this._lastProbe = data;
        this._renderProbeOutsidePoints(data);
        this._updateProbeHud();
      } else {
        this._scheduleProbe(120);
      }
    } catch (err) {
      console.warn('[probe] 请求失败:', err);
    } finally {
      this._probeBusy = false;
    }
  }

  _renderProbeOutsidePoints(data) {
    // 后端口径外点云替换旧的前端单射线检测（有 probe 时禁用后者）
    if (this._outsidePointsPending) {
      cancelAnimationFrame(this._outsidePointsPending);
      this._outsidePointsPending = null;
    }
    this._clearOutsidePoints();
    const pts = data.outside_points || [];
    if (pts.length === 0) return;

    const pos = new Float32Array(pts.length * 3);
    const col = new Float32Array(pts.length * 3);
    const c1 = [1.0, 0.63, 0.25], c2 = [1.0, 0.19, 0.19], c3 = [0.48, 0.0, 0.0], c4 = [1.0, 0.0, 1.0];
    for (let i = 0; i < pts.length; i++) {
      pos[i * 3] = pts[i][0]; pos[i * 3 + 1] = pts[i][1]; pos[i * 3 + 2] = pts[i][2];
      const depth = pts[i][3];
      const c = depth <= 1 ? c1 : depth <= 3 ? c2 : depth <= 6 ? c3 : c4;
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let maxDim = 100;
    if (this.candidateMesh) {
      this.candidateMesh.geometry.computeBoundingBox();
      const bb = this.candidateMesh.geometry.boundingBox;
      maxDim = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
    }
    const mat = new THREE.PointsMaterial({
      size: Math.max(maxDim * 0.008, 0.5),
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
    });
    this.outsidePointsGroup = new THREE.Points(geom, mat);
    const showOutside = document.getElementById('showOutsidePoints');
    this.outsidePointsGroup.visible = showOutside ? showOutside.checked : true;
    this.scene.add(this.outsidePointsGroup);
  }

  _ensureProbeHud() {
    if (this._probeHud || !this.container) return;
    const hud = document.createElement('div');
    hud.style.cssText = [
      'position:absolute', 'top:10px', 'left:10px', 'z-index:20',
      'background:rgba(20,24,34,0.82)', 'color:#e8ecf4',
      'font:12px/1.7 "SF Mono",Menlo,monospace',
      'padding:8px 12px', 'border-radius:6px', 'pointer-events:none',
      'white-space:pre', 'border:1px solid rgba(255,255,255,0.12)',
    ].join(';');
    if (getComputedStyle(this.container).position === 'static') {
      this.container.style.position = 'relative';
    }
    this.container.appendChild(hud);
    this._probeHud = hud;
    this._updateProbeHud();
  }

  _updateProbeHud() {
    if (!this._probeHud) return;
    const { dl, dlat, dv } = this.manualOffset;
    const { rl, rlat, rv } = this.manualRotation;
    const moved = dl !== 0 || dlat !== 0 || dv !== 0 || rl !== 0 || rlat !== 0 || rv !== 0;
    const p = this._lastProbe;
    let wrapLine = '包裹率: 计算中…';
    if (p) {
      const w = (p.wrap * 100).toFixed(2);
      const b = (p.baseline_wrap * 100).toFixed(2);
      const delta = (p.wrap - p.baseline_wrap) * 100;
      const sign = delta > 0.005 ? '▲' : delta < -0.005 ? '▼' : '·';
      const color = delta > 0.005 ? '#4cc17a' : delta < -0.005 ? '#e06552' : '#e8ecf4';
      // stored = 匹配时存档的最终指标（5000 面积采样）；试探口径同为面积采样
      //（8000 点、不同随机抽样），基线与存档间 ±0.3pp 内属采样噪声
      const stored = (p.stored_wrap != null) ? ` · 存档 ${(p.stored_wrap * 100).toFixed(2)}%` : '';
      const mode = (p.sampling === 'vertex') ? ' ⚠顶点口径' : '';
      wrapLine = `包裹率: <b style="color:${color}">${w}%</b> ${sign} `
        + `(基线 ${b}%${stored})${mode}  外点 ${p.outside_count}/${p.sample_count}`;
    }
    this._probeHud.innerHTML =
      `<b>${moved ? '⚠ 手动试探位姿' : '算法输出位姿'}</b>  步长 ${this.moveStep}mm/${this.moveStep}°\n`
      + `ΔL ${dl.toFixed(1)}  ΔLat ${dlat.toFixed(1)}  ΔV ${dv.toFixed(1)} (mm)`
      + `   旋转 滚${rl.toFixed(1)} 俯${rlat.toFixed(1)} 偏${rv.toFixed(1)} (°)\n`
      + wrapLine + '\n'
      + '<span style="opacity:.65">←→纵向  ↑↓垂直  [ ]横向  ⇧←→偏航  ⇧↑↓俯仰  ⇧[ ]滚转  -/=步长  R复位</span>';
  }

  // ─── 通用方法 ───

  _buildGeometry(vertices, faces) {
    if (!vertices || vertices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    // 支持 TypedArray（二进制格式）和嵌套数组（旧 JSON 格式）
    const vArray = (vertices instanceof Float32Array) ? vertices : new Float32Array(vertices.flat());
    geometry.setAttribute('position', new THREE.BufferAttribute(vArray, 3));
    if (faces && faces.length > 0) {
      const iArray = (faces instanceof Uint32Array) ? faces : new Uint32Array(faces.flat());
      geometry.setIndex(new THREE.BufferAttribute(iArray, 1));
    }
    geometry.computeVertexNormals();
    return geometry;
  }

  _cleanVertices(vertices) {
    const cleaned = [];
    if (vertices.length > 0 && Array.isArray(vertices[0])) {
      for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        if (Array.isArray(v) && v.length >= 3) {
          cleaned.push(
            isNaN(v[0]) || !isFinite(v[0]) ? 0 : Number(v[0]),
            isNaN(v[1]) || !isFinite(v[1]) ? 0 : Number(v[1]),
            isNaN(v[2]) || !isFinite(v[2]) ? 0 : Number(v[2])
          );
        } else {
          cleaned.push(0, 0, 0);
        }
      }
    } else {
      for (let i = 0; i < vertices.length; i++) {
        const val = vertices[i];
        cleaned.push(typeof val === 'number' && !isNaN(val) && isFinite(val) ? Number(val) : 0);
      }
      while (cleaned.length % 3 !== 0) cleaned.push(0);
    }
    return cleaned;
  }

  _cleanFaces(faces, maxVertexCount) {
    const cleaned = [];
    const maxIndex = maxVertexCount - 1;
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i];
      if (Array.isArray(face) && face.length >= 3) {
        const idx0 = Math.max(0, Math.min(maxIndex, Math.floor(face[0])));
        const idx1 = Math.max(0, Math.min(maxIndex, Math.floor(face[1])));
        const idx2 = Math.max(0, Math.min(maxIndex, Math.floor(face[2])));
        if (idx0 !== idx1 && idx1 !== idx2 && idx0 !== idx2) {
          cleaned.push(idx0, idx1, idx2);
        }
      } else if (typeof face === 'number' && !isNaN(face) && isFinite(face)) {
        cleaned.push(Math.max(0, Math.min(maxIndex, Math.floor(face))));
      }
    }
    return cleaned;
  }

  fitToView() {
    if (this.meshes.length === 0) return;
    const box = new THREE.Box3();
    this.meshes.forEach(mesh => box.expandByObject(mesh));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = maxDim * 2;

    this.camera.position.set(
      center.x + distance * 0.7,
      center.y + distance * 0.7,
      center.z + distance * 0.7
    );
    this.camera.lookAt(center);
    if (this.controls) {
      if (this.controls.target) this.controls.target.copy(center);
      if (this.controls.update) this.controls.update();
    }
  }

  dispose() {
    this.stopReplay();
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.clear();
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._themeHandler) {
      window.removeEventListener('themechange', this._themeHandler);
      this._themeHandler = null;
    }
    if (this.renderer) {
      if (this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
      this.renderer.dispose();
      this.renderer = null;
    }
    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }
  }
}

if (typeof THREE === 'undefined') {
  console.error('Three.js未加载，请确保已引入Three.js库');
}