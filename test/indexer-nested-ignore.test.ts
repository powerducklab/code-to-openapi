import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProject } from '../src/core/indexer.js';

it('honors nested ignore paths, negation, siblings, and caller exclusions', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-ignore-'));
  const put = (path: string, body = '// source') => writeFileSync(join(root, path), body);
  try {
    mkdirSync(join(root, 'api', 'generated'), {recursive:true});
    mkdirSync(join(root, 'other'));
    put('.gitignore', '*.generated.ts\n');
    put('api/.gitignore', '/generated/\n!keep.generated.ts\n');
    put('api/.powerduckignore', 'private.ts\n');
    put('api/generated/routes.ts'); put('api/private.ts');
    put('api/keep.generated.ts'); put('api/drop.generated.ts'); put('api/routes.ts');
    put('other/private.ts');
    expect(indexProject(root).files.map(f=>f.path)).toEqual(['api/keep.generated.ts','api/routes.ts','other/private.ts']);
    expect(indexProject(root,{ignore:['api/keep.generated.ts']}).files.map(f=>f.path)).toEqual(['api/routes.ts','other/private.ts']);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
