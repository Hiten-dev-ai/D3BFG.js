import { chromium } from 'playwright';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';

const gameUrl = process.env.DOOM_GAME_URL || 'http://127.0.0.1:8080/';
const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
const profilePath = path.join(localAppData, 'DOOM3BFG-Playwright');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const context = await chromium.launchPersistentContext(profilePath, {
  channel: 'chrome',
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
});

const page = context.pages()[0] || await context.newPage();
await page.goto(gameUrl, { waitUntil: 'domcontentloaded' });

console.log(`DOOM tab: ${page.url()}`);
console.log(`Isolated Chrome profile: ${profilePath}`);
console.log('Sign in and enter gameplay manually. Type "help" for controls; "quit" closes this Playwright browser.');

const input = createInterface({ input: process.stdin, output: process.stdout, prompt: 'doom> ' });
const heldKeys = new Set();
let mouseX = 0;
let mouseY = 0;
let shuttingDown = false;

function normalizeKey(value) {
  const key = value.trim();
  const aliases = {
    esc: 'Escape',
    escape: 'Escape',
    enter: 'Enter',
    return: 'Enter',
    space: ' ',
    spacebar: ' ',
    tab: 'Tab',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
  };
  if (/^key[a-z]$/i.test(key)) return key.slice(-1).toLowerCase();
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  return aliases[key.toLowerCase()] || key;
}

async function showHelp() {
  console.log([
    'hold <key> <ms>   Hold a movement key, then release it (max 5000 ms).',
    'tap <key>         Tap a key, for example: tap e',
    'look <dx> <dy>    Move the captured mouse smoothly; click into gameplay first.',
    'fire <ms>         Hold left mouse button to fire (max 1500 ms).',
    'status            Show page URL and pointer-lock state.',
    'quit              Close only this Playwright-launched Chrome session.',
  ].join('\n'));
}

async function execute(line) {
  const [command = '', ...args] = line.trim().split(/\s+/);
  if (!command) return;

  if (command === 'help') return showHelp();
  if (command === 'quit') {
    shuttingDown = true;
    input.close();
    return;
  }
  if (command === 'status') {
    const locked = await page.evaluate(() => Boolean(document.pointerLockElement));
    console.log(`URL: ${page.url()} | pointer lock: ${locked ? 'active' : 'inactive'}`);
    return;
  }

  if (command === 'tap') {
    if (!args[0]) throw new Error('Usage: tap <key>');
    await page.keyboard.press(normalizeKey(args[0]));
    return;
  }

  if (command === 'hold') {
    const key = normalizeKey(args[0] || '');
    const durationMs = Number(args[1]);
    if (!args[0] || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 5000) {
      throw new Error('Usage: hold <key> <1-5000 ms>');
    }
    await page.keyboard.down(key);
    heldKeys.add(key);
    try {
      await wait(durationMs);
    } finally {
      await page.keyboard.up(key);
      heldKeys.delete(key);
    }
    return;
  }

  if (command === 'look') {
    const dx = Number(args[0]);
    const dy = Number(args[1]);
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 1000 || Math.abs(dy) > 1000) {
      throw new Error('Usage: look <dx> <dy>, each between -1000 and 1000');
    }
    const locked = await page.evaluate(() => Boolean(document.pointerLockElement));
    if (!locked) throw new Error('Pointer is not locked. Click inside the game and try again.');
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (!mouseX && !mouseY) {
      mouseX = Math.round(size.width / 2);
      mouseY = Math.round(size.height / 2);
    }
    const steps = Math.max(8, Math.min(40, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 4)));
    const startX = mouseX;
    const startY = mouseY;
    for (let step = 1; step <= steps; step++) {
      const progress = step / steps;
      const eased = progress * progress * (3 - 2 * progress);
      mouseX = Math.max(1, Math.min(size.width - 1, Math.round(startX + dx * eased)));
      mouseY = Math.max(1, Math.min(size.height - 1, Math.round(startY + dy * eased)));
      await page.mouse.move(mouseX, mouseY);
      await wait(8);
    }
    return;
  }

  if (command === 'fire') {
    const durationMs = Number(args[0]);
    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 1500) {
      throw new Error('Usage: fire <1-1500 ms>');
    }
    await page.mouse.down();
    try {
      await wait(durationMs);
    } finally {
      await page.mouse.up();
    }
    return;
  }

  throw new Error(`Unknown command: ${command}. Type "help".`);
}

input.on('line', async (line) => {
  try {
    await execute(line);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  if (!shuttingDown) input.prompt();
});

input.on('close', async () => {
  shuttingDown = true;
  for (const key of heldKeys) await page.keyboard.up(key).catch(() => {});
  await context.close();
  process.exit(0);
});

input.prompt();
