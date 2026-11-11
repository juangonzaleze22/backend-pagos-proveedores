import { env } from '../config/env';

/** Lista de nombres de archivo de facturas de un pedido. */
export function getInvoiceFileNames(order: { invoiceFiles?: unknown } | null | undefined): string[] {
  if (order?.invoiceFiles != null && Array.isArray(order.invoiceFiles)) {
    return order.invoiceFiles as string[];
  }
  return [];
}

/** URL de una factura: /api/orders/:id/invoice/:filename */
export function buildInvoiceUrl(orderId: number, fileName: string): string {
  const basePath = `/api/orders/${orderId}/invoice/${encodeURIComponent(fileName)}`;
  const timestampMatch = fileName.match(/invoice-(\d+)-/);
  const urlWithCache = timestampMatch ? `${basePath}?v=${timestampMatch[1]}` : basePath;
  if (env.API_BASE_URL) {
    const baseUrl = env.API_BASE_URL.replace(/\/$/, '');
    return `${baseUrl}${urlWithCache}`;
  }
  return urlWithCache;
}

export function buildInvoiceUrls(orderId: number, fileNames: string[]): string[] {
  return fileNames.map((name) => buildInvoiceUrl(orderId, name));
}

/**
 * Extrae el nombre del archivo de una URL de factura.
 * Ej: "http://localhost:3000/api/orders/5/invoice/invoice-123-456.JPG?v=123"
 *     -> "invoice-123-456.JPG"
 */
export function parseInvoiceFilenameFromUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const pathPart = url.split('?')[0];
    const match = pathPart.match(/\/invoice\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}
