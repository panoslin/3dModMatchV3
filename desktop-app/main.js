const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let backendProcess = null;
const BACKEND_PORT = 5000;

// 启动后端Python服务
function startBackend() {
  return new Promise((resolve, reject) => {
    // 在打包后的应用中，backend目录在resources目录下
    let backendPath = path.join(__dirname, 'backend', 'server.py');
    if (!fs.existsSync(backendPath) && process.resourcesPath) {
      backendPath = path.join(process.resourcesPath, 'backend', 'server.py');
    }
    
    // 检查后端文件是否存在
    if (!fs.existsSync(backendPath)) {
      const error = `后端服务文件不存在: ${backendPath}`;
      console.error(error);
      reject(new Error(error));
      return;
    }

    // 检测Python路径 - 优先使用虚拟环境
    let pythonPath = null;
    const isWin = process.platform === 'win32';
    const venvBin = isWin ? path.join('venv', 'Scripts', 'python.exe')
                          : path.join('venv', 'bin', 'python3');
    const venvPythonPath = path.join(__dirname, venvBin);
    const venvPythonPathAlt = process.resourcesPath
                              ? path.join(process.resourcesPath, venvBin)
                              : null;

    // 优先尝试虚拟环境
    if (fs.existsSync(venvPythonPath)) {
      pythonPath = venvPythonPath;
      console.log('使用虚拟环境Python:', pythonPath);
    } else if (venvPythonPathAlt && fs.existsSync(venvPythonPathAlt)) {
      pythonPath = venvPythonPathAlt;
      console.log('使用打包后的虚拟环境Python:', pythonPath);
    } else {
      // 回退到系统Python
      pythonPath = process.platform === 'win32' ? 'python' : 'python3';
      try {
        execSync(`${pythonPath} --version`, { stdio: 'ignore' });
        console.log('使用系统Python:', pythonPath);
      } catch (e) {
        try {
          execSync('python --version', { stdio: 'ignore' });
          pythonPath = 'python';
          console.log('使用系统Python (python):', pythonPath);
        } catch (e2) {
          const error = '未找到Python，请确保已安装Python 3.8+';
          console.error(error);
          reject(new Error(error));
          return;
        }
      }
    }
    
    const backendDir = path.dirname(backendPath);
    
    // 设置Python路径，包括项目根目录
    // 在打包后的应用中，src目录在resources下
    let projectRoot = path.resolve(backendDir, '..', '..');
    let srcBizPath = path.join(projectRoot, 'src', 'biz');
    
    // 检查打包后的路径
    if (!fs.existsSync(srcBizPath) && process.resourcesPath) {
      srcBizPath = path.join(process.resourcesPath, 'src', 'biz');
      projectRoot = process.resourcesPath;
    }
    
    const pythonPathEnv = [
      srcBizPath,
      backendDir,
      ...(process.env.PYTHONPATH ? process.env.PYTHONPATH.split(path.delimiter) : [])
    ].join(path.delimiter);
    
    console.log('启动后端服务...');
    console.log('后端路径:', backendPath);
    console.log('Python路径:', pythonPath);
    console.log('工作目录:', backendDir);
    
    // 设置环境变量，优先使用虚拟环境的site-packages
    const env = {
      ...process.env,
      FLASK_ENV: 'production',
      PORT: BACKEND_PORT.toString(),
      PYTHONPATH: pythonPathEnv
    };
    
    // 如果使用虚拟环境，添加 site-packages 到 PYTHONPATH
    // 注意：不设置 PYTHONHOME —— venv 通过 pyvenv.cfg 定位基础 Python 的 stdlib，
    // 设置 PYTHONHOME 会使 Python 在 venv 中找不到 encodings 等标准库模块
    if (pythonPath.includes('venv')) {
      const venvRoot = path.resolve(path.dirname(pythonPath), '..');
      // 确保清除任何可能继承的 PYTHONHOME
      delete env.PYTHONHOME;
      console.log('使用虚拟环境:', venvRoot);
      // macOS/Linux: venv/lib/pythonX.Y/site-packages
      // Windows:     venv/Lib/site-packages
      let sitePackagesPath = null;
      const winSitePkg = path.join(venvRoot, 'Lib', 'site-packages');
      if (fs.existsSync(winSitePkg)) {
        sitePackagesPath = winSitePkg;
      } else {
        const libDir = path.join(venvRoot, 'lib');
        if (fs.existsSync(libDir)) {
          const pyDirs = fs.readdirSync(libDir).filter(d => d.startsWith('python'));
          if (pyDirs.length > 0) {
            const candidate = path.join(libDir, pyDirs[0], 'site-packages');
            if (fs.existsSync(candidate)) sitePackagesPath = candidate;
          }
        }
      }
      if (sitePackagesPath) {
        env.PYTHONPATH = [sitePackagesPath, pythonPathEnv].join(path.delimiter);
        console.log('添加虚拟环境site-packages到PYTHONPATH:', sitePackagesPath);
      }
    }
    
    backendProcess = spawn(pythonPath, [backendPath], {
      cwd: backendDir,
      env: env
    });

    let backendReady = false;
    const startupTimeout = setTimeout(() => {
      if (!backendReady) {
        console.warn('后端启动超时，但继续运行...');
        resolve();
      }
    }, 10000); // 10秒超时

    backendProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`后端输出: ${output}`);
      
      // 检测后端是否已启动
      if (output.includes('启动后端服务在') || output.includes('Running on')) {
        backendReady = true;
        clearTimeout(startupTimeout);
        console.log('✅ 后端服务已启动');
        resolve();
      }
    });

    backendProcess.stderr.on('data', (data) => {
      const error = data.toString();
      console.error(`后端错误: ${error}`);
      
      // 收集所有错误信息
      if (!backendProcess.errorBuffer) {
        backendProcess.errorBuffer = '';
      }
      backendProcess.errorBuffer += error;
      
      // 某些错误信息是正常的（如警告），不一定是致命错误
      if (error.includes('Error') || error.includes('Traceback') || error.includes('ModuleNotFoundError')) {
        console.error('后端启动可能失败:', error);
      }
    });

    backendProcess.on('close', (code) => {
      console.log(`后端进程退出，代码: ${code}`);
      if (code !== 0 && code !== null) {
        const errorMsg = backendProcess.errorBuffer || `后端进程异常退出，代码: ${code}`;
        console.error('后端启动失败详情:', errorMsg);
        reject(new Error(`后端进程异常退出，代码: ${code}\n\n错误详情:\n${errorMsg.substring(0, 500)}`));
      }
    });

    backendProcess.on('error', (error) => {
      console.error('启动后端服务失败:', error);
      clearTimeout(startupTimeout);
      reject(error);
    });
  });
}

// 停止后端服务
function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#ffffff'
  });

  mainWindow.loadFile('index.html');

  // 开发模式下打开开发者工具
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    // 启动后端服务
    await startBackend();
    console.log('后端服务启动成功');
  } catch (error) {
    console.error('后端服务启动失败:', error);
    // 即使后端启动失败，也创建窗口，让用户知道问题
    const errorDetails = error.message || error.toString();
    dialog.showErrorBox(
      '后端服务启动失败',
      `无法启动后端服务：${errorDetails}\n\n请检查：\n1. Python虚拟环境是否正确\n2. 依赖包是否已安装\n3. 查看控制台日志获取详细信息\n\n应用将继续运行，但部分功能可能不可用。`
    );
  }
  
  // 创建窗口
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});

// IPC处理程序
ipcMain.handle('show-open-dialog', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

ipcMain.handle('show-save-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

ipcMain.handle('get-app-path', () => {
  return app.getPath('userData');
});

// 文件读取处理（用于Electron环境下的文件上传）
ipcMain.handle('read-file', async (event, filePath) => {
  const fs = require('fs');
  try {
    const fileBuffer = fs.readFileSync(filePath);
    return {
      success: true,
      buffer: fileBuffer,
      filename: require('path').basename(filePath)
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});
