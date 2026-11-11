import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed...');

  // Crear roles
  const roles = [
    { nombre: 'ADMINISTRADOR' },
    { nombre: 'SUPERVISOR' },
    { nombre: 'CAJERO' }
  ];

  const createdRoles: { [key: string]: any } = {};

  for (const rol of roles) {
    const existingRol = await prisma.rol.findUnique({
      where: { nombre: rol.nombre }
    });

    if (!existingRol) {
      const newRol = await prisma.rol.create({
        data: rol
      });
      createdRoles[rol.nombre] = newRol;
      console.log(`✅ Rol creado: ${rol.nombre}`);
    } else {
      createdRoles[rol.nombre] = existingRol;
      console.log(`ℹ️  Rol ya existe: ${rol.nombre}`);
    }
  }

  // Hash de password por defecto
  const defaultPassword = 'pagosproveedores123';
  const hashedPassword = await bcrypt.hash(defaultPassword, 10);

  // Crear usuarios
  const usuarios = [
    {
      email: 'admin@pagosproveedores.com',
      nombre: 'Administrador',
      rolNombre: 'ADMINISTRADOR'
    },
    {
      email: 'supervisor@pagosproveedores.com',
      nombre: 'Supervisor',
      rolNombre: 'SUPERVISOR'
    },
    {
      email: 'cajero1@pagosproveedores.com',
      nombre: 'Cajero 1',
      rolNombre: 'CAJERO'
    },
    {
      email: 'cajero2@pagosproveedores.com',
      nombre: 'Cajero 2',
      rolNombre: 'CAJERO'
    },
    {
      email: 'cajero3@pagosproveedores.com',
      nombre: 'Cajero 3',
      rolNombre: 'CAJERO'
    },
    {
      email: 'cajero4@pagosproveedores.com',
      nombre: 'Cajero 4 (CXC)',
      rolNombre: 'CAJERO'
    }
  ];

  for (const usuario of usuarios) {
    const existingUsuario = await prisma.usuario.findUnique({
      where: { email: usuario.email }
    });

    if (!existingUsuario) {
      await prisma.usuario.create({
        data: {
          email: usuario.email,
          nombre: usuario.nombre,
          password: hashedPassword,
          rolId: createdRoles[usuario.rolNombre].id
        }
      });
      console.log(`✅ Usuario creado: ${usuario.email} (${usuario.rolNombre})`);
    } else {
      console.log(`ℹ️  Usuario ya existe: ${usuario.email}`);
    }
  }

  // Configuración de marca por defecto (singleton)
  const existingBranding = await prisma.brandingConfig.findFirst();
  if (!existingBranding) {
    await prisma.brandingConfig.create({ data: {} });
    console.log('✅ Branding por defecto creado');
  } else {
    console.log('ℹ️  Branding ya existe');
  }

  console.log('✨ Seed completado exitosamente!');
  console.log('\n📝 Credenciales por defecto:');
  console.log(
    '   Email: admin@pagosproveedores.com | supervisor@pagosproveedores.com | cajero1@pagosproveedores.com'
  );
  console.log(`   Password: ${defaultPassword}`);
}

main()
  .catch((e) => {
    console.error('❌ Error en seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
