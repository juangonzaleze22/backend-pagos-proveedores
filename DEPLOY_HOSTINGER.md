# Despliegue en Hostinger – Qué se ejecuta

## Configuración en el panel (resumen)

| Opción | Valor |
|--------|--------|
| **Package manager** | **npm** |
| **Node version** | **18** o **20** (recomendado **20**) |
| **Build command** | **`npm run build:deploy`** |
| **Output Directory** | **`dist`** |
| **Entry file** | **`dist/server.js`** |

- **`build:deploy`** no ejecuta `prisma db push` durante el build (evita fallos si no hay `DATABASE_URL` en ese momento). Para crear/actualizar tablas al arrancar, define **`RUN_DB_PUSH_ON_START=true`** en las variables de entorno.

---

## Cuando haces **build** en Hostinger: usa `npm run build:deploy`

En el panel de Hostinger configura el **Build command** como:

```bash
npm run build:deploy
```

Ese script hace:

1. Borra la carpeta `dist`
2. `prisma generate` – genera el cliente de Prisma
3. `tsc` – compila TypeScript a JavaScript en `dist/`

**No** ejecuta `prisma db push` durante el build (así no falla si `DATABASE_URL` no está disponible en ese momento). Para que las tablas se creen/actualicen al arrancar la app, define la variable **`RUN_DB_PUSH_ON_START=true`** en el panel.

---

## `npm run build` vs `npm run build:local`

- **`npm run build`** (y su alias `build:deploy`): NO toca la base de datos. Es el que debe ejecutar Hostinger. Hace:
  1. Borra `dist`
  2. `prisma generate`
  3. `tsc` – compila a `dist/`
  4. Copia assets

  Funciona aunque `DATABASE_URL` no exista durante el build (Hostinger inyecta las variables solo al arrancar el proceso Node).

- **`npm run build:local`**: incluye **`prisma db push`** y requiere `DATABASE_URL` en `.env`. Úsalo solo en tu PC o donde tengas la BD accesible. No lo uses como Build command en Hostinger.

---

## Cuando se **inicia** la app (`npm start` → `node dist/server.js`)

Solo se ejecuta:

1. Cargar variables de entorno (panel o `.env`)
2. Conectar a la base de datos (`prisma.$connect()`)
3. Arrancar Express

**No se ejecutan migraciones ni `db push` al iniciar.** Si la base de datos no tiene las tablas o columnas que espera el código, el servidor puede arrancar igual; el fallo aparecerá en la **primera petición** que use Prisma (error de tabla/columna inexistente).

---

## Riesgos en un proyecto nuevo

| Situación | Qué puede fallar |
|-----------|-------------------|
| Base de datos vacía o sin tablas | `prisma db push` no se ejecutó (build sin BD) o falló. Al usar la API: error tipo "Table 'xxx' doesn't exist". |
| Schema cambiado (nuevo campo en `schema.prisma`) | Si no se ha vuelto a ejecutar `db push` o migraciones, la BD no tiene esa columna → error al leer/escribir ese campo. |
| Build en Hostinger sin `DATABASE_URL` | `prisma db push` falla → el build puede romperse o la BD quedarse desactualizada. |

---

## Qué hacer en un proyecto nuevo en Hostinger (sin consola)

1. **Crear la base de datos** en el panel de Hostinger (MySQL) y anotar usuario, contraseña, host y nombre de la BD.
2. **Variables de entorno** en el panel de Hostinger:
   - `DATABASE_URL` (MySQL)
   - `JWT_SECRET`, `NODE_ENV`, `JWT_EXPIRES_IN`, `API_BASE_URL`, etc.
   - **`RUN_DB_PUSH_ON_START` = `true`**  
     Con esto, cada vez que la app arranque (deploy o reinicio), se ejecutará **prisma db push** y se sincronizará el schema con la BD. No necesitas consola ni SSH.
3. **Deploy:** sube el código y deja que Hostinger ejecute build y start. La primera vez que arranque con `RUN_DB_PUSH_ON_START=true`, se crearán/actualizarán las tablas solas.
4. **Opcional – datos iniciales (seed):** el seed no se ejecuta solo. Si necesitas usuarios/roles iniciales, tendrías que ejecutar `npm run prisma:seed` alguna vez (por ejemplo desde tu PC con `DATABASE_URL` apuntando a la BD de Hostinger, o si en el futuro tienes acceso a ejecutar un script en el panel).

---

## Resumen

- **El build no toca la BD.** `npm run build` / `build:deploy` solo generan Prisma Client y compilan TypeScript. Las variables del panel no están disponibles en el build, por eso no debe haber `db push` ahí.
- **Las “migraciones” (schema aplicado a la BD)** se aplican en **runtime** con `prisma db push`, habilitado por `RUN_DB_PUSH_ON_START=true`, donde sí existen las variables de entorno.
- **Si algo falla por tablas o campos:** revisa que `RUN_DB_PUSH_ON_START=true` esté definido y mira en los logs las líneas `[DB_PUSH]` / `[BOOT]` del arranque.
- **En local**, usa `npm run build:local` si quieres que el build aplique el schema.
