import { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { brandingService, UpdateBrandingInput } from '../services/branding.service';
import { env } from '../config/env';

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normalizeHex(value: string): string {
  return value.trim();
}

/** Convierte "/uploads/branding/archivo.png" a ruta absoluta en disco. */
function toDiskPath(publicPath: string | null | undefined): string | null {
  if (!publicPath) return null;
  const relative = publicPath.replace(/^\/?uploads\//, '');
  return path.join(env.UPLOAD_PATH, relative);
}

function removeFile(publicPath: string | null | undefined): void {
  const diskPath = toDiskPath(publicPath);
  if (!diskPath) return;
  try {
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
  } catch {
    // Si no se puede borrar, no se interrumpe la actualización.
  }
}

function publicPathForFile(file: Express.Multer.File): string {
  return `/uploads/branding/${file.filename}`;
}

function sanitizeText(value: unknown, maxLength = 200): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  return text.slice(0, maxLength);
}

export class BrandingController {
  async getPublic(_req: Request, res: Response, next: NextFunction) {
    try {
      const config = await brandingService.getConfig();
      res.json({ success: true, data: config });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const current = await brandingService.getConfig();
      const files = (req.files ?? {}) as { [field: string]: Express.Multer.File[] };
      const body = req.body ?? {};

      const input: UpdateBrandingInput = {};

      const appName = sanitizeText(body.appName, 120);
      if (appName !== undefined) input.appName = appName;

      const companyName = sanitizeText(body.companyName, 160);
      if (companyName !== undefined) input.companyName = companyName;

      const loginTitle = sanitizeText(body.loginTitle, 160);
      if (loginTitle !== undefined) input.loginTitle = loginTitle;

      const loginSubtitle = sanitizeText(body.loginSubtitle, 200);
      if (loginSubtitle !== undefined) input.loginSubtitle = loginSubtitle;

      const reportTitle = sanitizeText(body.reportTitle, 160);
      if (reportTitle !== undefined) input.reportTitle = reportTitle;

      if (body.footerText !== undefined) {
        input.footerText = String(body.footerText).trim().slice(0, 300) || null;
      }

      if (body.primaryColor !== undefined) {
        const color = normalizeHex(String(body.primaryColor));
        if (!HEX_COLOR.test(color)) {
          return res.status(400).json({ success: false, message: 'Color primario inválido' });
        }
        input.primaryColor = color;
      }

      if (body.accentColor !== undefined) {
        const color = normalizeHex(String(body.accentColor));
        if (!HEX_COLOR.test(color)) {
          return res.status(400).json({ success: false, message: 'Color de acento inválido' });
        }
        input.accentColor = color;
      }

      const logoFile = files.logo?.[0];
      if (logoFile) {
        removeFile(current.logoPath);
        input.logoPath = publicPathForFile(logoFile);
      } else if (body.removeLogo === 'true') {
        removeFile(current.logoPath);
        input.logoPath = null;
      }

      const faviconFile = files.favicon?.[0];
      if (faviconFile) {
        removeFile(current.faviconPath);
        input.faviconPath = publicPathForFile(faviconFile);
      } else if (body.removeFavicon === 'true') {
        removeFile(current.faviconPath);
        input.faviconPath = null;
      }

      if (req.user?.userId) {
        input.updatedBy = req.user.userId;
      }

      const updated = await brandingService.updateConfig(input);

      res.json({
        success: true,
        message: 'Configuración de marca actualizada',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }
}
