/** Dashboard: overview stats, trend chart, heatmap, distribution, leaderboard, system health. */
class DashboardManager {
  constructor() {
    this._refreshTimer = null;
    this._sysTimer = null;
    this._days = 30;
    this._lastRefresh = null;
    this._setupControls();
  }

  _setupControls() {
    const refreshBtn = document.getElementById('dashboard-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.load());
    }
    const daysSelect = document.getElementById('dashboard-days-select');
    if (daysSelect) {
      daysSelect.addEventListener('change', () => {
        this._days = parseInt(daysSelect.value, 10);
        this.load();
      });
    }
  }

  async load() {
    try {
      const data = await API.request(`/dashboard?days=${this._days}`);
      this._renderOverview(data.overview);
      this._renderTrend(data.trend);
      this._renderDistribution(data.distribution);
      this._renderHeatmap(data.heatmap);
      this._renderLeaderboard(data.leaderboard);
      this._renderSystem(data.system);
      this._lastRefresh = new Date();
      this._updateRefreshIndicator();
    } catch (err) {
      console.error('看板数据加载失败:', err);
    }
  }

  startAutoRefresh() {
    this.load();
    this._refreshTimer = setInterval(() => this.load(), 30_000);
    this._sysTimer = setInterval(() => this._pollSystem(), 5_000);
  }

  stopAutoRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (this._sysTimer) {
      clearInterval(this._sysTimer);
      this._sysTimer = null;
    }
  }

  async _pollSystem() {
    try {
      const sys = await API.request('/system-status');
      this._renderSystem(sys);
    } catch (_) { /* ignore */ }
  }

  _updateRefreshIndicator() {
    const el = document.getElementById('dashboard-refresh-indicator');
    if (!el || !this._lastRefresh) return;
    const sec = Math.round((Date.now() - this._lastRefresh.getTime()) / 1000);
    el.textContent = sec < 60 ? `${sec}s 前更新` : `${Math.floor(sec / 60)}m 前更新`;
  }

  // ── 模块一：概览卡片 ─────────────────────────────────────────
  _renderOverview(ov) {
    if (!ov) return;

    // 今日任务数
    const cardCount = document.getElementById('ov-today-count');
    if (cardCount) {
      const delta = ov.today_count - ov.yesterday_count;
      cardCount.querySelector('.ov-value').textContent = ov.today_count;
      cardCount.querySelector('.ov-delta').textContent =
        delta >= 0 ? `↑${delta} vs 昨日` : `↓${Math.abs(delta)} vs 昨日`;
      cardCount.querySelector('.ov-delta').className =
        'ov-delta ' + (delta >= 0 ? 'delta-up' : 'delta-down');
    }

    // 命中率
    const cardHit = document.getElementById('ov-hit-rate');
    if (cardHit) {
      cardHit.querySelector('.ov-value').textContent = `${ov.hit_rate}%`;
      cardHit.querySelector('.ov-delta').textContent = `全量 ${ov.hit_rate_all}%`;
    }

    // 平均包裹率
    const cardWrap = document.getElementById('ov-avg-wrapping');
    if (cardWrap) {
      cardWrap.querySelector('.ov-value').textContent = `${ov.avg_wrapping_ratio}%`;
      cardWrap.querySelector('.ov-delta').textContent = `全量 ${ov.avg_wrapping_ratio_all}%`;
    }

    // P99 单对耗时
    const cardP99 = document.getElementById('ov-p99-time');
    if (cardP99) {
      cardP99.querySelector('.ov-value').textContent =
        ov.p99_pair_time_s > 0 ? `${ov.p99_pair_time_s}s` : '—';
    }
  }

  // ── 模块二：每日任务趋势 ──────────────────────────────────────
  _renderTrend(trend) {
    const container = document.getElementById('dashboard-trend');
    if (!container || !trend) return;

    if (trend.length === 0 || trend.every(d => d.total === 0)) {
      container.innerHTML = '<div class="empty-hint">暂无数据</div>';
      return;
    }

    const maxVal = Math.max(...trend.map(d => d.total), 1);

    const bars = trend.map(d => {
      const hitH = Math.round((d.hit / maxVal) * 100);
      const missH = Math.round((d.miss / maxVal) * 100);
      const label = d.date.slice(5); // MM-DD
      return `
        <div class="trend-bar-group" title="${d.date}&#10;总计: ${d.total}  命中: ${d.hit}  未命中: ${d.miss}">
          ${d.total > 0 ? `<div class="trend-bar-count">${d.total}</div>` : '<div class="trend-bar-count"></div>'}
          <div class="trend-bar-stack">
            <div class="trend-bar-miss" style="height:${missH}%"></div>
            <div class="trend-bar-hit" style="height:${hitH}%"></div>
          </div>
          <div class="trend-bar-label">${label}</div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="trend-legend">
        <span class="legend-dot legend-dot-hit"></span>命中
        <span class="legend-dot legend-dot-miss"></span>未命中
      </div>
      <div class="trend-bars">${bars}</div>`;
  }

  // ── 模块三：粗胚热力图 ───────────────────────────────────────
  _renderHeatmap(heatmap) {
    const container = document.getElementById('dashboard-heatmap');
    if (!container) return;

    if (!heatmap || heatmap.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无数据</div>';
      return;
    }

    const maxTotal = Math.max(...heatmap.map(h => h.total), 1);

    const rows = heatmap.map((h, i) => {
      const barW = Math.round((h.total / maxTotal) * 100);
      const hitRateColor = h.hit_rate >= 80 ? 'var(--success-color)'
        : h.hit_rate >= 50 ? 'var(--warning-color)'
        : 'var(--error-color)';
      return `
        <div class="heatmap-row">
          <div class="heatmap-rank">${i + 1}</div>
          <div class="heatmap-name" title="${h.blank_name}">
            ${h.blank_name}
            ${h.category ? `<span class="heatmap-category">${h.category}</span>` : ''}
          </div>
          <div class="heatmap-bar-wrap">
            <div class="heatmap-bar" style="width:${barW}%"></div>
          </div>
          <div class="heatmap-volume">${h.volume ? (h.volume / 1000).toFixed(1) + ' cm³' : '—'}</div>
          <div class="heatmap-count">${h.total} 次</div>
          <div class="heatmap-hitrate" style="color:${hitRateColor}">${h.hit_rate}%</div>
          <div class="heatmap-lastused">${this._relativeTime(h.last_used)}</div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="heatmap-header">
        <div class="heatmap-rank">#</div>
        <div class="heatmap-name">粗胚名称</div>
        <div class="heatmap-bar-wrap"></div>
        <div class="heatmap-volume">体积</div>
        <div class="heatmap-count">次数</div>
        <div class="heatmap-hitrate">命中率</div>
        <div class="heatmap-lastused">最近使用</div>
      </div>
      ${rows}`;
  }

  // ── 模块四：包裹率分布 ───────────────────────────────────────
  _renderDistribution(dist) {
    const container = document.getElementById('dashboard-distribution');
    if (!container || !dist) return;

    if (dist.total === 0) {
      container.innerHTML = '<div class="empty-hint">暂无数据</div>';
      return;
    }

    const pct = (n) => dist.total > 0 ? Math.round(n / dist.total * 100) : 0;

    container.innerHTML = `
      <div class="dist-total">共 ${dist.total} 条匹配记录</div>
      <div class="dist-row">
        <div class="dist-label">
          <span class="dist-dot dist-dot-good"></span>≥ 96%
        </div>
        <div class="dist-bar-wrap">
          <div class="dist-bar dist-bar-good" style="width:${pct(dist.gte96)}%"></div>
        </div>
        <div class="dist-count">${dist.gte96} <span class="dist-pct">(${pct(dist.gte96)}%)</span></div>
      </div>
      <div class="dist-row">
        <div class="dist-label">
          <span class="dist-dot dist-dot-warn"></span>90–96%
        </div>
        <div class="dist-bar-wrap">
          <div class="dist-bar dist-bar-warn" style="width:${pct(dist.range_90_96)}%"></div>
        </div>
        <div class="dist-count">${dist.range_90_96} <span class="dist-pct">(${pct(dist.range_90_96)}%)</span></div>
      </div>
      <div class="dist-row">
        <div class="dist-label">
          <span class="dist-dot dist-dot-bad"></span>< 90%
        </div>
        <div class="dist-bar-wrap">
          <div class="dist-bar dist-bar-bad" style="width:${pct(dist.lt90)}%"></div>
        </div>
        <div class="dist-count">${dist.lt90} <span class="dist-pct">(${pct(dist.lt90)}%)</span></div>
      </div>`;
  }

  // ── 模块五：鞋模排行榜 ──────────────────────────────────────
  _renderLeaderboard(leaderboard) {
    this._renderLeaderboardList('dashboard-leaderboard-top', leaderboard?.top_hit, true);
    this._renderLeaderboardList('dashboard-leaderboard-miss', leaderboard?.top_miss, false);
  }

  _renderLeaderboardList(containerId, items, isTop) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!items || items.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无数据</div>';
      return;
    }

    const rows = items.map((s, i) => {
      const ratioColor = s.hit_rate >= 80 ? 'var(--success-color)'
        : s.hit_rate >= 50 ? 'var(--warning-color)'
        : 'var(--error-color)';
      return `
        <div class="leaderboard-row">
          <div class="leaderboard-rank">${i + 1}</div>
          <div class="leaderboard-name" title="${s.blank_name}">
            ${s.blank_name}
            ${s.category ? `<span class="leaderboard-category">${s.category}</span>` : ''}
          </div>
          <div class="leaderboard-meta">
            <span class="leaderboard-hitrate" style="color:${ratioColor}">${s.hit_rate}%</span>
            <span class="leaderboard-count">${s.total} 次</span>
          </div>
          ${isTop && s.best_blank ? `<div class="leaderboard-best">${s.best_blank} ${s.best_ratio_pct}%</div>` : '<div class="leaderboard-best"></div>'}
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="leaderboard-header">
        <div class="leaderboard-rank">#</div>
        <div class="leaderboard-name">粗胚</div>
        <div class="leaderboard-meta">命中率 / 次数</div>
        <div class="leaderboard-best">${isTop ? '最佳粗胚' : ''}</div>
      </div>
      ${rows}`;
  }

  // ── 模块六：系统资源 ─────────────────────────────────────────
  _renderSystem(sys) {
    const container = document.getElementById('dashboard-system');
    if (!container || !sys) return;

    const cpuVal = sys.cpu_percent != null ? `${sys.cpu_percent}%` : '—';
    const cpuColor = sys.cpu_percent == null ? 'var(--text-secondary)'
      : sys.cpu_percent >= 85 ? 'var(--error-color)'
      : sys.cpu_percent >= 60 ? 'var(--warning-color)'
      : 'var(--success-color)';
    const cpuBarW = sys.cpu_percent != null ? sys.cpu_percent : 0;

    const engineStatus = sys.matcher_available
      ? '<span class="sys-badge sys-badge-ok">✓ 正常</span>'
      : '<span class="sys-badge sys-badge-err">✗ 不可用</span>';

    const uptime = this._formatUptime(sys.uptime_s);

    container.innerHTML = `
      <div class="sys-grid">
        <div class="sys-item">
          <div class="sys-item-label">当前并发任务</div>
          <div class="sys-item-value">
            ${sys.active_tasks} / ${sys.max_concurrent}
            <div class="sys-slots">
              ${Array.from({length: sys.max_concurrent}, (_, i) =>
                `<span class="sys-slot ${i < sys.active_tasks ? 'sys-slot-active' : ''}"></span>`
              ).join('')}
            </div>
          </div>
        </div>
        <div class="sys-item">
          <div class="sys-item-label">队列等待</div>
          <div class="sys-item-value">${sys.queue_waiting} 个任务</div>
        </div>
        <div class="sys-item">
          <div class="sys-item-label">CPU 负载</div>
          <div class="sys-item-value" style="color:${cpuColor}">
            ${cpuVal}
            <div class="sys-cpu-bar">
              <div class="sys-cpu-fill" style="width:${cpuBarW}%;background:${cpuColor}"></div>
            </div>
          </div>
        </div>
        <div class="sys-item">
          <div class="sys-item-label">C++ 引擎</div>
          <div class="sys-item-value">${engineStatus}</div>
        </div>
        <div class="sys-item">
          <div class="sys-item-label">后端运行时长</div>
          <div class="sys-item-value">${uptime}</div>
        </div>
      </div>`;
  }

  // ── 工具函数 ─────────────────────────────────────────────────
  _relativeTime(isoStr) {
    if (!isoStr) return '—';
    try {
      const d = new Date(isoStr);
      const diffMs = Date.now() - d.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays === 0) return '今天';
      if (diffDays === 1) return '昨天';
      return `${diffDays} 天前`;
    } catch (e) {
      return '—';
    }
  }

  _formatUptime(s) {
    if (!s) return '—';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }
}
