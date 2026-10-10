#!/usr/bin/env python3
"""Install the staged readonly MCP; restore only its own additions on failure."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request


def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def install_config(source, target):
    fd, filename = tempfile.mkstemp(prefix='.portfolio-mcp-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(source.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(filename, 0o644)
        os.replace(filename, target)
    finally:
        Path(filename).unlink(missing_ok=True)


def probe(url, body=None, headers=None):
    request = urllib.request.Request(url, data=body, headers=headers or {})
    with urllib.request.urlopen(request, timeout=8) as response:
        return response.status, response.read(128 * 1024)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 3:
        raise RuntimeError("Invalid deployment invocation")
    stage = Path(sys.argv[1]).resolve()
    expected = sys.argv[2]
    if stage.parent != Path('/home/rocky') or not stage.name.startswith('portfolio-mcp-'):
        raise RuntimeError('Invalid staging path')
    if digest(stage / 'portfolio-mcp') != expected:
        raise RuntimeError('Staged binary hash mismatch')

    root = Path('/usr/share/nginx/html/portfolio')
    targets = {
        'portfolio-mcp.service': Path('/etc/systemd/system/portfolio-mcp.service'),
        'portfolio-mcp-rate.conf': Path('/etc/nginx/conf.d/portfolio-mcp-rate.conf'),
        'portfolio-mcp-location.conf': Path('/etc/nginx/default.d/portfolio-mcp-location.conf'),
    }
    current = Path('/opt/portfolio-mcp/current')
    if current.exists() or current.is_symlink() or any(p.exists() or p.is_symlink() for p in targets.values()):
        raise RuntimeError('A previous MCP installation exists; inspect it before replacing')
    state = run('systemctl', 'show', 'portfolio-mcp.service', '-p', 'LoadState', '-p', 'FragmentPath', '-p', 'ActiveState', check=False)
    unit_state = dict(line.split('=', 1) for line in state.stdout.splitlines() if '=' in line)
    if unit_state.get('LoadState') != 'not-found' or unit_state.get('ActiveState') != 'inactive' or unit_state.get('FragmentPath'):
        raise RuntimeError('A previous MCP unit exists; inspect it before replacing')
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as test_socket:
        test_socket.bind(('127.0.0.1', 3318))
    if run('systemctl', 'is-active', 'portfolio-api.service', check=False).returncode != 0:
        raise RuntimeError('Existing API is not active')
    run('nginx', '-t')
    api_pid = run('systemctl', 'show', 'portfolio-api.service', '-p', 'MainPID', '--value').stdout.strip()
    sources = [root / name for name in ['index.html', 'myworks.html', 'terminal/profile.txt', 'api/data/portfolio.db']]
    before = {str(p): digest(p) for p in sources}
    backup = stage / 'backup'
    backup.mkdir(mode=0o700)
    os.chmod(backup, 0o700)
    for p in [Path('/etc/nginx/nginx.conf'), Path('/etc/nginx/conf.d/altena.conf'), Path('/etc/nginx/default.d/portfolio.conf')]:
        shutil.copy2(p, backup / p.name)
    source_db = sqlite3.connect('file:' + str(root / 'api/data/portfolio.db') + '?mode=ro', uri=True)
    backup_db = sqlite3.connect(str(backup / 'portfolio.db'))
    source_db.backup(backup_db)
    backup_db.close()
    source_db.close()
    (backup / 'before.json').write_text(json.dumps({'source_sha256': before, 'api_pid': api_pid}, indent=2))

    release = Path('/opt/portfolio-mcp/releases') / stage.name
    release.mkdir(parents=True, mode=0o755)
    os.chmod(release.parent.parent, 0o755)
    os.chmod(release.parent, 0o755)
    os.chmod(release, 0o755)
    binary = release / 'portfolio-mcp'
    shutil.copyfile(stage / 'portfolio-mcp', binary)
    os.chmod(binary, 0o755)
    if digest(binary) != expected:
        raise RuntimeError('Installed binary hash mismatch')
    started = False
    enabled_by_us = False
    nginx_reloaded = False
    installed = []
    try:
        current.symlink_to(release)
        run('restorecon', '-R', '/opt/portfolio-mcp')
        for name, target in targets.items():
            install_config(stage / name, target)
            installed.append(target)
            run('restorecon', str(target))
        run('systemctl', 'daemon-reload')
        run('systemd-analyze', 'verify', str(targets['portfolio-mcp.service']))
        started = True
        run('systemctl', 'start', 'portfolio-mcp.service')
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-11-25', 'capabilities': {},
            'clientInfo': {'name': 'deployment-readiness', 'version': '1.0.0'}}}).encode()
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        for attempt in range(20):
            try:
                status, payload = probe('http://127.0.0.1:3318/mcp', body, headers)
                result = json.loads(payload)
                if status != 200 or 'result' not in result:
                    raise RuntimeError('MCP readiness response invalid')
                break
            except Exception:
                if attempt == 19:
                    raise RuntimeError('MCP did not become ready')
                time.sleep(0.25)
        run('nginx', '-t')
        nginx_reloaded = True
        run('systemctl', 'reload', 'nginx')
        for attempt in range(20):
            p = run('curl', '--resolve', 'altena.me:443:127.0.0.1', '--silent', '--show-error', '--max-time', '8',
                    '-H', 'Content-Type: application/json', '-H', 'Accept: application/json, text/event-stream',
                    '--data-binary', body.decode(), 'https://altena.me/portfolio/mcp', check=False)
            try:
                if p.returncode != 0 or 'result' not in json.loads(p.stdout):
                    raise RuntimeError('TLS readiness response invalid')
                break
            except Exception:
                if attempt == 19:
                    raise RuntimeError('HTTPS MCP did not become ready')
                time.sleep(0.25)
        for path in ['/portfolio/index.html', '/portfolio/index.md', '/portfolio/api/status']:
            result = run('curl', '--resolve', 'altena.me:443:127.0.0.1', '--silent', '--show-error', '--max-time', '8',
                         '--output', '/dev/null', '--write-out', '%{http_code} %{ssl_verify_result}', 'https://altena.me' + path).stdout.strip()
            if result != '200 0':
                raise RuntimeError('Existing public route failed')
        after = {str(p): digest(p) for p in sources}
        if after != before:
            raise RuntimeError('Existing source changed during deployment; DB will not be restored automatically')
        if run('systemctl', 'show', 'portfolio-api.service', '-p', 'MainPID', '--value').stdout.strip() != api_pid:
            raise RuntimeError('Existing API PID changed')
        enabled_by_us = True
        run('systemctl', 'enable', 'portfolio-mcp.service')
        record = {'deployment': 'ok', 'stage': str(stage), 'release': str(release), 'binary_sha256': expected,
                  'source_sha256': after, 'api_pid': api_pid, 'sources_unchanged': True,
                  'mcp_url': 'https://altena.me/portfolio/mcp', 'tls_verified': True}
        (stage / 'result.json').write_text(json.dumps(record, indent=2))
        print(json.dumps(record))
    except Exception:
        if started:
            run('systemctl', 'stop', 'portfolio-mcp.service', check=False)
        if enabled_by_us:
            run('systemctl', 'disable', 'portfolio-mcp.service', check=False)
        for target in installed:
            target.unlink(missing_ok=True)
        if current.is_symlink():
            current.unlink()
        run('systemctl', 'daemon-reload', check=False)
        run('nginx', '-t')
        if nginx_reloaded:
            run('systemctl', 'reload', 'nginx')
        api_active = run('systemctl', 'is-active', 'portfolio-api.service', check=False).returncode == 0
        print(json.dumps({'deployment': 'rolled_back', 'stage': str(stage), 'api_active': api_active,
                          'db_restore_performed': False}), file=sys.stderr)
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('MCP deployment failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
