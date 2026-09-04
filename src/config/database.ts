import { PrismaClient } from '@prisma/client';

console.log(
  `[BOOT] ${new Date().toISOString()} phase=PRISMA_CLIENT_NEW PrismaClient constructor (antes de $connect)`
);

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
}) as any; // Temporal: usar 'as any' hasta que se regenere el cliente de Prisma

console.log(
  `[BOOT] ${new Date().toISOString()} phase=PRISMA_CLIENT_READY instancia creada (query engine se usa en $connect)`
);

export default prisma;

