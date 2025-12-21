const { execSync } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const port = process.env.PORT || 3000;
const platform = process.platform;

console.log(`[Kill-Port] Detected platform: ${platform}, Port: ${port}`);

try {
    if (platform === 'win32') {
        // Windows: PowerShell을 사용하여 포트 점유 프로세스 종료 (PID 0 제외)
        const command = `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`;
        execSync(command, { stdio: 'inherit' });
    } else {
        // Linux/macOS: fuser 또는 lsof 사용
        try {
            execSync(`fuser -k ${port}/tcp`, { stdio: 'inherit' });
        } catch (e) {
            // fuser가 실패할 경우 lsof + kill 시도
            execSync(`lsof -t -i:${port} | xargs kill -9`, { stdio: 'inherit' });
        }
    }
    console.log(`[Kill-Port] Successfully cleared port ${port}`);
} catch (error) {
    // 포트가 이미 비어있는 경우 에러가 발생할 수 있으므로 무시하거나 로그만 출력
    console.log(`[Kill-Port] Port ${port} is already clear or no process found to kill.`);
}
