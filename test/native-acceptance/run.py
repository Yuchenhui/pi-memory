#!/usr/bin/env python3
"""Offline native loader acceptance; retains all NTFS artifacts, never touches deployed memory."""
import base64, datetime, hashlib, json, os, pathlib, shutil, subprocess, sys, time, uuid
REPO = pathlib.Path(__file__).resolve().parents[2]
ROOT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path('/mnt/c/Users/Marshall/.pi/stress') / ('phase3-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
assert ROOT.parent == pathlib.Path('/mnt/c/Users/Marshall/.pi/stress') and ROOT.name.startswith('phase3-')
ROOT.mkdir(parents=True, exist_ok=True)
ATTEMPT = str(len(list(ROOT.glob('summary*.json'))) + 1)
(ROOT / 'DISPOSABLE-ACCEPTANCE.txt').write_text('Disposable native acceptance. Retain evidence; not a real memory directory.\n')
shutil.copy2(REPO / 'index.ts', ROOT / 'index.ts')
shutil.copy2(pathlib.Path(__file__).with_name('driver.mjs'), ROOT / 'driver.mjs')
HASH = hashlib.sha256((ROOT / 'index.ts').read_bytes()).hexdigest()
assert HASH == hashlib.sha256((REPO / 'index.ts').read_bytes()).hexdigest()
PS = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
NODE_WIN = r'C:\Program Files\nodejs\node.exe'
summary = {'root': str(ROOT), 'sourceHash': HASH, 'checks': [], 'errors': [], 'skipped': ['Native qmd query (offline unit fixtures only)', 'Paid classifier/LLM hooks', 'Automatic exit/compact summary hooks requiring LLM']}
sequence = len(list(ROOT.glob('request-*.json')))

def win(p):
    return 'C:\\' + str(p).removeprefix('/mnt/c/').replace('/', '\\')

def context(endpoint, different=False):
    return win(ROOT / ('workspace-other' if different else 'workspace') / 'same-name') if endpoint == 'windows' else str(ROOT / ('workspace-other' if different else 'workspace') / 'same-name')

def prepare(endpoint, store, operations=None, **extra):
    global sequence
    sequence += 1
    req = ROOT / f'request-{sequence}-{endpoint}.json'
    output = ROOT / f'output-{sequence}-{endpoint}.json'
    native = win if endpoint == 'windows' else str
    data = dict(store=native(store), extension=native(ROOT / 'index.ts'), agent=r'C:\Users\Marshall\.pi\agent' if endpoint == 'windows' else '/home/myu/.pi/agent', cwd=context(endpoint), output=native(output), operations=operations or [], **extra)
    req.write_text(json.dumps(data))
    if endpoint == 'windows':
        quote = lambda s: "'" + str(s).replace("'", "''") + "'"
        script = ROOT / f'launch-{sequence}.ps1'
        script.write_text('& ' + quote(NODE_WIN) + ' ' + quote(win(ROOT / 'driver.mjs')) + ' ' + quote(win(req)) + '\nexit $LASTEXITCODE\n', encoding='ascii')
        command = [PS, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', win(script)]
    else:
        command = ['node', str(ROOT / 'driver.mjs'), str(req)]
    return command, output

def run(endpoint, store, ops):
    cmd, output = prepare(endpoint, store, ops)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    (output.with_suffix('.console.txt')).write_text(result.stdout + result.stderr)
    assert result.returncode == 0, f'{endpoint} loader failure: {result.stdout} {result.stderr}'
    report = json.loads(output.read_text())
    assert report['source'] == endpoint and report['hash'] == HASH
    return report

def tool(name, params, contains=(), excludes=(), **extra):
    return dict(tool=name, params=params, contains=list(contains), excludes=list(excludes), **extra)

def read(contains=(), excludes=(), inspect=False, **extra):
    return tool('memory_read', dict(target='long_term', inspect=inspect), contains, excludes, **extra)

def frames(file):
    # Independent direct-byte length parser: no previews, no line/UTF-16 truncation assumptions.
    data = file.read_bytes()
    import re
    result = []
    offset = 0
    pattern = re.compile(rb'<!-- pi-memory-record:v1:([A-Za-z0-9_-]+):(\d+) -->\r?\n')
    while True:
        match = pattern.search(data, offset)
        if not match:
            assert b'<!-- pi-memory-record:' not in data[offset:], 'malformed trailing frame'
            break
        assert b'<!-- pi-memory-record:' not in data[offset:match.start()], 'malformed intervening frame'
        length = int(match[2]); end = match.end() + length
        assert end <= len(data), 'torn frame'
        metadata = json.loads(base64.urlsafe_b64decode(match[1] + b'=' * (-len(match[1]) % 4)))
        content = data[match.end():end].decode('utf8')
        result.append((metadata, content, data[match.start():end]))
        offset = end
    return result

try:
    store = ROOT / ('store-' + ATTEMPT); store.mkdir()
    legacy = b'legacy-secret\r\nexact untouched legacy \xe9\x9b\xaa\r\n'
    (store / 'MEMORY.md').write_bytes(legacy)
    for endpoint in ['windows', 'wsl']:
        other = 'wsl' if endpoint == 'windows' else 'windows'
        runtime = 'Runtime executable C:\\native\\only.exe windows-private' if endpoint == 'windows' else 'Runtime executable /home/native/only wsl-private'
        report = run(endpoint, store, [
            tool('memory_write', {'target':'long_term','content':f'I prefer concise answers shared-{endpoint}','scope':'shared','source':other}, contains=[endpoint, 'shared']),
            tool('memory_write', {'target':'long_term','content':runtime,'scope':'shared'}, contains=[endpoint, 'source-local scope']),
            tool('memory_write', {'target':'long_term','content':f'project-private-{endpoint}','scope':'project'}),
            read([f'shared-{endpoint}', f'{endpoint}-private'], ['legacy-secret', f'{other}-private', f'project-private-{other}']),
            read([f'shared-{endpoint}'], [f'project-private-{endpoint}'], cwd=context(endpoint, True)),
            read(['WARNING', 'legacy-secret', '[source:'], inspect=True),
        ])
        dangerous = report['results'][1]['result']
        assert dangerous['details']['scope'] in ['environment', 'project']
        assert len(dangerous['content'][0]['text']) > len('Appended to MEMORY.md [source: windows | scope: environment].')
    run('windows', store, [read(['shared-wsl'], ['wsl-private','legacy-secret','project-private-wsl'])])
    run('wsl', store, [read(['shared-windows'], ['windows-private','legacy-secret','project-private-windows'])])
    summary['checks'].append('Both native sources; same canonical store; bidirectional shared reads; runtime narrowing; project cwd isolation; legacy inspect warnings')
    for endpoint in ['windows', 'wsl']:
        run(endpoint, store, [tool('memory_write', {'target':'long_term', 'content':f'unrelated-project-{endpoint}', 'scope':'project'}, cwd=context(endpoint, True))])
    for endpoint in ['windows', 'wsl']:
        other = 'wsl' if endpoint == 'windows' else 'windows'
        before = frames(store / 'MEMORY.md')
        protected = [raw for meta, content, raw in before if (meta['scope'] != 'shared' and meta['source'] == other) or content.startswith('unrelated-project-')]
        run(endpoint, store, [
            tool('memory_write', {'target':'long_term','content':f'replacement-{endpoint}','mode':'overwrite','scope':'environment'}),
            tool('memory_forget', {'match':f'{other}-private','inspect':True}),
            tool('memory_forget', {'match':f'replacement-{endpoint}'}),
            tool('memory_restore', {'recoveryId':'$last'}),
            tool('memory_restore', {'recoveryId':'$last'}),
        ])
        data = (store / 'MEMORY.md').read_bytes()
        assert data.startswith(legacy) and all(raw in data for raw in protected)
        restored = next(meta for meta, body, raw in frames(store / 'MEMORY.md') if body == f'replacement-{endpoint}')
        assert restored['source'] == endpoint and restored['scope'] == 'environment'
    summary['checks'].append('Both endpoints overwrite/forget/inspect mutation/restore/idempotence preserve foreign and exact legacy bytes')
    # A real Windows recovery is denied on WSL, with original provenance retained.
    report = run('windows', store, [tool('memory_forget', {'match':'replacement-windows'})])
    recovery = report['results'][0]['result']['details']['recoveryId']
    unchanged = (store / 'MEMORY.md').read_bytes()
    run('wsl', store, [tool('memory_restore', {'recoveryId':recovery}, expectError=True)])
    assert (store / 'MEMORY.md').read_bytes() == unchanged
    run('windows', store, [tool('memory_restore', {'recoveryId':recovery})])
    summary['checks'].append('Actual foreign recovery denied; original endpoint restores original frame')
    # Separate fixture within the same marked tree; still a single store shared by both endpoints.
    scratch = ROOT / ('scratch-store-' + ATTEMPT); scratch.mkdir()
    (scratch / 'SCRATCHPAD.md').write_bytes(legacy)
    for endpoint in ['windows','wsl']:
        run(endpoint, scratch, [tool('scratchpad', {'action':'add','text':f'local-task-{endpoint}','scope':'environment'}), tool('scratchpad', {'action':'add','text':f'project-task-{endpoint}','scope':'project'}), tool('scratchpad', {'action':'add','text':f'shared-task-{endpoint}','scope':'shared'})])
    for endpoint in ['windows','wsl']:
        other = 'wsl' if endpoint == 'windows' else 'windows'
        protected = [raw for meta, content, raw in frames(scratch / 'SCRATCHPAD.md') if meta['source'] == other and meta['scope'] != 'shared']
        run(endpoint, scratch, [
            tool('scratchpad', {'action':'list'}, contains=[f'local-task-{endpoint}'], excludes=[f'local-task-{other}','legacy-secret']),
            tool('scratchpad', {'action':'list','inspect':True}, contains=['WARNING',f'project-task-{other}','legacy-secret']),
            tool('scratchpad', {'action':'done','text':f'project-task-{other}','inspect':True}, contains=['No applicable']),
            tool('scratchpad', {'action':'done','text':f'local-task-{endpoint}'}),
            tool('scratchpad', {'action':'undo','text':f'local-task-{endpoint}'}),
            tool('scratchpad', {'action':'done','text':f'local-task-{endpoint}'}),
            tool('scratchpad', {'action':'done','text':f'shared-task-{endpoint}'}),
            tool('scratchpad', {'action':'clear_done'}),
        ])
        data = (scratch / 'SCRATCHPAD.md').read_bytes()
        assert data.startswith(legacy) and all(raw in data for raw in protected)
    summary['checks'].append('Native scratchpad list/inspect/done/undo/clear_done preserve foreign/project and legacy exact bytes')
    hooks = ROOT / ('hook-store-' + ATTEMPT); hooks.mkdir()
    (hooks / 'MEMORY.md').write_bytes(legacy)
    for endpoint in ['windows','wsl']:
        run(endpoint, hooks, [tool('memory_write', {'target':'long_term','content':f'foreign-hook-secret-{endpoint}','scope':'environment'})])
    for endpoint in ['wsl','windows']:
        run(endpoint, hooks, [
            tool('memory_write', {'target':'long_term','content':'hook-one','scope':'shared','mode':'overwrite'}),
            {'hook':True, 'contains':['hook-one'], 'excludes':['legacy-secret', 'foreign-hook-secret-windows' if endpoint == 'wsl' else 'foreign-hook-secret-wsl']},
            {'replaceExternal':True},
            {'hook':True, 'contains':['hook-two'], 'excludes':['hook-one','legacy-secret']},
            tool('memory_write', {'target':'long_term','content':f'hook-project-{endpoint}','scope':'project'}),
            {'hook':True, 'contains':[f'hook-project-{endpoint}']},
            {'hook':True, 'cwd':context(endpoint, True), 'contains':['hook-two'], 'excludes':[f'hook-project-{endpoint}', 'legacy-secret']},
        ])
    summary['checks'].append('Real before_agent_start hooks recheck other-process same-size restored-mtime replacement on both native endpoints')
    project = ROOT / ('project-id-store-' + ATTEMPT); project.mkdir()
    for endpoint in ['windows', 'wsl']:
        cmd, output = prepare(endpoint, project, [tool('memory_write', {'target':'long_term', 'content':f'id-private-{endpoint}', 'scope':'project'})], projectId='common-explicit-id')
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stdout + result.stderr
    for endpoint in ['windows', 'wsl']:
        other = 'wsl' if endpoint == 'windows' else 'windows'
        cmd, output = prepare(endpoint, project, [read([f'id-private-{endpoint}'], [f'id-private-{other}'])], projectId='common-explicit-id')
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stdout + result.stderr
    summary['checks'].append('Common explicit project ID does not broaden cross-endpoint applicability')
    stress = ROOT / ('stress-store-' + ATTEMPT); stress.mkdir()
    start = int(time.time()*1000) + 18000
    jobs = []
    reader_jobs = []
    for endpoint in ['windows','wsl']:
        cmd, output = prepare(endpoint, stress, reader=10000, startAt=start)
        log = output.with_suffix('.console.txt').open('w')
        reader_jobs.append((subprocess.Popen(cmd, stdout=log, stderr=log), output, log))
    for endpoint in ['windows','wsl']:
        for i in range(4):
            cmd, output = prepare(endpoint, stress, writer=f'{endpoint}-{i}', count=25, startAt=start)
            log = output.with_suffix('.console.txt').open('w')
            jobs.append((subprocess.Popen(cmd, stdout=log, stderr=log), output, log))
    reads = 0; sharing_errors = []; corruption = []
    while any(p.poll() is None for p, _, _ in jobs):
        for file in (stress / 'daily').glob('*.md') if (stress / 'daily').exists() else []:
            try:
                frames(file); reads += 1
            except OSError as e:
                sharing_errors.append(str(e))
            except Exception as e:
                corruption.append(str(e))
        time.sleep(.01)
    for p, output, log in jobs:
        log.close(); assert p.returncode == 0, output.with_suffix('.console.txt').read_text()
        report = json.loads(output.read_text()); assert report['ok'] == report['attempted'] == 25 and report['hash'] == HASH
    native_readers = []
    for p, output, log in reader_jobs:
        p.wait(timeout=30); log.close()
        assert p.returncode == 0, output.with_suffix('.console.txt').read_text()
        report = json.loads(output.read_text())
        assert report['completeReads'] > 0 and not report['corruptions'] and report['hash'] == HASH
        native_readers.append({key:report[key] for key in ['source','completeReads','sharingErrors','corruptions']})
    records = [entry for file in (stress / 'daily').glob('*.md') for entry in frames(file)]
    expected = {f'ACCEPT-{endpoint}-{i}-{j}' for endpoint in ['windows','wsl'] for i in range(4) for j in range(25)}
    landed = {content for _,content,_ in records}
    assert len(records) == 200 and landed == expected
    counts = {endpoint: sum(meta['source'] == endpoint for meta,_,_ in records) for endpoint in ['windows','wsl']}
    assert counts == {'windows':100, 'wsl':100}
    assert all(meta['scope'] == 'shared' for meta,_,_ in records)
    residue = [str(p) for p in stress.rglob('*') if '.lock' in p.name or '.tmp' in p.name]
    assert not residue and not corruption
    summary['stress'] = dict(expected=200, landed=len(records), sourceCounts=counts, completeReaderProbes=reads, nativeReaders=native_readers, sharingErrors=sharing_errors, corruptions=corruption, residue=residue)
    summary['checks'].append('8 simultaneous native loader writers x25=200; source 100/100; exact unique set; direct byte framing reader no torn frames; no lock/temp residue')
except Exception as e:
    import traceback
    summary['errors'].append(traceback.format_exc())
finally:
    summary['currentSourceHash'] = hashlib.sha256((REPO / 'index.ts').read_bytes()).hexdigest()
    summary['sourceUnchanged'] = summary['currentSourceHash'] == HASH
    (ROOT / ('summary-' + ATTEMPT + '.json')).write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    print('EVIDENCE_ROOT=' + str(ROOT))
if summary['errors']:
    raise SystemExit(1)
