/** Sequential isolated source-only scans; never install or execute corpus applications.
 * node examples/audit-real-corpus.mjs /tmp/powerduck-corpus-audit [framework]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const base = resolve('test-corpus/real-apis');
const manifest = JSON.parse(readFileSync(resolve(base, 'manifest.json'), 'utf8'));
const out = resolve(process.argv[2] || '/tmp/powerduck-corpus-audit');
mkdirSync(out, { recursive: true });
const rows = [];
for (const e of Object.values(manifest.frameworks).flat()) {
  if (process.argv[3] && e.framework !== process.argv[3]) continue;
  const id = `${e.framework}--${e.repo.replaceAll('/', '__')}${e.subdir ? '--' + e.subdir.replaceAll('/', '_') : ''}`;
  const file = resolve(out, id + '.json');
  const root = resolve(base, e.scanRoot);
  const started = Date.now();
  const code = `import { scanProject } from './src/index.ts'; import { writeFileSync } from 'node:fs';
    const r = await scanProject({root:process.argv[1],frameworks:[process.argv[3]],includeTests:false});
    const c = await r.convert({validate:true});
    writeFileSync(process.argv[2],JSON.stringify({report:r.report,project:r.project,document:c.document,valid:c.documentValid,diagnostics:c.diagnostics}));`;
  const run = existsSync(root) ? spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, root, file, e.framework], { encoding:'utf8', timeout:180000, maxBuffer:1024*1024 }) : null;
  let row = {id,framework:e.framework,repo:e.repo,commit:e.commit,scanRoot:e.scanRoot,ms:Date.now()-started};
  if (run?.status === 0 && existsSync(file)) {
    const data = JSON.parse(readFileSync(file,'utf8'));
    const gaps = {};
    for (const op of data.project.operations) for (const gap of op.gaps || []) gaps[gap] = (gaps[gap] || 0) + 1;
    row = {...row,status:'scanned',operations:data.project.operations.length,partial:data.report.routesPartial,valid:data.valid,gaps};
  } else row = {...row,status:run?'failed':'missing',error:String(run?.error || run?.stderr || 'missing checkout').slice(-2000)};
  rows.push(row);
  writeFileSync(resolve(out,'summary.json'),JSON.stringify(rows,null,2));
  console.log(JSON.stringify(row));
}
