/** Install the public launcher cache; private data remains in its existing stores. */
export async function initializeOfflineShell(): Promise<void> {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/offline-sw.js', { scope: '/', updateViaCache: 'none' });
    let readyTimer: number | undefined;
    try {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<never>((_resolve, reject) => {
          readyTimer = window.setTimeout(() => reject(new Error('Offline shell installation timed out')), 10000);
        }),
      ]);
    } finally { window.clearTimeout(readyTimer); }
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => {
        const changed = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); resolve(); };
        const timer = window.setTimeout(changed, 5000);
        navigator.serviceWorker.addEventListener('controllerchange', changed);
      });
    }
  } catch (error) {
    console.warn('[DOOM 3 offline] Launcher cache unavailable:', error);
  }
}

export async function prepareOfflineEngine(engineUrl: URL): Promise<void> {
  if (import.meta.env.DEV || !navigator.serviceWorker?.controller || navigator.onLine === false) return;
  const version = engineUrl.pathname.match(/\/engine-worker\/([a-f0-9]{24})\//)?.[1];
  if (!version) return;
  await new Promise<void>(resolve => {
    const channel = new MessageChannel();
    const finish = () => { clearTimeout(timer); channel.port1.close(); resolve(); };
    const timer = window.setTimeout(finish, 30000);
    channel.port1.onmessage = event => {
      if (!event.data?.ok) console.warn('[DOOM 3 offline] Engine cache incomplete:', event.data?.error);
      finish();
    };
    navigator.serviceWorker.controller!.postMessage({ type: 'CACHE_ENGINE', version }, [channel.port2]);
  });
}
