import { Router } from 'express';
import { CreditController } from '../controllers/credit.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { body, param } from 'express-validator';
import { validate } from '../middleware/validation.middleware';

const router: Router = Router();
const creditController = new CreditController();

router.use(authenticate);

router.get(
  '/',
  creditController.listCredits.bind(creditController)
);

router.get(
  '/:id',
  validate([
    param('id').isInt().withMessage('ID de crédito inválido')
  ]),
  creditController.getCreditById.bind(creditController)
);

router.post(
  '/:id/apply',
  validate([
    param('id').isInt().withMessage('ID de crédito inválido'),
    body('debtId').notEmpty().withMessage('ID de deuda requerido').custom((value) => {
      const num = parseInt(value);
      if (isNaN(num) || num <= 0) {
        throw new Error('ID de deuda inválido');
      }
      return true;
    }),
    body('amount').notEmpty().withMessage('Monto requerido').custom((value) => {
      const num = parseFloat(value);
      if (isNaN(num) || num <= 0) {
        throw new Error('El monto debe ser mayor a 0');
      }
      return true;
    })
  ]),
  authorize('ADMINISTRADOR', 'SUPERVISOR'),
  creditController.applyCredit.bind(creditController)
);

export default router;
