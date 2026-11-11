import { Router } from 'express';
import { OrderController } from '../controllers/order.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { body, param } from 'express-validator';
import { validate } from '../middleware/validation.middleware';
import { uploadInvoiceMultiple, handleMulterError } from '../config/multer';
import { optimizeUploadedImages } from '../middleware/image-optimizer.middleware';

const router = Router();
const orderController = new OrderController();

// Endpoint PÚBLICO para servir facturas de pedidos (sin auth, para <img>)
router.get(
  '/:id/invoice/:filename',
  validate([param('id').isInt().withMessage('ID inválido')]),
  orderController.getInvoice.bind(orderController)
);
router.get(
  '/:id/invoice',
  validate([param('id').isInt().withMessage('ID inválido')]),
  orderController.getInvoice.bind(orderController)
);

router.use(authenticate);

router.post(
  '/',
  uploadInvoiceMultiple('invoiceFiles', 2),
  handleMulterError,
  optimizeUploadedImages({ maxWidth: 1920, maxHeight: 1920, quality: 80 }),
  validate([
    body('supplierId').isInt().withMessage('ID de proveedor inválido'),
    body('amount').isFloat({ min: 0.01 }).withMessage('El monto debe ser mayor a 0'),
    body('dispatchDate').isISO8601().withMessage('Fecha de despacho inválida'),
    body('creditDays').isInt({ min: 1 }).withMessage('Los días de crédito deben ser mayor a 0'),
    body('title').optional().isString().withMessage('El título debe ser un texto'),
    body('surplusAmountToApply').optional().isFloat({ min: 0 }).withMessage('El saldo excedente a aplicar debe ser un número mayor o igual a 0')
  ]),
  authorize('ADMINISTRADOR', 'SUPERVISOR', 'CAJERO'),
  orderController.create.bind(orderController)
);

router.get(
  '/',
  orderController.getAll.bind(orderController)
);

router.get(
  '/:id',
  validate([
    param('id').isInt().withMessage('ID inválido')
  ]),
  orderController.getById.bind(orderController)
);

router.get(
  '/supplier/:supplierId',
  validate([
    param('supplierId').isInt().withMessage('ID de proveedor inválido')
  ]),
  orderController.getBySupplier.bind(orderController)
);

router.put(
  '/:id',
  uploadInvoiceMultiple('invoiceFiles', 2),
  handleMulterError,
  optimizeUploadedImages({ maxWidth: 1920, maxHeight: 1920, quality: 80 }),
  validate([
    param('id').isInt().withMessage('ID inválido'),
    body('removeInvoice').optional().isBoolean().withMessage('removeInvoice debe ser un booleano'),
    body('dispatchDate').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          throw new Error('La fecha de despacho debe ser una fecha válida');
        }
      }
      return true;
    }),
    body('creditDays').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseInt(value);
        if (isNaN(num) || num < 1) {
          throw new Error('Los días de crédito deben ser mayor a 0');
        }
      }
      return true;
    }),
    body('amount').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseFloat(value);
        if (isNaN(num) || num <= 0) {
          throw new Error('El monto debe ser un número mayor a 0');
        }
      }
      return true;
    }),
    body('title').optional().custom((value) => value === null || value === undefined || typeof value === 'string').withMessage('El título debe ser un texto o null'),
    body('surplusAmountToApply').optional().isFloat({ min: 0 }).withMessage('El saldo excedente a aplicar debe ser un número mayor o igual a 0'),
    body().custom((value) => {
      // Validar que al menos uno de los campos esté presente
      const hasField =
        value.dispatchDate !== undefined ||
        value.creditDays !== undefined ||
        value.amount !== undefined ||
        value.title !== undefined ||
        value.surplusAmountToApply !== undefined ||
        value.removeInvoice !== undefined ||
        value.existingInvoiceFiles !== undefined;
      if (!hasField) {
        throw new Error(
          'Debe proporcionar al menos dispatchDate, creditDays, amount, title, surplusAmountToApply o datos de facturas para actualizar'
        );
      }
      return true;
    })
  ]),
  authorize('ADMINISTRADOR', 'SUPERVISOR'),
  orderController.update.bind(orderController)
);

export default router;

