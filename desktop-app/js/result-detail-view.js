// 共享的匹配结果详情视图模块
// 被 MatchManager 和 HistoryManager 共同使用
class ResultDetailView {
  static _viewer = null;
  static _loadSeq = 0;

  static _esc(text) {
    if (!text && text !== 0) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
  }

  /**
   * 展示鞋模的全部粗胚匹配结果
   * @param {object} task - { shoeName: string, results: Array }
   */
  static showAllResults(task) {
    const modal = document.getElementById('match-result-modal');
    modal.classList.add('active');

    const matched = (task.results || [])
      .filter(r => r.matched)
      .sort((a, b) => ((a.match_info || {}).volume || 0) - ((b.match_info || {}).volume || 0));
    const unmatched = (task.results || [])
      .filter(r => !r.matched)
      .sort((a, b) => ((b.match_info || {}).wrapping_ratio || 0) - ((a.match_info || {}).wrapping_ratio || 0));
    const allSorted = [...matched, ...unmatched];

    document.getElementById('match-result-modal-title').textContent = task.shoeName;
    document.getElementById('match-result-modal-subtitle').textContent =
      `${matched.length} 个匹配 · ${unmatched.length} 个不符 · 共 ${allSorted.length} 个粗胚`;

    const detailPane = document.getElementById('match-result-details');
    const overviewEl = document.getElementById('match-result-overview');
    overviewEl.innerHTML = '';
    detailPane.innerHTML = '';

    const listEl = document.createElement('div');
    listEl.className = 'all-matches-list';
    listEl.innerHTML = '<h3>全部粗胚结果</h3>';

    allSorted.forEach((r, idx) => {
      const mi = r.match_info || {};
      const isMatched = r.matched;
      const wr = (mi.wrapping_ratio || 0) * 100;
      const wrCls = isMatched ? (wr >= 96 ? 'good' : 'warn') : 'bad';
      const isFirstRow = idx === 0;

      const row = document.createElement('div');
      row.className = `match-list-row ${isFirstRow ? 'active' : ''} ${isMatched ? '' : 'row-unmatched'}`;
      row.dataset.index = idx;

      let rankHtml;
      if (isMatched && idx === 0) rankHtml = '<span class="rank-best">最佳</span>';
      else if (isMatched) rankHtml = `#${idx + 1}`;
      else rankHtml = '<span class="rank-fail">✕</span>';

      const wrHtml = wr > 0 ? `${wr.toFixed(1)}%` : '—';
      const p96Html = mi.percentile96_clearance != null ? `${mi.percentile96_clearance.toFixed(2)} mm` : '—';
      const volHtml = mi.volume ? mi.volume.toFixed(0) : '—';

      row.innerHTML = `
        <div class="match-list-rank">${rankHtml}</div>
        <div class="match-list-name">${this._esc(mi.blank_name || r.blank_name || 'N/A')}</div>
        <div class="match-list-wr ${wrCls}">${wrHtml}</div>
        <div class="match-list-p96">${p96Html}</div>
        <div class="match-list-vol">${volHtml}</div>
      `;
      row.addEventListener('click', () => {
        listEl.querySelectorAll('.match-list-row').forEach(el => el.classList.remove('active'));
        row.classList.add('active');
        this.showMatchDetail(overviewEl, r, task.shoeName);
        if (r.record_id) this.load3DPreview(r.record_id);
        else this._showNoPreview();
      });
      listEl.appendChild(row);
    });

    detailPane.appendChild(listEl);

    if (allSorted.length > 0) {
      const first = allSorted[0];
      this.showMatchDetail(overviewEl, first, task.shoeName);
      if (first.record_id) this.load3DPreview(first.record_id);
      else this._showNoPreview();
    }
  }

  static showMatchDetail(overviewEl, result, shoeName) {
    const mi = result.match_info || {};
    const wr = (mi.wrapping_ratio || 0) * 100;
    const isMatched = result.matched;

    let failReasons = [];
    if (!isMatched) {
      if (mi.error) {
        failReasons.push(mi.error);
      } else {
        if (!mi.meets_direction_constraints) failReasons.push('方向约束不满足');
        if (!mi.is_fully_wrapped) failReasons.push(`包裹率不足 (${wr.toFixed(1)}% < ${((mi.target_wrapping_ratio || 0.96) * 100).toFixed(0)}%)`);
        if (failReasons.length === 0) failReasons.push('不满足匹配条件');
      }
    }

    overviewEl.innerHTML = `
      <div class="detail-header">
        <h3>${this._esc(mi.blank_name || result.blank_name || '')}</h3>
        ${isMatched
          ? '<span class="detail-status-badge matched">✓ 匹配成功</span>'
          : '<span class="detail-status-badge unmatched">✕ 不匹配</span>'}
      </div>
      ${!isMatched && failReasons.length > 0 ? `
      <div class="detail-fail-reason">${failReasons.map(r => `<span>${this._esc(r)}</span>`).join('')}</div>
      ` : ''}
      <div class="detail-metrics-grid">
        <div class="detail-metric">
          <span class="dm-label">包裹率</span>
          <span class="dm-value ${wr > 0 ? (isMatched ? 'good' : 'warn') : ''}">${wr > 0 ? wr.toFixed(2) + '%' : '—'}</span>
        </div>
        <div class="detail-metric">
          <span class="dm-label">目标包裹率</span>
          <span class="dm-value">${((mi.target_wrapping_ratio || 0.96) * 100).toFixed(0)}%</span>
        </div>
        <div class="detail-metric">
          <span class="dm-label">P96间隙</span>
          <span class="dm-value">${mi.percentile96_clearance != null ? mi.percentile96_clearance.toFixed(2) + ' mm' : '—'}</span>
        </div>
        <div class="detail-metric">
          <span class="dm-label">体积</span>
          <span class="dm-value">${mi.volume ? mi.volume.toFixed(1) : '—'}</span>
        </div>
        <div class="detail-metric">
          <span class="dm-label">完全包裹</span>
          <span class="dm-value ${mi.is_fully_wrapped ? 'good' : 'warn'}">${mi.is_fully_wrapped ? '是' : '否'}</span>
        </div>
        <div class="detail-metric">
          <span class="dm-label">方向约束</span>
          <span class="dm-value ${mi.meets_direction_constraints ? 'good' : 'warn'}">${mi.meets_direction_constraints ? '满足' : '不满足'}</span>
        </div>
        <div class="detail-metric">
          <span class="dm-label">纵向平移</span>
          <span class="dm-value">${mi.optimal_translation != null ? mi.optimal_translation.toFixed(2) + ' mm' : '—'}</span>
        </div>
        <div class="detail-metric">
          <span class="dm-label">旋转角度</span>
          <span class="dm-value">${mi.optimal_rotation_angle_deg != null ? mi.optimal_rotation_angle_deg.toFixed(2) + '°' : '—'}</span>
        </div>
        <div class="detail-metric">
          <span class="dm-label">横向偏移</span>
          <span class="dm-value">${mi.optimal_lateral_offset != null ? mi.optimal_lateral_offset.toFixed(2) + ' mm' : '—'}</span>
        </div>
      </div>
      ${mi.direction_alignment ? `
      <div class="detail-section">
        <h4>方向对齐</h4>
        <div class="detail-metrics-grid">
          <div class="detail-metric">
            <span class="dm-label">前后角度</span>
            <span class="dm-value">${(mi.direction_alignment.heel_toe_angle_deg || 0).toFixed(2)}°</span>
          </div>
          <div class="detail-metric">
            <span class="dm-label">垂直角度</span>
            <span class="dm-value">${(mi.direction_alignment.vertical_angle_deg || 0).toFixed(2)}°</span>
          </div>
        </div>
      </div>` : ''}
    `;
  }

  static async load3DPreview(recordId) {
    const viewerContainer = document.getElementById('match-result-3d');
    if (!recordId) {
      viewerContainer.innerHTML = '<div class="viewer-placeholder">无法加载3D预览</div>';
      return;
    }

    // 清除旧模型数据，但保留 Viewer3D 实例（复用 WebGL 上下文）
    if (this._viewer) {
      this._viewer.clear();
    }

    // 显示加载状态（叠加在 canvas 上方）
    this._showLoading(viewerContainer, true);

    // 请求序号防止并发竞态
    const seq = ++this._loadSeq;
    const t0 = performance.now();

    try {
      const data = await API.getMatchResultPreview(recordId);
      const tApi = performance.now();
      const tvLen = data.target_vertices ? (data._binary ? data.target_vertices.length / 3 : data.target_vertices.length) : 0;
      const cvLen = data.candidate_vertices ? (data._binary ? data.candidate_vertices.length / 3 : data.candidate_vertices.length) : 0;
      console.log(`[3D perf] API fetch: ${(tApi - t0).toFixed(1)}ms (binary=${!!data._binary}, vertices: target=${tvLen}, candidate=${cvLen})`);

      // 如果在等待期间用户又点了另一行，丢弃本次结果
      if (seq !== this._loadSeq) return;

      this._showLoading(viewerContainer, false);

      // 构建回放控制 UI
      this._injectReplayUI(data);

      // 复用已有 viewer 或首次创建
      const tViewer0 = performance.now();
      const isReuse = !!this._viewer;
      if (!this._viewer) {
        // 清除占位文本（如"仅成功匹配的粗胚支持3D预览"），防止挤压 canvas
        viewerContainer.innerHTML = '';
        this._viewer = new Viewer3D('match-result-3d');
      }
      const tViewer1 = performance.now();
      if (!isReuse) {
        console.log(`[3D perf] Viewer3D init: ${(tViewer1 - tViewer0).toFixed(1)}ms`);
      }

      this._viewer.loadMatchResult(data);
      const tLoad = performance.now();
      console.log(`[3D perf] loadMatchResult: ${(tLoad - tViewer1).toFixed(1)}ms`);
      console.log(`[3D perf] total (excl outsidePoints): ${(tLoad - t0).toFixed(1)}ms`);

      // 绑定轴和外点显示控制
      this._bindViewerControls();
    } catch (error) {
      if (seq !== this._loadSeq) return;
      this._showLoading(viewerContainer, false);
      console.error('加载3D预览失败:', error);
      viewerContainer.innerHTML = `<div class="viewer-placeholder">3D预览加载失败: ${this._esc(error.message)}</div>`;
      this._viewer = null;
    }
  }

  static _showLoading(container, show) {
    let overlay = container.querySelector('.viewer-loading-overlay');
    if (show) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'viewer-loading-overlay';
        overlay.innerHTML = '<span>加载3D预览中...</span>';
        container.appendChild(overlay);
      }
    } else if (overlay) {
      overlay.remove();
    }
  }

  static _showNoPreview() {
    if (this._viewer) { this._viewer.dispose(); this._viewer = null; }
    document.getElementById('match-result-3d').innerHTML =
      '<div class="viewer-placeholder">仅成功匹配的粗胚支持3D预览</div>';
    const controlsEl = document.getElementById('viewer-controls');
    if (controlsEl) controlsEl.innerHTML = '';
  }

  static _injectReplayUI(data) {
    const hasReplay = data.match_result &&
      data.match_result.generation_history &&
      data.match_result.generation_history.length > 0;
    const maxGen = hasReplay ? data.match_result.generation_history.length - 1 : 0;

    // 注入回放控制到 viewer-controls 区域
    const controlsEl = document.getElementById('viewer-controls');
    if (controlsEl) {
      controlsEl.innerHTML = `
        <div class="viewer-axis-controls">
          <h4>坐标轴与外点显示</h4>
          <label class="viewer-control-label">
            <input type="checkbox" id="showTargetAxis" checked>
            <span>鞋模坐标轴 (红/绿/蓝)</span>
          </label>
          <label class="viewer-control-label">
            <input type="checkbox" id="showCandidateAxis" checked>
            <span>粗胚坐标轴 (浅红/浅绿/浅蓝)</span>
          </label>
          <label class="viewer-control-label">
            <input type="checkbox" id="showOutsidePoints" checked>
            <span>粗胚外采样点 (洋红色)</span>
          </label>
        </div>
        ${hasReplay ? `
        <div class="viewer-replay-controls">
          <h4>GA 回放（每代最优解）</h4>
          <div class="replay-toolbar">
            <button id="replayPlayBtn" class="btn-small">播放</button>
            <span class="replay-gen-info">代数: <span id="replayGenLabel">-</span> / <span id="replayTotalGen">${maxGen}</span></span>
          </div>
          <input id="replaySlider" type="range" min="0" max="${maxGen}" value="${maxGen}" class="replay-slider">
          <div class="replay-stats">
            <div>best: <span id="replayBest">-</span> | avg: <span id="replayAvg">-</span> | std: <span id="replayStd">-</span></div>
            <div>t=<span id="replayT">-</span>mm, rot=<span id="replayRot">-</span>°, lat=<span id="replayLat">-</span>mm</div>
            <div>xover=<span id="replayXover">-</span>, mut=<span id="replayMut">-</span>, time=<span id="replayTime">-</span>ms</div>
          </div>
        </div>
        ` : ''}
      `;
    }
  }

  static _bindViewerControls() {
    const showTargetAxis = document.getElementById('showTargetAxis');
    const showCandidateAxis = document.getElementById('showCandidateAxis');
    const showOutsidePoints = document.getElementById('showOutsidePoints');

    if (showTargetAxis) {
      showTargetAxis.addEventListener('change', () => {
        if (this._viewer) this._viewer.setTargetAxisVisible(showTargetAxis.checked);
      });
    }
    if (showCandidateAxis) {
      showCandidateAxis.addEventListener('change', () => {
        if (this._viewer) this._viewer.setCandidateAxisVisible(showCandidateAxis.checked);
      });
    }
    if (showOutsidePoints) {
      showOutsidePoints.addEventListener('change', () => {
        if (this._viewer) this._viewer.setOutsidePointsVisible(showOutsidePoints.checked);
      });
    }
  }

  static disposeViewer() {
    if (this._viewer) {
      this._viewer.dispose();
      this._viewer = null;
    }
  }
}
