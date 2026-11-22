import { Router } from 'express';
import { UserController } from '../controllers/user.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router: Router = Router();
const userController = new UserController();

router.use(authenticate);

// GET /api/users?role=CAJERO - Lista usuarios (opcionalmente por rol). Para reporte de caja.
router.get(
  '/',
  authorize('ADMINISTRADOR', 'SUPERVISOR', 'CAJERO'),
  userController.getUsers.bind(userController)
);

export default router;
