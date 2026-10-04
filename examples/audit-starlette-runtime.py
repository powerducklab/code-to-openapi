"""Execute the pinned upstream app unchanged, with only DATABASE_URL isolated.
The sample does not pin dependency versions; this probe pins a compatible runtime.
"""
import importlib.util
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from starlette.testclient import TestClient

root = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
assert commit == 'd948b7b7b076a92438f64e8f49f32dcc108bc10c', commit
with tempfile.TemporaryDirectory(prefix='starlette-native-') as tmp:
    os.environ['DATABASE_URL'] = 'sqlite:///' + str(Path(tmp) / 'contacts.db')
    os.chdir(root)
    spec = importlib.util.spec_from_file_location('upstream_starlette_app', root / 'app.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    probes = []
    def probe(client, method, path, expected, **kwargs):
        response = client.request(method, path, **kwargs)
        assert response.status_code == expected, (method, path, response.status_code, response.text)
        media = response.headers.get('content-type', '').split(';')[0]
        body = response.json() if media == 'application/json' else None
        probes.append(dict(method=method, path=path, status=response.status_code,
                           mediaType=media, body=body, input=kwargs.get('json')))
        return body
    with TestClient(module.app, raise_server_exceptions=False) as client:
        probe(client, 'GET', '/', 200)
        probe(client, 'GET', '/msg', 200)
        probe(client, 'GET', '/dt', 200)
        # Create first: the unmodified example lists a SQL table that may not yet exist.
        payload = dict(firstName='Ada', lastName='Lovelace', email='ada@example.test',
                       company='Audit', phone='123', creationTime=1)
        probe(client, 'POST', '/api/contact', 200, json=payload)
        contacts = probe(client, 'GET', '/api/contact', 200)
        assert len(contacts) == 1
        path = '/api/contact/' + str(contacts[0]['id'])
        probe(client, 'GET', path, 200)
        probe(client, 'PUT', path, 200, json=payload)
        for field in payload:
            invalid = {key: value for key, value in payload.items() if key != field}
            probe(client, 'PUT', path, 500, json=invalid)
        probe(client, 'GET', '/api/contact/999999', 200)
        probe(client, 'DELETE', path, 200)
        probe(client, 'GET', '/error', 500)
        # Verify the application's registered handler in non-debug mode too.
        module.app.debug = False
        module.app.middleware_stack = None
        probe(client, 'GET', '/error', 500)
    output = dict(repository='https://github.com/gtfisher/starlette-example-crud', commit=commit,
                  versions={name: importlib.metadata.version(name) for name in ['starlette','httpx','dataset','jinja2']},
                  probes=probes, limitations=['SQLite schema is inferred dynamically from inserted data; one observed record does not prove a fixed response DTO.',
                                             'Upstream requirements are unpinned; this is one pinned compatible runtime, not a version matrix.'])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, indent=2) + '\n')
    print(f'{len(probes)} original-handler probes passed; {out}')
