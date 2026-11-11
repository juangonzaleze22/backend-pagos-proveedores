import { Router } from 'express';
import { BrandingController } from '../controllers/branding.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { uploadBrandingFields, handleMulterError } from '../config/multer';
import { optimizeUploadedImages } from '../middleware/image-optimizer.middleware';

const router = Router();
const brandingController = new BrandingController();

// Público: el login necesita logo/colores antes de autenticarse.
router.get('/', brandingController.getPublic.bind(brandingController));

router.put(
  '/',
  authenticate,
  authorize('ADMINISTRADOR'),
  uploadBrandingFields([
    { name: 'logo', maxCount: 1 },
    { name: 'favicon', maxCount: 1 },
  ]),
  handleMulterError,
  // El favicon se deja intacto (ICO/PNG); el logo se normaliza a WebP.
  optimizeUploadedImages({ maxWidth: 1024, maxHeight: 1024, quality: 85, skipFields: ['favicon'] }),
  brandingController.update.bind(brandingController)
);

export default router;
