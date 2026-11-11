import { Router, Request, Response, NextFunction } from 'express';
import { PaymentController } from '../controllers/payment.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { body, param } from 'express-validator';
import { validate } from '../middleware/validation.middleware';
import { uploadMultiple, handleMulterError } from '../config/multer';
import { optimizeUploadedImages } from '../middleware/image-optimizer.middleware';

const router = Router();
const paymentController = new PaymentController();

// Middleware de logging específico para payments (antes de authenticate)
router.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`🔵 PAYMENT ROUTE: ${req.method} ${req.path}`);
  console.log('Headers:', {
    authorization: req.headers.authorization ? 'Presente' : 'Ausente',
    contentType: req.headers['content-type'],
    origin: req.headers.origin
  });
  next();
});

// Endpoint PÚBLICO de comprobantes (sin auth). Múltiples imágenes por pago.
// GET /:id/receipt/:filename - devuelve una imagen por su nombre de archivo
// GET /:id/receipt - devuelve la primera imagen (compatibilidad)
router.get(
  '/:id/receipt/:filename',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ success: false, message: 'ID de pago inválido' });
      }
      return paymentController.getReceipt(req, res, next);
    } catch (error: any) {
      next(error);
    }
  }
);
router.get(
  '/:id/receipt',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ success: false, message: 'ID de pago inválido' });
      }
      return paymentController.getReceipt(req, res, next);
    } catch (error: any) {
      next(error);
    }
  }
);

// Preview para WhatsApp: HTML con Open Graph para que el link muestre imagen y texto
router.get(
  '/:id/preview',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) {
        return res.status(400).send('ID de pago inválido');
      }
      return paymentController.getPreview(req, res, next);
    } catch (error: any) {
      next(error);
    }
  }
);

router.use(authenticate);

router.post(
  '/',
  // Middleware para capturar errores de Multer
  (req: Request, res: Response, next: NextFunction) => {
    console.log('📤 Antes de Multer - Content-Type:', req.headers['content-type']);
    console.log('📤 Headers completos:', JSON.stringify(req.headers, null, 2));
    next();
  },
  uploadMultiple('receipt', 10), // Campo FormData 'receipt' - hasta 10 imágenes
  handleMulterError,
  optimizeUploadedImages({ maxWidth: 1920, maxHeight: 1920, quality: 80 }),
  // Middleware después de Multer para ver qué se recibió
  (req: Request, res: Response, next: NextFunction) => {
    console.log('📥 Después de Multer');
    console.log('Body recibido:', req.body);
    const files = (req as any).files as Express.Multer.File[] | undefined;
    console.log('Archivos recibidos:', files?.length ?? 0, files?.map((f: any) => ({ filename: f.filename, originalname: f.originalname, size: f.size })));
    next();
  },
  // Validaciones personalizadas para FormData (los valores vienen como strings)
  (req: Request, res: Response, next: NextFunction) => {
    console.log('🔍 Antes de validaciones - Body:', req.body);
    next();
  },
  validate([
    body('debtId').custom((value) => {
      console.log('🔍 Validando debtId:', value);
      const num = parseInt(value);
      if (isNaN(num) || num <= 0) {
        throw new Error('ID de deuda inválido');
      }
      return true;
    }),
    body('supplierId').custom((value) => {
      console.log('🔍 Validando supplierId:', value);
      const num = parseInt(value);
      if (isNaN(num) || num <= 0) {
        throw new Error('ID de proveedor inválido');
      }
      return true;
    }),
    body('amount').custom((value) => {
      console.log('🔍 Validando amount:', value);
      const num = parseFloat(value);
      if (isNaN(num)) {
        throw new Error('El monto debe ser un número válido');
      }
      if (num <= 0) {
        throw new Error('El monto debe ser mayor a 0');
      }
     /*  if (num > 999999.99) {
        throw new Error('El monto es demasiado grande (máximo $999,999.99)');
      } */
      return true;
    }),
    body('paymentMethod').isIn(['ZELLE', 'TRANSFER', 'CASH']).withMessage('Método de pago inválido'),
    body('senderName').notEmpty().withMessage('Nombre del emisor es requerido'),
    body('senderEmail').optional().custom((value) => {
      if (value === null || value === '' || value === undefined) {
        return true;
      }
      if (typeof value !== 'string') {
        throw new Error('El email o identificador debe ser texto');
      }
      return true;
    }),
    body('paymentDate').notEmpty().withMessage('Fecha de pago requerida'),
    body('confirmationNumber').optional().isString(),
    body('exchangeRate').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseFloat(value);
        if (isNaN(num)) {
          throw new Error('La tasa del dólar debe ser un número válido');
        }
        if (num <= 0) {
          throw new Error('La tasa del dólar debe ser mayor a 0');
        }
      }
      return true;
    }),
    body('amountInBolivares').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseFloat(value);
        if (isNaN(num)) {
          throw new Error('El monto en bolívares debe ser un número válido');
        }
        if (num <= 0) {
          throw new Error('El monto en bolívares debe ser mayor a 0');
        }
      }
      return true;
    }),
    body('cashierId').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseInt(value);
        if (isNaN(num) || num <= 0) {
          throw new Error('ID de cajero inválido');
        }
      }
      return true;
    }),
    body('surplusAction').optional().isIn(['CREDIT', 'APPLY_TO_DEBT']).withMessage('Acción de excedente inválida'),
    body('surplusTargetDebtId').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseInt(value);
        if (isNaN(num) || num <= 0) {
          throw new Error('ID de deuda destino inválido');
        }
      }
      return true;
    }),
    body('destinationAccountId').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseInt(value);
        if (isNaN(num) || num <= 0) {
          throw new Error('ID de cuenta de pago inválido');
        }
      }
      return true;
    })
  ]),
  authorize('ADMINISTRADOR', 'SUPERVISOR', 'CAJERO'),
  paymentController.create.bind(paymentController)
);

router.get(
  '/',
  paymentController.getAll.bind(paymentController)
);

router.get(
  '/search-by-confirmation',
  paymentController.searchByConfirmationNumber.bind(paymentController)
);

// Pagos registrados por un cajero (para cierre de caja)
router.get(
  '/cashier/:cashierId',
  validate([
    param('cashierId').isInt().withMessage('ID de cajero inválido')
  ]),
  paymentController.getByCashier.bind(paymentController)
);

// Pagos por proveedor (mover antes de /:id para evitar conflicto de rutas)
router.get(
  '/supplier/:supplierId',
  validate([
    param('supplierId').isInt().withMessage('ID de proveedor inválido')
  ]),
  paymentController.getBySupplier.bind(paymentController)
);

router.get(
  '/:id',
  validate([
    param('id').isInt().withMessage('ID inválido')
  ]),
  paymentController.getById.bind(paymentController)
);

router.put(
  '/:id',
  uploadMultiple('receipt', 10), // Opcional: hasta 10 imágenes para actualizar comprobantes
  handleMulterError,
  optimizeUploadedImages({ maxWidth: 1920, maxHeight: 1920, quality: 80 }),
  validate([
    param('id').isInt().withMessage('ID inválido'),
    body('amount').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseFloat(value);
        if (isNaN(num)) {
          throw new Error('El monto debe ser un número válido');
        }
        if (num <= 0) {
          throw new Error('El monto debe ser mayor a 0');
        }
      /*   if (num > 999999.99) {
          throw new Error('El monto es demasiado grande (máximo $999,999.99)');
        } */
      }
      return true;
    }),
    body('debtId').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseInt(value);
        if (isNaN(num) || num <= 0) {
          throw new Error('ID de deuda inválido');
        }
      }
      return true;
    }),
    body('supplierId').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseInt(value);
        if (isNaN(num) || num <= 0) {
          throw new Error('ID de proveedor inválido');
        }
      }
      return true;
    }),
    body('paymentMethod').optional().isIn(['ZELLE', 'TRANSFER', 'CASH']).withMessage('Método de pago inválido'),
    body('senderName').optional().notEmpty().withMessage('Nombre del emisor es requerido'),
    body('senderEmail').optional().custom((value) => {
      if (value === null || value === '' || value === undefined) {
        return true;
      }
      if (typeof value !== 'string') {
        throw new Error('El email o identificador debe ser texto');
      }
      return true;
    }),
    body('paymentDate').optional().notEmpty().withMessage('Fecha de pago requerida'),
    body('confirmationNumber').optional().isString(),
    body('removeReceipt').optional().isBoolean().withMessage('removeReceipt debe ser un booleano'),
    body('receiptFiles').optional().isArray().withMessage('receiptFiles debe ser un array'),
    body('exchangeRate').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseFloat(value);
        if (isNaN(num)) {
          throw new Error('La tasa del dólar debe ser un número válido');
        }
        if (num <= 0) {
          throw new Error('La tasa del dólar debe ser mayor a 0');
        }
      }
      return true;
    }),
    body('amountInBolivares').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseFloat(value);
        if (isNaN(num)) {
          throw new Error('El monto en bolívares debe ser un número válido');
        }
        if (num <= 0) {
          throw new Error('El monto en bolívares debe ser mayor a 0');
        }
      }
      return true;
    }),
    body('destinationAccountId').optional().custom((value) => {
      if (value !== undefined && value !== null && value !== '') {
        const num = parseInt(value);
        if (isNaN(num) || num < 0) {
          throw new Error('ID de cuenta de pago inválido');
        }
      }
      return true;
    })
  ]),
  authorize('ADMINISTRADOR', 'SUPERVISOR'),
  paymentController.update.bind(paymentController)
);

router.delete(
  '/:id',
  validate([
    param('id').isInt().withMessage('ID inválido'),
    body('reason').optional().isString().withMessage('El motivo debe ser un string')
  ]),
  authorize('ADMINISTRADOR', 'SUPERVISOR'),
  paymentController.delete.bind(paymentController)
);

router.post(
  '/verify-zelle',
  validate([
    body('confirmationNumber').notEmpty().withMessage('Número de confirmación requerido')
  ]),
  authorize('ADMINISTRADOR', 'SUPERVISOR'),
  paymentController.verifyZelle.bind(paymentController)
);

router.post(
  '/:id/share',
  validate([
    param('id').isInt().withMessage('ID de pago inválido')
  ]),
  authorize('ADMINISTRADOR', 'SUPERVISOR', 'CAJERO'),
  paymentController.share.bind(paymentController)
);

export default router;

