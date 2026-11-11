import { execSync } from 'child_process';
import path from 'path';
// Cargar env ANTES de Prisma (side effects en ./config/env)
import { env } from './config/env';
import app from './app';
import { logger } from './utils/logger';
import prisma from './config/database';
import { logRuntimeBootstrap, logPrismaConnectError } from './utils/runtimeDiagnostics';

// Capturar errores no manejados (útil en runtime logs del panel)
process.on('uncaughtException', (error) => {
  const t = new Date().toISOString();
  console.error(`[RUNTIME] ${t} uncaughtException:`, error);
  console.error(`[RUNTIME] ${t} stack:`, error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  const t = new Date().toISOString();
  console.error(`[RUNTIME] ${t} unhandledRejection:`, reason);
  console.error(`[RUNTIME] ${t} promise:`, promise);
});

const PORT = parseInt(process.env.PORT || '3000', 10);

console.log('PORT ==>>', PORT);

// Sincronizar schema con la BD al arrancar (útil en Hostinger sin consola).
// Actívalo en el panel: RUN_DB_PUSH_ON_START = true
// Usa node + ruta a prisma CLI (en Hostinger npx no suele estar en el PATH del proceso).
function runDbPushIfEnabled() {
  if (process.env.RUN_DB_PUSH_ON_START !== 'true') {
    console.log('[DB_PUSH] Omitido (RUN_DB_PUSH_ON_START != "true").');
    return;
  }

  const fs = require('fs') as typeof import('fs');
  const projectRoot = path.resolve(__dirname, '..');
  const schemaPath = path.join(projectRoot, 'prisma', 'schema.prisma');

  let prismaCli = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js');
  try {
    prismaCli = require.resolve('prisma/build/index.js', { paths: [projectRoot] });
  } catch {
    // Fallback a la ruta del monorepo/proyecto.
  }

  if (!fs.existsSync(prismaCli)) {
    console.warn('⚠️ Prisma CLI no encontrado en', prismaCli, '- se omite db push.');
    return;
  }
  if (!fs.existsSync(schemaPath)) {
    console.warn('⚠️ schema.prisma no encontrado en', schemaPath, '- se omite db push.');
    return;
  }

  console.log('🔄 Sincronizando schema con la BD (prisma db push)...');
  console.log(`[DB_PUSH] cwd=${projectRoot} schema=${schemaPath}`);
  try {
    const node = process.execPath;
    const out = execSync(
      `"${node}" "${prismaCli}" db push --skip-generate --schema "${schemaPath}"`,
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: process.env,
      }
    );
    if (out) console.log(out);
    console.log('✅ Schema sincronizado.');
  } catch (e: any) {
    const msg = e?.stderr || e?.stdout || e?.message || String(e);
    console.error('❌ Error al sincronizar schema (la app seguirá):', msg);
  }
}

// Función para iniciar el servidor
async function startServer() {
  let prismaConnectErrorLogged = false;
  try {
    console.log('🔄 Iniciando servidor...');
    logRuntimeBootstrap('START');
    runDbPushIfEnabled();
    logRuntimeBootstrap('AFTER_DB_PUSH');

    // Verificar conexión a la base de datos
    console.log('🔄 Conectando a la base de datos...');
    logRuntimeBootstrap('PRE_PRISMA_CONNECT');
    const connectStarted = Date.now();
    console.log(`[BOOT] ${new Date().toISOString()} phase=CALLING prisma.$connect()`);
    try {
      await prisma.$connect();
    } catch (connectErr) {
      prismaConnectErrorLogged = true;
      logPrismaConnectError('PRISMA_CONNECT_CATCH', connectErr);
      throw connectErr;
    }
    console.log(
      `[BOOT] ${new Date().toISOString()} phase=PRISMA_CONNECT_OK ms=${Date.now() - connectStarted}`
    );
    console.log('✅ Conexión a la base de datos establecida');

    // Iniciar servidor (escuchar en todas las interfaces)
    app.listen(PORT, () => {
      console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
      console.log(`📝 Ambiente: ${env.NODE_ENV}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/health`);
      console.log(`🌐 Servidor escuchando en: http://0.0.0.0:${PORT}`);
      logger.info(`🚀 Servidor corriendo en puerto ${PORT}`);
      logger.info(`📝 Ambiente: ${env.NODE_ENV}`);
      logger.info(`🔗 Health check: http://localhost:${PORT}/health`);
    });
  } catch (error: any) {
    if (!prismaConnectErrorLogged) {
      logPrismaConnectError('STARTUP_OUTER_CATCH', error);
    }
    console.error('❌ Error al iniciar el servidor:', error);
    console.error('Stack:', error?.stack);
    logger.error('❌ Error al iniciar el servidor:', error);
    process.exit(1);
  }
}

// Manejo de cierre graceful
process.on('SIGTERM', async () => {
  logger.info('SIGTERM recibido, cerrando servidor...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT recibido, cerrando servidor...');
  await prisma.$disconnect();
  process.exit(0);
});

startServer();

