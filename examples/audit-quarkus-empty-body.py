"""Independent empty/null entity probes against the pinned Quarkus sample.
Start the original app with an isolated in-memory set on localhost:18764 first.
"""
import json
import urllib.error
import urllib.request
from pathlib import Path
import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
results = []
for method in ['POST', 'DELETE']:
    for payload in [b'', b'null', b'{}']:
        request = urllib.request.Request('http://127.0.0.1:18764/example_model', data=payload, method=method, headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                status, body = response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            status, body = error.code, error.read().decode()
        results.append({'method': method, 'input': payload.decode(), 'status': status, 'body': body})
        args.output.write_text(json.dumps({'commit': '87ba422a85a7f732f567f955f3406cf992b44f83', 'probes': results}, indent=2) + '\n')
        assert status == 200, (method, payload, status)
print(f'{len(results)} native entity presence probes passed')
