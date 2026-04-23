/**
 * Per-user GitHub token store.
 * Maps Discord user ID -> GH token, persisted to store/user-tokens.json.
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const STORE_FILE = path.join(process.cwd(), 'store', 'user-tokens.json');

export interface UserTokenRecord {
  gh_token: string;
  registered_at: string;
}

type TokenStore = Record<string, UserTokenRecord>;

function readStore(): TokenStore {
  try {
    if (!fs.existsSync(STORE_FILE)) return {};
    const content = fs.readFileSync(STORE_FILE, 'utf-8');
    return JSON.parse(content) as TokenStore;
  } catch (err) {
    logger.warn({ err }, 'Failed to read user-tokens.json, treating as empty');
    return {};
  }
}

function writeStore(store: TokenStore): void {
  const dir = path.dirname(STORE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
  try {
    fs.chmodSync(STORE_FILE, 0o600);
  } catch {
    // best-effort
  }
}

export function getUserToken(userId: string): string | undefined {
  const store = readStore();
  return store[userId]?.gh_token;
}

export function setUserToken(userId: string, token: string): void {
  const store = readStore();
  store[userId] = {
    gh_token: token,
    registered_at: new Date().toISOString(),
  };
  writeStore(store);
  logger.info({ userId }, 'User GH token registered');
}

export function hasUserToken(userId: string): boolean {
  return !!getUserToken(userId);
}

export function removeUserToken(userId: string): boolean {
  const store = readStore();
  if (!(userId in store)) return false;
  delete store[userId];
  writeStore(store);
  logger.info({ userId }, 'User GH token removed');
  return true;
}

/**
 * Write GH_TOKEN into a group's .env so container-runner picks it up per-group.
 * Used when a thread is routed to a specific user's token.
 */
export function writeGroupGhToken(groupDir: string, token: string): void {
  const envFile = path.join(groupDir, '.env');
  let existing = '';
  if (fs.existsSync(envFile)) {
    existing = fs.readFileSync(envFile, 'utf-8');
  }
  // Remove any existing GH_TOKEN / GITHUB_TOKEN line
  const cleaned = existing
    .split('\n')
    .filter((l) => !/^(#?\s*)?GH_TOKEN=/.test(l) && !/^(#?\s*)?GITHUB_TOKEN=/.test(l))
    .join('\n');
  const newContent =
    (cleaned.endsWith('\n') || cleaned === '' ? cleaned : cleaned + '\n') +
    `GH_TOKEN=${token}\n`;
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(envFile, newContent, { mode: 0o600 });
  try {
    fs.chmodSync(envFile, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Detect if a string looks like a GitHub token.
 * Accepted prefixes: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
 * Case-insensitive prefix match.
 */
export function looksLikeGhToken(raw: string): boolean {
  const s = raw.trim();
  return /^(gh[pouse]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/i.test(s);
}
