// 主应用入口
let blankManager, matchManager, historyManager, dashboardManager;

document.addEventListener('DOMContentLoaded', () => {
  // 初始化主题
  initTheme();

  // 初始化各个模块
  blankManager = new BlankManager();
  matchManager = new MatchManager();
  historyManager = new HistoryManager();
  dashboardManager = new DashboardManager();
  dashboardManager.startAutoRefresh();

  // 页面切换
  setupPageNavigation();

  // 设置按钮
  setupSettings();

  // 首次使用引导
  checkFirstTimeGuide();
});

function initTheme() {
  const saved = localStorage.getItem('theme');
  const btn = document.getElementById('theme-toggle-btn');
  if (saved === 'dark') {
    document.documentElement.dataset.theme = 'dark';
    if (btn) btn.textContent = '☀️';
  }
  if (btn) {
    btn.addEventListener('click', () => {
      const isDark = document.documentElement.dataset.theme === 'dark';
      if (isDark) {
        delete document.documentElement.dataset.theme;
        localStorage.setItem('theme', 'light');
        btn.textContent = '🌙';
      } else {
        document.documentElement.dataset.theme = 'dark';
        localStorage.setItem('theme', 'dark');
        btn.textContent = '☀️';
      }
      window.dispatchEvent(new CustomEvent('themechange'));
    });
  }
}

function setupPageNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  const pages = document.querySelectorAll('.page');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const prevPage = document.querySelector('.nav-tab.active')?.dataset.page;
      const targetPage = tab.dataset.page;

      // 更新标签状态
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // 更新页面显示
      pages.forEach(p => p.classList.remove('active'));
      document.getElementById(`${targetPage}-page`).classList.add('active');

      // 切换到匹配页面：刷新分类（粗胚管理中可能新增了分类）
      if (targetPage === 'match' && matchManager) {
        matchManager.loadCategories();
      }

      // 历史记录页面：自动刷新控制
      if (targetPage === 'history' && historyManager) {
        historyManager.startAutoRefresh();
      } else if (prevPage === 'history' && historyManager) {
        historyManager.stopAutoRefresh();
      }

      // 看板页面：自动刷新控制
      if (targetPage === 'dashboard' && dashboardManager) {
        dashboardManager.startAutoRefresh();
      } else if (prevPage === 'dashboard' && dashboardManager) {
        dashboardManager.stopAutoRefresh();
      }
    });
  });
}

function setupSettings() {
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsClose = document.getElementById('settings-close');

  settingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('active');
    loadSettings();
  });

  settingsClose.addEventListener('click', () => {
    settingsModal.classList.remove('active');
    saveSettings();
  });

  // 点击外部关闭
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      settingsModal.classList.remove('active');
      saveSettings();
    }
  });
}

function loadSettings() {
  const autosaveInterval = localStorage.getItem('autosaveInterval') || '30';
  const defaultConcurrent = localStorage.getItem('defaultConcurrent') || '2';
  const showTutorial = localStorage.getItem('showTutorial') !== 'false';

  document.getElementById('setting-autosave-interval').value = autosaveInterval;
  document.getElementById('setting-default-concurrent').value = defaultConcurrent;
  document.getElementById('setting-show-tutorial').checked = showTutorial;
}

function saveSettings() {
  const autosaveInterval = document.getElementById('setting-autosave-interval').value;
  const defaultConcurrent = document.getElementById('setting-default-concurrent').value;
  const showTutorial = document.getElementById('setting-show-tutorial').checked;

  localStorage.setItem('autosaveInterval', autosaveInterval);
  localStorage.setItem('defaultConcurrent', defaultConcurrent);
  localStorage.setItem('showTutorial', showTutorial.toString());

  // 更新匹配页面的默认并发数
  if (document.getElementById('param-concurrent-matches')) {
    document.getElementById('param-concurrent-matches').value = defaultConcurrent;
  }
}

function checkFirstTimeGuide() {
  const hasSeenGuide = localStorage.getItem('hasSeenGuide');
  const showTutorial = localStorage.getItem('showTutorial') !== 'false';

  if (!hasSeenGuide && showTutorial) {
    showTutorialGuide();
    localStorage.setItem('hasSeenGuide', 'true');
  }
}

function showTutorialGuide() {
  const steps = [
    {
      title: '欢迎使用3D模型匹配系统',
      content: '这是一个用于鞋模和粗胚智能匹配的桌面应用程序。',
      target: null
    },
    {
      title: '粗胚管理',
      content: '在"粗胚管理"页面，您可以上传、分类和管理粗胚文件。支持拖拽上传和批量操作。',
      target: '.nav-tab[data-page="blank"]'
    },
    {
      title: '鞋模匹配',
      content: '在"鞋模匹配"页面，上传鞋模文件，选择粗胚分类，配置参数后开始匹配。',
      target: '.nav-tab[data-page="match"]'
    },
    {
      title: '历史记录',
      content: '在"历史记录"页面，查看所有匹配结果，支持导出和对比功能。',
      target: '.nav-tab[data-page="history"]'
    }
  ];

  let currentStep = 0;
  const overlay = document.createElement('div');
  overlay.className = 'tutorial-overlay';
  overlay.id = 'tutorial-overlay';
  overlay.style.display = 'block';

  function showStep(stepIndex) {
    if (stepIndex >= steps.length) {
      overlay.remove();
      return;
    }

    const step = steps[stepIndex];
    overlay.innerHTML = `
      <div class="tutorial-modal">
        <div class="tutorial-content">
          <h2>${step.title}</h2>
          <p>${step.content}</p>
          <div class="tutorial-actions">
            ${stepIndex > 0 ? '<button class="btn-secondary" id="tutorial-prev">上一步</button>' : ''}
            <button class="btn-primary" id="tutorial-next">${stepIndex === steps.length - 1 ? '完成' : '下一步'}</button>
            <button class="btn-secondary" id="tutorial-skip">跳过</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // 高亮目标元素
    if (step.target) {
      const target = document.querySelector(step.target);
      if (target) {
        target.style.position = 'relative';
        target.style.zIndex = '1001';
        target.style.boxShadow = '0 0 0 4px rgba(0, 122, 255, 0.5)';
      }
    }

    overlay.querySelector('#tutorial-next').addEventListener('click', () => {
      if (step.target) {
        const target = document.querySelector(step.target);
        if (target) {
          target.style.boxShadow = '';
        }
      }
      showStep(stepIndex + 1);
    });

    if (overlay.querySelector('#tutorial-prev')) {
      overlay.querySelector('#tutorial-prev').addEventListener('click', () => {
        if (step.target) {
          const target = document.querySelector(step.target);
          if (target) {
            target.style.boxShadow = '';
          }
        }
        showStep(stepIndex - 1);
      });
    }

    overlay.querySelector('#tutorial-skip').addEventListener('click', () => {
      overlay.remove();
    });
  }

  showStep(0);
}

// 全局错误处理
window.addEventListener('error', (event) => {
  console.error('全局错误:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('未处理的Promise拒绝:', event.reason);
});
