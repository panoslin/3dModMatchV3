// 历史记录管理模块
class HistoryManager {
  constructor() {
    this.currentPage = 1;
    this.perPage = 50;
    this.selectedTasks = new Set();
    this._refreshTimer = null;
    this._lastRefreshTime = null;
    this._cachedItems = []; // 缓存当前页数据，供导出/对比使用

    this.init();
  }

  init() {
    this.loadHistory();
    this.setupEventListeners();
  }

  setupEventListeners() {
    document.getElementById('history-search').addEventListener('input', () => {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = setTimeout(() => {
        this.currentPage = 1;
        this.loadHistory();
      }, 300);
    });

    document.getElementById('history-date-from').addEventListener('change', () => {
      this.currentPage = 1;
      this.loadHistory();
    });

    document.getElementById('history-date-to').addEventListener('change', () => {
      this.currentPage = 1;
      this.loadHistory();
    });

    document.getElementById('history-select-all').addEventListener('change', (e) => {
      const checked = e.target.checked;
      document.querySelectorAll('#history-table-body input[type="checkbox"]').forEach(cb => {
        cb.checked = checked;
        const taskId = cb.dataset.id;
        if (checked) this.selectedTasks.add(taskId);
        else this.selectedTasks.delete(taskId);
      });
    });

    document.getElementById('export-csv-btn').addEventListener('click', () => this.exportCSV());
    document.getElementById('export-excel-btn').addEventListener('click', () => this.exportExcel());
    document.getElementById('compare-btn').addEventListener('click', () => this.compareRecords());

    // Close result modal (shared with match-manager)
    const closeBtn = document.getElementById('match-result-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        ResultDetailView.disposeViewer();
      });
    }
  }

  // ===== Auto-refresh =====
  startAutoRefresh() {
    if (this._refreshTimer) return;
    this.loadHistory();
    this._refreshTimer = setInterval(() => this.loadHistory(), 5000);
  }

  stopAutoRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  _updateRefreshIndicator() {
    const el = document.getElementById('history-refresh-indicator');
    if (!el) return;
    if (!this._lastRefreshTime) {
      el.textContent = '';
      return;
    }
    const secs = Math.floor((Date.now() - this._lastRefreshTime) / 1000);
    if (secs < 5) {
      el.textContent = '已更新';
    } else {
      el.textContent = `${secs}s 前更新`;
    }
  }

  // ===== Data loading =====
  async loadHistory() {
    const search = document.getElementById('history-search').value;
    const dateFrom = document.getElementById('history-date-from').value;
    const dateTo = document.getElementById('history-date-to').value;

    try {
      const data = await API.getHistoryTasks({
        search,
        date_from: dateFrom,
        date_to: dateTo,
        page: this.currentPage,
        per_page: this.perPage,
      });

      this._lastRefreshTime = Date.now();
      this._cachedItems = data.items || [];
      this.renderHistory(this._cachedItems);
      this.renderPagination(data.total, 'history-pagination');
      this._updateRefreshIndicator();

      if (!this._indicatorTimer) {
        this._indicatorTimer = setInterval(() => this._updateRefreshIndicator(), 5000);
      }
    } catch (error) {
      console.error('加载历史记录失败:', error);
    }
  }

  renderHistory(items) {
    const tbody = document.getElementById('history-table-body');
    tbody.innerHTML = '';

    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">暂无匹配记录</td></tr>';
      return;
    }

    items.forEach(item => {
      const row = document.createElement('tr');
      const isSelected = this.selectedTasks.has(item.task_id);

      const bestWr = (item.best_wrapping_ratio || 0) * 100;
      const wrClass = bestWr >= 96 ? 'good' : bestWr >= 90 ? 'warn' : '';
      const matchSummary = `${item.matched_count} / ${item.total_count} 匹配`;

      row.innerHTML = `
        <td><input type="checkbox" data-id="${this.escapeHtml(item.task_id)}" ${isSelected ? 'checked' : ''}></td>
        <td><strong>${this.escapeHtml(item.shoe_name || '')}</strong></td>
        <td>${matchSummary}</td>
        <td>${this.escapeHtml(item.best_blank_name || '—')}</td>
        <td style="color: var(--${wrClass === 'good' ? 'success' : wrClass === 'warn' ? 'warning' : 'text-primary'}-color); font-weight:600;">${bestWr.toFixed(2)}%</td>
        <td>${this.formatDate(item.completed_at)}</td>
        <td>
          <button class="btn-secondary btn-sm" onclick="historyManager.viewTaskDetail('${this.escapeHtml(item.task_id)}')">查看详情</button>
        </td>
      `;

      row.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
        const id = e.target.dataset.id;
        if (e.target.checked) this.selectedTasks.add(id);
        else this.selectedTasks.delete(id);
      });

      tbody.appendChild(row);
    });
  }

  renderPagination(total, containerId) {
    const container = document.getElementById(containerId);
    const totalPages = Math.ceil(total / this.perPage);

    container.innerHTML = `
      <button class="pagination-btn" ${this.currentPage === 1 ? 'disabled' : ''} data-page="${this.currentPage - 1}">上一页</button>
      <span class="pagination-info">第 ${this.currentPage} / ${Math.max(1, totalPages)} 页，共 ${total} 条</span>
      <button class="pagination-btn" ${this.currentPage >= totalPages ? 'disabled' : ''} data-page="${this.currentPage + 1}">下一页</button>
    `;

    container.querySelectorAll('.pagination-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const page = parseInt(btn.dataset.page);
        if (page >= 1 && page <= totalPages) {
          this.currentPage = page;
          this.loadHistory();
        }
      });
    });
  }

  // ===== Detail view (delegates to shared ResultDetailView) =====
  viewTaskDetail(taskId) {
    const item = this._cachedItems.find(i => i.task_id === taskId);
    if (!item) {
      alert('未找到匹配记录');
      return;
    }
    ResultDetailView.showAllResults({
      shoeName: item.shoe_name,
      results: item.results || [],
    });
  }

  // ===== Export =====
  async exportCSV() {
    try {
      // 使用扁平的 match_records 进行导出
      const data = await API.getHistory({
        page: 1,
        per_page: 10000,
      });
      const records = data.items;

      const headers = ['鞋模名称', '粗胚名称', '粗胚分类', '匹配时间', '包裹率(%)', 'P96间隙(mm)', '体积', '完全包裹'];
      const rows = records.map(r => [
        r.shoe_name || '',
        r.blank_name || '',
        r.category_name || '',
        r.match_time || '',
        ((r.wrapping_ratio || 0) * 100).toFixed(2),
        (r.percentile96_clearance || 0).toFixed(2),
        (r.volume || 0).toFixed(2),
        r.is_fully_wrapped ? '是' : '否',
      ]);

      const csv = [headers, ...rows].map(row => row.map(c => `"${c}"`).join(',')).join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `匹配记录_${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      alert('导出CSV失败: ' + error.message);
    }
  }

  async exportExcel() {
    try {
      if (typeof XLSX === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        await new Promise((res, rej) => { script.onload = res; script.onerror = rej; document.head.appendChild(script); });
      }

      const data = await API.getHistory({ page: 1, per_page: 10000 });
      const records = data.items;

      const headers = ['鞋模名称', '粗胚名称', '粗胚分类', '匹配时间', '包裹率(%)', 'P96间隙(mm)', '体积', '最优平移(mm)', '最优旋转(°)', '完全包裹'];
      const rows = records.map(r => [
        r.shoe_name || '',
        r.blank_name || '',
        r.category_name || '',
        r.match_time || '',
        ((r.wrapping_ratio || 0) * 100).toFixed(2),
        (r.percentile96_clearance || 0).toFixed(2),
        (r.volume || 0).toFixed(2),
        (r.optimal_translation || 0).toFixed(2),
        (r.optimal_rotation_angle_deg || 0).toFixed(2),
        r.is_fully_wrapped ? '是' : '否',
      ]);

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      XLSX.utils.book_append_sheet(wb, ws, '匹配记录');
      XLSX.writeFile(wb, `匹配记录_${new Date().toISOString().split('T')[0]}.xlsx`);
    } catch (error) {
      alert('导出Excel失败: ' + error.message);
    }
  }

  async compareRecords() {
    if (this.selectedTasks.size < 2) {
      alert('请至少选择2条记录进行对比');
      return;
    }

    const items = this._cachedItems.filter(i => this.selectedTasks.has(i.task_id));
    if (items.length < 2) {
      alert('请至少选择2条记录进行对比');
      return;
    }

    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.innerHTML = `
      <div class="modal-content modal-large">
        <div class="modal-header">
          <h2>记录对比 (${items.length}条)</h2>
          <button class="modal-close" onclick="this.closest('.modal').remove()">×</button>
        </div>
        <div class="modal-body">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;">
            ${items.map(item => {
              const bestWr = ((item.best_wrapping_ratio || 0) * 100).toFixed(2);
              return `<div style="border:1px solid var(--border-color);border-radius:10px;padding:16px;">
                <h3 style="font-size:15px;margin-bottom:12px;">${this.escapeHtml(item.shoe_name || '未知')}</h3>
                <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">最佳粗胚: ${this.escapeHtml(item.best_blank_name || '—')}</p>
                ${[
                  ['匹配结果', `${item.matched_count} / ${item.total_count} 匹配`],
                  ['最佳包裹率', bestWr + '%'],
                  ['匹配时间', this.formatDate(item.completed_at)],
                ].map(([l, v]) => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-color);font-size:13px;"><span style="color:var(--text-secondary)">${l}</span><span style="font-weight:500">${v}</span></div>`).join('')}
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  formatDate(dateString) {
    if (!dateString) return '—';
    return new Date(dateString).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
