import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

/**
 * Seed idempotente (roles, usuarios por defecto y branding).
 * Se ejecuta al arrancar la app cuando RUN_SEED_ON_START=true,
 * útil en hostings sin consola/SSH.
 */
export async function runSeed(prisma?: PrismaClient): Promise<void> {
  const client = prisma ?? new PrismaClient();
  const shouldDisconnect = !prisma;

  try {
    const roles = [{ nombre: 'ADMINISTRADOR' }, { nombre: 'SUPERVISOR' }, { nombre: 'CAJERO' }];
    const createdRoles: { [key: string]: { id: number } } = {};

    for (const rol of roles) {
      const existing = await client.rol.findUnique({ where: { nombre: rol.nombre } });
      if (existing) {
        createdRoles[rol.nombre] = existing;
      } else {
        createdRoles[rol.nombre] = await client.rol.create({ data: rol });
        console.log(`✅ Rol creado: ${rol.nombre}`);
      }
    }

    const defaultPassword = 'pagosproveedores123';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    const usuarios = [
      { email: 'admin@pagosproveedores.com', nombre: 'Administrador', rolNombre: 'ADMINISTRADOR' },
      { email: 'supervisor@pagosproveedores.com', nombre: 'Supervisor', rolNombre: 'SUPERVISOR' },
      { email: 'cajero1@pagosproveedores.com', nombre: 'Cajero 1', rolNombre: 'CAJERO' },
      { email: 'cajero2@pagosproveedores.com', nombre: 'Cajero 2', rolNombre: 'CAJERO' },
      { email: 'cajero3@pagosproveedores.com', nombre: 'Cajero 3', rolNombre: 'CAJERO' },
      { email: 'cajero4@pagosproveedores.com', nombre: 'Cajero 4 (CXC)', rolNombre: 'CAJERO' },
    ];

    for (const usuario of usuarios) {
      const existing = await client.usuario.findUnique({ where: { email: usuario.email } });
      if (existing) continue;

      await client.usuario.create({
        data: {
          email: usuario.email,
          nombre: usuario.nombre,
          password: hashedPassword,
          rolId: createdRoles[usuario.rolNombre].id,
        },
      });
      console.log(`✅ Usuario creado: ${usuario.email} (${usuario.rolNombre})`);
    }

    const existingBranding = await client.brandingConfig.findFirst();
    if (!existingBranding) {
      await client.brandingConfig.create({ data: {} });
      console.log('✅ Branding por defecto creado');
    }

    console.log('[SEED] Completado');
  } finally {
    if (shouldDisconnect) await client.$disconnect();
  }
}
