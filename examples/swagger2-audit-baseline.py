"""Normalize a source Swagger 2 contract for audit; never reads scan output.
Retains definitions and local refs, preserves request-body required and media.
"""
import copy, json, pathlib, sys
source = json.loads(pathlib.Path(sys.argv[1]).read_text())
doc = copy.deepcopy(source)
for path, item in doc.get('paths', {}).items():
    for method in ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']:
        op = item.get(method)
        if not op:
            continue
        parameters = []
        form_properties = {}
        form_required = []
        for parameter in op.get('parameters', []):
            if parameter.get('in') == 'body':
                op['requestBody'] = {
                    'required': parameter.get('required', False),
                    'content': {media: {'schema': parameter.get('schema', {})}
                                for media in op.get('consumes', doc.get('consumes', ['application/json']))}}
            elif parameter.get('in') == 'formData':
                schema = {key: parameter[key] for key in ['type','format','items','enum','minimum','maximum','default'] if key in parameter}
                if schema.get('type') == 'file':
                    schema = {'type':'string','format':'binary'}
                form_properties[parameter['name']] = schema
                if parameter.get('required'):
                    form_required.append(parameter['name'])
            else:
                p = copy.deepcopy(parameter)
                if 'schema' not in p:
                    p['schema'] = {key: p[key] for key in ['type','format','items','enum','minimum','maximum','default'] if key in p}
                parameters.append(p)
        if form_properties:
            schema = {'type':'object','properties':form_properties,'required':form_required}
            op['requestBody'] = {'required':bool(form_required), 'content':{media:{'schema':schema} for media in op.get('consumes',doc.get('consumes',['application/x-www-form-urlencoded']))}}
        op['parameters'] = parameters
        for response in op.get('responses', {}).values():
            if 'schema' in response:
                response['content'] = {media: {'schema': response['schema']}
                    for media in op.get('produces', doc.get('produces', ['application/json']))}
pathlib.Path(sys.argv[2]).write_text(json.dumps(doc, indent=2, ensure_ascii=False))
