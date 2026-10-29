import { WebSocket, WebSocketServer } from 'ws';

// A live socket owns the account's game instance until the tab disconnects.
export function attachSessionLease(server, { authorize, identity }) {
  const wss = new WebSocketServer({ noServer: true });
  const active = new Map();
  const upgrade = (req, socket, head) => {
    let url, origin;
    try { url = new URL(req.url, 'http://localhost'); } catch { return; }
    if (url.pathname !== '/__session/game-instance') return;
    try { origin = new URL(req.headers.origin); } catch { /* rejected below */ }
    const account = identity(req);
    if (!authorize(req) || !account || origin?.host !== req.headers.host || !['http:', 'https:'].includes(origin?.protocol)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, async ws => {
      ws.on('error', () => {});
      const previous = active.get(account.id);
      if (previous) {
        const authorized = previous.isAuthorized();
        const alive = authorized && previous.readyState === WebSocket.OPEN && await new Promise(resolve => {
          const done = value => { clearTimeout(timeout); previous.off('pong', pong); previous.off('close', closed); resolve(value); };
          const pong = () => done(true), closed = () => done(false);
          const timeout = setTimeout(() => done(false), 1000);
          previous.once('pong', pong); previous.once('close', closed);
          try { previous.ping(); } catch { done(false); }
        });
        if (!alive && active.get(account.id) === previous) {
          active.delete(account.id);
          if (!authorized) previous.close(4001, 'Signed in elsewhere');
          else previous.terminate();
        }
      }
      if (ws.readyState !== WebSocket.OPEN || !authorize(req)) { ws.close(4001, 'Session expired'); return; }
      if (active.has(account.id)) {
        ws.send(JSON.stringify({ type: 'occupied' }));
        ws.close(4009, 'Account already in use');
        return;
      }
      active.set(account.id, ws);
      ws.isAuthorized = () => authorize(req);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => { if (active.get(account.id) === ws) active.delete(account.id); });
      ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'acquired' }));
    });
  };
  server.on('upgrade', upgrade);
  const heartbeat = setInterval(() => {
    for (const ws of active.values()) {
      if (ws.readyState !== WebSocket.OPEN || !ws.isAlive || !ws.isAuthorized()) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 15_000);
  heartbeat.unref?.();
  return { close() { server.off('upgrade', upgrade); clearInterval(heartbeat);
    for (const ws of active.values()) ws.terminate(); active.clear(); wss.close(); } };
}
