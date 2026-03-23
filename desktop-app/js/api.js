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

  // 匹配结果预览API
  static async getMatchResultPreview(recordId) {
    return this.request(`/match/result/${recordId}/preview`);
  }
}
