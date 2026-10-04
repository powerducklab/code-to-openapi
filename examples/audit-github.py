"""Reproducible static audit. Requires pre-cloned repositories at localRoot.
Never executes backend code, installs its dependencies, or sends source to AI.
Override localRoot in a copy of the manifest when using another machine.
A valid OAS is a structural check, NOT proof of complete API extraction.
"""
import json, pathlib, subprocess, sys, time
repo = pathlib.Path(__file__).resolve().parent.parent
manifest = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else repo / 'docs/audits/github-projects.json'
output = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path('/tmp/powerduck-github-audit')
output.mkdir(parents=True, exist_ok=True)
rows = []
for case in json.loads(manifest.read_text()):
    row = dict(case)
    start = time.monotonic()
    try:
        actual = subprocess.check_output(['git', '-C', case['localRoot'], 'rev-parse', 'HEAD'], text=True).strip()
        if actual != case['commit']:
            raise ValueError('Checkout does not match pinned commit')
        dest = output / (case['framework'] + '.json')
        run = subprocess.run(['node', '--max-old-space-size=1536', '--import', 'tsx',
            str(repo / 'examples/scan-audit-project.ts'), case['localRoot'], str(dest), *case.get('additionalSourceRoots', [])],
            cwd=repo, capture_output=True, text=True, timeout=90)
        if run.returncode:
            raise RuntimeError(run.stderr[-2000:])
        result = json.loads(dest.read_text())
        row.update(operations=len(result['project']['operations']), report=result['report'],
                   valid=result['valid'], ok=result['ok'])
        row['assessment'] = 'Needs source-contract comparison; schema validity is not completeness'
    except Exception as error:
        row['error'] = str(error)
    row['seconds'] = round(time.monotonic() - start, 2)
    rows.append(row)
    (output / 'summary.json').write_text(json.dumps(rows, indent=2, ensure_ascii=False))
    print(case['framework'], row.get('operations'), row.get('error', ''), flush=True)
