// OrbitControls加载器 - 使用ES模块方式
(async function() {
  if (typeof THREE === 'undefined') {
    console.warn('Three.js未加载，无法加载OrbitControls');
    return;
  }

  try {
    // 使用动态导入加载OrbitControls
    const { OrbitControls } = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js');
    
    // 将OrbitControls挂载到全局，以便3d-viewer.js使用
    window.OrbitControls = OrbitControls;
    
    // 触发加载完成事件
    window.dispatchEvent(new CustomEvent('orbitcontrols-loaded', { detail: OrbitControls }));
    
    console.log('OrbitControls加载成功');
  } catch (error) {
    console.warn('OrbitControls加载失败，将使用简单控制:', error);
    window.dispatchEvent(new CustomEvent('orbitcontrols-failed', { detail: error }));
  }
})();
