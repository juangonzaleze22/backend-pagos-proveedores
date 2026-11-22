# API Vencedora - Pagos a Proveedores

API robusta desarrollada con Node.js, Express, PostgreSQL, Prisma y TypeScript para la gestión de pagos a proveedores.

## 🚀 Tecnologías

- **Node.js** + **Express** - Servidor y framework
- **PostgreSQL** - Base de datos
- **Prisma** - ORM
- **TypeScript** - Tipado estático
- **JWT** - Autenticación
- **Multer** - Manejo de archivos
- **Nodemon** - Auto-reload en desarrollo

## 📋 Requisitos Previos

- Node.js (v18 o superior)
- PostgreSQL (v14 o superior)
- npm o yarn

## 🔧 Instalación

1. Clonar el repositorio
```bash
git clone <url-del-repositorio>
cd api-vencedora-pagos-proveedores
```

2. Instalar dependencias
```bash
npm install
```

3. Configurar variables de entorno
```bash
# Copiar el archivo de ejemplo
cp .env.example .env

# Editar .env con tus credenciales
```

4. Configurar la base de datos
```bash
# Generar el cliente de Prisma
npm run prisma:generate

# Ejecutar migraciones
npm run prisma:migrate

# Ejecutar seed (crea roles y usuarios)
npm run prisma:seed
```

## 🏃 Ejecución

### Desarrollo
```bash
npm run dev
```

### Producción
```bash
npm run build
npm start
```

## 📁 Estructura del Proyecto

```
api-vencedora-pagos-proveedores/
├── prisma/
│   ├── schema.prisma      # Modelos de base de datos
│   └── seed.ts            # Datos iniciales
├── src/
│   ├── config/            # Configuraciones (DB, Multer, Env)
│   ├── controllers/       # Controladores de rutas
│   ├── middleware/        # Middlewares (Auth, Error, Validation)
│   ├── routes/            # Definición de rutas
│   ├── services/          # Lógica de negocio
│   ├── utils/             # Utilidades (Logger, JWT, Hash)
│   ├── types/             # Tipos TypeScript
│   ├── app.ts             # Configuración de Express
│   └── server.ts          # Punto de entrada
└── uploads/               # Archivos subidos
```

## 👥 Usuarios por Defecto (Seed)


## 🔐 Roles

- **ADMINISTRADOR**: Acceso completo al sistema
- **SUPERVISOR**: Supervisión y aprobación
- **CAJERO**: Operaciones de caja

## 📝 Scripts Disponibles

- `npm run dev` - Inicia el servidor en modo desarrollo con auto-reload
- `npm run build` - Compila TypeScript a JavaScript
- `npm start` - Inicia el servidor en modo producción
- `npm run prisma:generate` - Genera el cliente de Prisma
- `npm run prisma:migrate` - Ejecuta las migraciones
- `npm run prisma:seed` - Ejecuta el seed
- `npm run prisma:studio` - Abre Prisma Studio (GUI para la BD)

## 🌐 Endpoints

### Health Check
```
GET /health
```

## 🔒 Seguridad

- Passwords hasheados con bcrypt
- Autenticación JWT
- Helmet para headers de seguridad
- Validación de entrada
- Manejo seguro de errores

## 📦 Variables de Entorno

Ver `.env.example` para la lista completa de variables requeridas.

## 🐛 Troubleshooting

Si encuentras problemas:

1. Verifica que PostgreSQL esté corriendo
2. Revisa que las variables de entorno estén correctamente configuradas
3. Asegúrate de haber ejecutado las migraciones y el seed

## 📄 Licencia

ISC

