# Configuración Node.js en Hostinger – Errores frecuentes

## Configuración recomendada para que el build funcione

| Campo | Valor |
|-------|--------|
| **Package manager** | **npm** (no yarn ni pnpm) |
| **Node version** | **18** o **20** (recomendado **20** LTS). En el panel de Hostinger elige Node 20 si está disponible. |
| **Build command** | `npm run build` (o su alias `build:deploy`). Ninguno toca la base de datos. |
| **Output Directory** | **`dist`** |
| **Entry file** | **`dist/server.js`** |
| **Application root** | `public_html` (o la carpeta donde está el proyecto), **sin** `/` al final. |

- **`build` / `build:deploy`**: solo ejecutan `prisma generate` y `tsc` (no necesitan base de datos durante el build). Las tablas se crean/actualizan al arrancar si configuras `RUN_DB_PUSH_ON_START=true`.
- **`build:local`**: ejecuta además `prisma db push`; requiere `DATABASE_URL` en `.env`. Úsalo solo en local, nunca como Build command en Hostinger.

---

## Error "Failed to build the application" / Output directory null

Si el build termina bien en local pero en Hostinger ves **"Failed to build the application"** y el mensaje indica que el **directorio de salida** no está definido (output directory is null), hay que indicar dónde está el resultado del build:

- **Output Directory** (o "Build output directory"): pon **`dist`**

El proyecto compila TypeScript a la carpeta `dist/`; si el panel no sabe cuál es esa carpeta, el despliegue falla.

---

## Error "Cannot find module .../dist/server.js"

Si ves en los logs:

- `Cannot find module '.../public_html//dist/server.js'` (con **doble barra** `//`)
- `Error setting directory to: .../public_html/` (ENOENT)

es que la **ruta de la aplicación** o el **archivo de entrada** en Hostinger están mal configurados.

## Cómo debe quedar en el panel de Hostinger

En la sección donde configuras la **aplicación Node.js** (Application / Node.js app):

| Campo | Valor correcto | Evitar |
|-------|----------------|--------|
| **Output Directory** (o "Build output directory") | **`dist`** | dejar vacío o null |
| **Application root** (o "Start path") | `public_html` **sin barra al final** | `public_html/` |
| **Entry file** (o "Application startup file") | `dist/server.js` **sin barra al inicio** | `/dist/server.js` |

La ruta final que debe usar Hostinger es:

- `public_html` + `dist/server.js` → `public_html/dist/server.js`

Si pones **Application root** con barra al final (`public_html/`) y **Entry** con barra al inicio (`/dist/server.js`), puede generarse `public_html//dist/server.js` y fallar.

## Comprobar que `dist` existe

En el **Administrador de archivos** de Hostinger, dentro de la carpeta donde está el proyecto (por ejemplo `public_html`), debe existir:

```
public_html/
  dist/
    server.js   ← este archivo debe existir
  node_modules/
  package.json
```

Si no hay carpeta `dist` o no está `server.js`, el deploy no ha compilado bien. Asegúrate de que en el despliegue se ejecute:

1. `npm install`
2. `npm run build` (que genera `dist/`)

y que el **Application root** apunte a la carpeta que **contiene** a `dist` (normalmente `public_html`).

## Variables de entorno y archivo `.env`

Si ves en los logs:

- `No se encontró .env en .../public_html/.env`
- `DATABASE_URL no está definida`

debes **crear el archivo `.env` en el servidor** dentro de la carpeta del proyecto (la misma que contiene `dist/`), por ejemplo `public_html/.env`.

1. En el **Administrador de archivos** de Hostinger, entra en `public_html`.
2. Crea un archivo llamado exactamente `.env` (con el punto delante).
3. Dentro del archivo, añade al menos (sustituye por tus datos de MySQL de Hostinger):

   ```env
   DATABASE_URL="mysql://USUARIO:CONTRASEÑA@HOST:3306/NOMBRE_BD"
   ```

   Los datos (usuario, contraseña, host, nombre de BD) los ves en el panel de Hostinger en **Bases de datos MySQL** / tu base de datos.

4. Guarda el archivo y reinicia la aplicación Node.js.

Si tu plan de Hostinger permite **Variables de entorno** en la configuración de la app Node.js, también puedes definir ahí `DATABASE_URL` en lugar de usar `.env`.

## Resumen

1. **Package manager**: **npm**.
2. **Node version**: **18** o **20** (recomendado **20**).
3. **Build command**: **`npm run build`** (no toca la BD; las variables llegan en runtime).
4. **Output Directory**: **`dist`**.
5. **Application root**: carpeta del proyecto, **sin** `/` al final (ej: `public_html`).
6. **Entry file**: **`dist/server.js`**, **sin** `/` al inicio.
7. **Archivo `.env`** o variables en el panel: `DATABASE_URL`, `JWT_SECRET`, y opcionalmente **`RUN_DB_PUSH_ON_START=true`** para crear/actualizar tablas al arrancar.
8. Tras cambiar, guardar y reiniciar la aplicación Node.js en el panel.
