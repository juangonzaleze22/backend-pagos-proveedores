import { Request, Response, NextFunction } from 'express';
import { SupplierService } from '../services/supplier.service';
import { AppError } from '../middleware/error.middleware';
import fs from 'fs';

const supplierService = new SupplierService();

export class SupplierController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw new AppError('Usuario no autenticado', 401);
      }

      // paymentAccounts puede venir como array (JSON) o como string JSON (FormData)
      let paymentAccounts = req.body.paymentAccounts;
      if (typeof paymentAccounts === 'string') {
        try {
          paymentAccounts = JSON.parse(paymentAccounts);
        } catch {
          throw new AppError('Los métodos de pago enviados no son válidos', 400);
        }
      }

      const files = (req as any).files as Express.Multer.File[] | undefined;
      const fileList = Array.isArray(files) ? files : [];

      console.log('Creando proveedor con datos:', { ...req.body, paymentAccounts });
      const supplier = await supplierService.createSupplier(
        { ...req.body, paymentAccounts },
        req.user.userId,
        fileList.map((f) => f.filename),
        fileList.map((f) => f.path)
      );
      console.log('Proveedor creado exitosamente:', supplier.id);

      res.status(201).json({
        success: true,
        message: 'Proveedor registrado exitosamente',
        data: supplier
      });
    } catch (error: any) {
      console.error('Error al crear proveedor:', error);
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
      next(error);
    }
  }

  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const search = req.query.search as string;
      const status = req.query.status as any;

      const result = await supplierService.searchSuppliers(search, { status });

      res.json({
        success: true,
        data: result.data
      });
    } catch (error: any) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id);
      
      if (isNaN(id)) {
        throw new AppError('ID de proveedor inválido', 400);
      }

      const supplier = await supplierService.getSupplierById(id);

      if (!supplier) {
        throw new AppError('Proveedor no encontrado', 404);
      }

      res.json({
        success: true,
        data: supplier
      });
    } catch (error: any) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id);
      
      if (isNaN(id)) {
        throw new AppError('ID de proveedor inválido', 400);
      }

      console.log(`Actualizando proveedor ${id} con datos:`, req.body);
      const supplier = await supplierService.updateSupplier(id, req.body);
      console.log(`Proveedor ${id} actualizado exitosamente`);

      res.json({
        success: true,
        message: 'Proveedor actualizado exitosamente',
        data: supplier
      });
    } catch (error: any) {
      console.error('Error al actualizar proveedor:', error);
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        throw new AppError('ID de proveedor inválido', 400);
      }
      await supplierService.deleteSupplier(id);
      res.json({
        success: true,
        message: 'Proveedor eliminado correctamente'
      });
    } catch (error: any) {
      next(error);
    }
  }

  async getDebts(req: Request, res: Response, next: NextFunction) {
    try {
      const supplierId = parseInt(req.params.id);
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const status = req.query.status as any;
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

      const { DebtService } = await import('../services/debt.service');
      const debtService = new DebtService();
      const result = await debtService.getDebtsBySupplier(supplierId, {
        page,
        limit,
        status,
        startDate,
        endDate
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

  async getPayments(req: Request, res: Response, next: NextFunction) {
    try {
      const supplierId = parseInt(req.params.id);
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;

      const { PaymentService } = await import('../services/payment.service');
      const paymentService = new PaymentService();
      const result = await paymentService.getPaymentsBySupplier(supplierId, {
        page,
        limit
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
}

