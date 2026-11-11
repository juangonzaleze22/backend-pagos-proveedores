import { Router } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import supplierRoutes from './supplier.routes';
import orderRoutes from './order.routes';
import debtRoutes from './debt.routes';
import paymentRoutes from './payment.routes';
import creditRoutes from './credit.routes';
import reportRoutes from './report.routes';
import brandingRoutes from './branding.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/branding', brandingRoutes);
router.use('/users', userRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/orders', orderRoutes);
router.use('/debts', debtRoutes);
router.use('/payments', paymentRoutes);
router.use('/credits', creditRoutes);
router.use('/reports', reportRoutes);

export default router;

