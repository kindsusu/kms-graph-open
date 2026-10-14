import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOP_LEVEL = new Set(['index.html', 'assets', '.nojekyll']);
const ADMIN_NAMES = new Set(['config.json', '.env', 'wrangler.json', 'wrangler.jsonc', 'report.json', 'snapshot.json', 'unmatched.json', 'mappings.json']);
const STATIC_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf']);

export function resolveProductionPaths(configPath = path.join(ROOT, 'config.json')) {
  const absoluteConfig = path.resolve(configPath);
  if (!fs.existsSync(absoluteConfig)) throw new Error(`운영 설정 파일이 없습니다: ${absoluteConfig}`);
  let config;
  try { config = JSON.parse(fs.readFileSync(absoluteConfig, 'utf8')); }
  catch (error) { throw new Error(`config.json을 읽을 수 없습니다: ${error.message}`); }
  if (typeof config.repo_dir !== 'string' || !config.repo_dir.trim()) throw new Error('config.json의 repo_dir이 필요합니다.');
  if (typeof config.out_subdir !== 'string' || !config.out_subdir.trim()) throw new Error('config.json의 out_subdir이 필요합니다.');
  const repo = path.resolve(config.repo_dir);
  const output = path.resolve(repo, config.out_subdir);
  if (repo !== ROOT) throw new Error(`repo_dir은 현재 저장소의 정확한 경로여야 합니다. 예상: ${ROOT}, 실제: ${repo}`);
  if (output !== path.join(ROOT, 'out')) throw new Error(`out_subdir은 이 저장소의 out을 가리켜야 합니다. 실제: ${output}`);
  return { configPath: absoluteConfig, repo, output, config };
}

function walk(directory, assetRoot) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`심볼릭 링크는 게시할 수 없습니다: ${full}`);
    if (ADMIN_NAMES.has(entry.name.toLowerCase()) || entry.name.toLowerCase().endsWith('.map')) throw new Error(`관리·내부 파일은 게시할 수 없습니다: ${full}`);
    if (stat.isDirectory()) results.push(...walk(full, assetRoot));
    else if (stat.isFile()) {
      if (assetRoot && (full === assetRoot || full.startsWith(assetRoot + path.sep)) && !STATIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        throw new Error(`허용되지 않은 정적 자산 형식입니다: ${full}`);
      }
      results.push(full);
    }
    else throw new Error(`일반 파일이 아닌 항목은 게시할 수 없습니다: ${full}`);
  }
  return results;
}

export function validatePublishDirectory(output) {
  const out = path.resolve(output);
  if (!fs.existsSync(out)) throw new Error(`게시 출력 폴더가 없습니다: ${out}`);
  const outputStat = fs.lstatSync(out);
  if (outputStat.isSymbolicLink()) throw new Error(`게시 출력 폴더 자체가 심볼릭 링크입니다: ${out}`);
  if (!outputStat.isDirectory()) throw new Error(`게시 출력 폴더가 없습니다: ${out}`);
  const top = fs.readdirSync(out);
  for (const name of top) if (!TOP_LEVEL.has(name)) throw new Error(`허용되지 않은 최상위 게시 항목: ${name}`);
  const indexPath = path.join(out, 'index.html');
  const assetsPath = path.join(out, 'assets');
  if (!fs.existsSync(indexPath) || !fs.lstatSync(indexPath).isFile()) throw new Error('게시 index.html이 없습니다.');
  if (!fs.existsSync(assetsPath) || !fs.lstatSync(assetsPath).isDirectory()) throw new Error('게시 assets 폴더가 없습니다.');
  walk(out, assetsPath);
  const html = fs.readFileSync(indexPath, 'utf8');
  if (html.includes('/*__KMS_DATA__*/')) throw new Error('index.html에 데이터 자리표시자가 남아 있습니다.');
  const match = html.match(/<script\b[^>]*\bid=["']kms-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('index.html에 kms-data가 없습니다.');
  let payload;
  try { payload = JSON.parse(match[1]); } catch (error) { throw new Error(`kms-data JSON이 올바르지 않습니다: ${error.message}`); }
  if (payload?.schemaVersion !== 2 || !Array.isArray(payload.items) || !Array.isArray(payload.relations)) throw new Error('kms-data는 items/relations를 가진 schemaVersion 2여야 합니다.');
  if (payload.isDemo === true) throw new Error('개발용 데모 데이터는 게시할 수 없습니다.');
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(?:https?:|data:|#)/i.test(ref)) continue;
    const clean = ref.split(/[?#]/, 1)[0].replace(/^\.\//, '');
    const target = path.resolve(out, clean);
    if (!target.startsWith(out + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`참조한 정적 자산이 없습니다: ${ref}`);
  }
  return { output: out, items: payload.items.length, relations: payload.relations.length, assets: walk(assetsPath, assetsPath).length };
}

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outputArg = arg('--out');
    const output = outputArg ? path.resolve(outputArg) : resolveProductionPaths(arg('--config')).output;
    const result = validatePublishDirectory(output);
    console.log(`게시 검증 통과: ${result.output} (자료 ${result.items}, 관계 ${result.relations}, 자산 ${result.assets})`);
  } catch (error) { console.error(`게시 검증 실패: ${error.message}`); process.exitCode = 1; }
}
