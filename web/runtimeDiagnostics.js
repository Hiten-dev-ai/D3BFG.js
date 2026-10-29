// Authenticated, bounded engine diagnostics go to the service journal.
export function createRuntimeDiagnostics({ identity, log = console.warn }) {
  const limits = new Map();
  return async function handle(req, res) {
    const account = identity(req);
    let origin;
    try { origin = new URL(String(req.headers.origin)); } catch { /* rejected below */ }
    if (!account || origin?.host !== req.headers.host || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (req.method !== 'POST' || !String(req.headers['content-type'] || '').startsWith('text/plain')) {
      res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' }); res.end(); return;
    }
    const now = Date.now();
    for (const [id, entry] of limits) if (now - entry.start >= 60_000) limits.delete(id);
    const key = account.id;
    const entry = limits.get(key) || { start: now, count: 0, fatalCount: 0 };
    // Keep a small bounded reserve for original traps after noisy startup logs.
    if (++entry.count > 96) { res.writeHead(429, { 'Cache-Control': 'no-store' }); res.end(); return; }
    limits.set(key, entry);
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) { res.writeHead(413, { 'Cache-Control': 'no-store' }); res.end(); req.resume(); return; }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const lines = text.split(/\r?\n/).filter(line =>
      /^\[(?:web-port map|web-port menu|web-port session|physics|snapshot|BFG Worker Async Fatal|BFG Engine Error|BFG Engine Abort|BFG Engine Crash)\]/.test(line));
    const fatal = lines.some(line => /^\[BFG (?:Worker Async Fatal|Engine (?:Error|Abort|Crash))\]/.test(line));
    if ((fatal && ++entry.fatalCount > 8) || (entry.count > 60 && !fatal)) {
      res.writeHead(429, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    for (const line of lines.slice(0, 24)) {
      const safe = line.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, /^\[BFG (?:Worker Async Fatal|Engine (?:Error|Abort|Crash))\]/.test(line) ? 3500 : 1024)
        .replace(/\b(password|cookie|authorization|token)\s*[:=]\s*\S+/ig, '$1=[redacted]');
      log('[DOOM 3 client trace]', JSON.stringify({ account: key, message: safe }));
    }
    res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end();
  };
}
