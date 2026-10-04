/**
 * File storage for bill photos and PDFs. Local disk for development and single-server setups;
 * swap in S3 / Cloudflare R2 / DigitalOcean Spaces by implementing the same three functions.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

const root = resolve(config.UPLOAD_DIR);
const safe = (key: string) => {
  const p = resolve(root, key);
  if (!p.startsWith(root)) throw new Error('Invalid storage key');
  return p;
};

export const storage = {
  async put(shopId: string, ext: string, data: Buffer): Promise<string> {
    const key = join(shopId, `${randomUUID()}${ext}`);
    await mkdir(dirname(safe(key)), { recursive: true });
    await writeFile(safe(key), data);
    return key;
  },
  get: (key: string) => readFile(safe(key)),
  remove: (key: string) => unlink(safe(key)).catch(() => undefined),
};

export const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'application/pdf': '.pdf',
};
