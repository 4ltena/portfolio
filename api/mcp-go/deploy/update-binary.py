#!/usr/bin/env python3
"""Replace only a known MCP binary; retain the previous release for rollback."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True).stdout.strip()


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def sources():
    root = Path('/usr/share/nginx/html/portfolio')
    return {name: digest(root / name) for name in (
        'index.html', 'myworks.html', 'terminal/profile.txt',
        'api/data/portfolio.db', 'api/server.js', 'admin/editor.html')}


def swap(current, target):
    temporary = current.with_name('current-update-' + uuid.uuid4().hex)
    try:
        temporary.symlink_to(target)
        os.replace(temporary, current)
    finally:
        temporary.unlink(missing_ok=True)


def public_lists():
    counts = {}
    for kind in ('notes', 'works', 'skills', 'timeline'):
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                           'params': {'name': 'list_public_content',
                                      'arguments': {'kind': kind, 'limit': 50}}}).encode()
        request = urllib.request.Request('http://127.0.0.1:3318/mcp', data=body,
            headers={'Content-Type': 'application/json',
                     'Accept': 'application/json, text/event-stream',
                     'MCP-Protocol-Version': '2025-11-25'})
        with urllib.request.urlopen(request, timeout=8) as response:
            result = json.loads(response.read(5 * 1024 * 1024))
        envelope = result.get('result', {})
        data = envelope.get('structuredContent', {})
        if envelope.get('isError') or data.get('schema_version') != 1 or not isinstance(data.get('items'), list):
            raise RuntimeError('A public list failed validation')
        counts[kind] = len(data['items'])
    return counts


def main():
    if os.geteuid() != 0 or len(sys.argv) != 4:
        raise RuntimeError('Invalid update invocation')
    stage = Path(sys.argv[1]).resolve(strict=True)
    expected, previous = sys.argv[2:]
    if stage.parent != Path('/home/rocky') or not stage.name.startswith('portfolio-mcp-'):
        raise RuntimeError('Invalid staging path')
    if not all(re.fullmatch(r'[0-9a-f]{64}', value) for value in (expected, previous)):
        raise RuntimeError('Invalid binary hash')
    current = Path('/opt/portfolio-mcp/current')
    releases = Path('/opt/portfolio-mcp/releases')
    if not current.is_symlink():
        raise RuntimeError('Current release is not a symlink')
    old = current.resolve(strict=True)
    if old.parent != releases or digest(old / 'portfolio-mcp') != previous:
        raise RuntimeError('Current release differs from the inspected binary')
    if digest(stage / 'portfolio-mcp') != expected:
        raise RuntimeError('Staged binary hash mismatch')
    if run('systemctl', 'show', 'portfolio-mcp.service', '-p', 'FragmentPath', '--value') != '/etc/systemd/system/portfolio-mcp.service':
        raise RuntimeError('Unexpected service unit')
    if run('systemctl', 'is-active', 'portfolio-mcp.service') != 'active':
        raise RuntimeError('MCP service is not active')
    if run('systemctl', 'is-active', 'portfolio-api.service') != 'active':
        raise RuntimeError('Existing API is not active')
    api_pid = run('systemctl', 'show', 'portfolio-api.service', '-p', 'MainPID', '--value')
    before = sources()
    backup = stage / 'update-backup'
    backup.mkdir(mode=0o700)
    os.chown(backup, 0, 0)
    (backup / 'before.json').write_text(json.dumps({'previous_release': str(old), 'api_pid': api_pid, 'sources': before}, indent=2))
    release = releases / stage.name
    release.mkdir(mode=0o755)
    binary = release / 'portfolio-mcp'
    shutil.copyfile(stage / 'portfolio-mcp', binary)
    os.chmod(binary, 0o755)
    if digest(binary) != expected:
        raise RuntimeError('Installed binary hash mismatch')
    run('restorecon', '-R', str(release))
    swapped = False
    try:
        if current.resolve(strict=True) != old:
            raise RuntimeError('Current release changed during update')
        swap(current, release)
        swapped = True
        run('systemctl', 'restart', 'portfolio-mcp.service')
        for attempt in range(20):
            try:
                counts = public_lists()
                break
            except Exception:
                if attempt == 19:
                    raise RuntimeError('MCP public data readiness failed') from None
                time.sleep(0.3)
        run('nginx', '-t')
        if sources() != before:
            raise RuntimeError('A protected source changed during update')
        if run('systemctl', 'show', 'portfolio-api.service', '-p', 'MainPID', '--value') != api_pid:
            raise RuntimeError('Existing API restarted during update')
        result = {'update': 'ok', 'release': str(release), 'binary_sha256': expected,
                  'previous_release': str(old), 'api_pid': api_pid,
                  'sources_unchanged': True, 'public_counts': counts}
        (stage / 'update-result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    except Exception:
        if swapped:
            swap(current, old)
            run('systemctl', 'restart', 'portfolio-mcp.service')
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('MCP binary update failed; inspect the staged recovery metadata.', file=sys.stderr)
        sys.exit(1)
