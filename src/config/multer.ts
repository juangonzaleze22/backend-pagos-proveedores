import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { RequestHandler } from 'express';
import { env } from './env';

// Crear directorio base si no existe
if (!fs.existsSync(env.UPLOAD_PATH)) {
  fs.mkdirSync(env.UPLOAD_PATH, { recursive: true });
}

// Crear directorio para comprobantes (receipts) si no existe
const receiptsPath = path.join(env.UPLOAD_PATH, 'receipt');
if (!fs.existsSync(receiptsPath)) {
  fs.mkdirSync(receiptsPath, { recursive: true });
}

// Crear directorio para imágenes de marca (logo / favicon) si no existe
const brandingPath = path.join(env.UPLOAD_PATH, 'branding');
if (!fs.existsSync(brandingPath)) {
  fs.mkdirSync(brandingPath, { recursive: true });
}

// Crear directorio para facturas de pedidos si no existe
const invoicesPath = path.join(env.UPLOAD_PATH, 'invoice');
if (!fs.existsSync(invoicesPath)) {
  fs.mkdirSync(invoicesPath, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Guardar comprobantes en la subcarpeta receipt/
    cb(null, receiptsPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // Tipos de archivo permitidos (ajusta según tus necesidades)
  const allowedMimes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Tipo de archivo no permitido. Tipos permitidos: ${allowedMimes.join(', ')}`));
  }
};

export const upload = multer({
  storage: storage,
  limits: {
    fileSize: env.MAX_FILE_SIZE, // Tamaño máximo en bytes
  },
  fileFilter: fileFilter,
});

// ===== Facturas de pedidos/deudas =====
const invoiceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, invoicesPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'invoice-' + uniqueSuffix + path.extname(file.originalname));
  }
});

export const uploadInvoice = multer({
  storage: invoiceStorage,
  limits: {
    fileSize: env.MAX_FILE_SIZE,
  },
  fileFilter: fileFilter,
});

// ===== Imágenes de marca (logo / favicon) =====
const brandingStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, brandingPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const imageOnlyFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimes = ['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'];
  const allowedExts = ['.png', '.jpg', '.jpeg', '.webp', '.ico'];
  const ext = path.extname(file.originalname).toLowerCase();

  // Algunos navegadores envían los .ico como application/octet-stream.
  if (allowedMimes.includes(file.mimetype) || (ext === '.ico' && allowedExts.includes(ext))) {
    cb(null, true);
  } else {
    cb(new Error('Tipo de archivo no permitido. Usa PNG, JPG, WEBP o ICO.'));
  }
};

export const uploadBranding = multer({
  storage: brandingStorage,
  limits: {
    fileSize: env.MAX_FILE_SIZE,
  },
  fileFilter: imageOnlyFilter,
});

export const uploadBrandingFields = (fields: multer.Field[]): RequestHandler =>
  uploadBranding.fields(fields) as unknown as RequestHandler;

// Middleware para manejar errores de Multer
export const handleMulterError = (err: any, req: any, res: any, next: any) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: `El archivo excede el tamaño máximo permitido (${env.MAX_FILE_SIZE / 1024 / 1024}MB)`
      });
    }
    return res.status(400).json({
      success: false,
      message: `Error al subir archivo: ${err.message}`
    });
  }
  if (err) {
    return res.status(400).json({
      success: false,
      message: err.message || 'Error al procesar el archivo'
    });
  }
  next();
};

// Configuraciones específicas (as unknown as RequestHandler evita conflicto entre @types/express y @types/multer)
export const uploadSingle = (fieldName: string): RequestHandler => upload.single(fieldName) as unknown as RequestHandler;
export const uploadMultiple = (fieldName: string, maxCount?: number): RequestHandler => upload.array(fieldName, maxCount) as unknown as RequestHandler;
export const uploadFields = (fields: multer.Field[]): RequestHandler => upload.fields(fields) as unknown as RequestHandler;
export const uploadInvoiceMultiple = (fieldName: string, maxCount?: number): RequestHandler => uploadInvoice.array(fieldName, maxCount) as unknown as RequestHandler;

