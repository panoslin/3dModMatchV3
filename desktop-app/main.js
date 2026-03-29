const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let backendProcess = null;
const BACKEND_PORT = 5000;

// ── Logging ─────────────────────────────────────────────────────────────────
// Daily log files under userData/logs/, auto-purge files older than 90 days.
const LOG_RETENTION_DAYS = 90;
let logStream = null;

function initLogging() {
  const logDir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  // Purge old logs
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
    fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .forEach(f => {
        const fullPath = path.join(logDir, f);
        try {
          if (fs.statSync(fullPath).mtimeMs < cutoff) fs.unlinkSync(fullPath);
        } catch (_) { /* ignore */ }
      });
  } catch (_) { /* ignore */ }

  // Open today's log file (append mode)
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logPath = path.join(logDir, `backend-${today}.log`);
  logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const header = `\n${'='.repeat(60)}\nSession started: ${new Date().toISOString()}\n${'='.repeat(60)}\n`;
  logStream.write(header);
  console.log(`日志文件: ${logPath}`);
}

function writeLog(prefix, data) {
  const text = data.toString();
  if (logStream) {
    const ts = new Date().toISOString().slice(11, 23);
    const lines = text.split('\n').filter(l => l.length > 0);
    lines.forEach(line => logStream.write(`[${ts}] ${prefix} ${line}\n`));
  }
}

// Patch pyvenv.cfg so the bundled venv works on ANY machine.
// The build-time "home" points to the CI runner's Python — rewrite it
// to the venv's own Scripts/ (or bin/) directory on THIS machine.
function patchPyvenvCfg(venvRoot) {
  const cfgPath = path.join(venvRoot, 'pyvenv.cfg');
  const isWin = process.platform === 'win32';
  const binDir = isWin ? path.join(venvRoot, 'Scripts') : path.join(venvRoot, 'bin');

  try {
    if (!fs.existsSync(cfgPath)) {
      // Create a minimal pyvenv.cfg — Python requires it when running from a venv
      const content = `home = ${binDir}\ninclude-system-site-packages = false\n`;
      fs.writeFileSync(cfgPath, content, 'utf8');
      writeLog('INFO', `Created pyvenv.cfg: home = ${binDir}`);
      return;
    }
    const original = fs.readFileSync(cfgPath, 'utf8');
    const patched = original.replace(/^home\s*=.*/m, `home = ${binDir}`);
    if (patched !== original) {
      fs.writeFileSync(cfgPath, patched, 'utf8');
      writeLog('INFO', `Patched pyvenv.cfg: home = ${binDir}`);
    }
  } catch (err) {
    writeLog('WARN', `Failed to patch pyvenv.cfg: ${err.message}`);
  }
}

// 启动后端Python服务
function startBackend() {
  return new Promise((resolve, reject) => {
    // 在打包后的应用中，backend 作为 extraResources 在 resources 目录下（真实 FS）。
    // 优先检查 resourcesPath，避免从 app.asar 内部读取（spawn 无法执行 asar 内的脚本）。
    let backendPath = null;
    if (process.resourcesPath) {
      const resBackend = path.join(process.resourcesPath, 'backend', 'server.py');
      if (fs.existsSync(resBackend)) backendPath = resBackend;
    }
    if (!backendPath) {
      backendPath = path.join(__dirname, 'backend', 'server.py');
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

    // In packaged app, extraResources land under process.resourcesPath (real FS).
    // __dirname points inside app.asar where venv doesn't actually exist as a
    // real executable, but Electron's patched fs.existsSync can return true for
    // paths inside asar — so we must check resourcesPath FIRST.
    const venvPythonPathRes = process.resourcesPath
                              ? path.join(process.resourcesPath, venvBin)
                              : null;
    const venvPythonPathLocal = path.join(__dirname, venvBin);

    // 优先尝试 resources 目录（打包后的真实路径）
    if (venvPythonPathRes && fs.existsSync(venvPythonPathRes)) {
      pythonPath = venvPythonPathRes;
      console.log('使用打包后的虚拟环境Python:', pythonPath);
    } else if (fs.existsSync(venvPythonPathLocal)) {
      pythonPath = venvPythonPathLocal;
      console.log('使用本地虚拟环境Python:', pythonPath);
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
    writeLog('INFO', `启动后端: python=${pythonPath}, backend=${backendPath}, cwd=${backendDir}`);

    // 设置环境变量，优先使用虚拟环境的site-packages
    const env = {
      ...process.env,
      FLASK_ENV: 'production',
      PORT: BACKEND_PORT.toString(),
      PYTHONPATH: pythonPathEnv
    };
    
    // 如果使用虚拟环境，配置 Python 环境变量
    if (pythonPath.includes('venv')) {
      const venvRoot = path.resolve(path.dirname(pythonPath), '..');
      console.log('使用虚拟环境:', venvRoot);

      // pyvenv.cfg's "home" was written at build time on the CI machine.
      // Rewrite it to point to this machine's actual venv Scripts/bin dir.
      patchPyvenvCfg(venvRoot);

      // PYTHONHOME tells the interpreter where to find Lib/ and DLLs/.
      env.PYTHONHOME = venvRoot;
      delete env.PYTHONUSERBASE; // prevent user site-packages interference
      console.log('设置 PYTHONHOME:', venvRoot);

      // Add site-packages to PYTHONPATH
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
    
    writeLog('INFO', `PYTHONHOME=${env.PYTHONHOME || '(unset)'}`);
    writeLog('INFO', `PYTHONPATH=${env.PYTHONPATH || '(unset)'}`);

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
      writeLog('OUT', output);

      // 检测后端是否已启动
      if (output.includes('启动后端服务在') || output.includes('Running on')) {
        backendReady = true;
        clearTimeout(startupTimeout);
        console.log('✅ 后端服务已启动');
        writeLog('INFO', '后端服务已启动');
        resolve();
      }
    });

    backendProcess.stderr.on('data', (data) => {
      const error = data.toString();
      console.error(`后端错误: ${error}`);
      writeLog('ERR', error);

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
      writeLog('INFO', `后端进程退出，代码: ${code}`);
      if (code !== 0 && code !== null) {
        const errorMsg = backendProcess.errorBuffer || `后端进程异常退出，代码: ${code}`;
        console.error('后端启动失败详情:', errorMsg);
        writeLog('FATAL', errorMsg);
        reject(new Error(`后端进程异常退出，代码: ${code}\n\n错误详情:\n${errorMsg.substring(0, 500)}`));
      }
    });

    backendProcess.on('error', (error) => {
      console.error('启动后端服务失败:', error);
      writeLog('FATAL', `spawn error: ${error.message}`);
      clearTimeout(startupTimeout);
      reject(error);
    });
  });
}

// 停止后端服务
function stopBackend() {
  if (backendProcess) {
    if (process.platform === 'win32') {
      // On Windows, child.kill() sends SIGTERM which Python ignores.
      // Use taskkill to forcefully terminate the process tree.
      try {
        execSync(`taskkill /pid ${backendProcess.pid} /T /F`, { stdio: 'ignore' });
      } catch (_) { /* already exited */ }
    } else {
      backendProcess.kill();
    }
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
  // Initialize daily log file (purge files > 90 days old)
  initLogging();

  try {
    // 启动后端服务
    await startBackend();
    console.log('后端服务启动成功');
  } catch (error) {
    console.error('后端服务启动失败:', error);
    writeLog('FATAL', `启动失败: ${error.message || error}`);
    // 即使后端启动失败，也创建窗口，让用户知道问题
    const logDir = path.join(app.getPath('userData'), 'logs');
    const errorDetails = error.message || error.toString();
    dialog.showErrorBox(
      '后端服务启动失败',
      `无法启动后端服务：${errorDetails}\n\n请检查：\n1. Python虚拟环境是否正确\n2. 依赖包是否已安装\n3. 查看日志目录获取详细信息:\n   ${logDir}\n\n应用将继续运行，但部分功能可能不可用。`
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
  if (logStream) {
    writeLog('INFO', '应用退出');
    logStream.end();
    logStream = null;
  }
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
