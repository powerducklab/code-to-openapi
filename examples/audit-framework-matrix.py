"""Reproduce pinned real-project scans without equating fixture agreement to accuracy.

No dependencies are installed, repositories modified or baselines regenerated.
Use --strict-contracts to additionally fail on recorded upstream discrepancies.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time

BASE = Path(__file__).resolve().parents[1]


def execute(command, cwd=BASE, timeout=120):
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{command[0]} exited {result.returncode}: {result.stderr[-2000:]}')
    return result.stdout


def verify(project):
    root = Path(project['localRoot'])
    actual = execute(['git', 'rev-parse', 'HEAD'], cwd=root).strip()
    if actual != project['commit']:
        raise RuntimeError(f'Unexpected sample commit: {actual}; expected {project["commit"]}')
    return bool(execute(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=root).strip())


def scan(project, target):
    execute(['node', '--import', 'tsx', 'examples/scan-audit-project.ts', project['localRoot'], str(target), *project.get('additionalSourceRoots', [])])
    return json.loads(target.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=BASE / 'docs/audits/2026-10-04-response-contracts/projects.json')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--framework', action='append')
    parser.add_argument('--strict-contracts', action='store_true')
    args = parser.parse_args()
    projects = json.loads(args.manifest.read_text())
    if args.framework:
        unknown = set(args.framework) - {p['framework'] for p in projects}
        if unknown:
            parser.error(f'Unknown frameworks: {sorted(unknown)}')
        projects = [p for p in projects if p['framework'] in args.framework]
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output.resolve()
    results = []
    for project in projects:
        framework = project['framework']
        start = time.monotonic()
        row = {**project, 'independentContract': 'partial'}
        try:
            row['trackedSampleChanges'] = verify(project)
            target = output / f'{framework}.json'
            data = scan(project, target)
            row.update(valid=data['valid'], operations=len(data['project']['operations']), unresolved=len(data['project']['unresolved']))
            if not row['valid']:
                raise RuntimeError('Scanner produced invalid OpenAPI')
            comparison = project.get('comparisonProject')
            if comparison:
                row['trackedComparisonChanges'] = verify(comparison)
                target = output / f'{framework}-comparison.json'
                compared = scan(comparison, target)
                if not compared['valid']:
                    raise RuntimeError('Comparison project produced invalid OpenAPI')
            baseline = BASE / project['baseline']
            row['baselineSha256'] = hashlib.sha256(baseline.read_bytes()).hexdigest()
            report = output / f'{framework}-result.json'
            ledger = BASE / 'docs/audits/2026-10-04-response-contracts/baseline-errors.json'
            compare_cmd = ['node', '--import', 'tsx', 'examples/audit-contracts.ts', str(baseline), str(target), str(report), project.get('pathPrefix', '')]
            if ledger.exists():
                compare_cmd += [str(ledger), framework]
            execute(compare_cmd)
            contract = json.loads(report.read_text())
            sc = contract.get('scorecard', {})
            row.update(assertions=contract['assertions'], mismatches=contract['mismatches'],
                       unknown=contract.get('unknown', 0), baselineErrors=len(contract.get('baselineErrors', [])),
                       overall=sc.get('overall'), pass95=sc.get('pass95'),
                       routeRecall=sc.get('routeRecall'), routePrecision=sc.get('routePrecision'),
                       responseCompleteness=sc.get('responseCompleteness'),
                       requestCompleteness=sc.get('requestCompleteness'),
                       unresolvedRatio=sc.get('unresolvedRatio'))
        except Exception as error:
            row['error'] = str(error)
        row['elapsedSeconds'] = round(time.monotonic() - start, 2)
        results.append(row)
        (output / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
        print(framework, row.get('operations'), row.get('assertions'), row.get('mismatches'), row.get('error', ''), flush=True)
    return int(any(row.get('error') or (args.strict_contracts and row.get('mismatches')) for row in results))


if __name__ == '__main__':
    raise SystemExit(main())
