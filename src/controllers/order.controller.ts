import { Request, Response, NextFunction } from 'express';
import { OrderService } from '../services/order.service';
import { AppError } from '../middleware/error.middleware';
import path from 'path';
import fs from 'fs';
import prisma from '../config/database';
import { env } from '../config/env';
import { getInvoiceFileNames, parseInvoiceFilenameFromUrl } from '../utils/invoiceUrls';

const orderService = new OrderService();

export class OrderController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw new AppError('Usuario no autenticado', 401);
      }

      const files = (req as any).files as Express.Multer.File[] | undefined;
      const fileList = Array.isArray(files) ? files : [];

      const orderData = {
        supplierId: parseInt(req.body.supplierId),
        amount: parseFloat(req.body.amount),
        dispatchDate: req.body.dispatchDate,
        creditDays: parseInt(req.body.creditDays),
        title: req.body.title || undefined,
        surplusAmountToApply:
          req.body.surplusAmountToApply !== undefined &&
          req.body.surplusAmountToApply !== null &&
          req.body.surplusAmountToApply !== ''
            ? parseFloat(req.body.surplusAmountToApply)
            : undefined
      };

      const order = await orderService.createOrder(
        orderData as any,
        req.user.userId,
        fileList.map((f) => f.filename),
        fileList.map((f) => f.path)
      );

      res.status(201).json({
        success: true,
        message: 'Pedido creado exitosamente',
        data: order
      });
    } catch (error: any) {
      this.cleanupUploadedFiles(req);
      next(error);
    }
  }

  private cleanupUploadedFiles(req: Request) {
    const files = (req as any).files as Express.Multer.File[] | undefined;
    if (Array.isArray(files)) {
      for (const file of files) {
        try {
          if (file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        } catch {
          // Ignorar errores al limpiar archivos
        }
      }
    }
  }

  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;

      const result = await orderService.getAllOrders({ page, limit });

      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error: any) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id);
      const order = await orderService.getOrderById(id);

      if (!order) {
        throw new AppError('Pedido no encontrado', 404);
      }

      res.json({
        success: true,
        data: order
      });
    } catch (error: any) {
      next(error);
    }
  }

  async getBySupplier(req: Request, res: Response, next: NextFunction) {
    try {
      const supplierId = parseInt(req.params.supplierId);
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;

      const result = await orderService.getOrdersBySupplier(supplierId, { page, limit });

      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error: any) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id);
      
      if (isNaN(id)) {
        throw new AppError('ID de orden inválido', 400);
      }

      // Preparar datos para actualizar
      const updateData: any = {};
      
      if (req.body.dispatchDate !== undefined) {
        updateData.dispatchDate = new Date(req.body.dispatchDate);
      }
      
      if (req.body.creditDays !== undefined) {
        updateData.creditDays = parseInt(req.body.creditDays);
      }
      
      if (req.body.amount !== undefined) {
        updateData.amount = parseFloat(req.body.amount);
      }

      if (req.body.title !== undefined) {
        updateData.title = req.body.title;
      }

      if (req.body.surplusAmountToApply !== undefined && req.body.surplusAmountToApply !== null && req.body.surplusAmountToApply !== '') {
        updateData.surplusAmountToApply = parseFloat(req.body.surplusAmountToApply);
      }

      // Manejar facturas: archivos nuevos, quitar todas, o conservar/actualizar lista
      const files = (req as any).files as Express.Multer.File[] | undefined;
      const fileList = Array.isArray(files) ? files : [];
      if (fileList.length > 0) {
        updateData.invoiceFileNames = fileList.map((f) => f.filename);
        updateData.invoiceFilePaths = fileList.map((f) => f.path);
      } else if (req.body.removeInvoice === 'true' || req.body.removeInvoice === true) {
        updateData.invoiceFileNames = null;
        updateData.removeInvoice = true;
      } else if (req.body.existingInvoiceFiles !== undefined) {
        const raw = req.body.existingInvoiceFiles;
        const urlList = Array.isArray(raw) ? raw : raw != null && raw !== '' ? [raw] : [];
        updateData.existingInvoiceFileNames = urlList
          .map((u: string) => parseInvoiceFilenameFromUrl(u))
          .filter((name: string | null): name is string => name != null);
      }

      console.log(`Actualizando orden ${id} con datos:`, updateData);
      const updatedOrder = await orderService.updateOrder(id, updateData);
      console.log(`Orden ${id} actualizada exitosamente`);

      res.json({
        success: true,
        message: 'Orden actualizada exitosamente',
        data: updatedOrder
      });
    } catch (error: any) {
      console.error('Error al actualizar orden:', error);
      this.cleanupUploadedFiles(req);
      next(error);
    }
  }

  /**
   * Sirve una factura de pedido. Endpoint público (igual que los comprobantes de pago)
   * para que las etiquetas <img> puedan cargarla sin cabecera Authorization.
   */
  async getInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id);
      const filenameParam = req.params.filename;

      if (isNaN(id)) {
        throw new AppError('ID de pedido inválido', 400);
      }

      const order = await prisma.order.findUnique({
        where: { id },
        select: { invoiceFiles: true }
      });

      if (!order) {
        throw new AppError('Pedido no encontrado', 404);
      }

      const fileNames = getInvoiceFileNames(order);
      if (fileNames.length === 0) {
        throw new AppError('No hay facturas disponibles para este pedido', 404);
      }

      const fileNameToServe = filenameParam
        ? (fileNames.includes(filenameParam) ? filenameParam : null)
        : fileNames[0];
      if (!fileNameToServe) {
        throw new AppError('Archivo de factura no encontrado', 404);
      }

      const filePath = path.resolve(env.UPLOAD_PATH, 'invoice', fileNameToServe);
      if (!fs.existsSync(filePath)) {
        throw new AppError('Archivo de factura no encontrado', 404);
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
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');

      res.sendFile(filePath);
    } catch (error: any) {
      next(error);
    }
  }
}

