import path from 'path';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import { Writable } from 'stream';
import { env } from '../config/env';
import type { SupplierDetailedReport, PaymentMethod, DebtStatus } from '../types';

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  ZELLE: 'Zelle',
  TRANSFER: 'Transferencia',
  CASH: 'Efectivo'
};

const DEBT_STATUS_LABELS: Record<DebtStatus, string> = {
  PENDING: 'Pendiente',
  PARTIALLY_PAID: 'Parcialmente pagado',
  PAID: 'Pagado',
  OVERDUE: 'Vencido'
};

// Colores del reporte
const COLORS = {
  primary: '#1e3a5f',
  primaryLight: '#2c5282',
  accent: '#2b6cb0',
  text: '#2d3748',
  textMuted: '#718096',
  border: '#e2e8f0',
  headerBg: '#f7fafc',
  boxBg: '#edf2f7',
  success: '#276749',
  warning: '#b7791f'
};

export interface PdfBranding {
  companyName?: string;
  reportTitle?: string;
  logoPath?: string | null;
  primaryColor?: string;
  accentColor?: string;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let value = hex.replace('#', '').trim();
  if (value.length === 3) {
    value = value.split('').map((c) => c + c).join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Aclara un color hex mezclándolo con blanco (amount 0..1). */
function lightenHex(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(
    rgb.r + (255 - rgb.r) * amount,
    rgb.g + (255 - rgb.g) * amount,
    rgb.b + (255 - rgb.b) * amount
  );
}

/** Luminancia relativa (WCAG) para decidir texto claro u oscuro. */
function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Texto legible sobre un fondo de color: blanco si es oscuro, gris oscuro si es claro. */
function contrastText(backgroundHex: string): string {
  return relativeLuminance(backgroundHex) > 0.5 ? '#1f2937' : '#ffffff';
}

/** Si el color de marca es muy claro, usa un tono oscuro para textos sobre fondos blancos. */
function readableOnLight(hex: string): string {
  return relativeLuminance(hex) > 0.6 ? '#1f2937' : hex;
}

function resolveColors(branding?: PdfBranding) {
  const primary = branding?.primaryColor || COLORS.primary;
  const accent = branding?.accentColor || COLORS.accent;
  const primaryLight = lightenHex(primary, 0.18);
  return {
    ...COLORS,
    primary,
    primaryLight,
    accent,
    primaryText: readableOnLight(primary),
    onPrimary: contrastText(primary),
    onPrimaryLight: contrastText(primaryLight),
    onAccent: contrastText(accent)
  };
}

function resolveUploadedLogo(logoPath?: string | null): string | null {
  if (!logoPath) return null;
  const relative = logoPath.replace(/^\/?uploads\//, '');
  const diskPath = path.isAbsolute(logoPath) ? logoPath : path.join(env.UPLOAD_PATH, relative);
  return fs.existsSync(diskPath) ? diskPath : null;
}

function getLogoPath(branding?: PdfBranding): string | null {
  const uploaded = resolveUploadedLogo(branding?.logoPath);
  if (uploaded) return uploaded;

  const candidates = [
    path.join(__dirname, '..', 'assets', 'logo.png'),
    path.join(process.cwd(), 'dist', 'assets', 'logo.png'),
    path.join(process.cwd(), 'src', 'assets', 'logo.png'),
    path.join(process.cwd(), 'assets', 'image', 'logo.png'),
    path.join(process.cwd(), 'assets', 'logo.png')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const TIMEZONE_VENEZUELA = 'America/Caracas';

function formatDate(d: Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('es-VE', {
    timeZone: TIMEZONE_VENEZUELA,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

/** Solo hora (HH:mm) en zona Venezuela, para columna separada. */
function formatTime(d: Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleTimeString('es-VE', {
    timeZone: TIMEZONE_VENEZUELA,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

/**
 * Genera un PDF con el reporte de pagos a un proveedor y lo escribe en el stream.
 */
export function generateSupplierPaymentsPdf(
  data: SupplierDetailedReport,
  writeStream: Writable,
  branding?: PdfBranding
): void {
  // Sombra la paleta global con los colores configurados por el cliente.
  const COLORS = resolveColors(branding);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(writeStream);

  const { supplier, totalPaid, paymentCount, debts, payments } = data;
  const pageWidth = 595;
  const margin = 50;
  const contentWidth = pageWidth - margin * 2;
  const maxY = 750;

  const companyName = branding?.companyName?.trim() || '';
  const reportTitle = branding?.reportTitle?.trim() || 'Reporte de Pagos a Proveedor';

  // ========== ENCABEZADO CON LOGO ==========
  const headerHeight = 64;
  doc.fillColor(COLORS.headerBg).rect(0, 0, pageWidth, headerHeight).fill();
  doc.strokeColor(COLORS.border).lineWidth(0.5).moveTo(0, headerHeight).lineTo(pageWidth, headerHeight).stroke();

  const logoPath = getLogoPath(branding);
  if (logoPath) {
    try {
      doc.image(logoPath, margin, 16, { width: 90, height: 32 });
    } catch {
      // Si falla la imagen, seguir sin logo
    }
  }

  const textX = logoPath ? margin + 100 : margin;
  const textWidth = logoPath ? contentWidth - 100 : contentWidth;
  const generatedAt = `Generado el ${formatDate(new Date())}`;

  if (companyName) {
    doc.fontSize(14).fillColor(COLORS.primaryText).font('Helvetica-Bold');
    doc.text(companyName, textX, 12, { width: textWidth });
    doc.fontSize(10).fillColor(COLORS.text).font('Helvetica-Bold');
    doc.text(reportTitle, textX, 30, { width: textWidth });
    doc.fontSize(8).fillColor(COLORS.textMuted).font('Helvetica');
    doc.text(generatedAt, textX, 45, { width: textWidth });
  } else {
    doc.fontSize(16).fillColor(COLORS.primaryText).font('Helvetica-Bold');
    doc.text(reportTitle, textX, 16, { width: textWidth });
    doc.fontSize(9).fillColor(COLORS.textMuted).font('Helvetica');
    doc.text(generatedAt, textX, 38, { width: textWidth });
  }

  doc.y = headerHeight + 22;

  // ========== INFORMACIÓN DEL PROVEEDOR (caja con fondo) ==========
  doc.fontSize(11).fillColor(COLORS.primaryText).font('Helvetica-Bold');
  doc.text('Datos del proveedor', margin, doc.y);
  doc.moveDown(0.4);
  const boxStartY = doc.y;
  const boxHeight = 68;
  doc.fillColor(COLORS.boxBg).rect(margin, boxStartY, contentWidth, boxHeight).fill();
  doc.strokeColor(COLORS.border).rect(margin, boxStartY, contentWidth, boxHeight).stroke();
  doc.fillColor(COLORS.text).font('Helvetica').fontSize(10);
  const boxInnerY = boxStartY + 8;
  doc.text(`Empresa: ${supplier.companyName}`, margin + 12, boxInnerY, { width: contentWidth - 24 });
  doc.text(`RIF: ${supplier.taxId ?? 'N/A'}`, margin + 12, boxInnerY + 14, { width: contentWidth - 24 });
  doc.text(`Teléfono: ${supplier.phone ?? 'N/A'}  |  Email: ${supplier.email ?? 'N/A'}`, margin + 12, boxInnerY + 28, {
    width: contentWidth - 24
  });
  doc.font('Helvetica-Bold').fillColor(COLORS.primaryText);
  doc.text(`Deuda total actual: USD ${formatCurrency(supplier.totalDebt)}`, margin + 12, boxInnerY + 44, {
    width: contentWidth - 24
  });
  doc.y = boxStartY + boxHeight + 18;

  // ========== RESUMEN DEL PERIODO (2 bloques visuales) ==========
  doc.fontSize(11).fillColor(COLORS.primaryText).font('Helvetica-Bold');
  doc.text('Resumen del periodo', margin, doc.y);
  doc.moveDown(0.5);

  const cardGap = 10;
  const cardWidth = (contentWidth - cardGap) / 2;
  const cardHeight = 42;
  const cardY = doc.y;

  doc.fillColor(COLORS.primaryLight).rect(margin, cardY, cardWidth, cardHeight).fill();
  doc.fillColor(COLORS.onPrimaryLight).font('Helvetica').fontSize(8).text('Total pagado (USD)', margin + 8, cardY + 7, {
    width: cardWidth - 16
  });
  doc.font('Helvetica-Bold').fontSize(13).text(formatCurrency(totalPaid), margin + 8, cardY + 22, {
    width: cardWidth - 16
  });

  const card2X = margin + cardWidth + cardGap;
  doc.fillColor(COLORS.accent).rect(card2X, cardY, cardWidth, cardHeight).fill();
  doc.fillColor(COLORS.onAccent).font('Helvetica').fontSize(8).text('Cantidad de pagos', card2X + 8, cardY + 7, {
    width: cardWidth - 16
  });
  doc.font('Helvetica-Bold').fontSize(13).text(String(paymentCount), card2X + 8, cardY + 22, {
    width: cardWidth - 16
  });

  doc.y = cardY + cardHeight + 20;

  // Agrupar pagos por deuda para mostrar cada deuda con sus pagos y su desglose
  const paymentsByDebtId: Record<number, typeof payments> = {};
  for (const p of payments) {
    if (!paymentsByDebtId[p.debtId]) paymentsByDebtId[p.debtId] = [];
    paymentsByDebtId[p.debtId].push(p);
  }

  const colWidths = {
    fecha: 50,
    hora: 32,
    monto: 48,
    metodo: 50,
    remitente: 62,
    confirmacion: 52,
    bs: 42,
    tasa: 38,
    cajero: 58
  };
  const tableLeft = margin;
  const rowH = 18;

  for (const d of debts) {
    const debtLabel = d.title ? `#${d.debtNumber ?? d.id} - ${d.title}` : `#${d.debtNumber ?? d.id}`;
    const debtPayments = paymentsByDebtId[d.id] ?? [];

    // ---------- Título: Detalle de pagos de {{deuda}} ----------
    if (doc.y + 100 > maxY) doc.addPage();
    doc.fontSize(11).fillColor(COLORS.primaryText).font('Helvetica-Bold');
    doc.text(`Detalle de pagos de ${debtLabel}`, margin, doc.y);
    doc.moveDown(0.4);

    // Tabla de pagos de esta deuda
    const headerY = doc.y;
    doc.fillColor(COLORS.headerBg).rect(tableLeft, headerY, contentWidth, rowH).fill();
    doc.strokeColor(COLORS.border).rect(tableLeft, headerY, contentWidth, rowH).stroke();
    doc.fontSize(8).fillColor(COLORS.primaryText).font('Helvetica-Bold');
    let x = tableLeft + 6;
    doc.text('Fecha', x, headerY + 5, { width: colWidths.fecha }); x += colWidths.fecha;
    doc.text('Hora', x, headerY + 5, { width: colWidths.hora }); x += colWidths.hora;
    doc.text('Monto USD', x, headerY + 5, { width: colWidths.monto }); x += colWidths.monto;
    doc.text('Método', x, headerY + 5, { width: colWidths.metodo }); x += colWidths.metodo;
    doc.text('Remitente', x, headerY + 5, { width: colWidths.remitente }); x += colWidths.remitente;
    doc.text('Confirm.', x, headerY + 5, { width: colWidths.confirmacion }); x += colWidths.confirmacion;
    doc.text('Bs', x, headerY + 5, { width: colWidths.bs }); x += colWidths.bs;
    doc.text('Tasa', x, headerY + 5, { width: colWidths.tasa }); x += colWidths.tasa;
    doc.text('Registrado por', x, headerY + 5, { width: colWidths.cajero });

    doc.font('Helvetica').fillColor(COLORS.text).fontSize(8);
    let y = headerY + rowH;
    for (let i = 0; i < debtPayments.length; i++) {
      if (y + rowH > maxY) {
        doc.addPage();
        y = 50;
      }
      const p = debtPayments[i];
      const bs = p.amountInBolivares != null ? formatCurrency(p.amountInBolivares) : '-';
      const tasa = p.exchangeRate != null ? formatCurrency(p.exchangeRate) : '-';
      const cajero = (p.createdByUser?.nombre ?? '-').substring(0, 12);
      const remitente = (p.senderName || '-').substring(0, 12);
      const confirm = (p.confirmationNumber || '-').substring(0, 8);
      if (i % 2 === 1) {
        doc.save();
        doc.fillColor('#f0f4f8').rect(tableLeft, y, contentWidth, rowH).fill();
        doc.restore();
      }
      doc.fillColor(COLORS.text).font('Helvetica').fontSize(8);
      x = tableLeft + 6;
      doc.text(formatDate(p.paymentDate), x, y + 5, { width: colWidths.fecha }); x += colWidths.fecha;
      doc.text(formatTime(p.paymentDate), x, y + 5, { width: colWidths.hora }); x += colWidths.hora;
      doc.text(formatCurrency(p.amount), x, y + 5, { width: colWidths.monto }); x += colWidths.monto;
      doc.text(PAYMENT_METHOD_LABELS[p.paymentMethod], x, y + 5, { width: colWidths.metodo }); x += colWidths.metodo;
      doc.text(remitente, x, y + 5, { width: colWidths.remitente }); x += colWidths.remitente;
      doc.text(confirm, x, y + 5, { width: colWidths.confirmacion }); x += colWidths.confirmacion;
      doc.text(bs, x, y + 5, { width: colWidths.bs }); x += colWidths.bs;
      doc.text(tasa, x, y + 5, { width: colWidths.tasa }); x += colWidths.tasa;
      doc.text(cajero, x, y + 5, { width: colWidths.cajero });
      doc.strokeColor(COLORS.border).moveTo(tableLeft, y + rowH).lineTo(tableLeft + contentWidth, y + rowH).stroke();
      y += rowH;
    }
    if (debtPayments.length === 0) {
      doc.text('No hay pagos en el periodo para esta deuda.', tableLeft + 12, y + 6);
      y += rowH;
    }
    doc.y = y + 10;

    // Footer: resumen de la deuda (padding generoso para que no choque con la card)
    const totalPagadoDeuda = d.initialAmount - d.remainingAmount;
    const footerTitleH = 14;
    const bodyPadH = 18;
    const bodyPadV = 14;
    const row1Y = bodyPadV;
    const row2Y = bodyPadV + 22;
    const footerBodyH = bodyPadV + 22 + 12 + bodyPadV + 6;
    const footerH = footerTitleH + footerBodyH;
    if (doc.y + footerH > maxY) doc.addPage();
    const footerY = doc.y;
    doc.fillColor(COLORS.primaryLight).rect(margin, footerY, contentWidth, footerTitleH).fill();
    doc.fillColor(COLORS.onPrimaryLight).font('Helvetica-Bold').fontSize(8);
    doc.text('Resumen de la deuda', margin + bodyPadH, footerY + 4, { width: contentWidth - bodyPadH * 2 });
    doc.fillColor(COLORS.boxBg).rect(margin, footerY + footerTitleH, contentWidth, footerBodyH).fill();
    doc.strokeColor(COLORS.border).lineWidth(0.5).rect(margin, footerY, contentWidth, footerH).stroke();
    const bodyY = footerY + footerTitleH;
    const innerW = contentWidth - bodyPadH * 2;
    const colW = innerW / 3;
    const x1 = margin + bodyPadH;
    const x2 = margin + bodyPadH + colW;
    const x3 = margin + bodyPadH + colW * 2;
    doc.font('Helvetica');
    doc.fillColor(COLORS.textMuted).fontSize(7);
    doc.text('Monto inicial', x1, bodyY + row1Y, { width: colW });
    doc.text('Total pagado', x2, bodyY + row1Y, { width: colW });
    doc.text('Monto restante', x3, bodyY + row1Y, { width: colW });
    doc.fillColor(COLORS.text).fontSize(9);
    doc.text(`${formatCurrency(d.initialAmount)} USD`, x1, bodyY + row1Y + 10, { width: colW });
    doc.text(`${formatCurrency(totalPagadoDeuda)} USD`, x2, bodyY + row1Y + 10, { width: colW });
    doc.text(`${formatCurrency(d.remainingAmount)} USD`, x3, bodyY + row1Y + 10, { width: colW });
    doc.fillColor(COLORS.textMuted).fontSize(7);
    doc.text('Estado', x1, bodyY + row2Y, { width: colW });
    doc.text('Vence', x2, bodyY + row2Y, { width: colW });
    doc.text('Saldo excedente asignado', x3, bodyY + row2Y, { width: colW });
    doc.fillColor(COLORS.text).fontSize(9);
    doc.text(DEBT_STATUS_LABELS[d.status], x1, bodyY + row2Y + 10, { width: colW });
    doc.text(formatDate(d.dueDate), x2, bodyY + row2Y + 10, { width: colW });
    const saldoExcedenteLabel =
      d.surplusAmountAtCreation != null && Number(d.surplusAmountAtCreation) > 0
        ? `${formatCurrency(Number(d.surplusAmountAtCreation))} USD`
        : '—';
    doc.text(saldoExcedenteLabel, x3, bodyY + row2Y + 10, { width: colW });
    doc.y = footerY + footerH + 18;
  }

  if (debts.length === 0) {
    doc.fontSize(11).fillColor(COLORS.primaryText).font('Helvetica-Bold');
    doc.text('Detalle de pagos', margin, doc.y);
    doc.moveDown(0.4);
    doc.font('Helvetica').fillColor(COLORS.textMuted).fontSize(9);
    doc.text('No hay deudas registradas para este proveedor.', margin, doc.y);
    doc.moveDown(0.5);
  }

  if (companyName) {
    doc.moveDown(1);
    doc.fontSize(8).fillColor(COLORS.textMuted).font('Helvetica');
    doc.text(`${companyName} · ${generatedAt}`, margin, doc.y, {
      width: contentWidth,
      align: 'center'
    });
  }

  doc.end();
}
