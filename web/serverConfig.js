import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.env.D3BFG_ENV_FILE || path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile); // Real environment always wins.

export function readServerConfig(env = process.env) {
  const bool = (key, fallback) => {
    if (env[key] === undefined || env[key] === '') return fallback;
    if (!['true', 'false', '1', '0'].includes(env[key])) throw new Error(`${key} must be true or false.`);
    return ['true', '1'].includes(env[key]);
  };
  const integer = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be ${min}–${max}.`);
    return value;
  };
  const resolve = (value, fallback) => path.resolve(root, value || fallback);
  return {
    host: env.HOST || '127.0.0.1', port: integer('PORT', 8080, 1, 65535),
    accounts: resolve(env.DOOM3BFG_ACCOUNTS_DIR, 'data/accounts'),
    saves: resolve(env.DOOM3BFG_SYNC_DIR, 'data/saves'),
    game: resolve(env.DOOM3BFG_GAME_DIR, 'game'),
    multiplayer: bool('MULTIPLAYER_ENABLED', true),
    offlinePlaybackAllowed: bool('OFFLINE_PLAYBACK_ALLOWED', true),
    sharedAssetCache: bool('SHARED_ASSET_CACHE', true),
    browserDefaults: {
      cacheMode: integer('BROWSER_CACHE_MODE', 1, 0, 3),
      persistSaves: Number(bool('BROWSER_PERSIST_SAVES', true)),
      browserSync: 0,
      developerMenu: Number(bool('BROWSER_DEVELOPER_LEVELS', false)),
      enableConsole: Number(bool('BROWSER_ENABLE_CONSOLE', false)),
      skipIntro: Number(bool('BROWSER_SKIP_CINEMATICS', true)),
      pauseAudioUnfocused: Number(bool('BROWSER_PAUSE_AUDIO_UNFOCUSED', true)),
      aspect: 0, resolutionIndex: 0, audioOutput: 0,
      frameRateCap: integer('BROWSER_FRAME_RATE_CAP', 60, 60, 360),
    },
  };
}

export const serverConfig = readServerConfig();
