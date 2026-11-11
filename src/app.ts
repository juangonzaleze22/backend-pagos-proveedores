import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { logger } from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { env } from './config/env';
import routes from './routes';

const app: Application = express();

// CORS - Debe ir ANTES de otros middlewares
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
}));

// Middleware de seguridad (configurado para no bloquear CORS)
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false
}));

// Body parser (solo para JSON, FormData lo maneja Multer)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Archivos subidos (comprobantes e imágenes de marca)
app.use('/uploads', express.static(path.resolve(env.UPLOAD_PATH), { maxAge: '1d' }));

// Logging de requests (después del body parser para ver JSON, pero antes de Multer)
app.use((req, res, next) => {
  // Loggear todas las peticiones
  console.log(`📥 ${req.method} ${req.path}`, {
    origin: req.headers.origin,
    authorization: req.headers.authorization ? 'Presente' : 'Ausente',
    contentType: req.headers['content-type']
  });
  
  // Solo loggear body si no es multipart/form-data (FormData lo loggea después de Multer)
  if (!req.headers['content-type']?.includes('multipart/form-data') && req.body && Object.keys(req.body).length > 0) {
    console.log('Body:', JSON.stringify(req.body));
  }
  
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Ruta raíz (evita 404 cuando alguien visita /)
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'API de pagos a proveedores exampleee',
    health: '/health',
    api: '/api'
  });
});

// Favicon: responde 204 para no llenar logs de 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Ruta de salud (sin autenticación)
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'API funcionando correctamente',
    timestamp: new Date().toISOString()
  });
});

// Manejar preflight OPTIONS requests explícitamente
app.options('*', (req, res) => {
  console.log('🔄 OPTIONS request recibida para:', req.path);
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

// Middleware de prueba para verificar que las peticiones lleguen
app.use('/api', (req, res, next) => {
  console.log(`🌐 API Request: ${req.method} ${req.path}`);
  console.log('Origin:', req.headers.origin);
  next();
});

// Rutas de la API
app.use('/api', routes);

// Manejo de errores (debe ir al final)
app.use(notFoundHandler);
app.use(errorHandler);

export default app;

