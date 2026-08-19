/**
 * session.ts
 *
 * Centralized Viberate session-file resolution + secure runtime provisioning.
 *
 * Resolution order for the session PATH:
 *   1. process.env.VIBERATE_SESSION_PATH  (e.g. a Render Secret File mounted at
 *      /etc/secrets/viberate-session.json, or a temp path we materialize)
 *   2. the legacy default next to this module (viberate-session.json)
 *
 * Provisioning (for ephemeral runtimes like a Render Cron Job that ship no
 * session on disk): if a session file is NOT already present at the resolved
 * path, and VIBERATE_SESSION_B64 is set, decode it to a private temp file and
 * point subsequent reads at it via VIBERATE_SESSION_PATH.
 *
 * SECURITY: session contents (cookies) are NEVER logged. Only the resolved
 * path and the source ('file' | 'env-b64' | 'none') are ever surfaced.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_SESSION_PATH = path.resolve(__dirname, 'viberate-session.json');

/** Resolve the session file path (env override wins). Evaluated at call time. */
export function getSessionPath(): string {
  const override = process.env.VIBERATE_SESSION_PATH;
  return override && override.trim() ? override.trim() : DEFAULT_SESSION_PATH;
}

export interface SessionProvisionResult {
  source: 'file' | 'env-b64' | 'none';
  sessionPath: string;
}

/**
 * Ensure a session file exists for this run.
 * - If one already exists at the resolved path (local dev, or a Render Secret
 *   File), use it as-is — the preferred secret-file approach.
 * - Else, if VIBERATE_SESSION_B64 is set, decode it to a private temp file and
 *   expose it via VIBERATE_SESSION_PATH for the rest of the process.
 * - Else, report 'none' (caller decides how to fail).
 *
 * Never logs or returns the session contents.
 */
export function provisionSessionFromEnv(): SessionProvisionResult {
  const resolved = getSessionPath();
  if (fs.existsSync(resolved)) {
    return { source: 'file', sessionPath: resolved };
  }

  const b64 = process.env.VIBERATE_SESSION_B64;
  if (b64 && b64.trim()) {
    // No explicit path override → materialize to a private temp file.
    const target = process.env.VIBERATE_SESSION_PATH?.trim()
      ? getSessionPath()
      : path.join(os.tmpdir(), 'viberate-session.json');

    let json: string;
    try {
      json = Buffer.from(b64.trim(), 'base64').toString('utf8');
      JSON.parse(json); // validate structure only — do NOT log it
    } catch {
      throw new Error('VIBERATE_SESSION_B64 is set but is not valid base64-encoded JSON.');
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json, { mode: 0o600 });
    process.env.VIBERATE_SESSION_PATH = target; // so getSessionPath() is consistent everywhere
    return { source: 'env-b64', sessionPath: target };
  }

  return { source: 'none', sessionPath: resolved };
}
