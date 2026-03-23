const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 5055;
const ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(ROOT, '..');

function waitForBackend(timeoutMs = 15_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error('Backend start timeout'));
      const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', () => setTimeout(poll, 300));
    };
    poll();
  });
}

module.exports = async function globalSetup() {
  const venvPython = path.join(ROOT, 'venv', 'bin', 'python3');
  const pythonPath = fs.existsSync(venvPython) ? venvPython : 'python3';

  const env = {
    ...process.env,
    PORT: String(PORT),
    PYTHONPATH: `${path.join(PROJECT_ROOT, 'src', 'biz')}:${process.env.PYTHONPATH || ''}`,
    FLASK_SERVE_STATIC: '1',
  };

  const proc = spawn(pythonPath, [path.join(ROOT, 'backend', 'server.py')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  proc.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  proc.unref();

  // Save PID for teardown
  fs.writeFileSync(path.join(__dirname, '.backend-pid'), String(proc.pid));

  await waitForBackend();
  console.log(`  Backend ready on port ${PORT}`);
};
