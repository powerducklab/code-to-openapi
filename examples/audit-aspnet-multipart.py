"""Probe the local fixture started with dotnet run, not a production service."""
import json
import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError

cases = [('/uploads', [], 400, None),
         ('/uploads', ['avatar'], 200, []),
         ('/uploads', ['avatar', 'attachments', 'attachments'], 200, ['attachments', 'attachments']),
         ('/uploads', ['avatar', 'other'], 200, []),
         ('/uploads/optional', [], 200, None)]
rows = []
for path, fields, status, expected_files in cases:
    boundary = 'powerduck-native-probe'
    chunks = [f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nx\r\n' for field in fields]
    body = (''.join(chunks) + f'--{boundary}--\r\n').encode()
    request = Request('http://127.0.0.1:18769' + path, data=body,
                      headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
    try:
        response = urlopen(request, timeout=10)
    except HTTPError as error:
        response = error
    actual = json.loads(response.read())
    assert response.status == status, (path, fields, response.status, actual)
    if expected_files is not None:
        assert actual['attachments'] == expected_files, actual
        assert actual['photo'] == 'avatar' and actual['preview'] is None, actual
    elif status == 400:
        assert set(actual['errors']) == {'avatar'}, actual
    else:
        assert actual == {'present': False}, actual
    actual.pop('traceId', None)
    rows.append(dict(path=path, fields=fields, status=response.status, body=actual))
with open(sys.argv[1], 'w') as output:
    json.dump(rows, output, indent=2)
print(f'{len(rows)} native multipart binding probes passed')
