import { Router, Request, Response, NextFunction } from 'express';
import { DebtService } from '../services/debt.service';
import { PaymentService } from '../services/payment.service';
import { CreditService } from '../services/credit.service';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { param, body } from 'express-validator';
import { validate } from '../middleware/validation.middleware';
import { AppError } from '../middleware/error.middleware';
import prisma from '../config/database';

const router: Router = Router();
const debtService = new DebtService();
const paymentService = new PaymentService();
const creditService = new CreditService();

router.use(authenticate);

router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const status = req.query.status as any;
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

      const result = await debtService.getAllDebts({
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
);

router.get(
  '/supplier/:supplierId',
  validate([param('supplierId').isInt().withMessage('ID de proveedor inválido')]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const supplierId = parseInt(req.params.supplierId);
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const status = req.query.status as any;
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

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
);

// Endpoint para obtener pagos de una deuda específica 
// IMPORTANTE: Esta ruta debe estar ANTES de /:id para evitar conflictos de routing
router.get(
  '/:debtId/payments',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const debtId = parseInt(req.params.debtId);
      if (isNaN(debtId) || debtId <= 0) {
        throw new AppError('ID de deuda inválido', 400);
      }

      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const includeDeleted = req.query.includeDeleted === 'true';
      
      // Parsear fechas correctamente (formato YYYY-MM-DD)
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      
      if (req.query.startDate) {
        const dateStr = req.query.startDate as string;
        // Si viene en formato YYYY-MM-DD, crear fecha en UTC
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const [year, month, day] = dateStr.split('-').map(Number);
          startDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
        } else {
          startDate = new Date(dateStr);
        }
      }
      
      if (req.query.endDate) {
        const dateStr = req.query.endDate as string;
        // Si viene en formato YYYY-MM-DD, crear fecha en UTC
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const [year, month, day] = dateStr.split('-').map(Number);
          endDate = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
        } else {
          endDate = new Date(dateStr);
        }
      }

      // Verificar que la deuda existe y obtener información completa (incl. surplusAmountAtCreation)
      const debtRow = await prisma.debt.findUnique({
        where: { id: debtId },
        select: {
          id: true,
          orderId: true,
          supplierId: true,
          title: true,
          initialAmount: true,
          remainingAmount: true,
          surplusAmountAtCreation: true,
          status: true,
          dueDate: true,
          createdAt: true,
          updatedAt: true,
          supplier: {
            select: { id: true, companyName: true, taxId: true, phone: true }
          }
        }
      });

      if (!debtRow) {
        throw new AppError('Deuda no encontrada', 404);
      }

      // Obtener pagos paginados (puede incluir eliminados si includeDeleted=true)
      const result = await paymentService.getPaymentsByDebt(debtId, {
        page,
        limit,
        startDate,
        endDate,
        includeDeleted
      });

      // Obtener TODOS los pagos ACTIVOS de la deuda (sin paginación) para calcular estadísticas
      // IMPORTANTE: Las estadísticas SIEMPRE excluyen pagos eliminados
      const allPaymentsResult = await paymentService.getPaymentsByDebt(debtId, {
        limit: 10000,
        startDate,
        endDate,
        includeDeleted: false
      });

      const totalPaid = allPaymentsResult.data.reduce((sum, payment) => sum + payment.amount, 0);
      const paymentCount = allPaymentsResult.pagination.total;
      const averagePayment = paymentCount > 0 ? totalPaid / paymentCount : 0;

      // Saldo excedente del proveedor (créditos disponibles)
      const totalCreditAvailable = await creditService.getTotalAvailableCredit(debtRow.supplierId);

      // Número secuencial de la deuda para este proveedor
      const allDebtIds = await prisma.debt.findMany({
        where: { supplierId: debtRow.supplierId },
        orderBy: { createdAt: 'asc' },
        select: { id: true }
      });
      const debtNumber = allDebtIds.findIndex((d: { id: number }) => d.id === debtId) + 1;

      const debt = {
        id: debtRow.id,
        orderId: debtRow.orderId,
        supplierId: debtRow.supplierId,
        supplier: debtRow.supplier,
        title: debtRow.title ?? undefined,
        initialAmount: Number(debtRow.initialAmount),
        remainingAmount: Number(debtRow.remainingAmount),
        surplusAmountAtCreation: debtRow.surplusAmountAtCreation != null ? Number(debtRow.surplusAmountAtCreation) : null,
        status: debtRow.status,
        dueDate: debtRow.dueDate,
        createdAt: debtRow.createdAt,
        updatedAt: debtRow.updatedAt,
        debtNumber
      };

      res.json({
        success: true,
        debt,
        totalCreditAvailable,
        data: result.data,
        pagination: result.pagination,
        statistics: {
          totalPaid,
          paymentCount,
          averagePayment
        }
      });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  validate([param('id').isInt().withMessage('ID inválido')]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id);
      const debt = await debtService.getDebtById(id);

      if (!debt) {
        return res.status(404).json({
          success: false,
          message: 'Deuda no encontrada'
        });
      }

      res.json({
        success: true,
        data: debt
      });
    } catch (error: any) {
      next(error);
    }
  }
);

router.put(
  '/:id',
  validate([
    param('id').isInt().withMessage('ID inválido'),
    body('initialAmount').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseFloat(value);
        if (isNaN(num)) {
          throw new Error('El monto inicial debe ser un número válido');
        }
        if (num <= 0) {
          throw new Error('El monto inicial debe ser mayor a 0');
        }
       /*  if (num > 999999.99) {
          throw new Error('El monto inicial es demasiado grande (máximo $999,999.99)');
        } */
      }
      return true;
    }),
    body('dueDate').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          throw new Error('La fecha de vencimiento debe ser una fecha válida');
        }
      }
      return true;
    }),
    body('title').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '' && typeof value !== 'string') {
        throw new Error('El título debe ser un texto');
      }
      return true;
    })
  ]),
  authorize('ADMINISTRADOR', 'SUPERVISOR'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id);
      
      if (isNaN(id)) {
        throw new AppError('ID de deuda inválido', 400);
      }

      // Preparar datos para actualizar
      const updateData: any = {};
      
      if (req.body.initialAmount !== undefined) {
        updateData.initialAmount = parseFloat(req.body.initialAmount);
      }
      
      if (req.body.dueDate !== undefined) {
        updateData.dueDate = new Date(req.body.dueDate);
      }

      if (req.body.title !== undefined) {
        updateData.title = req.body.title === '' || req.body.title === null ? null : req.body.title;
      }

      console.log(`Actualizando deuda ${id} con datos:`, updateData);
      const updatedDebt = await debtService.updateDebt(id, updateData);
      console.log(`Deuda ${id} actualizada exitosamente`);

      res.json({
        success: true,
        message: 'Deuda actualizada exitosamente',
        data: updatedDebt
      });
    } catch (error: any) {
      console.error('Error al actualizar deuda:', error);
      next(error);
    }
  }
);

router.delete(
  '/:id',
  validate([param('id').isInt().withMessage('ID inválido')]),
  authorize('ADMINISTRADOR', 'SUPERVISOR'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id);
      console.log(`🗑️ [DELETE] Eliminando deuda ${id}...`);
      if (isNaN(id)) {
        throw new AppError('ID de deuda inválido', 400);
      }
      await debtService.deleteDebt(id);
      console.log(`✅ [DELETE] Deuda ${id} eliminada, enviando respuesta`);
      res.json({
        success: true,
        message: 'Deuda y pagos asociados eliminados correctamente'
      });
    } catch (error: any) {
      console.error('❌ [DELETE] Error al eliminar deuda:', error);
      next(error);
    }
  }
);

export default router;

