// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 5055;
const TESTCASE_DIR = path.resolve(__dirname, '..', '..', 'testcases', 'testcase1');
const SHOE_FILE = path.join(TESTCASE_DIR, 'target', 'B004小.3dm');
const BLANK_FILE = path.join(TESTCASE_DIR, 'candidate_set', 'B004小.3dm');

// ── Helpers ──────────────────────────────────────────────────────────────────

function httpRequest(method, urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let buf;
    if (body && contentType) {
      buf = typeof body === 'string' ? Buffer.from(body) : body;
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = buf.length;
    }
    const req = http.request(`http://127.0.0.1:${PORT}${urlPath}`, { method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

function uploadFileHttp(urlPath, filePath, fields) {
  const boundary = '----Boundary' + Date.now();
  const fileName = path.basename(filePath);
  const fileData = fs.readFileSync(filePath);
  let parts = '';
  for (const [k, v] of Object.entries(fields)) {
    parts += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const fullBody = Buffer.concat([
    Buffer.from(parts, 'utf8'),
    Buffer.from(fileHeader, 'utf8'),
    fileData,
    Buffer.from(tail, 'utf8'),
  ]);
  return httpRequest('POST', urlPath, fullBody, `multipart/form-data; boundary=${boundary}`);
}

/**
 * Navigate to match page with API monkey-patch for same-origin fetch.
 */
async function gotoMatchPage(page) {
  await page.addInitScript(`
    document.addEventListener('DOMContentLoaded', () => {
      if (typeof API === 'undefined') return;
      API.request = async function(endpoint, options = {}) {
        const url = '/api' + endpoint;
        const config = { headers: { 'Content-Type': 'application/json' }, ...options };
        const response = await fetch(url, config);
        if (!response.ok) {
          let errorMessage = 'HTTP ' + response.status, errorDetail = null, errorHint = null;
          try { const d = await response.json(); errorMessage = d.error || errorMessage; errorDetail = d.detail; errorHint = d.hint; } catch (_) {}
          const err = new Error(errorMessage);
          err.httpStatus = response.status; err.detail = errorDetail; err.hint = errorHint;
          throw err;
        }
        const ct = response.headers.get('content-type') || '';
        return ct.includes('json') ? response.json() : response.text();
      };
      API.uploadShoe = async (file, name) => {
        const fd = new FormData(); fd.append('file', file); fd.append('name', name);
        const r = await fetch('/api/shoes', { method: 'POST', body: fd }); return r.json();
      };
      API.uploadBlank = async (file, name, catId) => {
        const fd = new FormData(); fd.append('file', file); fd.append('name', name);
        if (catId) fd.append('category_id', catId);
        const r = await fetch('/api/blanks', { method: 'POST', body: fd }); return r.json();
      };
      API.getMatchResultPreview = async (id) => {
        const r = await fetch('/api/match/result/' + id + '/preview'); return r.json();
      };
    });
  `);

  await page.goto(`http://127.0.0.1:${PORT}/`);
  const skipBtn = page.getByRole('button', { name: '跳过' });
  if (await skipBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await skipBtn.click();
  }
  await page.getByRole('button', { name: '鞋模匹配' }).click();
  await expect(page.getByRole('heading', { name: '鞋模上传匹配' })).toBeVisible();
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('匹配任务界面', () => {
  test.beforeAll(async () => {
    await httpRequest('POST', '/api/categories', JSON.stringify({ name: 'E2E测试分类' }), 'application/json');
    const cats = await httpRequest('GET', '/api/categories');
    const cat = Array.isArray(cats) ? cats.find((c) => c.name === 'E2E测试分类') : null;
    if (cat) {
      await uploadFileHttp('/api/blanks', BLANK_FILE, { name: 'B004小', category_id: String(cat.id) });
    }
  });

  // ── 1. 匹配模块状态检测 ──

  test('1.1 模块可用时无警告横幅', async ({ page }) => {
    await gotoMatchPage(page);
    await expect(page.locator('#matcher-unavailable-banner')).toBeHidden();
  });

  // ── 2. 鞋模文件上传 ──

  test('2.1 点击上传区域弹出文件选择框', async ({ page }) => {
    await gotoMatchPage(page);
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('#shoe-upload-zone').click(),
    ]);
    expect(fileChooser).toBeTruthy();
  });

  test('2.4 格式校验: 非stl/3dm文件弹出alert', async ({ page }) => {
    await gotoMatchPage(page);
    // Register dialog handler BEFORE triggering the alert
    let dialogMsg = '';
    page.on('dialog', async (dialog) => {
      dialogMsg = dialog.message();
      await dialog.accept();
    });
    await page.evaluate(() => {
      matchManager.handleFiles([new File(['x'], 'bad.txt', { type: 'text/plain' })]);
    });
    // Wait a tick for the dialog handler
    await page.waitForTimeout(500);
    expect(dialogMsg).toContain('格式不支持');
  });

  test('2.5 大小校验: 超500MB弹出alert', async ({ page }) => {
    await gotoMatchPage(page);
    let dialogMsg = '';
    page.on('dialog', async (dialog) => {
      dialogMsg = dialog.message();
      await dialog.accept();
    });
    await page.evaluate(() => {
      matchManager.handleFiles([{ name: 'big.3dm', size: 600 * 1024 * 1024 }]);
    });
    await page.waitForTimeout(500);
    expect(dialogMsg).toContain('500MB');
  });

  test('2.6 上传后显示文件名和大小', async ({ page }) => {
    await gotoMatchPage(page);
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('#shoe-upload-zone').click(),
    ]);
    await fc.setFiles([SHOE_FILE]);
    await expect(page.locator('.uploaded-file-name')).toContainText('B004小.3dm');
    await expect(page.locator('.uploaded-file-size')).toContainText('MB');
  });

  test('2.7 点击×移除文件', async ({ page }) => {
    await gotoMatchPage(page);
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('#shoe-upload-zone').click(),
    ]);
    await fc.setFiles([SHOE_FILE]);
    await expect(page.locator('.uploaded-file')).toHaveCount(1);
    await page.locator('.uploaded-file-remove').click();
    await expect(page.locator('.uploaded-file')).toHaveCount(0);
  });

  // ── 3. 粗胚分类选择 ──

  test('3.1 分类从后端加载为树形结构', async ({ page }) => {
    await gotoMatchPage(page);
    // At least 1 category item loaded
    const items = page.locator('#category-tree .category-item');
    await expect(items.first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#category-tree')).toContainText('E2E测试分类');
  });

  test('3.2 直接点击checkbox可切换 (regression fix)', async ({ page }) => {
    await gotoMatchPage(page);
    const cb = page.locator('#category-tree .category-checkbox').first();
    await cb.click();
    await expect(cb).toBeChecked();
    const s1 = await page.evaluate(() => [...matchManager.selectedCategories]);
    expect(s1.length).toBeGreaterThan(0);
    await cb.click();
    await expect(cb).not.toBeChecked();
    const s2 = await page.evaluate(() => [...matchManager.selectedCategories]);
    expect(s2).toHaveLength(0);
  });

  test('3.3 点击分类名称切换选中', async ({ page }) => {
    await gotoMatchPage(page);
    const label = page.locator('#category-tree .category-label').first();
    const cb = page.locator('#category-tree .category-checkbox').first();
    await label.click();
    await expect(cb).toBeChecked();
    await label.click();
    await expect(cb).not.toBeChecked();
  });

  test('3.4 无分类时显示空态提示', async ({ page }) => {
    await gotoMatchPage(page);
    await page.evaluate(() => matchManager.renderCategoryTree([]));
    await expect(page.locator('#category-tree')).toContainText('暂无分类');
  });

  // ── 4. 匹配参数 ──

  test('4.1-4.10 参数默认值', async ({ page }) => {
    await gotoMatchPage(page);
    await page.getByText('展开高级参数').click();
    const expected = {
      'param-wrapping-threshold': '0.96',
      'param-concurrent-matches': '2',
      'param-ga-population': '50',
      'param-ga-generations': '30',
      'param-ga-crossover': '0.8',
      'param-ga-mutation': '0.1',
      'param-translation-range': '50',
      'param-rotation-range': '180',
      'param-lateral-range': '30',
      'param-sample-points': '500',
    };
    for (const [id, val] of Object.entries(expected)) {
      await expect(page.locator(`#${id}`)).toHaveValue(val);
    }
  });

  test('4.11 参数区域默认折叠', async ({ page }) => {
    await gotoMatchPage(page);
    await expect(page.locator('.param-grid')).toBeHidden();
  });

  // ── 5. 前置校验 ──

  test('5.1 无鞋模时alert', async ({ page }) => {
    await gotoMatchPage(page);
    let dialogMsg = '';
    page.on('dialog', async (dialog) => {
      dialogMsg = dialog.message();
      await dialog.accept();
    });
    await page.getByRole('button', { name: '开始匹配' }).click();
    await page.waitForTimeout(500);
    expect(dialogMsg).toBe('请先上传鞋模文件');
  });

  test('5.2 无分类时alert', async ({ page }) => {
    await gotoMatchPage(page);
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('#shoe-upload-zone').click(),
    ]);
    await fc.setFiles([SHOE_FILE]);

    let dialogMsg = '';
    page.on('dialog', async (dialog) => {
      dialogMsg = dialog.message();
      await dialog.accept();
    });
    await page.getByRole('button', { name: '开始匹配' }).click();
    await page.waitForTimeout(500);
    expect(dialogMsg).toBe('请选择粗胚分类');
  });

  // ── 6-9. 完整匹配流程 ──

  test('6-9 完整匹配流程', async ({ page }) => {
    await gotoMatchPage(page);

    // Upload shoe
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('#shoe-upload-zone').click(),
    ]);
    await fc.setFiles([SHOE_FILE]);

    // Select category
    await page.locator('#category-tree .category-checkbox').first().click();

    // Start matching
    const btn = page.getByRole('button', { name: '开始匹配' });
    await btn.click();

    // Progress visible (the button may transition very fast, so skip disabled check
    // and just verify progress section appears)
    await expect(page.locator('#match-progress-section')).toBeVisible();

    // Wait for completion
    await expect(page.locator('.status-completed')).toBeVisible({ timeout: 45_000 });

    // 7.5: 已完成
    await expect(page.locator('#match-progress-section')).toContainText('已完成');

    // 7.6: summary
    await expect(page.locator('.progress-summary')).toContainText(/\d+ \/ \d+ 匹配/);
    await expect(page.locator('.progress-summary')).toContainText('最高包裹率');

    // 7.8: elapsed
    await expect(page.locator('#match-progress-section')).toContainText(/用时 \d+/);

    // 5.4: restored after completion
    await expect(btn).toBeEnabled();
    await expect(btn).toContainText('开始匹配');

    // 8.1-8.4: Result card
    const results = page.locator('#match-results-section');
    await expect(results).toBeVisible();
    await expect(results).toContainText('B004小.3dm');
    await expect(results).toContainText('最佳匹配');
    await expect(results).toContainText('包裹率');
    await expect(results).toContainText('P96间隙');
    await expect(results).toContainText('体积');

    // 8.7 + 9: Open detail modal
    await results.getByRole('button', { name: /查看全部/ }).click();
    const modal = page.locator('#match-result-modal');
    await expect(modal).toBeVisible();

    // 9.1
    await expect(modal.locator('#match-result-modal-title')).toContainText('B004小.3dm');

    // 9.3-9.4
    const firstRow = modal.locator('.match-list-row').first();
    await expect(firstRow).toContainText('最佳');

    // 9.6: 9 metrics
    const overview = modal.locator('#match-result-overview');
    for (const label of ['包裹率', '目标包裹率', 'P96间隙', '体积', '完全包裹', '方向约束', '纵向平移', '旋转角度', '横向偏移']) {
      await expect(overview).toContainText(label);
    }

    // 9.8
    await expect(overview).toContainText('前后角度');
    await expect(overview).toContainText('垂直角度');

    // 10.6: close
    await page.locator('#match-result-close').click();
    await expect(modal).toBeHidden();
    expect(await page.evaluate(() => ResultDetailView._viewer === null)).toBe(true);
  });

  // ── 11. 错误处理 ──

  test('11.6 XSS防护', async ({ page }) => {
    await gotoMatchPage(page);
    const result = await page.evaluate(
      () => matchManager._esc('<script>alert("xss")</script>')
    );
    expect(result).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
  });
});

// ── 多鞋模×多粗胚 批量匹配集成测试 ──────────────────────────────────────────

test.describe('批量匹配: 3鞋模×3粗胚', () => {
  const CANDIDATE_DIR = path.join(TESTCASE_DIR, 'candidate_set');
  const TARGET_DIR = path.join(TESTCASE_DIR, 'target');

  const BLANK_FILES = ['B004小.3dm', 'B004大.3dm', 'B004加大.3dm'];
  const SHOE_FILES  = ['B004小.3dm', 'B004大.3dm', 'B004加大.3dm'];

  let batchCategoryId;

  test.beforeAll(async () => {
    // Create a dedicated category for this test suite
    const catRes = await httpRequest(
      'POST', '/api/categories',
      JSON.stringify({ name: '批量匹配测试' }),
      'application/json'
    );
    batchCategoryId = catRes.id;

    // Upload 3 blanks into this category
    for (const name of BLANK_FILES) {
      await uploadFileHttp('/api/blanks', path.join(CANDIDATE_DIR, name), {
        name: name.replace('.3dm', ''),
        category_id: String(batchCategoryId),
      });
    }
  });

  test('多鞋模匹配: 上传3鞋模 → 匹配3粗胚 → 结果卡片 → 历史记录', async ({ page }) => {
    test.setTimeout(180_000); // matching 3×3 may take a while

    await gotoMatchPage(page);

    // ── Step 1: Upload 3 shoe files ──
    const shoeAbsPaths = SHOE_FILES.map((f) => path.join(TARGET_DIR, f));
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('#shoe-upload-zone').click(),
    ]);
    await fc.setFiles(shoeAbsPaths);

    // Verify all 3 files listed
    await expect(page.locator('.uploaded-file')).toHaveCount(3);
    for (const name of SHOE_FILES) {
      await expect(page.locator('#shoe-uploaded-files')).toContainText(name);
    }

    // ── Step 2: Select the batch category ──
    // Find the checkbox for "批量匹配测试"
    const catItem = page.locator('#category-tree .category-item', { hasText: '批量匹配测试' }).first();
    await expect(catItem).toBeVisible({ timeout: 5000 });
    await catItem.locator('.category-checkbox').click();

    // ── Step 3: Start matching ──
    const btn = page.getByRole('button', { name: '开始匹配' });
    await btn.click();

    // Progress section appears
    await expect(page.locator('#match-progress-section')).toBeVisible();

    // ── Step 4: Wait for ALL 3 tasks to complete ──
    // Each shoe becomes a separate progress item; wait until all show "已完成"
    const progressList = page.locator('#match-progress-list');
    // We need 3 completed items
    await expect(progressList.locator('.status-completed')).toHaveCount(3, { timeout: 120_000 });

    // Button restored
    await expect(btn).toBeEnabled();
    await expect(btn).toContainText('开始匹配');

    // ── Step 5: Verify result cards ──
    const resultsSection = page.locator('#match-results-section');
    await expect(resultsSection).toBeVisible();

    // 3 shoe result groups (one per shoe)
    const resultGroups = resultsSection.locator('.shoe-result-group');
    await expect(resultGroups).toHaveCount(3);

    // Each result card should reference one of the shoe names
    for (const name of SHOE_FILES) {
      await expect(resultsSection).toContainText(name);
    }

    // Each card shows "N 匹配 / M 不符" where N+M = 3 (total blanks)
    const resultHeaders = resultsSection.locator('.shoe-result-count');
    for (let i = 0; i < 3; i++) {
      const text = await resultHeaders.nth(i).textContent();
      // Parse "X 匹配 / Y 不符" → X + Y should be 3
      const match = text.match(/(\d+)\s*匹配\s*\/\s*(\d+)\s*不符/);
      expect(match).toBeTruthy();
      const matchedCount = parseInt(match[1]);
      const unmatchedCount = parseInt(match[2]);
      expect(matchedCount + unmatchedCount).toBe(3);
    }

    // Each progress summary should show "N / 3 匹配"
    const progressSummaries = progressList.locator('.progress-summary');
    for (let i = 0; i < 3; i++) {
      const text = await progressSummaries.nth(i).textContent();
      expect(text).toMatch(/\d+ \/ 3 匹配/);
    }

    // ── Step 6: Open one detail modal and verify 3 blank rows ──
    const firstViewAllBtn = resultsSection.getByRole('button', { name: /查看全部 3 个粗胚结果/ }).first();
    await firstViewAllBtn.click();

    const modal = page.locator('#match-result-modal');
    await expect(modal).toBeVisible();

    // Subtitle should show "共 3 个粗胚"
    await expect(modal.locator('#match-result-modal-subtitle')).toContainText('共 3 个粗胚');

    // 3 rows in the match list
    await expect(modal.locator('.match-list-row')).toHaveCount(3);

    // Close modal
    await page.locator('#match-result-close').click();
    await expect(modal).toBeHidden();

    // ── Step 7: Navigate to history page and verify grouped records ──
    await page.getByRole('button', { name: '历史记录' }).click();
    await expect(page.getByRole('heading', { name: '历史匹配记录' })).toBeVisible();

    // Wait for history data rows (rows with checkboxes, not empty-state row).
    // History now groups by shoe, so 3 shoes = 3 rows.
    // Auto-refresh fires every 5s, so allow up to 15s for data to appear.
    const dataRows = page.locator('#history-table-body tr:has(input[type="checkbox"])');
    await expect(dataRows.nth(2)).toBeVisible({ timeout: 15_000 });

    // Verify each shoe name appears in history
    const historyTable = page.locator('#history-table-body');
    for (const name of SHOE_FILES) {
      await expect(historyTable).toContainText(name, { timeout: 5_000 });
    }

    // Verify match summary column shows "N / M 匹配" format
    const matchCells = page.locator('#history-table-body td:nth-child(3)');
    const firstMatch = await matchCells.first().textContent();
    expect(firstMatch).toMatch(/\d+ \/ \d+ 匹配/);

    // Verify best blank name column is populated
    const blankCells = page.locator('#history-table-body td:nth-child(4)');
    const firstBlank = await blankCells.first().textContent();
    expect(firstBlank.trim().length).toBeGreaterThan(0);

    // Verify best wrapping ratio column shows percentage values
    const wrCells = page.locator('#history-table-body td:nth-child(5)');
    const firstWr = await wrCells.first().textContent();
    expect(firstWr).toMatch(/\d+\.\d+%/);

    // ── Step 8: Click detail button on a batch row and verify it shows all 3 blanks ──
    // Find a row from our batch test (matched against 3 blanks)
    const batchRow = page.locator('#history-table-body tr', { hasText: '/ 3 匹配' }).first();
    await expect(batchRow).toBeVisible({ timeout: 5_000 });
    const detailBtn = batchRow.getByRole('button', { name: '查看详情' });
    await detailBtn.click();

    const historyModal = page.locator('#match-result-modal');
    await expect(historyModal).toBeVisible();
    await expect(historyModal.locator('#match-result-modal-subtitle')).toContainText('个粗胚');
    await expect(historyModal.locator('.match-list-row')).toHaveCount(3);

    await page.locator('#match-result-close').click();
    await expect(historyModal).toBeHidden();
  });
});
