// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Dark Mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('hasSeenGuide', 'true');
      localStorage.setItem('showTutorial', 'false');
    });
    await page.route('http://127.0.0.1:5000/api/**', async (route) => {
      const redirected = route.request().url().replace('http://127.0.0.1:5000', 'http://127.0.0.1:5055');
      await route.continue({ url: redirected });
    });
    await page.goto('/');
    await page.waitForSelector('#app', { timeout: 8000 });
  });

  test('默认为亮色模式', async ({ page }) => {
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).not.toBe('dark');
    await expect(page.locator('#theme-toggle-btn')).toHaveText('🌙');
  });

  test('点击切换按钮进入暗色模式', async ({ page }) => {
    await page.click('#theme-toggle-btn');
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('dark');
    await expect(page.locator('#theme-toggle-btn')).toHaveText('☀️');
  });

  test('再次点击恢复亮色模式', async ({ page }) => {
    await page.click('#theme-toggle-btn');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.click('#theme-toggle-btn');
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).not.toBe('dark');
    await expect(page.locator('#theme-toggle-btn')).toHaveText('🌙');
  });

  test('主题偏好持久化', async ({ page }) => {
    await page.click('#theme-toggle-btn');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Reload page
    await page.reload();
    await page.waitForSelector('#app', { timeout: 8000 });

    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('dark');
    await expect(page.locator('#theme-toggle-btn')).toHaveText('☀️');
  });

  test('暗色模式下 navbar 背景色正确', async ({ page }) => {
    await page.click('#theme-toggle-btn');
    const navBg = await page.locator('.navbar').evaluate((el) =>
      getComputedStyle(el).backgroundColor
    );
    // Should be dark (--bg-color: #1C1C1E → rgb(28, 28, 30))
    expect(navBg).toBe('rgb(28, 28, 30)');
  });

  test('暗色模式下 dashboard-card 背景色正确', async ({ page }) => {
    await page.click('#theme-toggle-btn');
    const cardBg = await page.locator('.dashboard-card').first().evaluate((el) =>
      getComputedStyle(el).backgroundColor
    );
    expect(cardBg).toBe('rgb(28, 28, 30)');
  });

  test('暗色模式下 data-table 背景色正确', async ({ page }) => {
    await page.click('#theme-toggle-btn');
    await page.click('.nav-tab[data-page="history"]');
    await page.waitForSelector('#history-page.active', { timeout: 5000 });

    const tableBg = await page.locator('.data-table').evaluate((el) =>
      getComputedStyle(el).backgroundColor
    );
    expect(tableBg).toBe('rgb(28, 28, 30)');
  });

  test('暗色模式下 sidebar 背景色正确', async ({ page }) => {
    await page.click('#theme-toggle-btn');
    await page.click('.nav-tab[data-page="blank"]');
    await page.waitForSelector('#blank-page.active', { timeout: 5000 });

    const sidebarBg = await page.locator('.category-sidebar').evaluate((el) =>
      getComputedStyle(el).backgroundColor
    );
    // --bg-secondary: #2C2C2E → rgb(44, 44, 46)
    expect(sidebarBg).toBe('rgb(44, 44, 46)');
  });

  test('暗色模式下 upload-zone 背景色正确', async ({ page }) => {
    await page.click('#theme-toggle-btn');
    await page.click('.nav-tab[data-page="match"]');
    await page.waitForSelector('#match-page.active', { timeout: 5000 });

    const uploadBg = await page.locator('.upload-zone').evaluate((el) =>
      getComputedStyle(el).backgroundColor
    );
    expect(uploadBg).toBe('rgb(44, 44, 46)');
  });

  test('暗色模式下模态框背景色正确', async ({ page }) => {
    await page.click('#theme-toggle-btn');
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal.active', { timeout: 3000 });

    const modalBg = await page.locator('#settings-modal .modal-content').evaluate((el) =>
      getComputedStyle(el).backgroundColor
    );
    expect(modalBg).toBe('rgb(28, 28, 30)');
  });
});
