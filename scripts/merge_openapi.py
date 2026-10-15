"""Merge the OpenAPI blocks embedded in the Pagar.me .md pages into one openapi.json.

usage: python scripts/merge_openapi.py [docs dir] [out.json]
defaults: docs/pagarme and docs/pagarme/openapi.json (relative to the project root).
Source URLs (x-doc-url) are read from <docs dir>/INDEX.md.
"""
import sys, json, re, glob, os, copy, collections

project = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(project, 'docs', 'pagarme')
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, 'openapi.json')
MAIN_SERVER = 'https://api.pagar.me/core/v5'
METHODS = ('get', 'post', 'put', 'patch', 'delete')
# when several pages define the same operation, the generic page is the base
PRIMARY = {'criar-pedido-2', 'capturar-cobranca', 'cancelar-cobranca', 'criar-assinatura-de-plano-1'}
TAGS = {
    'orders': 'Pedidos', 'charges': 'Cobranças', 'customers': 'Clientes', 'tokens': 'Tokenização',
    'hooks': 'Webhooks', 'invoices': 'Faturas', 'plans': 'Planos', 'subscriptions': 'Assinaturas',
    'recipients': 'Recebedores', 'transfers': 'Transferências', 'settlements': 'Liquidações',
    'balance': 'Saldo', 'payables': 'Recebíveis', 'paymentlinks': 'Link de Pagamento',
    'contestations': 'Marketplace (Res. 264)', 'settlement-obligations': 'Marketplace (Res. 264)',
    'settlement_obligations': 'Marketplace (Res. 264)', 'v1': 'Disputas', '{bin}': 'BIN',
}

# INDEX.md rows look like: | [name.md](section/name.md) | Title | <https://docs.pagar.me/...> |
doc_url = {}
for line in open(os.path.join(root, 'INDEX.md'), encoding='utf-8'):
    m = re.match(r'\| \[[^\]]+\]\(([^)]+)\.md\) \|.*\| <([^>]+)> \|$', line.rstrip())
    if m:
        doc_url[m.group(1)] = m.group(2)

blk = re.compile(r'^# OpenAPI definition\s*\n+```json\n(.*?)\n```', re.S | re.M)


def snake(s):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', s).lower()


def norm_path(p):
    p = p.strip()
    return re.sub(r':([A-Za-z_]+)', lambda m: '{' + snake(m.group(1)) + '}', p)


def merge(a, b, key=None):
    """Deep-merge b into a (a wins on scalar conflicts)."""
    if isinstance(a, dict) and isinstance(b, dict):
        for k, v in b.items():
            if k not in a:
                a[k] = copy.deepcopy(v)
            elif k == 'examples' and all(isinstance(x, dict) for x in (a[k], v)):
                for ek, ev in v.items():
                    if ek in a[k] and a[k][ek] == ev:
                        continue
                    nk, i = ek, 2
                    while nk in a[k]:
                        nk = f'{ek} ({i})'; i += 1
                    a[k][nk] = copy.deepcopy(ev)
            else:
                a[k] = merge(a[k], v, k)
        return a
    if isinstance(a, list) and isinstance(b, list):
        if key == 'required' and all(isinstance(x, str) for x in a + b):
            return [x for x in a if x in b]          # required only if required in every variant
        if key == 'parameters':
            seen = {(p.get('name'), p.get('in')) for p in a}
            return a + [copy.deepcopy(p) for p in b if (p.get('name'), p.get('in')) not in seen]
        if key in ('enum', 'oneOf', 'anyOf', 'tags'):
            return a + [copy.deepcopy(x) for x in b if x not in a]
        return a
    return a


def top_required(op):
    try:
        return op['requestBody']['content']['application/json']['schema'].get('required', [])
    except (KeyError, AttributeError):
        return []


components = collections.defaultdict(dict)
found = collections.defaultdict(list)        # (path, method) -> [(name, op, servers)]
for f in sorted(glob.glob(os.path.join(root, '*', '*.md'))):
    m = blk.search(open(f, encoding='utf-8').read())
    if not m:
        continue
    d = json.loads(m.group(1))
    name = os.path.relpath(f, root).replace(os.sep, '/')[:-3]
    servers = [s['url'] for s in d.get('servers', [])]
    for k, v in (d.get('components') or {}).items():
        components[k].update(v)
    for p, item in d.get('paths', {}).items():
        for meth in METHODS:
            if meth in item:
                found[(norm_path(p), meth)].append((name, item[meth], servers))

paths = {}
for (p, meth), variants in sorted(found.items()):
    variants.sort(key=lambda v: (v[0].split('/')[-1] not in PRIMARY, v[0]))
    base_name, op, servers = variants[0]
    op = copy.deepcopy(op)
    for _, other, _ in variants[1:]:
        merge(op, other)
    slug = base_name.split('/')[-1]
    op['operationId'] = slug
    seg = p.strip('/').split('/')[0]
    op['tags'] = [TAGS.get(seg, seg)]
    op['x-doc-url'] = doc_url.get(base_name)
    if len(variants) > 1:
        op['x-variants'] = [{'operationId': n.split('/')[-1], 'summary': o.get('summary'),
                             'x-doc-url': doc_url.get(n), 'required': top_required(o)}
                            for n, o, _ in variants]
    # ensure every {param} in the path is declared
    params = op.setdefault('parameters', [])
    declared = {x.get('name') for x in params if x.get('in') == 'path'}
    for pp in re.findall(r'{([^}]+)}', p):
        if pp not in declared:
            params.insert(0, {'name': pp, 'in': 'path', 'required': True, 'schema': {'type': 'string'}})
    item = paths.setdefault(p, {})
    if servers and servers != [MAIN_SERVER]:
        item['servers'] = [{'url': s} for s in servers]
    item[meth] = op

spec = {
    'openapi': '3.1.0',
    'info': {
        'title': 'Pagar.me API v5',
        'version': '5',
        'description': 'Especificação compilada a partir dos blocos "OpenAPI definition" das páginas de '
                       'https://docs.pagar.me (baixadas em 2026-10-15). Cada operação aponta para a página de origem '
                       'em `x-doc-url`; operações documentadas em várias páginas foram fundidas e listam as variantes '
                       'em `x-variants`.',
    },
    'servers': [{'url': MAIN_SERVER}],
    'security': [{'sec0': []}],
    'tags': [{'name': t} for t in dict.fromkeys(op['tags'][0] for item in paths.values()
                                                 for k, op in item.items() if k in METHODS)],
    'paths': paths,
    'components': dict(components),
}



# ReadMe stores example payloads as JSON strings; turn them into real JSON values
def parse_examples(node):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == 'examples' and isinstance(v, dict):
                for ex in v.values():
                    if isinstance(ex, dict) and isinstance(ex.get('value'), str):
                        try:
                            ex['value'] = json.loads(ex['value'])
                        except ValueError:
                            try:                     # docs often carry trailing commas
                                ex['value'] = json.loads(re.sub(r',(\s*[}\]])', r'\1', ex['value']))
                                ex['x-fixed'] = 'trailing commas removed'
                            except ValueError:
                                pass                 # pseudo-JSON in the docs: keep as text
            parse_examples(v)
    elif isinstance(node, list):
        for v in node:
            parse_examples(v)


parse_examples(spec['paths'])

# sanity checks: unique operationIds, resolvable $refs
ids = [op['operationId'] for item in paths.values() for k, op in item.items() if k in METHODS]
dupes = [i for i, n in collections.Counter(ids).items() if n > 1]
refs = set(re.findall(r'"\$ref": "#/components/([^/]+)/([^"]+)"', json.dumps(spec)))
missing = [r for r in refs if r[1] not in spec['components'].get(r[0], {})]
with open(out, 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(spec, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
print(f'paths={len(paths)} operations={len(ids)} duplicate_ids={dupes} missing_refs={missing}')
print('merged:', {f'{m.upper()} {p}': len(v) for (p, m), v in found.items() if len(v) > 1})
