import { Request, Response, NextFunction } from 'express';
import { PaymentService } from '../services/payment.service';
import { AppError } from '../middleware/error.middleware';
import path from 'path';
import fs from 'fs';
import prisma from '../config/database';
import { getReceiptFileNames, parseReceiptFilenameFromUrl, buildReceiptUrl } from '../utils/receiptUrls';
import { env } from '../config/env';
import { brandingService } from '../services/branding.service';

const paymentService = new PaymentService();

export class PaymentController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      console.log('🎯 PaymentController.create - Iniciando...');
      console.log('User:', req.user ? req.user.email : 'No autenticado');
      
      if (!req.user) {
        console.log('❌ Usuario no autenticado');
        return res.status(401).json({
          success: false,
          message: 'Usuario no autenticado'
        });
      }

      console.log('Body recibido (FormData):', req.body);
      console.log('🔍 Campos BS/USD recibidos:', {
        exchangeRate: req.body.exchangeRate,
        amountInBolivares: req.body.amountInBolivares,
        exchangeRateType: typeof req.body.exchangeRate,
        amountInBolivaresType: typeof req.body.amountInBolivares
      });
      const files = (req as any).files as Express.Multer.File[] | undefined;
      const fileList = Array.isArray(files) ? files : [];
      console.log('Archivos recibidos:', fileList.length, fileList.map((f: any) => ({ filename: f.filename, path: f.path, size: f.size })));

      // Validar que los campos requeridos estén presentes
      if (!req.body.debtId || !req.body.supplierId || !req.body.amount) {
        return res.status(400).json({
          success: false,
          message: 'Faltan campos requeridos: debtId, supplierId, amount'
        });
      }

      // Convertir los valores de FormData a los tipos correctos
      const exchangeRateValue = req.body.exchangeRate && req.body.exchangeRate !== '' 
        ? parseFloat(req.body.exchangeRate) 
        : undefined;
      const amountInBolivaresValue = req.body.amountInBolivares && req.body.amountInBolivares !== '' 
        ? parseFloat(req.body.amountInBolivares) 
        : undefined;

      console.log('💰 Valores procesados de BS/USD:', {
        exchangeRate: exchangeRateValue,
        amountInBolivares: amountInBolivaresValue,
        exchangeRateIsValid: exchangeRateValue !== undefined && !isNaN(exchangeRateValue),
        amountInBolivaresIsValid: amountInBolivaresValue !== undefined && !isNaN(amountInBolivaresValue)
      });

      // cashierId: si se envía, se usa como createdBy; si no, se usa el usuario autenticado
      const cashierId = req.body.cashierId ? parseInt(req.body.cashierId) : undefined;

      const paymentData = {
        debtId: parseInt(req.body.debtId),
        supplierId: parseInt(req.body.supplierId),
        amount: parseFloat(req.body.amount),
        paymentMethod: req.body.paymentMethod,
        senderName: req.body.senderName,
        senderEmail: req.body.senderEmail || undefined,
        confirmationNumber: req.body.confirmationNumber || undefined,
        paymentDate: req.body.paymentDate,
        nota: req.body.nota || undefined,
        exchangeRate: exchangeRateValue,
        amountInBolivares: amountInBolivaresValue,
        cashierId,
        surplusAction: req.body.surplusAction as 'CREDIT' | 'APPLY_TO_DEBT' | undefined,
        surplusTargetDebtId: req.body.surplusTargetDebtId ? parseInt(req.body.surplusTargetDebtId) : undefined,
        destinationAccountId:
          req.body.destinationAccountId !== undefined &&
          req.body.destinationAccountId !== null &&
          req.body.destinationAccountId !== ''
            ? parseInt(req.body.destinationAccountId)
            : undefined
      };

      // Múltiples imágenes: array de nombres y rutas (se construyen las URLs en el servicio)
      const receiptFileNames = fileList.map((f: any) => f.filename);
      const receiptFilePaths = fileList.map((f: any) => f.path);

      console.log('📝 Datos del pago a procesar:', paymentData);
      console.log('📎 Imágenes recibidas:', receiptFileNames.length, receiptFileNames);

      const payment = await paymentService.createPayment(
        paymentData,
        req.user.userId,
        receiptFileNames,
        receiptFilePaths
      );

      console.log('✅ Pago creado exitosamente:', payment.id);

      // Asegurar que no se haya enviado respuesta antes
      if (!res.headersSent) {
        res.status(201).json({
          success: true,
          message: 'Pago registrado exitosamente',
          data: payment
        });
      }
    } catch (error: any) {
      console.error('❌ Error en PaymentController.create:', error);
      console.error('Stack:', error?.stack);
      console.error('Error completo:', JSON.stringify(error, Object.getOwnPropertyNames(error)));

      const createdFiles = (req as any).files as Express.Multer.File[] | undefined;
      if (Array.isArray(createdFiles) && createdFiles.length > 0) {
        for (const file of createdFiles) {
          try {
            if (file.path && fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
              console.log('🗑️ Archivo eliminado debido a error:', file.filename);
            }
          } catch (unlinkError) {
            console.error('Error al eliminar archivo:', unlinkError);
          }
        }
      }

      // Convertir errores genéricos a AppError si no lo son
      if (!res.headersSent) {
        if (error instanceof AppError) {
          next(error);
        } else {
          // Mapear mensajes de error comunes a códigos de estado apropiados
          let statusCode = 500;
          const errorMessage = error.message || 'Error al registrar el pago';
          
          // Errores de validación de negocio (400)
          if (
            errorMessage.includes('no encontrada') ||
            errorMessage.includes('no pertenece') ||
            errorMessage.includes('excede') ||
            errorMessage.includes('completamente pagada') ||
            errorMessage.includes('debe ser mayor') ||
            errorMessage.includes('requerido')
          ) {
            statusCode = 400;
          }
          
          // Convertir error genérico a AppError
          const appError = new AppError(errorMessage, statusCode);
          next(appError);
        }
      } else {
        console.error('⚠️ No se puede enviar respuesta, headers ya enviados');
      }
    }
  }

  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      console.log('GET /api/payments - Iniciando...');
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const includeDeleted = req.query.includeDeleted === 'true';

      console.log('Obteniendo pagos con page:', page, 'limit:', limit, 'includeDeleted:', includeDeleted);
      const result = await paymentService.getAllPayments({ page, limit, includeDeleted });
      console.log('Pagos obtenidos:', result.data.length);

      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error: any) {
      console.error('Error en getAll payments:', error);
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      console.log('🎯 PaymentController.getById - Iniciando...');
      console.log('Params:', req.params);
      console.log('Query:', req.query);
      
      const id = parseInt(req.params.id);
      // Para el detalle de un pago, por defecto permitimos ver también pagos eliminados
      // (historial/auditoría). Si se quiere forzar solo activos: ?includeDeleted=false
      const rawIncludeDeleted = req.query.includeDeleted as unknown;
      const includeDeleted =
        rawIncludeDeleted === undefined
          ? true
          : rawIncludeDeleted === 'true' || rawIncludeDeleted === true;
      
      if (isNaN(id)) {
        console.error('❌ ID inválido:', req.params.id);
        throw new AppError('ID de pago inválido', 400);
      }

      console.log(`🔍 Buscando pago con ID: ${id}, includeDeleted: ${includeDeleted}`);
      const payment = await paymentService.getPaymentById(id, includeDeleted);

      if (!payment) {
        console.error(`❌ Pago ${id} no encontrado`);
        throw new AppError('Pago no encontrado', 404);
      }

      console.log(`✅ Pago ${id} encontrado exitosamente`);
      
      if (!res.headersSent) {
        res.json({
          success: true,
          data: payment
        });
      }
    } catch (error: any) {
      console.error('❌ Error en PaymentController.getById:', error);
      next(error);
    }
  }

  async getBySupplier(req: Request, res: Response, next: NextFunction) {
    try {
      const supplierId = parseInt(req.params.supplierId);
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const includeDeleted = req.query.includeDeleted === 'true';

      const result = await paymentService.getPaymentsBySupplier(supplierId, { page, limit, includeDeleted });

      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error: any) {
      next(error);
    }
  }

  async getByCashier(req: Request, res: Response, next: NextFunction) {
    try {
      const cashierId = parseInt(req.params.cashierId);
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const includeDeleted = req.query.includeDeleted === 'true';
      const startDate = req.query.startDate
        ? new Date(req.query.startDate as string)
        : undefined;
      const endDate = req.query.endDate
        ? new Date(req.query.endDate as string)
        : undefined;
      const paymentMethod = req.query.paymentMethod as string | undefined;

      if (isNaN(cashierId)) {
        throw new AppError('ID de cajero inválido', 400);
      }

      const result = await paymentService.getPaymentsByCashier(cashierId, {
        page,
        limit,
        includeDeleted,
        startDate,
        endDate,
        paymentMethod
      });

      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination,
        summary: result.summary
      });
    } catch (error: any) {
      next(error);
    }
  }

  async verifyZelle(req: Request, res: Response, next: NextFunction) {
    try {
      const { confirmationNumber } = req.body;

      if (!confirmationNumber) {
        throw new AppError('Número de confirmación requerido', 400);
      }

      const payment = await paymentService.verifyZelleByConfirmationNumber({ confirmationNumber });

      if (!payment) {
        return res.status(404).json({
          success: false,
          message: 'No se encontraron registros para la confirmación proporcionada'
        });
      }

      res.json({
        success: true,
        message: 'Pago verificado',
        data: payment
      });
    } catch (error: any) {
      next(error);
    }
  }

  async searchByConfirmationNumber(req: Request, res: Response, next: NextFunction) {
    try {
      const query = req.query.q as string;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;

      if (!query) {
        return res.json({
          success: true,
          data: []
        });
      }

      // Validar que el query tenga al menos 3 caracteres
      if (query.length < 3) {
        return res.json({
          success: true,
          data: []
        });
      }

      // Validar límite máximo
      const maxLimit = Math.min(limit, 20); // Máximo 20 resultados

      const payments = await paymentService.searchPaymentsByConfirmationNumber(query, maxLimit);

      res.json({
        success: true,
        data: payments
      });
    } catch (error: any) {
      next(error);
    }
  }

  async getByDebt(req: Request, res: Response, next: NextFunction) {
    try {
      const debtId = parseInt(req.params.debtId);
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const includeDeleted = req.query.includeDeleted === 'true';
      const startDate = req.query.startDate 
        ? new Date(req.query.startDate as string) 
        : undefined;
      const endDate = req.query.endDate 
        ? new Date(req.query.endDate as string) 
        : undefined;

      if (isNaN(debtId)) {
        throw new AppError('ID de deuda inválido', 400);
      }

      const result = await paymentService.getPaymentsByDebt(debtId, {
        page,
        limit,
        startDate,
        endDate,
        includeDeleted
      });

      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Sirve el archivo del comprobante. Endpoint PÚBLICO (sin auth) para que
   * el crawler de WhatsApp pueda leer la imagen y mostrar la vista previa.
   * Responde con Content-Type: image/jpeg | image/png | etc. según extensión.
   */
  async getReceipt(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id);
      const filenameParam = req.params.filename; // presente en GET /:id/receipt/:filename

      const payment = await prisma.payment.findUnique({
        where: { id },
        select: { receiptFile: true, receiptFiles: true }
      });

      if (!payment) {
        throw new AppError('Pago no encontrado', 404);
      }

      const fileNames = getReceiptFileNames(payment);

      if (fileNames.length === 0) {
        throw new AppError('No hay comprobante disponible para este pago', 404);
      }

      const fileNameToServe = filenameParam
        ? (fileNames.includes(filenameParam) ? filenameParam : null)
        : fileNames[0];
      if (!fileNameToServe) {
        throw new AppError('Archivo de comprobante no encontrado', 404);
      }

      const { env } = await import('../config/env');
      const filePath = path.resolve(env.UPLOAD_PATH, 'receipt', fileNameToServe);

      if (!fs.existsSync(filePath)) {
        console.error(`❌ Archivo no encontrado en: ${filePath}`);
        throw new AppError('Archivo de comprobante no encontrado', 404);
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: { [key: string]: string } = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${fileNameToServe}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
      res.setHeader('ETag', `"${fileNameToServe}"`);
      const origin = req.headers.origin;
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Access-Control-Allow-Credentials', 'true');

      res.sendFile(path.resolve(filePath), {
        headers: { 'Content-Type': contentType }
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Página de preview para compartir en WhatsApp. Devuelve HTML con meta tags
   * Open Graph y Twitter Card para que el link muestre imagen, título y descripción.
   * Ruta PÚBLICA (sin auth).
   */
  async getPreview(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) {
        return res.status(400).send('ID de pago inválido');
      }

      const payment = await prisma.payment.findUnique({
        where: { id },
        select: {
          id: true,
          amount: true,
          paymentDate: true,
          paymentMethod: true,
          receiptFile: true,
          receiptFiles: true,
          supplier: { select: { companyName: true } }
        }
      });

      if (!payment) {
        return res.status(404).send('Pago no encontrado');
      }

      const fileNames = getReceiptFileNames(payment);
      if (fileNames.length === 0) {
        return res.status(404).send('No hay comprobante para este pago');
      }

      const baseUrl = (env.API_BASE_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
      const previewUrl = `${baseUrl}/api/payments/${payment.id}/preview`;
      let firstImageUrl = buildReceiptUrl(payment.id, fileNames[0]);
      if (!firstImageUrl.startsWith('http')) {
        firstImageUrl = `${baseUrl}${firstImageUrl.startsWith('/') ? '' : '/'}${firstImageUrl}`;
      }

      const amount = Number(payment.amount).toFixed(2);
      const date = new Date(payment.paymentDate).toLocaleDateString('es-VE', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
      const branding = await brandingService.getConfig().catch(() => null);
      const companyName = branding?.companyName?.trim() || '';

      const title = `Comprobante de pago - ${payment.supplier.companyName}`;
      const description = companyName
        ? `Pago de $${amount} • ${date} • ${payment.supplier.companyName} • ${companyName}`
        : `Pago de $${amount} • ${date} • ${payment.supplier.companyName}`;

      const escapeHtml = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const safeTitle = escapeHtml(title);
      const safeDescription = escapeHtml(description);
      const safeImageUrl = escapeHtml(firstImageUrl);
      const safePreviewUrl = escapeHtml(previewUrl);
      const safeCompanyName = escapeHtml(companyName);

      const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <!-- Open Graph (Facebook / WhatsApp) -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${safePreviewUrl}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDescription}">
  <meta property="og:image" content="${safeImageUrl}">
  <meta property="og:image:secure_url" content="${safeImageUrl}">
  <meta property="og:locale" content="es_VE">
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDescription}">
  <meta name="twitter:image" content="${safeImageUrl}">
</head>
<body>
  ${safeCompanyName ? `<p><strong>${safeCompanyName}</strong></p>` : ''}
  <p>Comprobante de pago</p>
  <p>${safeDescription}</p>
  <p><a href="${safeImageUrl}">Ver imagen del comprobante</a></p>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
      res.send(html);
    } catch (error: any) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        console.log('❌ Usuario no autenticado');
        return res.status(401).json({
          success: false,
          message: 'Usuario no autenticado'
        });
      }

      const id = parseInt(req.params.id);
      
      if (isNaN(id)) {
        throw new AppError('ID de pago inválido', 400);
      }

      // Obtener datos del body (puede ser JSON o FormData)
      const updateData: any = {};
      
      // Permitir cambiar deuda y proveedor
      if (req.body.debtId !== undefined) {
        updateData.debtId = parseInt(req.body.debtId);
      }
      if (req.body.supplierId !== undefined) {
        updateData.supplierId = parseInt(req.body.supplierId);
      }
      
      if (req.body.amount !== undefined) {
        updateData.amount = parseFloat(req.body.amount);
      }
      if (req.body.paymentMethod) {
        updateData.paymentMethod = req.body.paymentMethod;
      }
      if (req.body.senderName) {
        updateData.senderName = req.body.senderName;
      }
      if (req.body.senderEmail !== undefined) {
        updateData.senderEmail = req.body.senderEmail || null;
      }
      if (req.body.confirmationNumber !== undefined) {
        updateData.confirmationNumber = req.body.confirmationNumber || null;
      }
      if (req.body.paymentDate) {
        updateData.paymentDate = req.body.paymentDate;
      }
      if (req.body.nota !== undefined) {
        updateData.nota = req.body.nota || null;
      }
      if (req.body.exchangeRate !== undefined) {
        updateData.exchangeRate = req.body.exchangeRate ? parseFloat(req.body.exchangeRate) : null;
      }
      if (req.body.amountInBolivares !== undefined) {
        updateData.amountInBolivares = req.body.amountInBolivares ? parseFloat(req.body.amountInBolivares) : null;
      }
      if (req.body.destinationAccountId !== undefined) {
        updateData.destinationAccountId =
          req.body.destinationAccountId !== null &&
          req.body.destinationAccountId !== '' &&
          req.body.destinationAccountId !== '0'
            ? parseInt(req.body.destinationAccountId)
            : null;
      }

      // Manejar comprobantes: archivos nuevos, remover todas, o conservar/actualizar lista (existingReceiptFiles = URLs)
      const updateFiles = (req as any).files as Express.Multer.File[] | undefined;
      const fileList = Array.isArray(updateFiles) ? updateFiles : [];
      if (fileList.length > 0) {
        updateData.receiptFileNames = fileList.map((f: any) => f.filename);
        updateData.receiptFilePaths = fileList.map((f: any) => f.path);
      } else if (req.body.removeReceipt === 'true' || req.body.removeReceipt === true) {
        console.log('🗑️ Usuario quiere remover todos los comprobantes');
        updateData.receiptFileNames = null;
        updateData.removeReceipt = true;
      } else if (req.body.receiptFiles === '' || req.body.receiptFiles === null) {
        console.log('🗑️ Usuario quiere remover comprobantes (campo vacío)');
        updateData.receiptFileNames = null;
        updateData.removeReceipt = true;
      } else {
        // Sin archivos nuevos: el frontend puede enviar existingReceiptFiles (URLs) para conservar/reordenar/eliminar algunas
        const raw = req.body.existingReceiptFiles;
        const urlList = Array.isArray(raw) ? raw : raw != null && raw !== '' ? [raw] : [];
        const fileNamesFromUrls = urlList
          .map((u: string) => parseReceiptFilenameFromUrl(u))
          .filter((name: string | null): name is string => name != null);
        if (fileNamesFromUrls.length > 0) {
          updateData.existingReceiptFileNames = fileNamesFromUrls;
        }
      }

      const updatedPayment = await paymentService.updatePayment(id, updateData);

      console.log('✅ Pago actualizado exitosamente:', updatedPayment.id);

      if (!res.headersSent) {
        res.json({
          success: true,
          message: 'Pago actualizado exitosamente',
          data: updatedPayment
        });
      }
    } catch (error: any) {
      console.error('❌ Error en PaymentController.update:', error);
      console.error('Stack:', error?.stack);
      
      // Si hay archivos subidos y hay error, eliminarlos
      const updateFiles = (req as any).files as Express.Multer.File[] | undefined;
      if (Array.isArray(updateFiles) && updateFiles.length > 0) {
        for (const file of updateFiles) {
          try {
            if (file.path && fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
              console.log('🗑️ Archivo eliminado debido a error:', file.filename);
            }
          } catch (unlinkError) {
            console.error('Error al eliminar archivo:', unlinkError);
          }
        }
      }

      if (error instanceof AppError) {
        next(error);
      } else {
        let statusCode = 500;
        const errorMessage = error.message || 'Error al actualizar el pago';
        
        if (
          errorMessage.includes('no encontrado') ||
          errorMessage.includes('excede') ||
          errorMessage.includes('debe ser mayor') ||
          errorMessage.includes('requerido')
        ) {
          statusCode = 400;
        }
        
        const appError = new AppError(errorMessage, statusCode);
        next(appError);
      }
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      console.log('🗑️ PaymentController.delete - Iniciando...');
      console.log('User:', req.user ? req.user.email : 'No autenticado');
      console.log('Params:', req.params);
      console.log('Body:', req.body);
      
      if (!req.user) {
        console.log('❌ Usuario no autenticado');
        return res.status(401).json({
          success: false,
          message: 'Usuario no autenticado'
        });
      }

      const id = parseInt(req.params.id);
      
      if (isNaN(id)) {
        throw new AppError('ID de pago inválido', 400);
      }

      const reason = req.body.reason || undefined;

      console.log(`🗑️ Eliminando pago ${id}...`);
      const deletedPayment = await paymentService.deletePayment(id, req.user.userId, reason);

      console.log('✅ Pago eliminado exitosamente:', deletedPayment.id);

      if (!res.headersSent) {
        res.json({
          success: true,
          message: 'Pago eliminado exitosamente',
          data: deletedPayment
        });
      }
    } catch (error: any) {
      console.error('❌ Error en PaymentController.delete:', error);
      console.error('Stack:', error?.stack);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        let statusCode = 500;
        const errorMessage = error.message || 'Error al eliminar el pago';
        
        if (
          errorMessage.includes('no encontrado') ||
          errorMessage.includes('ya ha sido eliminado')
        ) {
          statusCode = 400;
        }
        
        const appError = new AppError(errorMessage, statusCode);
        next(appError);
      }
    }
  }

  async share(req: Request, res: Response, next: NextFunction) {
    try {
      console.log('📤 PaymentController.share - Iniciando...');
      
      if (!req.user) {
        console.log('❌ Usuario no autenticado');
        return res.status(401).json({
          success: false,
          message: 'Usuario no autenticado'
        });
      }

      const id = parseInt(req.params.id);
      
      if (isNaN(id)) {
        throw new AppError('ID de pago inválido', 400);
      }

      console.log(`📤 Compartiendo pago ${id}...`);
      const result = await paymentService.sharePayment(id);

      console.log('✅ Pago compartido exitosamente:', result.payment.id);

      if (!res.headersSent) {
        res.json({
          success: true,
          message: 'Pago compartido exitosamente',
          data: {
            payment: result.payment,
            whatsappUrl: result.whatsappUrl
          }
        });
      }
    } catch (error: any) {
      console.error('❌ Error en PaymentController.share:', error);
      console.error('Stack:', error?.stack);
      
      if (error instanceof AppError) {
        next(error);
      } else {
        let statusCode = 500;
        const errorMessage = error.message || 'Error al compartir el pago';
        
        if (
          errorMessage.includes('no encontrado') ||
          errorMessage.includes('no tiene un número de teléfono')
        ) {
          statusCode = 400;
        }
        
        const appError = new AppError(errorMessage, statusCode);
        next(appError);
      }
    }
  }
}

