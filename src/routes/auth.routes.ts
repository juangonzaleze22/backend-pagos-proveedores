import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { body } from 'express-validator';
import { validate } from '../middleware/validation.middleware';

const router: Router = Router();
const authController = new AuthController();

router.post(
  '/login',
  validate([
    body('email').isEmail().withMessage('Email inválido'),
    body('password').notEmpty().withMessage('Contraseña requerida')
  ]),
  authController.login.bind(authController)
);

router.get(
  '/me',
  authenticate,
  authController.getMe.bind(authController)
);

export default router;

