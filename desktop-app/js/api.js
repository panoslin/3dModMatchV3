// API客户端
const API_BASE_URL = 'http://127.0.0.1:5000/api';

class API {
  static async request(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const defaultOptions = {
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const config = { ...defaultOptions, ...options };
    
    try {
      const response = await fetch(url, config);
      
      // 检查响应状态
      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`;
        let errorDetail = null;
        let errorHint = null;
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
          errorDetail = errorData.detail || null;
          errorHint = errorData.hint || null;
        } catch (e) {
          const text = await response.text();
          if (text) errorMessage = text;
        }
        const err = new Error(errorMessage);
        err.detail = errorDetail;
        err.hint = errorHint;
        err.httpStatus = response.status;
        throw err;
      }
      
      // 检查响应内容类型
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        if (text) {
          throw new Error(`服务器返回非JSON响应: ${text.substring(0, 100)}`);
        }
        throw new Error('服务器返回空响应');
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('API请求错误:', error);
      console.error('请求URL:', url);
      console.error('请求配置:', config);
      throw error;
    }
  }

  // 健康检查
  static async health() {
    return this.request('/health');
  }

  // 分类API
  static async getCategories() {
    return this.request('/categories');
  }

  static async createCategory(data) {
    return this.request('/categories', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  static async deleteCategory(id) {
    return this.request(`/categories/${id}`, {
      method: 'DELETE',
    });
  }

  // 粗胚API
  static async getBlanks(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/blanks?${query}`);
  }

  static async uploadBlank(file, name, categoryId) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name || file.name);
    if (categoryId) {
      formData.append('category_id', categoryId);
    }

    return fetch(`${API_BASE_URL}/blanks`, {
      method: 'POST',
      body: formData,
    }).then(res => res.json());
  }

  static async deleteBlank(id) {
    return this.request(`/blanks/${id}`, {
      method: 'DELETE',
    });
  }

  static async getBlankPreview(id) {
    return this.request(`/blanks/${id}/preview`);
  }

  // 鞋模API
  static async uploadShoe(file, name) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name || file.name);

    return fetch(`${API_BASE_URL}/shoes`, {
      method: 'POST',
      body: formData,
    }).then(res => res.json());
  }

  // 重新加载匹配模块
  static async reloadMatcher() {
    return this.request('/match/reload', { method: 'POST' });
  }

  // 匹配API
  static async startMatch(data) {
    return this.request('/match/start', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  static async getMatchTask(taskId) {
    return this.request(`/match/task/${taskId}`);
  }

  static async cancelMatchTask(taskId) {
    return this.request(`/match/task/${taskId}`, {
      method: 'DELETE',
    });
  }

  // 历史记录API（按鞋模分组）
  static async getHistoryTasks(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/history/tasks?${query}`);
  }

  // 历史记录API（扁平，用于导出）
  static async getHistory(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/history?${query}`);
  }

  // 匹配结果预览API（二进制格式）
  static async getMatchResultPreview(recordId) {
    const url = `${API_BASE_URL}/match/result/${recordId}/preview`;
    const response = await fetch(url);
    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try { const e = await response.json(); msg = e.error || msg; } catch (_) {}
      throw new Error(msg);
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      // 后端返回了 JSON 错误
      const e = await response.json();
      throw new Error(e.error || 'unknown error');
    }
    const buf = await response.arrayBuffer();
    return this._decodeBinaryPreview(buf);
  }

  /**
   * 解码二进制预览格式 (.binprev)
   * Header 32B: magic(4) version(2) pad(2) n_tv(4) n_tf(4) n_cv(4) n_cf(4) meta_len(4) pad(4)
   * Body: tv(f32) tf(u32) cv(f32) cf(u32) meta(utf8)
   */
  static _decodeBinaryPreview(buffer) {
    const view = new DataView(buffer);
    // 验证 magic
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'BPV1') throw new Error('invalid preview format');

    const nTv = view.getUint32(8, true);
    const nTf = view.getUint32(12, true);
    const nCv = view.getUint32(16, true);
    const nCf = view.getUint32(20, true);
    const metaLen = view.getUint32(24, true);

    let off = 32;
    const tvBytes = nTv * 3 * 4;
    const targetVertices = new Float32Array(buffer, off, nTv * 3); off += tvBytes;
    const tfBytes = nTf * 3 * 4;
    const targetFaces = new Uint32Array(buffer, off, nTf * 3); off += tfBytes;
    const cvBytes = nCv * 3 * 4;
    const candidateVertices = new Float32Array(buffer, off, nCv * 3); off += cvBytes;
    const cfBytes = nCf * 3 * 4;
    const candidateFaces = new Uint32Array(buffer, off, nCf * 3); off += cfBytes;

    const metaBytes = new Uint8Array(buffer, off, metaLen);
    const metadata = JSON.parse(new TextDecoder().decode(metaBytes));

    return {
      ...metadata,
      // 直接传递 TypedArray，不需要嵌套数组
      _binary: true,
      target_vertices: targetVertices,
      target_faces: targetFaces,
      candidate_vertices: candidateVertices,
      candidate_faces: candidateFaces,
    };
  }

  static async deleteMatchRecord(recordId) {
    return this.request(`/match/record/${recordId}`, { method: 'DELETE' });
  }
}
