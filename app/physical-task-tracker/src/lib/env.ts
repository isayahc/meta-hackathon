// Minimal .env loader. Zero dependencies, no side effects on import:
// call loadEnvSync() once at process startup (before reading process.env).
// Never overrides a variable that is already set, never prints values.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// App root is two levels above this file (src/lib or dist/lib).
export function appRoot(fromDir: string = HERE): string {
  return join(fromDir, '..', '..');
}

// Parse KEY=VALUE lines. Skips blanks, `#` comments, and `export `
// prefixes. Strips one layer of matching single/double quotes.
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/\r$/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
    const eq = body.indexOf('=');
    if (eq < 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0 && !value.startsWith('"') && !value.startsWith("'")) {
        value = value.slice(0, hash).trimEnd();
      }
    }
    out[key] = value;
  }
  return out;
}

// Load one .env file. Returns the names (never values) that were set.
// Missing/unreadable files are a no-op — .env is optional.
export function loadEnvFile(path: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const set: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(raw))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      set.push(key);
    }
  }
  return set;
}

// Load .env from the current directory and the app root.
// Real environment always wins over file values.
export function loadEnvSync(): string[] {
  const seen: string[] = [];
  for (const dir of [process.cwd(), appRoot()]) {
    const file = join(dir, '.env');
    if (existsSync(file)) seen.push(...loadEnvFile(file));
  }
  return [...new Set(seen)];
}
