const fs = require('fs');
const path = require('path');

module.exports = async function globalTeardown() {
  const pidFile = path.join(__dirname, '.backend-pid');
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    try {
      // Kill process group (detached)
      process.kill(-pid, 'SIGTERM');
    } catch (_) {
      try { process.kill(pid, 'SIGTERM'); } catch (_2) { /* already dead */ }
    }
    fs.unlinkSync(pidFile);
  }
};
