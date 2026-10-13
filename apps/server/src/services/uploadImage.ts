/**
 * Validate and store jpg/png/webp uploads under /uploads (max 5MB).
 * Public paths look like /uploads/<file>; unlinkUploadPublicPath cleans them safely.
 */
import type { FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getUploadsDir } from '../db/index.js';
import sharp from 'sharp';

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

export async function readImageFromRequest(
  req: FastifyRequest,
  opts?: { maxBytes?: number; maxLabel?: string }
): Promise<{
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
  const limit = opts?.maxBytes ?? MAX_BYTES;
  const label = opts?.maxLabel ?? '5MB';
  if (buffer.length > limit) {
    throw Object.assign(new Error(`图片不能超过 ${label}`), { statusCode: 400 });
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

/** Resolve a /uploads/... public path to an absolute file under uploads (no traversal). */
export function resolveUploadAbsPath(publicPath: string): string | null {
  const raw = String(publicPath || '');
  const marker = '/uploads/';
  const idx = raw.indexOf(marker);
  if (idx < 0) return null;
  const rel = raw.slice(idx + marker.length).replace(/\\/g, '/');
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return null;
  const abs = path.resolve(getUploadsDir(), rel);
  const root = path.resolve(getUploadsDir());
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** Delete a file under /uploads if the stored path points there. */
export function unlinkUploadPublicPath(publicPath: string | null | undefined) {
  if (!publicPath) return;
  const abs = resolveUploadAbsPath(String(publicPath));
  if (!abs) return;
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    /* ignore */
  }
}



const REF_MAX_BYTES = 2 * 1024 * 1024;
const REF_SIZE = 1024;
const REF_SRC_MAX_EDGE = 1536;

/** X-02: validate, center-crop to 1024² jpeg/webp under uploads/char-refs/<characterId>/. */
export async function saveCharacterRefImage(
  buffer: Buffer,
  mime: string,
  characterId: string
): Promise<SavedImage & { width: number; height: number }> {
  if (!buffer?.length) {
    throw Object.assign(new Error('图片为空'), { statusCode: 400 });
  }
  if (buffer.length > REF_MAX_BYTES) {
    throw Object.assign(new Error('参考图不能超过 2MB，请压缩后再试'), { statusCode: 400 });
  }
  const lower = (mime || '').toLowerCase();
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(lower)) {
    throw Object.assign(new Error('参考图只支持 jpeg / webp（png 可上传，会转成 jpeg）'), { statusCode: 400 });
  }

  let pipeline = sharp(buffer, { failOn: 'none' });
  const meta = await pipeline.metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h) {
    throw Object.assign(new Error('无法读取图片尺寸'), { statusCode: 400 });
  }
  if (Math.max(w, h) > REF_SRC_MAX_EDGE) {
    throw Object.assign(
      new Error(`原图最长边不能超过 ${REF_SRC_MAX_EDGE} 像素，请先缩小再上传`),
      { statusCode: 400 }
    );
  }

  // Prefer webp when source is webp; otherwise jpeg (png converts to jpeg).
  const outExt = lower === 'image/webp' ? '.webp' : '.jpg';
  const outMime = outExt === '.webp' ? 'image/webp' : 'image/jpeg';

  const outBuf = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(REF_SIZE, REF_SIZE, { fit: 'cover', position: 'centre' })
    .toFormat(outExt === '.webp' ? 'webp' : 'jpeg', { quality: 85 })
    .toBuffer();

  if (outBuf.length > REF_MAX_BYTES) {
    throw Object.assign(new Error('处理后仍超过 2MB，请换一张更小的图'), { statusCode: 400 });
  }

  const uploads = getUploadsDir();
  const dir = path.join(uploads, 'char-refs', characterId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${randomUUID()}${outExt}`;
  const absPath = path.join(dir, filename);
  fs.writeFileSync(absPath, outBuf);
  const publicPath = `/uploads/char-refs/${characterId}/${filename}`;
  return { publicPath, filename, absPath, width: REF_SIZE, height: REF_SIZE };
}
