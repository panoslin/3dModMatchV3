/** Blank (粗胚) management: category sidebar, upload, preview, CRUD. */
class BlankManager {
  constructor() {
    this.currentPage = 1;
    this.perPage = 50;
    this.selectedBlanks = new Set();
    this.categories = [];
    this.viewer = null;
    this.activeSidebarCategoryId = null; // null = 全部
    this._activeBlankId = null;
    this._previewSeq = 0;

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

    // 快捷新建分类
    document.getElementById('add-category-inline-btn').addEventListener('click', () => {
      this.showCreateCategoryDialog();
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

  }

  async loadCategories() {
    try {
      const resp = await API.getCategories();
      this.categories = resp.categories || resp;
      this._totalBlanks = resp.total_blanks || 0;
      this._uncategorizedCount = resp.uncategorized_count || 0;
      this.renderCategorySidebar();
    } catch (error) {
      console.error('加载分类失败:', error);
    }
  }

  renderCategorySidebar() {
    const container = document.getElementById('category-sidebar-tree');
    if (!container) return;
    container.innerHTML = '';

    // Compute subtree counts (own + descendants)
    const countMap = new Map();
    this.categories.forEach(cat => countMap.set(cat.id, cat.blank_count || 0));

    // "全部" item
    const allItem = document.createElement('div');
    allItem.className = 'sidebar-cat-item' + (this.activeSidebarCategoryId === null ? ' active' : '');
    allItem.innerHTML = `
      <span class="sidebar-cat-label">全部粗胚</span>
      <span class="sidebar-cat-count">${this._totalBlanks || 0}</span>
    `;
    allItem.addEventListener('click', () => {
      this.activeSidebarCategoryId = null;
      this.currentPage = 1;
      this.loadBlanks();
      this.renderCategorySidebar();
    });
    container.appendChild(allItem);

    // "未分类" item (only show if there are uncategorized blanks)
    if (this._uncategorizedCount > 0) {
      const uncatItem = document.createElement('div');
      uncatItem.className = 'sidebar-cat-item' + (this.activeSidebarCategoryId === 'uncategorized' ? ' active' : '');
      uncatItem.innerHTML = `
        <span class="sidebar-cat-label sidebar-cat-label-muted">未分类</span>
        <span class="sidebar-cat-count">${this._uncategorizedCount}</span>
      `;
      uncatItem.addEventListener('click', () => {
        this.activeSidebarCategoryId = 'uncategorized';
        this.currentPage = 1;
        this.loadBlanks();
        this.renderCategorySidebar();
      });
      container.appendChild(uncatItem);
    }

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

    // Accumulate subtree counts (bottom-up)
    const subtreeCount = (node) => {
      let total = countMap.get(node.id) || 0;
      if (node.children) {
        node.children.forEach(child => { total += subtreeCount(child); });
      }
      node._subtreeCount = total;
      return total;
    };
    roots.forEach(root => subtreeCount(root));

    const renderNode = (node, level) => {
      const hasChildren = node.children && node.children.length > 0;
      const isActive = this.activeSidebarCategoryId === node.id;
      const isExpanded = !this._collapsedCategories?.has(node.id);

      const item = document.createElement('div');
      item.className = 'sidebar-cat-item' + (isActive ? ' active' : '');
      item.style.paddingLeft = `${12 + level * 16}px`;

      const ownCount = countMap.get(node.id) || 0;
      const displayCount = hasChildren ? node._subtreeCount : ownCount;

      item.innerHTML = `
        <button class="sidebar-cat-toggle ${hasChildren && !isExpanded ? 'collapsed' : ''}" style="${hasChildren ? '' : 'visibility:hidden'}">▾</button>
        <span class="sidebar-cat-label" title="${this.escapeHtml(node.path || node.name)}">${this.escapeHtml(node.name)}</span>
        <span class="sidebar-cat-count">${displayCount}</span>
        <button class="sidebar-cat-action sidebar-cat-rename" title="重命名分类">✎</button>
        <button class="sidebar-cat-action" title="删除分类">×</button>
      `;

      const toggle = item.querySelector('.sidebar-cat-toggle');
      const renameBtn = item.querySelector('.sidebar-cat-rename');
      const deleteBtn = item.querySelector('.sidebar-cat-action:last-child');

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

      renameBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newName = await this._showRenameDialog(node.name);
        if (!newName) return;
        try {
          await API.renameCategory(node.id, newName);
          await this.loadCategories();
          this.renderCategorySidebar();
        } catch (error) {
          alert('重命名失败: ' + error.message);
        }
      });

      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`确定要删除分类"${node.name}"吗？`)) return;
        try {
          await API.deleteCategory(node.id);
          if (this.activeSidebarCategoryId === node.id) {
            this.activeSidebarCategoryId = null;
          }
          await this.loadCategories();
          await this.loadBlanks();
        } catch (error) {
          alert('删除失败: ' + error.message);
        }
      });

      item.addEventListener('click', (e) => {
        if (e.target === toggle || e.target === deleteBtn || e.target === renameBtn) return;
        this.activeSidebarCategoryId = node.id;
        this.currentPage = 1;
        this.loadBlanks();
        this.renderCategorySidebar();
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

    const params = { search, sort, page: this.currentPage, per_page: this.perPage };
    if (categoryId !== null) {
      params.category_id = categoryId;
    }

    try {
      const data = await API.getBlanks(params);

      this.renderBlanks(data.items);
      this.renderPagination(data.total, 'blank-pagination');
    } catch (error) {
      console.error('加载粗胚失败:', error);
      alert('加载粗胚失败: ' + error.message);
    }
  }

  renderBlanks(blanks) {
    const list = document.getElementById('blank-list');
    list.innerHTML = '';

    blanks.forEach(blank => {
      const row = document.createElement('div');
      row.className = 'blank-list-row';
      row.dataset.id = blank.id;

      const isSelected = this.selectedBlanks.has(blank.id);
      if (isSelected) row.classList.add('selected');
      if (this._activeBlankId === blank.id) row.classList.add('active');

      row.innerHTML = `
        <input type="checkbox" class="blank-list-checkbox" ${isSelected ? 'checked' : ''}>
        <span class="blank-list-name" title="${this.escapeHtml(blank.name)}">${this.escapeHtml(blank.name)}</span>
        ${blank.category_name ? `<span class="blank-list-category">${this.escapeHtml(blank.category_name)}</span>` : ''}
        <span class="blank-list-size">${this.formatFileSize(blank.file_size)}</span>
        <span class="blank-list-date">${this.formatDate(blank.upload_time)}</span>
      `;

      const checkbox = row.querySelector('.blank-list-checkbox');
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        this.toggleSelect(blank.id);
      });

      row.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          this.previewBlank(blank.id, blank);
        }
      });

      list.appendChild(row);
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
    // Update active row highlight
    this._activeBlankId = blankId;
    document.querySelectorAll('.blank-list-row').forEach(row => {
      row.classList.toggle('active', row.dataset.id === String(blankId));
    });

    const placeholder = document.getElementById('blank-preview-placeholder');
    const viewerWrap = document.getElementById('blank-preview-viewer');
    const infoEl = document.getElementById('blank-preview-info');

    // Show viewer panel, hide placeholder
    placeholder.style.display = 'none';
    viewerWrap.style.display = 'flex';

    // Show info immediately
    infoEl.innerHTML = '<div style="color:#999;font-size:13px;">加载3D模型中...</div>';

    // Race condition guard
    const seq = ++this._previewSeq;

    try {
      const data = await API.getBlankPreview(blankId);
      if (seq !== this._previewSeq) return; // stale

      // Render info panel
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

      // Reuse or create 3D viewer
      if (this.viewer) {
        this.viewer.clear();
      } else {
        document.getElementById('blank-preview-3d').innerHTML = '';
        this.viewer = new Viewer3D('blank-preview-3d');
      }
      this.viewer.loadMesh(data.vertices, data.faces, { color: 0x007AFF, opacity: 0.8 });
    } catch (error) {
      if (seq !== this._previewSeq) return;
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
      const row = document.createElement('div');
      row.className = 'cat-tree-row';
      row.style.paddingLeft = `${12 + level * 24}px`;

      const nameEl = document.createElement('span');
      nameEl.className = 'cat-tree-row-name';
      nameEl.textContent = category.name;
      if (level > 0 && category.path) {
        const pathEl = document.createElement('span');
        pathEl.className = 'cat-tree-row-path';
        pathEl.textContent = `(${category.path})`;
        nameEl.appendChild(pathEl);
      }

      const countEl = document.createElement('span');
      countEl.className = 'cat-tree-row-count';
      countEl.textContent = `${category.blank_count || 0} 个粗胚`;

      const actions = document.createElement('div');
      actions.className = 'cat-tree-row-actions';

      const renameBtn = document.createElement('button');
      renameBtn.className = 'cat-tree-row-btn';
      renameBtn.textContent = '重命名';
      renameBtn.onclick = async () => {
        const newName = await this._showRenameDialog(category.name);
        if (!newName) return;
        try {
          await API.renameCategory(category.id, newName);
          await this.loadCategories();
          await this.renderCategoryTree();
          this.renderCategorySidebar();
        } catch (error) {
          alert('重命名失败: ' + error.message);
        }
      };

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'cat-tree-row-btn danger';
      deleteBtn.textContent = '删除';
      deleteBtn.onclick = async () => {
        if (!confirm(`确定要删除分类"${category.name}"吗？`)) return;
        try {
          await API.deleteCategory(category.id);
          if (this.activeSidebarCategoryId === category.id) {
            this.activeSidebarCategoryId = null;
          }
          await this.loadCategories();
          await this.renderCategoryTree();
          await this.loadBlanks();
        } catch (error) {
          alert('删除失败: ' + error.message);
        }
      };

      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);
      row.appendChild(nameEl);
      row.appendChild(countEl);
      row.appendChild(actions);
      treeContainer.appendChild(row);

      if (category.children && category.children.length > 0) {
        category.children.forEach(child => renderCategory(child, level + 1));
      }
    };

    rootCategories.forEach(cat => renderCategory(cat));

    if (rootCategories.length === 0) {
      treeContainer.innerHTML = '<div class="cat-tree-empty">暂无分类，点击上方「新建分类」创建</div>';
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

  /** @see utils.js formatFileSize */
  formatFileSize(bytes) { return formatFileSize(bytes); }

  /** @see utils.js formatDate */
  formatDate(dateString) { return formatDate(dateString); }

  /** @see utils.js escapeHtml */
  escapeHtml(text) { return escapeHtml(text); }

  _showRenameDialog(currentName) {
    return new Promise((resolve) => {
      const modal = document.getElementById('rename-category-modal');
      const input = document.getElementById('rename-category-name');
      const submitBtn = document.getElementById('rename-category-submit');
      const cancelBtn = document.getElementById('rename-category-cancel');
      const closeBtn = document.getElementById('rename-category-close');

      input.value = currentName;
      modal.classList.add('active');
      input.focus();
      input.select();

      const cleanup = () => {
        modal.classList.remove('active');
        submitBtn.replaceWith(submitBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));
        closeBtn.replaceWith(closeBtn.cloneNode(true));
        input.removeEventListener('keydown', onKey);
      };

      const submit = () => {
        const val = input.value.trim();
        cleanup();
        resolve(val && val !== currentName ? val : null);
      };

      const cancel = () => { cleanup(); resolve(null); };

      const onKey = (e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') cancel();
      };

      document.getElementById('rename-category-submit').addEventListener('click', submit);
      document.getElementById('rename-category-cancel').addEventListener('click', cancel);
      document.getElementById('rename-category-close').addEventListener('click', cancel);
      input.addEventListener('keydown', onKey);
    });
  }
}
