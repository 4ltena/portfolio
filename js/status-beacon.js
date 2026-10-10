function initStatusBeacon() {
    const source = document.getElementById('sys-status');
    const value = document.getElementById('divider-status-value');
    const tls = document.getElementById('divider-status-tls');
    const server = document.getElementById('divider-status-server');
    const uptime = document.getElementById('divider-status-uptime');
    const detail = document.getElementById('divider-status-detail');
    if (!source || !value || !tls || !server || !uptime || !detail) return;

    const syncStatus = () => {
        const text = source.textContent.trim();
        const isOnline = /\bonline\b/i.test(text);
        const isChecking = /checking|loading|upgrading|\.\.\./i.test(text);
        const state = isOnline ? 'online' : isChecking ? 'checking' : 'unknown';
        const tlsMatch = text.match(/\bTLS\b[^|·]*?\b(valid|expired|unknown)\b/i);
        const nginxMatch = text.match(/\bNGINX\b\s*[:/]?\s*([0-9][\w.-]*)/i);
        // js/main.js の initSystemStatus() は "up 128d 7h" という語順で埋め込む
        // （"UPTIME" というラベルは出力しない）。かつては \bUPTIME\b を探していて
        // 実データが来ても一致せず、常に UNKNOWN 表示になっていた。
        const uptimeMatch = text.match(/\bup\s+(\d+d\s*\d+h)\b/i);
        const tlsState = tlsMatch?.[1]?.toLowerCase() || (isChecking ? 'checking' : 'unknown');

        value.dataset.state = state;
        value.textContent = state.toUpperCase();
        tls.dataset.state = tlsState;
        tls.textContent = tlsState.toUpperCase();
        server.textContent = nginxMatch ? `NGINX / ${nginxMatch[1]}` : `NGINX / ${isChecking ? 'CHECKING' : 'UNKNOWN'}`;
        uptime.textContent = uptimeMatch?.[1]?.trim() || (isChecking ? 'CHECKING' : 'UNKNOWN');
        detail.textContent = text.replace(/^System Status:\s*/i, '') || 'WAITING FOR TELEMETRY…';
    };

    new MutationObserver(syncStatus).observe(source, {
        childList: true,
        subtree: true,
        characterData: true,
    });
    syncStatus();
}

document.addEventListener('DOMContentLoaded', initStatusBeacon);
