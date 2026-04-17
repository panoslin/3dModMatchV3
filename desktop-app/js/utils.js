/**
 * Shared utility functions used across multiple managers.
 */

/** Escape HTML special characters to prevent XSS (matches DOM textContent→innerHTML behavior). */
function escapeHtml(str) {
  if (!str && str !== 0) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

/** Format ISO date string to 'YYYY-MM-DD HH:MM' (China timezone). */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
}

/** Format file size in bytes to human-readable string. */
function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Build a tree structure from a flat list of categories.
 * Each category must have { id, name, parent_id }.
 * Returns an array of root nodes, each with a `children` array.
 */
function buildCategoryTree(categories) {
  const map = {};
  const roots = [];
  for (const cat of categories) {
    map[cat.id] = { ...cat, children: [] };
  }
  for (const cat of categories) {
    if (cat.parent_id && map[cat.parent_id]) {
      map[cat.parent_id].children.push(map[cat.id]);
    } else {
      roots.push(map[cat.id]);
    }
  }
  return roots;
}

/**
 * Render pagination controls into a container element.
 * @param {HTMLElement} container - Target DOM element
 * @param {number} currentPage - Current 1-based page index
 * @param {number} totalPages - Total number of pages
 * @param {function} onPageChange - Callback(pageNumber) when a page button is clicked
 */
function renderPagination(container, currentPage, totalPages, onPageChange) {
  if (!container || totalPages <= 1) {
    if (container) container.innerHTML = '';
    return;
  }
  let html = '';
  html += `<button class="page-btn" ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">&laquo;</button>`;
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
  }
  html += `<button class="page-btn" ${currentPage >= totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">&raquo;</button>`;
  container.innerHTML = html;
  container.querySelectorAll('.page-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = parseInt(btn.dataset.page);
      if (page >= 1 && page <= totalPages) onPageChange(page);
    });
  });
}
