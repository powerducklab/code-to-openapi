"""Add native default-serialization witnesses to HTTP sample contracts.

Samples alone cannot prove non-nullability or required presence. Original DTO
serialization is independent evidence for nulls/omission. Input contracts remain
untouched; this does not turn Swagger annotations into validation evidence.
"""
import copy, json, sys
baseline = json.load(open(sys.argv[1]))
defaults = json.load(open(sys.argv[2]))
models = {'user': 'user', 'profile': 'profile', 'article': 'article', 'comment': 'comment', 'author': 'person'}
collections = {'articles': 'article', 'comments': 'comment'}

def supplement(schema, model=None):
    native = defaults.get(model) if model else None
    if isinstance(native, dict) and 'properties' in schema:
        schema['required'] = [key for key in schema.get('required', []) if key in native]
    for key, child in schema.get('properties', {}).items():
        if isinstance(native, dict) and key in native and native[key] is None and 'type' in child:
            types = child['type'] if isinstance(child['type'], list) else [child['type']]
            child['type'] = list(dict.fromkeys(types + ['null']))
        supplement(child, models.get(key))
        if key in collections and isinstance(child.get('items'), dict):
            supplement(child['items'], collections[key])

result = copy.deepcopy(baseline)
for path in result['paths'].values():
    for operation in path.values():
        for response in operation.get('responses', {}).values():
            for content in response.get('content', {}).values():
                supplement(content.get('schema', {}))
with open(sys.argv[3], 'w') as output:
    json.dump(result, output, indent=2)
