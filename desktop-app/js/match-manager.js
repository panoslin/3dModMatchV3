// 鞋模匹配管理模块
class MatchManager {
  constructor() {
    this.uploadedShoes = [];
    this.selectedCategories = new Set();
    this.matchTasks = new Map();   // taskId -> taskInfo
    this._elapsedTimer = null;

    this.init();
  }

  static PARAM_IDS = [
    'param-wrapping-threshold',
    'param-concurrent-matches',
    'param-ga-population',
    'param-ga-generations',
    'param-ga-crossover',
    'param-ga-mutation',
    'param-translation-range',
    'param-rotation-range',
    'param-lateral-range',
    'param-sample-points',
  ];

  init() {
    this._restoreParams();
    this.setupEventListeners();
    this.loadCategories();
    this.checkMatcherHealth();
    this.startPolling();
    this.startElapsedTimer();
  }

  _restoreParams() {
    const saved = localStorage.getItem('matchParams');
    if (!saved) return;
    try {
      const params = JSON.parse(saved);
      for (const id of MatchManager.PARAM_IDS) {
        if (params[id] != null) {
          const el = document.getElementById(id);
          if (el) el.value = params[id];
        }
      }
    } catch (_) { /* ignore corrupt data */ }
  }

  _saveParams() {
    const params = {};
    for (const id of MatchManager.PARAM_IDS) {
      const el = document.getElementById(id);
      if (el) params[id] = el.value;
    }
    localStorage.setItem('matchParams', JSON.stringify(params));
  }

  async checkMatcherHealth() {
    try {
      const health = await API.health();
      this._updateMatcherBanner(!health.matcher_available, health.matcher_error, null);
    } catch (e) {
      // Server not reachable yet
    }
  }

  _updateMatcherBanner(show, detail, hint) {
    const banner = document.getElementById('matcher-unavailable-banner');
    if (!banner) return;
    if (!show) { banner.style.display = 'none'; return; }
    banner.style.display = 'flex';
    const detailEl = document.getElementById('matcher-banner-detail');
    const hintEl = document.getElementById('matcher-banner-hint');
    if (detailEl) detailEl.textContent = detail || '';
    if (hintEl) {
      hintEl.textContent = hint || 'cd src/core && mkdir -p build && cd build && cmake -DCMAKE_BUILD_TYPE=Release .. && make -j$(nproc)';
    }
  }

  setupEventListeners() {
    const uploadZone = document.getElementById('shoe-upload-zone');
    const fileInput = document.getElementById('shoe-file-input');

    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      this.handleFiles(Array.from(e.dataTransfer.files));
    });
    fileInput.addEventListener('change', (e) => this.handleFiles(Array.from(e.target.files)));

    document.getElementById('start-match-btn').addEventListener('click', () => this.startMatch());

    const reloadBtn = document.getElementById('matcher-reload-btn');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', async () => {
        reloadBtn.disabled = true;
        reloadBtn.textContent = '检测中...';
        try {
          const result = await API.reloadMatcher();
          this._updateMatcherBanner(!result.success, result.error, null);
        } catch (e) {
          this._updateMatcherBanner(true, e.message, null);
        } finally {
          reloadBtn.disabled = false;
          reloadBtn.textContent = '重新检测';
        }
      });
    }

    document.getElementById('match-result-close').addEventListener('click', () => {
      document.getElementById('match-result-modal').classList.remove('active');
      ResultDetailView.disposeViewer();
    });

    // 参数变更时自动保存
    for (const id of MatchManager.PARAM_IDS) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => this._saveParams());
    }
  }

  // ── Categories ──────────────────────────────────────────────────────────────
  async loadCategories() {
    try {
      const resp = await API.getCategories();
      const categories = resp.categories || resp;
      this.renderCategoryTree(categories);
    } catch (error) {
      console.error('加载分类失败:', error);
    }
  }

  renderCategoryTree(categories) {
    const container = document.getElementById('category-tree');
    if (!container) return;
    container.innerHTML = '';

    if (!categories || categories.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无分类，请先在"粗胚管理"中创建</div>';
      return;
    }

    const tree = this._buildTree(categories);
    const render = (node, level = 0) => {
      const item = document.createElement('div');
      item.className = 'category-item';
      item.style.paddingLeft = `${level * 20 + 8}px`;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'category-checkbox';
      cb.value = node.id;
      cb.checked = this.selectedCategories.has(node.id);
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        if (e.target.checked) this.selectedCategories.add(node.id);
        else this.selectedCategories.delete(node.id);
      });

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target === cb) return; // checkbox handles its own toggle
        cb.checked = !cb.checked;
        if (cb.checked) this.selectedCategories.add(node.id);
        else this.selectedCategories.delete(node.id);
      });

      const label = document.createElement('span');
      label.className = 'category-label';
      label.textContent = node.path || node.name;

      item.appendChild(cb);
      item.appendChild(label);
      container.appendChild(item);

      if (node.children) node.children.forEach(c => render(c, level + 1));
    };
    tree.forEach(r => render(r));
  }

  _buildTree(categories) {
    const map = new Map();
    const roots = [];
    categories.forEach(c => map.set(c.id, { ...c, children: [] }));
    categories.forEach(c => {
      const n = map.get(c.id);
      if (c.parent_id) { const p = map.get(c.parent_id); if (p) p.children.push(n); else roots.push(n); }
      else roots.push(n);
    });
    return roots;
  }

  // ── File handling ───────────────────────────────────────────────────────────
  handleFiles(files) {
    files.forEach(f => {
      if (f.size > 500 * 1024 * 1024) { alert(`文件 ${f.name} 超过500MB限制`); return; }
      if (!f.name.match(/\.(stl|3dm)$/i)) { alert(`文件 ${f.name} 格式不支持`); return; }
      this.uploadedShoes.push({ id: Date.now() + Math.random(), file: f, name: f.name, status: 'pending' });
    });
    this.renderUploadedFiles();
  }

  renderUploadedFiles() {
    const container = document.getElementById('shoe-uploaded-files');
    container.innerHTML = '';
    this.uploadedShoes.forEach(shoe => {
      const item = document.createElement('div');
      item.className = 'uploaded-file';
      item.innerHTML = `
        <span class="uploaded-file-name">${this._esc(shoe.name)}</span>
        <span class="uploaded-file-size">${(shoe.file.size / 1024 / 1024).toFixed(1)} MB</span>
        <button class="uploaded-file-remove" data-id="${shoe.id}">×</button>
      `;
      item.querySelector('.uploaded-file-remove').addEventListener('click', () => {
        this.uploadedShoes = this.uploadedShoes.filter(s => s.id !== shoe.id);
        this.renderUploadedFiles();
      });
      container.appendChild(item);
    });
  }

  getMatchParams() {
    return {
      wrapping_threshold: parseFloat(document.getElementById('param-wrapping-threshold').value),
      ga_population: parseInt(document.getElementById('param-ga-population').value),
      ga_generations: parseInt(document.getElementById('param-ga-generations').value),
      ga_crossover: parseFloat(document.getElementById('param-ga-crossover').value),
      ga_mutation: parseFloat(document.getElementById('param-ga-mutation').value),
      translation_range: parseFloat(document.getElementById('param-translation-range').value),
      rotation_range: parseFloat(document.getElementById('param-rotation-range').value),
      lateral_range: parseFloat(document.getElementById('param-lateral-range').value),
      sample_points: parseInt(document.getElementById('param-sample-points').value),
    };
  }

  // ── Match execution ─────────────────────────────────────────────────────────
  async startMatch() {
    if (this.uploadedShoes.length === 0) { alert('请先上传鞋模文件'); return; }
    if (this.selectedCategories.size === 0) { alert('请选择粗胚分类'); return; }

    const params = this.getMatchParams();
    const concurrentLimit = parseInt(document.getElementById('param-concurrent-matches').value) || 2;

    // Reset UI
    document.getElementById('match-progress-section').style.display = 'block';
    document.getElementById('match-results-section').style.display = 'none';
    document.getElementById('match-results-list').innerHTML = '';
    document.getElementById('start-match-btn').disabled = true;
    document.getElementById('start-match-btn').textContent = '匹配中...';

    this.matchTasks.clear();

    // Pre-register tasks
    const shoes = [...this.uploadedShoes];
    shoes.forEach(shoe => {
      this.matchTasks.set(`pending-${shoe.id}`, {
        localId: shoe.id,
        shoeName: shoe.name,
        status: 'uploading',
        progress: 0,
        startTime: Date.now(),
        endTime: null,
        error: null,
        results: [],
        isPending: true,
      });
    });
    this.renderProgress();

    // Concurrency-limited parallel execution
    const executing = new Set();
    for (const shoe of shoes) {
      const p = this._processShoe(shoe, params, concurrentLimit).finally(() => executing.delete(p));
      executing.add(p);
      if (executing.size >= concurrentLimit) await Promise.race(executing);
    }
    await Promise.allSettled(executing);

    document.getElementById('start-match-btn').disabled = false;
    document.getElementById('start-match-btn').textContent = '开始匹配';
  }

  async _processShoe(shoe, params, concurrentLimit) {
    const localKey = `pending-${shoe.id}`;
    const taskInfo = this.matchTasks.get(localKey);
    try {
      const shoeData = await API.uploadShoe(shoe.file, shoe.name);
      shoe.uploadedId = shoeData.id;
      if (taskInfo) taskInfo.status = 'queued';
      this.renderProgress();

      const taskData = await API.startMatch({
        shoe_id: shoeData.id,
        category_ids: Array.from(this.selectedCategories),
        params,
        max_concurrent: concurrentLimit,
      });

      shoe.taskId = taskData.task_id;
      this.matchTasks.delete(localKey);
      if (taskInfo) {
        taskInfo.isPending = false;
        taskInfo.taskId = taskData.task_id;
        this.matchTasks.set(taskData.task_id, taskInfo);
      }
      // Poll immediately so UI reflects server state without waiting 2s
      this.updateProgress();
    } catch (error) {
      console.error('启动匹配失败:', error);
      if (error.httpStatus === 503) this._updateMatcherBanner(true, error.detail, error.hint);
      if (taskInfo) {
        taskInfo.status = 'error';
        taskInfo.endTime = Date.now();
        taskInfo.error = error.httpStatus === 503
          ? '匹配模块不可用，请查看页面顶部提示'
          : error.message;
      }
    }
    this.renderProgress();
  }

  // ── Polling & timer ─────────────────────────────────────────────────────────
  startPolling() {
    setInterval(() => this.updateProgress(), 2000);
  }

  startElapsedTimer() {
    this._elapsedTimer = setInterval(() => {
      const hasActive = [...this.matchTasks.values()].some(t =>
        ['uploading', 'queued', 'running'].includes(t.status)
      );
      if (hasActive) this.renderProgress();
    }, 1000);
  }

  async updateProgress() {
    for (const [taskId, task] of this.matchTasks.entries()) {
      if (task.isPending || task.status === 'uploading') continue;
      if (task.status !== 'queued' && task.status !== 'running') continue;

      try {
        const d = await API.getMatchTask(taskId);
        const prevStatus = task.status;
        task.status = d.status;
        task.progress = d.progress || 0;
        task.results = d.results || [];
        if (d.error) task.error = d.error;
        if (d.started_at && !task.serverStartTime) {
          task.serverStartTime = new Date(d.started_at).getTime();
        }

        // Capture end time on terminal states
        if ((task.status === 'completed' || task.status === 'error') && !task.endTime) {
          task.endTime = Date.now();
        }

        if (task.status === 'completed' && prevStatus !== 'completed') {
          this.appendShoeResultCard(task);
        }
      } catch (error) {
        console.error('更新进度失败:', error);
      }
    }
    this.renderProgress();
  }

  // ── Progress rendering ──────────────────────────────────────────────────────
  renderProgress() {
    const container = document.getElementById('match-progress-list');
    container.innerHTML = '';

    this.matchTasks.forEach((task) => {
      const startTime = task.serverStartTime || task.startTime;
      // Use captured endTime for terminal states so timer doesn't keep counting
      const endRef = task.endTime || Date.now();
      const elapsed = startTime ? Math.floor((endRef - startTime) / 1000) : 0;

      let statusText, statusClass;
      switch (task.status) {
        case 'uploading':  statusText = '上传中';  statusClass = 'status-uploading'; break;
        case 'queued':     statusText = '排队中';  statusClass = 'status-queued'; break;
        case 'running':    statusText = '匹配中';  statusClass = 'status-running'; break;
        case 'completed':  statusText = '已完成';  statusClass = 'status-completed'; break;
        case 'error':      statusText = '失败';    statusClass = 'status-error'; break;
        case 'cancelled':  statusText = '已取消';  statusClass = 'status-cancelled'; break;
        default:           statusText = '等待中';  statusClass = 'status-queued';
      }

      const isDone = task.status === 'completed';
      const isFailed = task.status === 'error';
      const elapsedStr = this._formatDuration(elapsed);
      let elapsedHtml = '';
      if (isDone) elapsedHtml = `<span class="task-elapsed task-elapsed-done">用时 ${elapsedStr}</span>`;
      else if (!isFailed) elapsedHtml = `<span class="task-elapsed">${elapsedStr}</span>`;

      const totalCount = task.results ? task.results.length : 0;
      const matchedResults = task.results ? task.results.filter(r => r.matched) : [];
      const matchedCount = matchedResults.length;
      // Best = minimum volume among matched (same as matcher.py); show its wrapping ratio
      const bestMatch = matchedResults.length > 0
        ? matchedResults.reduce((a, b) => (a.match_info?.volume || 0) < (b.match_info?.volume || 0) ? a : b)
        : null;
      const bestWr = bestMatch ? (bestMatch.match_info?.wrapping_ratio || 0) * 100 : null;

      const item = document.createElement('div');
      item.className = `progress-item ${isDone ? 'progress-done' : ''} ${isFailed ? 'progress-failed' : ''}`;
      item.innerHTML = `
        <div class="progress-item-header">
          <span class="progress-item-name">${this._esc(task.shoeName)}</span>
          <div class="progress-item-right">
            ${elapsedHtml}
            <span class="progress-item-status ${statusClass}">${statusText}</span>
          </div>
        </div>
        ${!isDone && !isFailed ? `
        <div class="progress-bar">
          <div class="progress-bar-fill" style="width: ${task.progress}%"></div>
        </div>` : ''}
        ${isDone && totalCount > 0 ? `
        <div class="progress-summary">
          <span>${matchedCount} / ${totalCount} 匹配</span>
          ${bestWr !== null ? `<span>最高包裹率 ${bestWr.toFixed(1)}%</span>` : ''}
        </div>` : ''}
        ${task.error ? `<div class="task-error">${this._esc(task.error)}</div>` : ''}
      `;
      container.appendChild(item);
    });
  }

  // ── Result cards ────────────────────────────────────────────────────────────
  appendShoeResultCard(task) {
    const section = document.getElementById('match-results-section');
    section.style.display = 'block';
    const list = document.getElementById('match-results-list');

    if (!task.results || task.results.length === 0) return;

    // Matched: sort by volume asc (minimum volume = best fit, mirrors matcher.py)
    // Unmatched: sort by wrapping_ratio desc (closest misses first)
    const matched = task.results
      .filter(r => r.matched)
      .sort((a, b) => (a.match_info?.volume || 0) - (b.match_info?.volume || 0));
    const unmatched = task.results
      .filter(r => !r.matched)
      .sort((a, b) => (b.match_info?.wrapping_ratio || 0) - (a.match_info?.wrapping_ratio || 0));
    const allSorted = [...matched, ...unmatched];

    const best = matched[0];
    const mi = best?.match_info || {};
    const hasMatch = matched.length > 0;

    const group = document.createElement('div');
    group.className = 'shoe-result-group';

    const wrRatio = (mi.wrapping_ratio || 0) * 100;
    const wrClass = wrRatio >= 96 ? 'good' : wrRatio >= 90 ? 'warn' : 'bad';

    group.innerHTML = `
      <div class="shoe-result-header">
        <span class="shoe-result-name">${this._esc(task.shoeName)}</span>
        <span class="shoe-result-count">${matched.length} 匹配 / ${unmatched.length} 不符</span>
      </div>
      <div class="result-best-match">
        ${hasMatch ? `
          <div class="best-match-header">
            <span class="best-match-tag">最佳匹配</span>
            <span class="best-match-name">${this._esc(mi.blank_name || '')}</span>
          </div>
          <div class="overview-metrics">
            <div class="overview-metric">
              <div class="metric-value ${wrClass}">${wrRatio.toFixed(1)}%</div>
              <div class="metric-label">包裹率</div>
            </div>
            <div class="overview-metric">
              <div class="metric-value">${(mi.percentile96_clearance || 0).toFixed(2)}</div>
              <div class="metric-label">P96间隙 (mm)</div>
            </div>
            <div class="overview-metric">
              <div class="metric-value">${(mi.volume || 0).toFixed(0)}</div>
              <div class="metric-label">体积</div>
            </div>
            <div class="overview-metric">
              <div class="metric-value good">是</div>
              <div class="metric-label">完全包裹</div>
            </div>
          </div>
        ` : `
          <div class="no-match-notice">
            <span class="no-match-icon">⚠</span>
            <span>所有粗胚均不满足包裹条件</span>
          </div>
        `}
        <button class="btn-secondary btn-sm view-all-btn">查看全部 ${allSorted.length} 个粗胚结果</button>
      </div>
    `;

    group.querySelector('.view-all-btn').addEventListener('click', () => {
      this.previewAllResults(task);
    });

    list.appendChild(group);
  }

  // ── Detail modal — show ALL blanks for a shoe (delegates to shared module) ──
  previewAllResults(task) {
    // task.taskId is the server-assigned task ID (the matchTasks Map key after upload)
    ResultDetailView.showAllResults({
      taskId: task.taskId || null,
      shoeName: task.shoeName,
      results: task.results || [],
    });
  }

  _formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }

  _esc(text) {
    if (!text && text !== 0) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
  }
}
