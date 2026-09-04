import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/** Resumen de DATABASE_URL sin credenciales (solo host/puerto/BD). */
export function summarizeDatabaseUrl(dbUrl: string): {
  ok: boolean;
  host?: string;
  port?: string;
  database?: string;
  hint?: string;
} {
  const trimmed = (dbUrl || '').trim();
  if (!trimmed.toLowerCase().startsWith('mysql://')) {
    return { ok: false, hint: 'no empieza por mysql://' };
  }
  try {
    const rest = trimmed.slice('mysql://'.length);
    const at = rest.lastIndexOf('@');
    const hostPart = at >= 0 ? rest.slice(at + 1) : rest;
    const q = hostPart.indexOf('?');
    const pathOnly = q >= 0 ? hostPart.slice(0, q) : hostPart;
    const slash = pathOnly.indexOf('/');
    const hostPort = slash >= 0 ? pathOnly.slice(0, slash) : pathOnly;
    const db = slash >= 0 ? pathOnly.slice(slash + 1) : '';
    const colon = hostPort.lastIndexOf(':');
    const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
    const port = colon >= 0 ? hostPort.slice(colon + 1) : '3306';
    return { ok: true, host, port, database: db || '(sin nombre en path)' };
  } catch {
    return { ok: false, hint: 'parseo fallido' };
  }
}

function prismaClientVersion(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const v = require('@prisma/client/package.json')?.version as string | undefined;
    return v;
  } catch {
    return undefined;
  }
}

/** Ruta del motor de consultas si existe (útil en Hostinger). */
function queryEnginePathHint(): string {
  try {
    const clientDir = path.dirname(require.resolve('@prisma/client'));
    const enginesDir = path.join(clientDir, '..', '.prisma', 'client');
    if (!fs.existsSync(enginesDir)) {
      const cwdGuess = path.join(process.cwd(), 'node_modules', '.prisma', 'client');
      return `(NO EXISTE ${enginesDir}; cwd_alternativa=${cwdGuess} existe=${fs.existsSync(cwdGuess)})`;
    }
    const names = fs.readdirSync(enginesDir).filter((n) => n.includes('query_engine') || n.includes('libquery_engine'));
    return names.length ? names.join(', ') : '(carpeta .prisma/client vacía o sin motor)';
  } catch (e: any) {
    return `(error listando motor: ${e?.message || e})`;
  }
}

function ulimitU(): string {
  if (process.platform === 'win32') return '(omitido en Windows)';
  try {
    return String(execSync('ulimit -u', { encoding: 'utf8' })).trim();
  } catch (e: any) {
    return `error: ${e?.message || String(e)}`;
  }
}

/**
 * Logs siempre visibles en panel de hosting (no depende de NODE_ENV).
 * Prefijo fijo [BOOT] para filtrar en runtime logs.
 */
export function logRuntimeBootstrap(phase: string): void {
  const t = new Date().toISOString();
  const mem = process.memoryUsage();
  const dbSummary = summarizeDatabaseUrl(process.env.DATABASE_URL || '');
  const lines: string[] = [
    `[BOOT] ${t} phase=${phase}`,
    `[BOOT] node=${process.version} pid=${process.pid} ppid=${process.ppid} arch=${process.arch} platform=${process.platform}`,
    `[BOOT] cwd=${process.cwd()}`,
    `[BOOT] __dirname=${typeof __dirname !== 'undefined' ? __dirname : '(n/a)'}`,
    `[BOOT] execPath=${process.execPath}`,
    `[BOOT] NODE_ENV=${process.env.NODE_ENV ?? '(undefined)'}`,
    `[BOOT] rssMB=${Math.round(mem.rss / 1024 / 1024)} heapUsedMB=${Math.round(mem.heapUsed / 1024 / 1024)}`,
    `[BOOT] ulimit -u=${ulimitU()}`,
    `[BOOT] @prisma/client version=${prismaClientVersion() ?? '(no leída)'}`,
    `[BOOT] motores en .prisma/client: ${queryEnginePathHint()}`,
    `[BOOT] DATABASE_URL (sin secretos)=${JSON.stringify(dbSummary)}`,
    `[BOOT] RUN_DB_PUSH_ON_START=${process.env.RUN_DB_PUSH_ON_START ?? '(no set)'}`,
    `[BOOT] PRISMA_QUERY_ENGINE_LIBRARY=${process.env.PRISMA_QUERY_ENGINE_LIBRARY ?? '(no set)'}`,
    `[BOOT] PRISMA_CLIENT_ENGINE_TYPE=${process.env.PRISMA_CLIENT_ENGINE_TYPE ?? '(no set)'}`,
  ];
  for (const line of lines) console.log(line);
}

export function logPrismaConnectError(phase: string, error: unknown): void {
  const t = new Date().toISOString();
  const e = error as any;
  const name = e?.name ?? typeof error;
  const message = e?.message != null ? String(e.message) : String(error);
  const code = e?.code != null ? String(e.code) : '';
  console.error(`[BOOT] ${t} phase=${phase} PRISMA_CONNECT_FAIL name=${name} code=${code || '(n/a)'}`);
  console.error(`[BOOT] ${t} phase=${phase} message=${message}`);
  if (typeof e?.stack === 'string' && e.stack.length > 0) {
    console.error(`[BOOT] ${t} phase=${phase} stack=\n${e.stack}`);
  }
  if (/PANIC|timer has gone away/i.test(message)) {
    console.error(
      `[BOOT] ${t} phase=${phase} hint=PANIC/timer suele ser motor Prisma vs Linux/OpenSSL o límites ulimit/procesos del hosting; revisa binaryTargets y npm install+prisma generate en el servidor.`
    );
  }
}
