// 粗胚管理模块
class BlankManager {
  constructor() {
    this.currentPage = 1;
    this.perPage = 50;
    this.selectedBlanks = new Set();
    this.categories = [];
    this.viewer = null;
    this.activeSidebarCategoryId = null; // null = 全部

    this.init();
  }

  async init() {
    await this.loadCategories();
    await this.loadBlanks();
    this.setupEventListeners();
  }

  setupEventListeners() {
    // 上传按钮
    document.getElementById('upload-blank-btn').addEventListener('click', () => {
      this.showUploadDialog();
    });

    // 分类管理按钮
    document.getElementById('manage-categories-btn').addEventListener('click', () => {
      this.showCategoryManagement();
    });

    // 搜索
    document.getElementById('blank-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = setTimeout(() => {
        this.currentPage = 1;
        this.loadBlanks();
      }, 300);
    });

    // 排序
    document.getElementById('blank-sort').addEventListener('change', () => {
      this.currentPage = 1;
      this.loadBlanks();
    });

    // 批量操作
    document.getElementById('blank-batch-category').addEventListener('click', () => {
      this.batchAssignCategory();
    });

    document.getElementById('blank-batch-delete').addEventListener('click', () => {
      this.batchDelete();
    });

    // 预览模态框关闭
    document.getElementById('blank-preview-close').addEventListener('click', () => {
      document.getElementById('blank-preview-modal').classList.remove('active');
      document.getElementById('blank-preview-info').innerHTML = '';
      if (this.viewer) {
        this.viewer.dispose();
        this.viewer = null;
      }
    });
  }

  async loadCategories() {
    try {
      this.categories = await API.getCategories();
      this.renderCategorySidebar();
    } catch (error) {
      console.error('加载分类失败:', error);
    }
  }

  renderCategorySidebar() {
    const container = document.getElementById('category-sidebar-tree');
    if (!container) return;
    container.innerHTML = '';

    // 全部 item
    const allItem = document.createElement('div');
    allItem.className = 'sidebar-cat-item' + (this.activeSidebarCategoryId === null ? ' active' : '');
    allItem.innerHTML = `<span class="sidebar-cat-label">全部粗胚</span>`;
    allItem.addEventListener('click', () => {
      this.activeSidebarCategoryId = null;
      this.currentPage = 1;
      this.loadBlanks();
      this.renderCategorySidebar();
    });
    container.appendChild(allItem);

    if (this.categories.length === 0) return;

    // Build tree
    const map = new Map();
    this.categories.forEach(cat => map.set(cat.id, { ...cat, children: [] }));
    const roots = [];
    this.categories.forEach(cat => {
      const node = map.get(cat.id);
      if (cat.parent_id && map.has(cat.parent_id)) {
        map.get(cat.parent_id).children.push(node);
      } else {
        roots.push(node);
      }
    });

    const renderNode = (node, level) => {
      const hasChildren = node.children && node.children.length > 0;
      const isActive = this.activeSidebarCategoryId === node.id;
      const isExpanded = !this._collapsedCategories?.has(node.id);

      const item = document.createElement('div');
      item.className = 'sidebar-cat-item' + (isActive ? ' active' : '');
      item.style.paddingLeft = `${12 + level * 16}px`;

      item.innerHTML = `
        <button class="sidebar-cat-toggle ${hasChildren && !isExpanded ? 'collapsed' : ''}" style="${hasChildren ? '' : 'visibility:hidden'}">▾</button>
        <span class="sidebar-cat-label" title="${this.escapeHtml(node.path || node.name)}">${this.escapeHtml(node.name)}</span>
      `;

      const toggle = item.querySelector('.sidebar-cat-toggle');
      const label = item.querySelector('.sidebar-cat-label');

      if (hasChildren) {
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!this._collapsedCategories) this._collapsedCategories = new Set();
          if (isExpanded) {
            this._collapsedCategories.add(node.id);
          } else {
            this._collapsedCategories.delete(node.id);
          }
          this.renderCategorySidebar();
        });
      }

      label.addEventListener('click', () => {
        this.activeSidebarCategoryId = node.id;
        this.currentPage = 1;
        this.loadBlanks();
        this.renderCategorySidebar();
      });

      item.addEventListener('click', (e) => {
        if (e.target !== toggle) {
          this.activeSidebarCategoryId = node.id;
          this.currentPage = 1;
          this.loadBlanks();
          this.renderCategorySidebar();
        }
      });

      container.appendChild(item);

      if (hasChildren && isExpanded) {
        node.children.forEach(child => renderNode(child, level + 1));
      }
    };

    roots.forEach(root => renderNode(root, 0));
  }

  async loadBlanks() {
    const search = document.getElementById('blank-search').value;
    const categoryId = this.activeSidebarCategoryId;
    const sort = document.getElementById('blank-sort').value;

    try {
      const data = await API.getBlanks({
        search,
        category_id: categoryId,
        sort,
        page: this.currentPage,
        per_page: this.perPage,
      });

      this.renderBlanks(data.items);
      this.renderPagination(data.total, 'blank-pagination');
    } catch (error) {
      console.error('加载粗胚失败:', error);
      alert('加载粗胚失败: ' + error.message);
    }
  }

  renderBlanks(blanks) {
    const grid = document.getElementById('blank-grid');
    grid.innerHTML = '';

    blanks.forEach(blank => {
      const card = document.createElement('div');
      card.className = 'blank-card';
      card.dataset.id = blank.id;

      const isSelected = this.selectedBlanks.has(blank.id);
      if (isSelected) {
        card.classList.add('selected');
      }

      card.innerHTML = `
        <input type="checkbox" class="blank-card-checkbox" ${isSelected ? 'checked' : ''}>
        <div class="blank-card-preview">📦</div>
        <div class="blank-card-name">${this.escapeHtml(blank.name)}</div>
        <div class="blank-card-info">${this.formatFileSize(blank.file_size)}</div>
        <div class="blank-card-info">${this.formatDate(blank.upload_time)}</div>
        ${blank.category_name ? `<div class="blank-card-category">${this.escapeHtml(blank.category_name)}</div>` : ''}
      `;

      // 点击事件
      const checkbox = card.querySelector('.blank-card-checkbox');
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        this.toggleSelect(blank.id);
      });

      card.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          this.previewBlank(blank.id, blank);
        }
      });

      grid.appendChild(card);
    });

    this.updateBatchActions();
  }

  toggleSelect(blankId) {
    if (this.selectedBlanks.has(blankId)) {
      this.selectedBlanks.delete(blankId);
    } else {
      this.selectedBlanks.add(blankId);
    }
    this.loadBlanks(); // 重新渲染以更新选中状态
    this.updateBatchActions();
  }

  updateBatchActions() {
    const batchActions = document.getElementById('blank-batch-actions');
    const count = this.selectedBlanks.size;
    
    if (count > 0) {
      batchActions.style.display = 'flex';
      document.getElementById('blank-selected-count').textContent = count;
    } else {
      batchActions.style.display = 'none';
    }
  }

  renderPagination(total, containerId) {
    const container = document.getElementById(containerId);
    const totalPages = Math.ceil(total / this.perPage);

    container.innerHTML = `
      <button class="pagination-btn" ${this.currentPage === 1 ? 'disabled' : ''} data-page="${this.currentPage - 1}">上一页</button>
      <span class="pagination-info">第 ${this.currentPage} / ${totalPages} 页，共 ${total} 条</span>
      <button class="pagination-btn" ${this.currentPage >= totalPages ? 'disabled' : ''} data-page="${this.currentPage + 1}">下一页</button>
    `;

    container.querySelectorAll('.pagination-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const page = parseInt(btn.dataset.page);
        if (page >= 1 && page <= totalPages) {
          this.currentPage = page;
          this.loadBlanks();
        }
      });
    });
  }

  async showUploadDialog() {
    // 先选择分类（可选）
    const categoryId = await this.showCategorySelectDialog('上传时选择分类（可选）');
    
    if (window.electronAPI) {
      const result = await window.electronAPI.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '3D模型', extensions: ['stl', '3dm'] },
        ],
      });

      if (!result.canceled && result.filePaths) {
        // 在Electron中，需要通过主进程读取文件
        // 这里使用fetch API直接上传文件
        for (const filePath of result.filePaths) {
          try {
            const formData = await this.readFileAsFormData(filePath);
            if (categoryId) {
              formData.append('category_id', categoryId);
            }
            
            const response = await fetch('http://127.0.0.1:5000/api/blanks', {
              method: 'POST',
              body: formData
            });
            
            if (response.ok) {
              await this.loadBlanks();
            } else {
              const error = await response.json();
              alert('上传失败: ' + (error.error || '未知错误'));
            }
          } catch (error) {
            console.error('上传文件失败:', error);
            alert('上传失败: ' + error.message);
          }
        }
      }
    } else {
      // 浏览器环境，使用文件输入
      // 先显示分类选择对话框
      const categoryId = await this.showCategorySelectDialog('上传时选择分类（可选）');
      
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.stl,.3dm';
      input.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
          await this.uploadBlank(file, categoryId);
        }
      });
      input.click();
    }
  }

  async readFileAsFormData(filePath) {
    // 在Electron中，通过IPC调用主进程读取文件
    if (window.electronAPI && window.electronAPI.readFile) {
      const fileData = await window.electronAPI.readFile(filePath);
      if (!fileData.success) {
        throw new Error(fileData.error);
      }
      
      // 创建FormData
      const formData = new FormData();
      const blob = new Blob([fileData.buffer]);
      formData.append('file', blob, fileData.filename);
      formData.append('name', fileData.filename);
      
      return formData;
    } else {
      throw new Error('Electron API不可用');
    }
  }

  async uploadBlank(file, categoryId = null) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (categoryId) {
        formData.append('category_id', categoryId);
      }
      
      const response = await fetch('http://127.0.0.1:5000/api/blanks', {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '上传失败');
      }
      
      await this.loadBlanks();
      // 不显示成功提示，避免批量上传时弹出太多提示
    } catch (error) {
      console.error('上传失败:', error);
      alert('上传失败: ' + error.message);
      throw error;
    }
  }

  async previewBlank(blankId, blankData) {
    const modal = document.getElementById('blank-preview-modal');
    modal.classList.add('active');

    // Show blank name in header immediately
    const titleEl = document.getElementById('blank-preview-title');
    const subtitleEl = document.getElementById('blank-preview-subtitle');
    if (blankData) {
      titleEl.textContent = blankData.name || '粗胚预览';
      subtitleEl.textContent = blankData.category_name ? `分类: ${blankData.category_name}` : '';
    } else {
      titleEl.textContent = '粗胚预览';
      subtitleEl.textContent = '';
    }

    // Render static info immediately (before 3D loads)
    const infoEl = document.getElementById('blank-preview-info');
    infoEl.innerHTML = '<div style="color:#999;font-size:13px;">加载中...</div>';

    try {
      const data = await API.getBlankPreview(blankId);

      // Render info panel
      if (blankData || data.stats) {
        const stats = data.stats || {};
        const bounds = stats.bounds || {};
        const sizeX = bounds.x ? (bounds.x[1] - bounds.x[0]).toFixed(1) : '—';
        const sizeY = bounds.y ? (bounds.y[1] - bounds.y[0]).toFixed(1) : '—';
        const sizeZ = bounds.z ? (bounds.z[1] - bounds.z[0]).toFixed(1) : '—';

        infoEl.innerHTML = `
          <div class="result-details-content">
            <h3>模型信息</h3>
            ${blankData ? `
            <div class="result-metric"><label>名称:</label><span>${this.escapeHtml(blankData.name || '')}</span></div>
            <div class="result-metric"><label>文件大小:</label><span>${this.formatFileSize(blankData.file_size)}</span></div>
            <div class="result-metric"><label>上传时间:</label><span>${this.formatDate(blankData.upload_time)}</span></div>
            ${blankData.category_name ? `<div class="result-metric"><label>分类:</label><span>${this.escapeHtml(blankData.category_name)}</span></div>` : ''}
            ` : ''}
            ${stats.vertex_count !== undefined ? `
            <div class="result-metric"><label>顶点数:</label><span>${stats.vertex_count.toLocaleString()}</span></div>
            <div class="result-metric"><label>面数:</label><span>${stats.face_count.toLocaleString()}</span></div>
            ` : ''}
            ${bounds.x ? `
            <h3 style="margin-top:16px;">边界尺寸</h3>
            <div class="result-metric"><label>X 宽度:</label><span>${sizeX} mm</span></div>
            <div class="result-metric"><label>Y 深度:</label><span>${sizeY} mm</span></div>
            <div class="result-metric"><label>Z 高度:</label><span>${sizeZ} mm</span></div>
            ` : ''}
          </div>
        `;
      } else {
        infoEl.innerHTML = '';
      }

      // Init 3D viewer
      if (this.viewer) {
        this.viewer.dispose();
        this.viewer = null;
      }
      this.viewer = new Viewer3D('blank-preview-3d');
      this.viewer.loadMesh(data.vertices, data.faces, { color: 0x007AFF, opacity: 0.8 });
    } catch (error) {
      console.error('加载预览失败:', error);
      infoEl.innerHTML = `<div class="task-error">加载失败: ${this.escapeHtml(error.message)}</div>`;
    }
  }

  async batchAssignCategory() {
    if (this.selectedBlanks.size === 0) {
      alert('请先选择粗胚');
      return;
    }

    // 显示分类选择对话框
    const categoryId = await this.showCategorySelectDialog();
    if (!categoryId) return;

    try {
      const response = await fetch(`${API_BASE_URL}/blanks/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blank_ids: Array.from(this.selectedBlanks),
          category_id: categoryId || null
        })
      });

      const data = await response.json();
      if (data.success) {
        this.selectedBlanks.clear();
        await this.loadBlanks();
        alert(`成功更新 ${data.updated} 个粗胚的分类`);
      } else {
        throw new Error(data.error || '更新失败');
      }
    } catch (error) {
      console.error('批量分类失败:', error);
      alert('批量分类失败: ' + error.message);
    }
  }

  async showCategoryManagement() {
    const modal = document.getElementById('category-modal');
    modal.classList.add('active');
    
    await this.loadCategories(); // 确保分类已加载
    await this.renderCategoryTree();
    
    // 关闭按钮
    const closeBtn = document.getElementById('category-close');
    closeBtn.onclick = () => {
      modal.classList.remove('active');
    };
    
    // 创建分类按钮
    const createBtn = document.getElementById('create-category-btn');
    createBtn.onclick = () => {
      this.showCreateCategoryDialog();
    };
    
    // 点击外部关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('active');
      }
    });
  }

  async renderCategoryTree() {
    const treeContainer = document.getElementById('category-management-tree');
    treeContainer.innerHTML = '';
    
    // 构建树形结构
    const categoryMap = new Map();
    this.categories.forEach(cat => {
      categoryMap.set(cat.id, { ...cat, children: [] });
    });
    
    const rootCategories = [];
    this.categories.forEach(cat => {
      const category = categoryMap.get(cat.id);
      if (cat.parent_id) {
        const parent = categoryMap.get(cat.parent_id);
        if (parent) {
          parent.children.push(category);
        } else {
          rootCategories.push(category);
        }
      } else {
        rootCategories.push(category);
      }
    });
    
    // 渲染树
    const renderCategory = (category, level = 0) => {
      const item = document.createElement('div');
      item.className = 'category-tree-item';
      item.style.paddingLeft = `${level * 20}px`;
      item.style.marginBottom = '8px';
      item.style.display = 'flex';
      item.style.alignItems = 'center';
      item.style.justifyContent = 'space-between';
      
      const nameSpan = document.createElement('span');
      nameSpan.textContent = category.path || category.name;
      nameSpan.style.flex = '1';
      
      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '8px';
      
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-secondary';
      deleteBtn.textContent = '删除';
      deleteBtn.style.fontSize = '12px';
      deleteBtn.style.padding = '4px 8px';
      deleteBtn.onclick = async () => {
        if (confirm(`确定要删除分类"${category.name}"吗？`)) {
          try {
            await API.deleteCategory(category.id);
            if (this.activeSidebarCategoryId === category.id) {
              this.activeSidebarCategoryId = null;
            }
            await this.loadCategories();
            await this.renderCategoryTree();
            await this.loadBlanks();
            alert('删除成功');
          } catch (error) {
            alert('删除失败: ' + error.message);
          }
        }
      };
      
      actions.appendChild(deleteBtn);
      item.appendChild(nameSpan);
      item.appendChild(actions);
      treeContainer.appendChild(item);
      
      // 渲染子分类
      if (category.children && category.children.length > 0) {
        category.children.forEach(child => {
          renderCategory(child, level + 1);
        });
      }
    };
    
    rootCategories.forEach(cat => renderCategory(cat));
    
    if (rootCategories.length === 0) {
      treeContainer.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">暂无分类，点击"新建分类"创建</div>';
    }
  }

  async showCreateCategoryDialog() {
    const modal = document.getElementById('create-category-modal');
    const parentSelect = document.getElementById('create-category-parent');
    const nameInput = document.getElementById('create-category-name');
    
    // 填充分类选项
    parentSelect.innerHTML = '<option value="">无（顶级分类）</option>';
    this.categories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat.id;
      option.textContent = cat.path || cat.name;
      parentSelect.appendChild(option);
    });
    
    nameInput.value = '';
    modal.classList.add('active');
    
    // 关闭按钮
    const closeBtn = document.getElementById('create-category-close');
    closeBtn.onclick = () => {
      modal.classList.remove('active');
    };
    
    const cancelBtn = document.getElementById('create-category-cancel');
    cancelBtn.onclick = () => {
      modal.classList.remove('active');
    };
    
    // 提交按钮
    const submitBtn = document.getElementById('create-category-submit');
    submitBtn.onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) {
        alert('请输入分类名称');
        return;
      }
      
      const parentId = parentSelect.value || null;
      
      try {
        await API.createCategory({ name, parent_id: parentId });
        await this.loadCategories();      // also re-renders sidebar
        await this.renderCategoryTree();
        modal.classList.remove('active');
        alert('创建成功');
      } catch (error) {
        alert('创建失败: ' + error.message);
      }
    };
    
    // 点击外部关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('active');
      }
    });
  }

  async showCategorySelectDialog(title = '选择分类') {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.className = 'modal active';
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header">
            <h2>${title}</h2>
            <button class="modal-close" id="category-select-close">×</button>
          </div>
          <div class="modal-body">
            <select id="batch-category-select" class="filter-select" style="width: 100%; margin-bottom: 16px;">
              <option value="">无分类</option>
            </select>
            <div style="display: flex; gap: 12px; justify-content: flex-end;">
              <button class="btn-secondary" id="category-select-cancel">取消</button>
              <button class="btn-primary" id="category-select-confirm">确定</button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // 填充分类选项
      const select = modal.querySelector('#batch-category-select');
      this.categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat.id;
        option.textContent = cat.path || cat.name;
        select.appendChild(option);
      });

      // 事件处理
      const closeModal = () => {
        modal.remove();
        resolve(null);
      };

      const confirm = () => {
        const value = select.value === '' ? null : parseInt(select.value);
        modal.remove();
        resolve(value);
      };

      modal.querySelector('#category-select-close').onclick = closeModal;
      modal.querySelector('#category-select-cancel').onclick = closeModal;
      modal.querySelector('#category-select-confirm').onclick = confirm;

      document.body.appendChild(modal);

      // 点击外部关闭
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
          resolve(null);
        }
      });
    });
  }

  async batchDelete() {
    if (this.selectedBlanks.size === 0) return;

    if (!confirm(`确定要删除选中的 ${this.selectedBlanks.size} 个粗胚吗？`)) {
      return;
    }

    try {
      for (const id of this.selectedBlanks) {
        await API.deleteBlank(id);
      }
      this.selectedBlanks.clear();
      await this.loadBlanks();
      alert('删除成功');
    } catch (error) {
      console.error('删除失败:', error);
      alert('删除失败: ' + error.message);
    }
  }

  formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  formatDate(dateString) {
    if (!dateString) return '—';
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
