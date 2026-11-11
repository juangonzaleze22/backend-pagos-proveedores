import { NextFunction, Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { logger } from '../utils/logger';

/** Formatos que se convierten a WebP. PDF, Word, Excel e ICO quedan intactos. */
const OPTIMIZABLE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export interface ImageOptimizerOptions {
  /** Ancho máximo en px. Sin valor no se redimensiona. */
  maxWidth?: number;
  /** Alto máximo en px. Sin valor no se redimensiona. */
  maxHeight?: number;
  /** Calidad WebP (1-100). Por defecto 80. */
  quality?: number;
  /** Campos de Multer que no deben optimizarse (ej. favicon). */
  skipFields?: string[];
}

function collectFiles(req: Request): Express.Multer.File[] {
  const files = (req as any).files as
    | Express.Multer.File[]
    | { [fieldname: string]: Express.Multer.File[] }
    | undefined;

  if (!files) return [];
  if (Array.isArray(files)) return files;

  return Object.values(files).flat();
}

async function optimizeFile(
  file: Express.Multer.File,
  options: ImageOptimizerOptions,
): Promise<void> {
  if (options.skipFields?.includes(file.fieldname)) return;
  if (!OPTIMIZABLE_MIMES.has(file.mimetype)) return;

  const originalExt = path.extname(file.originalname).toLowerCase();
  // Favicon (.ico) no se convierte: no todos los navegadores aceptan WebP como favicon.
  if (originalExt === '.ico') return;

  const inputPath = file.path;
  const dir = path.dirname(inputPath);
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(dir, `${baseName}.webp`);
  const originalSize = file.size;

  try {
    let pipeline = sharp(inputPath, {
      animated: file.mimetype === 'image/gif',
      failOn: 'none',
    }).rotate();

    if (options.maxWidth || options.maxHeight) {
      pipeline = pipeline.resize({
        width: options.maxWidth,
        height: options.maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    await pipeline
      .webp({ quality: options.quality ?? 80, effort: 4 })
      .toFile(outputPath);

    const { size } = await fs.stat(outputPath);

    if (size >= originalSize) {
      await fs.unlink(outputPath).catch(() => undefined);
      logger.debug(
        `Imagen conservada en formato original (WebP no redujo peso): ${file.filename}`,
      );
      return;
    }

    if (outputPath !== inputPath) {
      await fs.unlink(inputPath).catch(() => undefined);
    }

    const webpName = path.basename(outputPath);
    file.filename = webpName;
    file.path = outputPath;
    file.mimetype = 'image/webp';
    file.size = size;
    file.originalname = `${path.basename(
      file.originalname,
      path.extname(file.originalname),
    )}.webp`;

    logger.info(
      `Imagen optimizada: ${webpName} (${Math.round(originalSize / 1024)}KB -> ${Math.round(
        size / 1024,
      )}KB)`,
    );
  } catch (error) {
    await fs.unlink(outputPath).catch(() => undefined);
    logger.warn(`No se pudo optimizar la imagen ${file.filename}`, error);
  }
}

/**
 * Optimiza las imágenes subidas por Multer: rota según EXIF, redimensiona y
 * convierte a WebP. Debe ejecutarse DESPUÉS del middleware de Multer y ANTES
 * del controlador, para que este último reciba el filename final.
 */
export function optimizeUploadedImages(options: ImageOptimizerOptions = {}) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const files = collectFiles(req);
    if (files.length === 0) return next();

    for (const file of files) {
      await optimizeFile(file, options);
    }

    next();
  };
}
