import { Router } from 'express';
import { SupplierController } from '../controllers/supplier.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { body, param } from 'express-validator';
import { validate } from '../middleware/validation.middleware';

const router = Router();
const supplierController = new SupplierController();

// Todas las rutas requieren autenticación
router.use(authenticate);

router.post(
  '/',
  validate([
    body('companyName').trim().isLength({ min: 3 }).withMessage('El nombre de la empresa debe tener al menos 3 caracteres'),
    body('taxId').optional().trim().notEmpty().withMessage('El RIF/Identificación Fiscal no puede estar vacío'),
    body('email').optional().custom((value) => {
      if (value === null || value === undefined || value === '') return true;
      return typeof value === 'string';
    }).withMessage('El email o identificador debe ser texto'),
    body('phone').optional().trim().isString().withMessage('El teléfono debe ser una cadena de texto'),
    body('title').optional().trim().isString().withMessage('El título de la deuda debe ser un texto'),
    body('paymentAccounts').optional().isArray().withMessage('paymentAccounts debe ser un arreglo')
  ]),
  authorize('ADMINISTRADOR', 'SUPERVISOR'),
  supplierController.create.bind(supplierController)
);

router.get(
  '/',
  supplierController.getAll.bind(supplierController)
);

router.get(
  '/:id',
  validate([param('id').isInt().withMessage('ID inválido')]),
  supplierController.getById.bind(supplierController)
);

router.put(
  '/:id',
  validate([
    param('id').isInt().withMessage('ID inválido'),
    body('companyName').optional().trim().isLength({ min: 3 }).withMessage('El nombre de la empresa debe tener al menos 3 caracteres'),
    body('taxId').optional().trim().notEmpty().withMessage('El RIF/Identificación Fiscal no puede estar vacío'),
    body('email').optional().custom((value) => {
      if (value === null || value === undefined || value === '') return true;
      return typeof value === 'string';
    }).withMessage('El email o identificador debe ser texto'),
    body('phone').optional().custom((value) => {
      // Permitir null, string vacío o string válido
      if (value === null || value === undefined || value === '') return true;
      return typeof value === 'string';
    }).withMessage('El teléfono debe ser una cadena de texto'),
    body('status').optional().isIn(['PENDING', 'COMPLETED']).withMessage('El estado debe ser PENDING o COMPLETED'),
    body('paymentAccounts').optional().isArray().withMessage('paymentAccounts debe ser un arreglo')
  ]),
  authorize('ADMINISTRADOR', 'SUPERVISOR'),
  supplierController.update.bind(supplierController)
);

router.delete(
  '/:id',
  validate([param('id').isInt().withMessage('ID inválido')]),
  authorize('ADMINISTRADOR', 'SUPERVISOR'),
  supplierController.delete.bind(supplierController)
);

router.get(
  '/:id/debts',
  validate([param('id').isInt().withMessage('ID inválido')]),
  supplierController.getDebts.bind(supplierController)
);

router.get(
  '/:id/payments',
  validate([param('id').isInt().withMessage('ID inválido')]),
  supplierController.getPayments.bind(supplierController)
);

export default router;

