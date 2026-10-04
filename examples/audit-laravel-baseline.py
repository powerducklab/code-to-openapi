"""Route-only baseline from the native Laravel router, never scanner output.

Koel's optional nonterminal parameters are recorded in normalized template form;
implicit HEAD aliases and optional-parameter omission paths are not scored here.
"""
import json, re, sys
rows = json.load(open(sys.argv[1]))
paths = {}
for row in rows:
    path = re.sub(r'\{([^}?]+)\?\}', r'{\1}', row['path'])
    for method in row['methods']:
        if method == 'HEAD':
            continue
        paths.setdefault(path, {})[method.lower()] = {
            'parameters': [{'name': name, 'in': 'path', 'required': True, 'schema': {'type': 'string'}}
                           for name in re.findall(r'\{([^}]+)\}', path)],
            'responses': {},
        }
# Independently transcribed original rules, confirmed with the native validator.
def body(path, properties, required):
    paths[path]['post']['requestBody'] = {'required': bool(required), 'content': {'application/json': {
        'schema': {'type': 'object', 'properties': properties, 'required': required}}}}
body('/api/ai/prompt', {'prompt': {'type': 'string', 'minLength': 1, 'maxLength': 500},
     **{key: {'type': ['string', 'null']} for key in ['current_song_id', 'current_radio_station_id', 'conversation_id']}}, ['prompt'])
body('/api/upload/complete', {'key': {'type': 'string', 'minLength': 1}}, ['key'])
paths['/api/invitations']['get']['parameters'] = [{'name': 'token', 'in': 'query', 'required': True, 'schema': {'type': 'string', 'minLength': 1}}]
paths['/api/browse/songs']['get']['parameters'] = [{'name': key, 'in': 'query', 'required': False, 'schema': {'type': ['string', 'null']}} for key in ['cursor', 'folder']]
with open(sys.argv[2], 'w') as output:
    json.dump({'openapi': '3.2.0', 'info': {'title': 'Native Koel Laravel route baseline', 'version': '1'}, 'paths': paths}, output, indent=2)
