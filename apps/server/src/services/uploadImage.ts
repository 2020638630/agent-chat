/**
 * Validate and store jpg/png/webp uploads under /uploads (max 5MB).
 * Public paths look like /uploads/<file>; unlinkUploadPublicPath cleans them safely.
 */
import type { FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getUploadsDir } from '../db/index.js';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export type SavedImage = {
  publicPath: string;
  filename: string;
  absPath: string;
};

function extFromName(name: string): string | null {
  const lower = (name || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return '.jpg';
  if (lower.endsWith('.png')) return '.png';
  if (lower.endsWith('.webp')) return '.webp';
  return null;
}

export async function readImageFromRequest(req: FastifyRequest): Promise<{
  buffer: Buffer;
  ext: string;
  mime: string;
}> {
  const file = await (req as any).file();
  if (!file) {
    throw Object.assign(new Error('请选择图片文件（jpg / png / webp）'), { statusCode: 400 });
  }

  const mime = String(file.mimetype || '').toLowerCase();
  const ext = ALLOWED[mime] || extFromName(file.filename || '');
  if (!ext || !['.jpg', '.png', '.webp'].includes(ext)) {
    throw Object.assign(new Error('仅支持 jpg / png / webp 图片'), { statusCode: 400 });
  }

  const buffer = await file.toBuffer();
  if (!buffer?.length) {
    throw Object.assign(new Error('图片为空'), { statusCode: 400 });
  }
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('图片不能超过 5MB'), { statusCode: 400 });
  }

  return { buffer, ext, mime: mime || 'image/' + ext.slice(1) };
}

export function saveImageBuffer(buffer: Buffer, ext: string, prefix: string): SavedImage {
  const uploads = getUploadsDir();
  const filename = `${prefix}-${randomUUID()}${ext}`;
  const absPath = path.join(uploads, filename);
  fs.writeFileSync(absPath, buffer);
  return { publicPath: `/uploads/${filename}`, filename, absPath };
}

/** Delete a file under /uploads if the stored path points there. */
export function unlinkUploadPublicPath(publicPath: string | null | undefined) {
  if (!publicPath) return;
  const name = path.basename(String(publicPath));
  if (!name || name === '.' || name === '..') return;
  if (!String(publicPath).includes('/uploads/')) return;
  const abs = path.join(getUploadsDir(), name);
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    /* ignore */
  }
}
