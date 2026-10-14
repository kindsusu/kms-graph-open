import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProductionPaths, validatePublishDirectory } from './check-publish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false, ...extra });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 명령이 종료 코드 ${result.status}로 실패했습니다.`);
}
function npmRun(prefix, script) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) run(process.execPath, [npmCli, '--prefix', prefix, 'run', script]);
  else run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', prefix, 'run', script]);
}
try {
  const configArg = process.argv.includes('--config') ? process.argv[process.argv.indexOf('--config') + 1] : path.join(ROOT, 'config.json');
  const paths = resolveProductionPaths(configArg); // Validate every path before starting either build.
  npmRun('frontend', 'build');
  run(process.platform === 'win32' ? 'python.exe' : 'python3', ['build.py', '--config', paths.configPath, '--no-push'], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const result = validatePublishDirectory(paths.output);
  console.log(`운영 빌드 완료: ${result.output}`);
} catch (error) { console.error(`운영 빌드 실패: ${error.message}`); process.exitCode = 1; }
