// 共享的匹配结果详情视图模块
// 被 MatchManager 和 HistoryManager 共同使用
class ResultDetailView {
  static _viewer = null;

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
        else {
          document.getElementById('match-result-3d').innerHTML =
            '<div class="viewer-placeholder">仅成功匹配的粗胚支持3D预览</div>';
        }
      });
      listEl.appendChild(row);
    });

    detailPane.appendChild(listEl);

    if (allSorted.length > 0) {
      const first = allSorted[0];
      this.showMatchDetail(overviewEl, first, task.shoeName);
      if (first.record_id) this.load3DPreview(first.record_id);
      else {
        document.getElementById('match-result-3d').innerHTML =
          '<div class="viewer-placeholder">仅成功匹配的粗胚支持3D预览</div>';
      }
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

    try {
      const data = await API.getMatchResultPreview(recordId);
      if (this._viewer) { this._viewer.dispose(); this._viewer = null; }
      this._viewer = new Viewer3D('match-result-3d');
      this._viewer.loadMatchResult(
        { vertices: data.target_vertices, faces: data.target_faces },
        { vertices: data.candidate_vertices, faces: data.candidate_faces },
        { vertices: data.candidate_vertices_transformed, faces: data.candidate_faces }
      );
    } catch (error) {
      console.error('加载3D预览失败:', error);
      viewerContainer.innerHTML = `<div class="viewer-placeholder">3D预览加载失败: ${this._esc(error.message)}</div>`;
    }
  }

  static disposeViewer() {
    if (this._viewer) {
      this._viewer.dispose();
      this._viewer = null;
    }
  }
}
