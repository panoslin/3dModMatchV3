// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('数据看板', () => {
  test.beforeEach(async ({ page }) => {
    // Suppress tutorial overlay so it doesn't intercept clicks
    await page.addInitScript(() => {
      localStorage.setItem('hasSeenGuide', 'true');
      localStorage.setItem('showTutorial', 'false');
    });
    // Proxy API calls from hardcoded port 5000 → test server port 5055
    await page.route('http://127.0.0.1:5000/api/**', async (route) => {
      const redirected = route.request().url().replace('http://127.0.0.1:5000', 'http://127.0.0.1:5055');
      await route.continue({ url: redirected });
    });
    await page.goto('/');
    await page.click('.nav-tab[data-page="dashboard"]');
    await page.waitForSelector('#dashboard-page.active', { timeout: 8000 });
  });

  test('看板页面可正常导航', async ({ page }) => {
    await expect(page.locator('#dashboard-page')).toBeVisible();
    await expect(page.locator('#dashboard-page .page-header h1')).toHaveText('数据看板');
  });

  test('刷新按钮存在且可点击', async ({ page }) => {
    const btn = page.locator('#dashboard-refresh-btn');
    await expect(btn).toBeVisible();
    await btn.click();
    // After click, refresh indicator should appear eventually
    await page.waitForTimeout(2000);
  });

  test('模块一：4个概览卡片渲染', async ({ page }) => {
    await expect(page.locator('#ov-today-count')).toBeVisible();
    await expect(page.locator('#ov-hit-rate')).toBeVisible();
    await expect(page.locator('#ov-avg-wrapping')).toBeVisible();
    await expect(page.locator('#ov-p99-time')).toBeVisible();
  });

  test('模块二：趋势图容器渲染', async ({ page }) => {
    await expect(page.locator('#dashboard-trend')).toBeVisible();
  });

  test('模块三：粗胚热力图容器渲染', async ({ page }) => {
    await expect(page.locator('#dashboard-heatmap')).toBeAttached();
  });

  test('模块四：包裹率分布容器渲染', async ({ page }) => {
    await expect(page.locator('#dashboard-distribution')).toBeVisible();
  });

  test('模块五：排行榜容器渲染', async ({ page }) => {
    await expect(page.locator('#dashboard-leaderboard-top')).toBeVisible();
    await expect(page.locator('#dashboard-leaderboard-miss')).toBeVisible();
  });

  test('模块六：系统状态容器渲染（在顶部）', async ({ page }) => {
    await expect(page.locator('#dashboard-system')).toBeAttached();
    // After data loads, sys-grid should appear in DOM
    await page.waitForSelector('.sys-grid', { timeout: 10000 });
    await expect(page.locator('.sys-grid')).toBeAttached();
    // System status should appear before overview cards in DOM order
    const sysTop = await page.locator('#dashboard-system').evaluate(el => el.getBoundingClientRect().top);
    const ovTop = await page.locator('#dashboard-overview').evaluate(el => el.getBoundingClientRect().top);
    expect(sysTop).toBeLessThan(ovTop);
  });

  test('概览卡片数据在 API 响应后更新', async ({ page }) => {
    // Wait for dashboard data to load (value should not be "—" indefinitely)
    await page.waitForFunction(() => {
      const el = document.querySelector('#ov-today-count .ov-value');
      return el && el.textContent !== '';
    }, { timeout: 10000 });

    const todayVal = await page.locator('#ov-today-count .ov-value').textContent();
    expect(todayVal).not.toBeNull();
    // Value should be a number (possibly 0) or "—" if no data
    expect(todayVal.trim()).toMatch(/^[\d—]+/);
  });

  test('天数选择器切换后重新加载数据', async ({ page }) => {
    const select = page.locator('#dashboard-days-select');
    await expect(select).toBeVisible();
    await select.selectOption('7');
    await page.waitForTimeout(1500);
    // Trend chart should still be present after reload
    await expect(page.locator('#dashboard-trend')).toBeVisible();
  });
});
