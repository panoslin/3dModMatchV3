// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('分类重命名', () => {
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
    await page.click('.nav-tab[data-page="blank"]');
    await page.waitForSelector('#blank-page.active', { timeout: 8000 });
  });

  async function createCategory(page, name) {
    await page.click('#manage-categories-btn');
    await page.waitForSelector('#category-modal.active', { timeout: 5000 });
    await page.click('#create-category-btn');
    await page.waitForSelector('#create-category-modal.active', { timeout: 5000 });
    await page.fill('#create-category-name', name);
    await page.click('#create-category-submit');
    await page.waitForTimeout(500);
  }

  async function closeManageModal(page) {
    const closeBtn = page.locator('#category-close');
    if (await closeBtn.isVisible()) await closeBtn.click();
    await page.waitForTimeout(300);
  }

  test('侧边栏重命名按钮显示并可使用', async ({ page }) => {
    const catName = `SideRename_${Date.now()}`;
    const newName = `SideRenamed_${Date.now()}`;

    await createCategory(page, catName);
    await closeManageModal(page);

    // Hover on sidebar category to reveal action buttons
    const sidebarItem = page.locator('.sidebar-cat-item', { hasText: catName });
    await expect(sidebarItem).toBeVisible({ timeout: 5000 });
    await sidebarItem.hover();

    // Click rename button (✎)
    const renameBtn = sidebarItem.locator('.sidebar-cat-rename');
    await expect(renameBtn).toBeVisible();
    await renameBtn.click();

    // Rename modal should appear
    const modal = page.locator('#rename-category-modal');
    await expect(modal).toHaveClass(/active/, { timeout: 3000 });

    // Input should have current name pre-filled
    const input = page.locator('#rename-category-name');
    await expect(input).toHaveValue(catName);

    // Type new name and submit
    await input.fill(newName);
    await page.click('#rename-category-submit');

    // Modal should close
    await expect(modal).not.toHaveClass(/active/, { timeout: 3000 });

    // Sidebar should show the new name
    await expect(page.locator('.sidebar-cat-item', { hasText: newName })).toBeVisible({ timeout: 5000 });
  });

  test('重命名对话框可取消', async ({ page }) => {
    const catName = `CancelRename_${Date.now()}`;

    await createCategory(page, catName);
    await closeManageModal(page);

    const sidebarItem = page.locator('.sidebar-cat-item', { hasText: catName });
    await expect(sidebarItem).toBeVisible({ timeout: 5000 });
    await sidebarItem.hover();
    await sidebarItem.locator('.sidebar-cat-rename').click();

    await expect(page.locator('#rename-category-modal')).toHaveClass(/active/);

    // Cancel
    await page.click('#rename-category-cancel');
    await expect(page.locator('#rename-category-modal')).not.toHaveClass(/active/, { timeout: 3000 });

    // Original name should remain
    await expect(page.locator('.sidebar-cat-item', { hasText: catName })).toBeVisible();
  });

  test('重命名对话框支持键盘操作', async ({ page }) => {
    const catName = `KeyRename_${Date.now()}`;
    const newName = `KeyRenamed_${Date.now()}`;

    await createCategory(page, catName);
    await closeManageModal(page);

    const sidebarItem = page.locator('.sidebar-cat-item', { hasText: catName });
    await expect(sidebarItem).toBeVisible({ timeout: 5000 });

    // Escape cancels
    await sidebarItem.hover();
    await sidebarItem.locator('.sidebar-cat-rename').click();
    await expect(page.locator('#rename-category-modal')).toHaveClass(/active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#rename-category-modal')).not.toHaveClass(/active/, { timeout: 3000 });

    // Enter confirms
    await sidebarItem.hover();
    await sidebarItem.locator('.sidebar-cat-rename').click();
    await expect(page.locator('#rename-category-modal')).toHaveClass(/active/);
    await page.locator('#rename-category-name').fill(newName);
    await page.keyboard.press('Enter');
    await expect(page.locator('#rename-category-modal')).not.toHaveClass(/active/, { timeout: 3000 });
    await expect(page.locator('.sidebar-cat-item', { hasText: newName })).toBeVisible({ timeout: 5000 });
  });

  test('分类管理弹窗中重命名按钮可用', async ({ page }) => {
    const catName = `ModalRename_${Date.now()}`;
    const newName = `ModalRenamed_${Date.now()}`;

    await createCategory(page, catName);

    // Manage modal should still be open; hover the row to reveal buttons
    const row = page.locator('.cat-tree-row', { hasText: catName });
    await expect(row).toBeVisible({ timeout: 5000 });
    await row.hover();

    const renameBtn = row.locator('.cat-tree-row-btn', { hasText: '重命名' });
    await expect(renameBtn).toBeVisible();
    await renameBtn.click();

    // Rename modal
    const modal = page.locator('#rename-category-modal');
    await expect(modal).toHaveClass(/active/, { timeout: 3000 });
    await page.locator('#rename-category-name').fill(newName);
    await page.click('#rename-category-submit');
    await expect(modal).not.toHaveClass(/active/, { timeout: 3000 });

    // Tree should update
    await expect(page.locator('.cat-tree-row', { hasText: newName })).toBeVisible({ timeout: 5000 });
  });

  test('后端 PUT 重命名接口正确', async ({ page }) => {
    const catName = `APIRename_${Date.now()}`;

    // Create via API
    const createRes = await page.evaluate(async (name) => {
      const res = await fetch('http://127.0.0.1:5055/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      return res.json();
    }, catName);

    expect(createRes.id).toBeTruthy();

    // Rename via API
    const newName = `APIRenamed_${Date.now()}`;
    const renameRes = await page.evaluate(async ({ id, name }) => {
      const res = await fetch(`http://127.0.0.1:5055/api/categories/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      return { status: res.status, body: await res.json() };
    }, { id: createRes.id, name: newName });

    expect(renameRes.status).toBe(200);
    expect(renameRes.body.name).toBe(newName);
    expect(renameRes.body.path).toBe(newName);
  });
});
