import prisma from '../config/database';
import { Prisma } from '@prisma/client';
import {
  CashierPaymentsResponse,
  CashierPaymentsSummary,
  CreatePaymentDTO,
  PaymentResponse,
  PaginationParams,
  PaginatedResponse,
  VerifyZelleDTO
} from '../types';
import { AppError } from '../middleware/error.middleware';
import { DebtService } from './debt.service';
import { SupplierService } from './supplier.service';
import { CreditService } from './credit.service';
import { env } from '../config/env';
import { getReceiptFileNames, buildReceiptUrl, buildReceiptUrls } from '../utils/receiptUrls';
import { brandingService } from './branding.service';

// PaymentMethod type
type PaymentMethod = 'ZELLE' | 'TRANSFER' | 'PAGO_MOVIL' | 'CASH';

const debtService = new DebtService();
const supplierService = new SupplierService();
const creditService = new CreditService();

export class PaymentService {
  async createPayment(
    data: CreatePaymentDTO,
    userId: number,
    receiptFileNames: string[] = [],
    receiptFilePaths?: string[]
  ): Promise<PaymentResponse> {
    try {
      console.log('💳 PaymentService.createPayment - Iniciando...');
      console.log('Datos recibidos:', { ...data, receiptFileNames, receiptFilePathsCount: receiptFilePaths?.length });
      
      const { debtId, supplierId, amount, paymentMethod, senderName, senderEmail, confirmationNumber, paymentDate, nota, exchangeRate, amountInBolivares, cashierId, surplusAction, surplusTargetDebtId } = data;

      // Determinar el createdBy: si se envía cashierId, validar que existe; si no, usar userId autenticado
      const effectiveCreatedBy = cashierId || userId;

      if (cashierId) {
        console.log(`🔍 Validando cajero con ID ${cashierId}...`);
        const cashierUser = await prisma.usuario.findUnique({
          where: { id: cashierId },
          select: { id: true, nombre: true, email: true }
        });
        if (!cashierUser) {
          throw new AppError(`Usuario cajero con ID ${cashierId} no encontrado`, 400);
        }
        console.log(`✅ Cajero validado: ${cashierUser.nombre} (${cashierUser.email})`);
      }

      console.log('🔍 Validando deuda...');
      // Validar que la deuda existe y pertenece al proveedor (select explícito para evitar columnas que no existan aún en la BD)
      const debt = await prisma.debt.findUnique({
        where: { id: debtId },
        select: {
          id: true,
          supplierId: true,
          initialAmount: true,
          remainingAmount: true,
          status: true,
          supplier: { select: { id: true, companyName: true } }
        }
      });

      if (!debt) {
        console.error('❌ Deuda no encontrada:', debtId);
        throw new Error('Deuda no encontrada');
      }

      console.log('✅ Deuda encontrada:', {
        id: debt.id,
        supplierId: debt.supplierId,
        initialAmount: debt.initialAmount,
        remainingAmount: debt.remainingAmount,
        status: debt.status
      });

      if (debt.supplierId !== supplierId) {
        console.error('❌ La deuda no pertenece al proveedor:', {
          debtSupplierId: debt.supplierId,
          providedSupplierId: supplierId
        });
        throw new Error('La deuda no pertenece al proveedor especificado');
      }

      // Validar que el monto sea mayor a 0
      if (Number(amount) <= 0) {
        console.error('❌ Monto inválido:', amount);
        throw new Error('El monto del pago debe ser mayor a 0');
      }

      // Validar que la deuda no esté completamente pagada
      if (debt.status === 'PAID' || Number(debt.remainingAmount) <= 0) {
        console.error('❌ La deuda ya está completamente pagada:', {
          status: debt.status,
          remainingAmount: debt.remainingAmount
        });
        throw new Error('Esta deuda ya está completamente pagada. No se pueden registrar más pagos');
      }

      const paymentAmount = Number(amount);
      const remainingAmount = Number(debt.remainingAmount);
      const surplusAmount = Math.max(0, paymentAmount - remainingAmount);

      console.log('✅ Validaciones de monto pasadas:', {
        paymentAmount,
        remainingAmount,
        surplusAmount: surplusAmount.toFixed(2),
        newRemainingAfterPayment: Math.max(0, remainingAmount - paymentAmount).toFixed(2)
      });

      // Validar confirmationNumber para Zelle y Transfer
      if ((paymentMethod === 'ZELLE' || paymentMethod === 'TRANSFER' || paymentMethod === 'PAGO_MOVIL') && !confirmationNumber) {
        console.error('❌ ConfirmationNumber requerido para:', paymentMethod);
        throw new Error('Número de confirmación requerido para este método de pago');
      }

      // Validar que el número de confirmación no esté duplicado (solo si se envía)
      const confirmationTrimmed = confirmationNumber?.trim();
      if (confirmationTrimmed) {
        const existingWithSameConfirmation = await prisma.payment.findFirst({
          where: {
            confirmationNumber: confirmationTrimmed,
            deletedAt: null
          }
        });
        if (existingWithSameConfirmation) {
          throw new AppError('Ya existe un pago con este número de confirmación', 400);
        }
      }

      // Resolver la cuenta de pago del proveedor usada (se guarda como snapshot)
      let destinationAccountSnapshot: any = null;
      if (data.destinationAccountId) {
        const account = await prisma.supplierPaymentAccount.findUnique({
          where: { id: data.destinationAccountId }
        });
        if (!account || account.supplierId !== supplierId) {
          throw new AppError('La cuenta de pago no existe o no pertenece al proveedor', 400);
        }
        destinationAccountSnapshot = this.buildAccountSnapshot(account);
      }

      console.log('💾 Creando pago en BD...');
      
      // Construir la URL del comprobante si hay archivo
      // La URL será: /api/payments/{paymentId}/receipt
      // Pero como aún no tenemos el ID, guardamos el nombre del archivo
      // y luego actualizaremos con la URL completa después de crear el pago
      
      // Guardar múltiples imágenes como JSON (receiptFiles); receiptFile se deja null
      const receiptFilesJson = receiptFileNames.length > 0 ? (receiptFileNames as unknown as object) : null;
      const payment = await prisma.payment.create({
        data: {
          debtId,
          supplierId,
          amount,
          paymentMethod,
          senderName,
          senderEmail: senderEmail || null,
          confirmationNumber: confirmationNumber || null,
          paymentDate: new Date(paymentDate),
          nota: nota || null,
          receiptFile: null,
          receiptFiles: receiptFilesJson,
          exchangeRate: exchangeRate ? exchangeRate : null,
          amountInBolivares: amountInBolivares ? amountInBolivares : null,
          surplusAmount: surplusAmount > 0 ? surplusAmount : null,
          ...(destinationAccountSnapshot && { destinationAccountSnapshot }),
          verified: false,
          createdBy: effectiveCreatedBy
        },
        include: {
          supplier: {
            select: {
              id: true,
              companyName: true,
              taxId: true,
              phone: true
            }
          },
          createdByUser: {
            select: {
              id: true,
              nombre: true,
              email: true
            }
          }
        }
      });

      console.log('✅ Pago creado en BD:', {
        paymentId: payment.id,
        amount: Number(payment.amount).toFixed(2),
        debtId: payment.debtId,
        receiptFiles: payment.receiptFiles,
        exchangeRate: payment.exchangeRate ? Number(payment.exchangeRate).toFixed(4) : null,
        amountInBolivares: payment.amountInBolivares ? Number(payment.amountInBolivares).toFixed(2) : null,
        createdAt: payment.createdAt
      });

      if (receiptFileNames.length > 0 && !payment.receiptFiles) {
        console.error('❌ ERROR: Los nombres de archivo no se guardaron en la BD');
        throw new Error('Error: Los archivos no se guardaron correctamente en la base de datos');
      }

      if (receiptFilePaths?.length) {
        const fs = await import('fs');
        for (const p of receiptFilePaths) {
          if (!fs.existsSync(p)) {
            console.error('❌ ERROR: El archivo físico no existe en:', p);
            throw new Error('Error: Un archivo no se guardó correctamente en el servidor');
          }
        }
        console.log('✅ Archivos físicos verificados:', receiptFilePaths.length);
      }

      const verifyPayment = await prisma.payment.findUnique({
        where: { id: payment.id },
        select: { id: true, amount: true, debtId: true, receiptFiles: true }
      });

      if (!verifyPayment) {
        throw new Error('Error: El pago no se guardó correctamente en la base de datos');
      }

      console.log('✅ Pago verificado en BD:', { id: verifyPayment.id, receiptFiles: verifyPayment.receiptFiles });

      console.log('🔄 Actualizando estado de deuda...');
      // Actualizar estado de la deuda (esto recalcula el remainingAmount basado en todos los pagos)
      // IMPORTANTE: Esto debe incluir el pago que acabamos de crear
      await debtService.updateDebtStatus(debtId);
      console.log('✅ Estado de deuda actualizado');

      // Obtener la deuda actualizada para verificar el nuevo monto restante
      const updatedDebt = await prisma.debt.findUnique({
        where: { id: debtId },
        select: {
          remainingAmount: true,
          status: true
        }
      });

      if (updatedDebt) {
        console.log('📊 Deuda actualizada:', {
          remainingAmount: updatedDebt.remainingAmount,
          status: updatedDebt.status
        });
      }

      console.log('🔄 Actualizando total de deuda del proveedor...');
      const amountAppliedToDebt = Math.min(paymentAmount, remainingAmount);
      await supplierService.updateSupplierTotalDebt(supplierId, -amountAppliedToDebt);
      console.log('✅ Total de deuda del proveedor actualizado:', {
        montoTotalPago: paymentAmount,
        montoAplicadoADeuda: amountAppliedToDebt,
        excedente: surplusAmount
      });

      // Obtener el proveedor actualizado para verificar el nuevo total
      const updatedSupplier = await prisma.supplier.findUnique({
        where: { id: supplierId },
        select: {
          totalDebt: true
        }
      });

      if (updatedSupplier) {
        console.log('📊 Proveedor actualizado:', {
          totalDebt: updatedSupplier.totalDebt
        });
      }

      console.log('🔄 Actualizando última fecha de pago...');
      await supplierService.updateSupplierLastPaymentDate(supplierId, new Date(paymentDate));
      console.log('✅ Última fecha de pago actualizada');

      // Manejar excedente aplicado directamente a otra deuda (APPLY_TO_DEBT)
      let appliedToTargetAmount = 0;
      if (surplusAmount > 0 && surplusAction === 'APPLY_TO_DEBT' && surplusTargetDebtId) {
        console.log(`💰 Excedente detectado: $${surplusAmount.toFixed(2)}`);

        const targetDebt = await prisma.debt.findUnique({
          where: { id: surplusTargetDebtId }
        });

        if (!targetDebt) {
          throw new AppError('Deuda destino para el excedente no encontrada', 400);
        }

        if (targetDebt.status === 'PAID' || Number(targetDebt.remainingAmount) <= 0) {
          throw new AppError('La deuda destino ya está completamente pagada', 400);
        }

        const targetRemaining = Number(targetDebt.remainingAmount);
        const amountForTarget = Math.min(surplusAmount, targetRemaining);
        appliedToTargetAmount = amountForTarget;

        await prisma.debt.update({
          where: { id: surplusTargetDebtId },
          data: {
            remainingAmount: Math.max(0, targetRemaining - amountForTarget),
            status: targetRemaining - amountForTarget <= 0 ? 'PAID' : 'PENDING'
          }
        });

        console.log(`✅ Excedente aplicado a deuda #${surplusTargetDebtId}: $${amountForTarget.toFixed(2)}`);

        await supplierService.updateSupplierTotalDebt(targetDebt.supplierId, -amountForTarget);
      }

      if (appliedToTargetAmount > 0 && surplusTargetDebtId) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            surplusTargetDebtId: surplusTargetDebtId,
            surplusAppliedToDebt: appliedToTargetAmount
          }
        });
      }

      // Reconciliar créditos del proveedor para evitar inconsistencias
      console.log('🔄 Reconciliando créditos del proveedor...');
      await creditService.reconcileSupplierCredits(supplierId);
      console.log('✅ Créditos reconciliados');

      const names = getReceiptFileNames(payment);
      const receiptFilesUrls = buildReceiptUrls(payment.id, names);

      // Buscar el crédito resultante asociado al pago o a la deuda de origen
      const creditCreated = await prisma.credit.findFirst({
        where: {
          supplierId,
          OR: [{ paymentId: payment.id }, { originDebtId: debtId }]
        },
        orderBy: { id: 'desc' }
      });

      const response: PaymentResponse = {
        id: payment.id,
        debtId: payment.debtId,
        supplierId: payment.supplierId,
        supplier: payment.supplier,
        amount: Number(payment.amount),
        paymentMethod: payment.paymentMethod,
        senderName: payment.senderName,
        senderEmail: payment.senderEmail,
        confirmationNumber: payment.confirmationNumber,
        paymentDate: payment.paymentDate,
        nota: payment.nota || null,
        receiptFiles: receiptFilesUrls,
        verified: payment.verified,
        shared: payment.shared || false,
        sharedAt: payment.sharedAt || null,
        exchangeRate: payment.exchangeRate ? Number(payment.exchangeRate) : null,
        amountInBolivares: payment.amountInBolivares ? Number(payment.amountInBolivares) : null,
        surplusAmount: surplusAmount > 0 ? surplusAmount : null,
        destinationAccount: this.mapDestinationAccount(payment.destinationAccountSnapshot),
        createdBy: payment.createdBy,
        createdByUser: payment.createdByUser || null,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
        credit: creditCreated ? {
          id: creditCreated.id,
          paymentId: creditCreated.paymentId,
          originDebtId: creditCreated.originDebtId,
          supplierId: creditCreated.supplierId,
          amount: Number(creditCreated.amount),
          remaining: Number(creditCreated.remaining),
          status: creditCreated.status as any,
          description: creditCreated.description,
          createdAt: creditCreated.createdAt,
          updatedAt: creditCreated.updatedAt
        } : null
      };

      console.log('✅ PaymentService.createPayment - Completado exitosamente');
      console.log('💰 Resumen del pago:', {
        pagoId: response.id,
        montoPagado: response.amount,
        excedente: surplusAmount > 0 ? surplusAmount.toFixed(2) : 'N/A',
        creditoCreado: creditCreated?.id || 'N/A',
        deudaId: response.debtId,
        montoRestanteDeuda: updatedDebt?.remainingAmount,
        estadoDeuda: updatedDebt?.status,
        totalDeudaProveedor: updatedSupplier?.totalDebt
      });

      return response;
    } catch (error: any) {
      console.error('❌ Error en PaymentService.createPayment:', error);
      console.error('Stack:', error?.stack);
      throw error;
    }
  }

  async getPaymentById(id: number, includeDeleted: boolean = false): Promise<PaymentResponse | null> {
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: {
        supplier: {
          select: {
            id: true,
            companyName: true,
            taxId: true,
            phone: true
          }
        },
        debt: {
          select: {
            id: true,
            orderId: true,
            status: true,
            initialAmount: true,
            remainingAmount: true,
            dueDate: true,
            title: true,
            createdAt: true,
            updatedAt: true
          }
        },
        createdByUser: {
          select: {
            id: true,
            nombre: true,
            email: true
          }
        },
        deletedByUser: includeDeleted ? {
          select: {
            id: true,
            nombre: true,
            email: true
          }
        } : false
      }
    });

    if (!payment) {
      return null;
    }

    // Si no se incluyen eliminados y el pago está eliminado, retornar null
    if (!includeDeleted && payment.deletedAt) {
      return null;
    }

    const receiptFilesUrls = buildReceiptUrls(payment.id, getReceiptFileNames(payment));

    return {
      id: payment.id,
      debtId: payment.debtId,
      supplierId: payment.supplierId,
      supplier: payment.supplier,
      amount: Number(payment.amount),
      paymentMethod: payment.paymentMethod,
      senderName: payment.senderName,
      senderEmail: payment.senderEmail,
      confirmationNumber: payment.confirmationNumber,
      paymentDate: payment.paymentDate,
      nota: payment.nota || null,
      receiptFiles: receiptFilesUrls,
      verified: payment.verified,
      shared: payment.shared || false,
      sharedAt: payment.sharedAt || null,
      exchangeRate: payment.exchangeRate ? Number(payment.exchangeRate) : null,
      amountInBolivares: payment.amountInBolivares ? Number(payment.amountInBolivares) : null,
      surplusAmount: payment.surplusAmount ? Number(payment.surplusAmount) : null,
      destinationAccount: this.mapDestinationAccount(payment.destinationAccountSnapshot),
      createdBy: payment.createdBy,
      createdByUser: payment.createdByUser || null,
      deletedAt: payment.deletedAt || null,
      deletedBy: payment.deletedBy || null,
      deletedByUser: payment.deletedByUser ? {
        id: payment.deletedByUser.id,
        nombre: payment.deletedByUser.nombre,
        email: payment.deletedByUser.email
      } : null,
      deletionReason: payment.deletionReason || null,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      debt: payment.debt ? {
        id: payment.debt.id,
        orderId: payment.debt.orderId,
        status: payment.debt.status,
        initialAmount: Number(payment.debt.initialAmount),
        remainingAmount: Number(payment.debt.remainingAmount),
        dueDate: payment.debt.dueDate,
        title: payment.debt.title ?? undefined,
        createdAt: payment.debt.createdAt,
        updatedAt: payment.debt.updatedAt
      } : undefined
    };
  }

  async getPaymentsByDebt(
    debtId: number,
    params?: PaginationParams & { startDate?: Date; endDate?: Date }
  ): Promise<PaginatedResponse<PaymentResponse>> {
    try {
      const page = params?.page || 1;
      const limit = params?.limit || 10;
      const skip = (page - 1) * limit;
      const includeDeleted = params?.includeDeleted || false;

      // Construir el filtro where
      const where: any = { debtId };
      
      // Excluir eliminados por defecto
      if (!includeDeleted) {
        where.deletedAt = null;
      }
      
      // Filtrar por rango de fechas si se proporciona
      if (params?.startDate || params?.endDate) {
        where.paymentDate = {};
        if (params.startDate) {
          const start = new Date(params.startDate);
          start.setUTCHours(0, 0, 0, 0);
          where.paymentDate.gte = start;
        }
        if (params.endDate) {
          const end = new Date(params.endDate);
          end.setUTCHours(23, 59, 59, 999);
          where.paymentDate.lte = end;
        }
      }

      const [payments, total] = await Promise.all([
        prisma.payment.findMany({
          where,
          include: {
            supplier: {
              select: {
                id: true,
                companyName: true,
                taxId: true,
                phone: true
              }
            },
            createdByUser: {
              select: {
                id: true,
                nombre: true,
                email: true
              }
            },
            deletedByUser: includeDeleted ? {
              select: {
                id: true,
                nombre: true,
                email: true
              }
            } : false
          },
          orderBy: {
            createdAt: 'desc'
          },
          skip,
          take: limit
        }),
        prisma.payment.count({ where })
      ]);

      console.log('🔍 Pagos recuperados de BD (primer pago):', payments.length > 0 ? {
        id: payments[0].id,
        exchangeRate: payments[0].exchangeRate,
        amountInBolivares: payments[0].amountInBolivares,
        exchangeRateType: typeof payments[0].exchangeRate,
        amountInBolivaresType: typeof payments[0].amountInBolivares
      } : 'No hay pagos');

      return {
        data: payments.map((payment: any) => {
          const receiptFilesUrls = buildReceiptUrls(payment.id, getReceiptFileNames(payment));
          return {
            id: payment.id,
            debtId: payment.debtId,
            supplierId: payment.supplierId,
            supplier: payment.supplier,
            amount: Number(payment.amount),
            paymentMethod: payment.paymentMethod,
            senderName: payment.senderName,
            senderEmail: payment.senderEmail,
            confirmationNumber: payment.confirmationNumber,
            paymentDate: payment.paymentDate,
            nota: payment.nota || null,
            receiptFiles: receiptFilesUrls,
            verified: payment.verified,
            shared: payment.shared || false,
            sharedAt: payment.sharedAt || null,
            exchangeRate: payment.exchangeRate ? Number(payment.exchangeRate) : null,
            amountInBolivares: payment.amountInBolivares ? Number(payment.amountInBolivares) : null,
            surplusAmount: payment.surplusAmount ? Number(payment.surplusAmount) : null,
            destinationAccount: this.mapDestinationAccount(payment.destinationAccountSnapshot),
            createdBy: payment.createdBy,
            createdByUser: payment.createdByUser || null,
            deletedAt: payment.deletedAt || null,
            deletedBy: payment.deletedBy || null,
            deletedByUser: payment.deletedByUser ? {
              id: payment.deletedByUser.id,
              nombre: payment.deletedByUser.nombre,
              email: payment.deletedByUser.email
            } : null,
            deletionReason: payment.deletionReason || null,
            createdAt: payment.createdAt,
            updatedAt: payment.updatedAt
          };
        }),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      };
    } catch (error: any) {
      console.error('❌ Error en PaymentService.getPaymentsByDebt:', error);
      throw error;
    }
  }

  async getPaymentsByCashier(
    cashierId: number,
    params?: PaginationParams & { startDate?: Date; endDate?: Date; paymentMethod?: string }
  ): Promise<CashierPaymentsResponse> {
    const page = params?.page || 1;
    const limit = params?.limit || 10;
    const skip = (page - 1) * limit;
    const includeDeleted = params?.includeDeleted || false;

    // Filtrar pagos registrados por este cajero (createdBy)
    const where: any = { createdBy: cashierId };

    // Excluir eliminados por defecto
    if (!includeDeleted) {
      where.deletedAt = null;
    }

    // Filtrar por método de pago si se proporciona
    if (params?.paymentMethod) {
      where.paymentMethod = params.paymentMethod;
    }

    // Filtrar por rango de fechas si se proporciona
    if (params?.startDate || params?.endDate) {
      where.paymentDate = {};
      if (params?.startDate) {
        const start = new Date(params.startDate);
        start.setUTCHours(0, 0, 0, 0);
        where.paymentDate.gte = start;
      }
      if (params?.endDate) {
        const end = new Date(params.endDate);
        end.setUTCHours(23, 59, 59, 999);
        where.paymentDate.lte = end;
      }
    }

    const [
      payments,
      total,
      aggregateTotals,
      groupByMethod,
      suppliersInRange
    ] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          supplier: {
            select: {
              id: true,
              companyName: true,
              taxId: true,
              phone: true
            }
          },
          debt: {
            select: {
              id: true,
              initialAmount: true,
              remainingAmount: true,
              status: true,
              order: {
                select: {
                  id: true,
                  dispatchDate: true
                }
              }
            }
          },
          createdByUser: {
            select: {
              id: true,
              nombre: true,
              email: true
            }
          },
          deletedByUser: includeDeleted ? {
            select: {
              id: true,
              nombre: true,
              email: true
            }
          } : false
        },
        orderBy: {
          createdAt: 'desc'
        },
        skip,
        take: limit
      }),
      prisma.payment.count({ where }),
      prisma.payment.aggregate({
        where,
        _sum: { amount: true, amountInBolivares: true }
      }),
      prisma.payment.groupBy({
        by: ['paymentMethod'],
        where,
        _sum: { amount: true },
        _count: { _all: true }
      }),
      prisma.payment.groupBy({
        by: ['supplierId'],
        where
      })
    ]);

    const byPaymentMethod: CashierPaymentsSummary['byPaymentMethod'] = {
      ZELLE: { count: 0, totalUsd: 0 },
      TRANSFER: { count: 0, totalUsd: 0 },
      PAGO_MOVIL: { count: 0, totalUsd: 0 },
      CASH: { count: 0, totalUsd: 0 }
    };
    for (const row of groupByMethod) {
      const method = row.paymentMethod as PaymentMethod;
      byPaymentMethod[method] = {
        count: row._count._all,
        totalUsd: Number(row._sum.amount ?? 0)
      };
    }

    const summary: CashierPaymentsSummary = {
      totalPayments: total,
      totalAmountUsd: Number(aggregateTotals._sum.amount ?? 0),
      totalAmountBs: Number(aggregateTotals._sum.amountInBolivares ?? 0),
      providersServed: suppliersInRange.length,
      byPaymentMethod
    };

    return {
      summary,
      data: payments.map((payment: any) => {
        const receiptFilesUrls = buildReceiptUrls(payment.id, getReceiptFileNames(payment));
        return {
          id: payment.id,
          debtId: payment.debtId,
          supplierId: payment.supplierId,
          supplier: payment.supplier,
          debt: payment.debt,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          senderName: payment.senderName,
          senderEmail: payment.senderEmail,
          confirmationNumber: payment.confirmationNumber,
          paymentDate: payment.paymentDate,
          nota: payment.nota || null,
          receiptFiles: receiptFilesUrls,
          verified: payment.verified,
          exchangeRate: payment.exchangeRate ? Number(payment.exchangeRate) : null,
          amountInBolivares: payment.amountInBolivares ? Number(payment.amountInBolivares) : null,
          surplusAmount: payment.surplusAmount ? Number(payment.surplusAmount) : null,
          destinationAccount: this.mapDestinationAccount(payment.destinationAccountSnapshot),
          createdBy: payment.createdBy,
          createdByUser: payment.createdByUser,
          deletedAt: payment.deletedAt || null,
          deletedBy: payment.deletedBy || null,
          deletedByUser: payment.deletedByUser ? {
            id: payment.deletedByUser.id,
            nombre: payment.deletedByUser.nombre,
            email: payment.deletedByUser.email
          } : null,
          deletionReason: payment.deletionReason || null,
          createdAt: payment.createdAt,
          updatedAt: payment.updatedAt
        };
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  async getPaymentsBySupplier(
    supplierId: number,
    params?: PaginationParams & { debtId?: number; startDate?: Date; endDate?: Date }
  ): Promise<PaginatedResponse<PaymentResponse>> {
    const page = params?.page || 1;
    const limit = params?.limit || 10;
    const skip = (page - 1) * limit;
    const includeDeleted = params?.includeDeleted || false;

    // Construir el filtro where
    const where: any = { supplierId };
    if (params?.debtId) {
      where.debtId = params.debtId;
    }
    
    // Excluir eliminados por defecto
    if (!includeDeleted) {
      where.deletedAt = null;
    }
    
    // Filtrar por rango de fechas si se proporciona
    if (params?.startDate || params?.endDate) {
      where.paymentDate = {};
      if (params.startDate) {
        const start = new Date(params.startDate);
        start.setUTCHours(0, 0, 0, 0);
        where.paymentDate.gte = start;
      }
      if (params.endDate) {
        const end = new Date(params.endDate);
        end.setUTCHours(23, 59, 59, 999);
        where.paymentDate.lte = end;
      }
    }

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          supplier: {
            select: {
              id: true,
              companyName: true,
              taxId: true,
              phone: true
            }
          },
          createdByUser: {
              select: {
                id: true,
                nombre: true,
                email: true
              }
            },
            deletedByUser: includeDeleted ? {
              select: {
                id: true,
                nombre: true,
                email: true
              }
            } : false
          },
          orderBy: {
            createdAt: 'desc'
          },
          skip,
          take: limit
        }),
        prisma.payment.count({ where })
      ]);

      return {
        data: payments.map((payment: any) => {
          const receiptFilesUrls = buildReceiptUrls(payment.id, getReceiptFileNames(payment));
          return {
            id: payment.id,
            debtId: payment.debtId,
            supplierId: payment.supplierId,
            supplier: payment.supplier,
            amount: Number(payment.amount),
            paymentMethod: payment.paymentMethod,
            senderName: payment.senderName,
            senderEmail: payment.senderEmail,
            confirmationNumber: payment.confirmationNumber,
            paymentDate: payment.paymentDate,
            nota: payment.nota || null,
            receiptFiles: receiptFilesUrls,
            verified: payment.verified,
            exchangeRate: payment.exchangeRate ? Number(payment.exchangeRate) : null,
            amountInBolivares: payment.amountInBolivares ? Number(payment.amountInBolivares) : null,
            surplusAmount: payment.surplusAmount ? Number(payment.surplusAmount) : null,
            destinationAccount: this.mapDestinationAccount(payment.destinationAccountSnapshot),
            createdBy: payment.createdBy,
            createdByUser: payment.createdByUser || null,
            deletedAt: payment.deletedAt || null,
            deletedBy: payment.deletedBy || null,
            deletedByUser: payment.deletedByUser ? {
              id: payment.deletedByUser.id,
              nombre: payment.deletedByUser.nombre,
              email: payment.deletedByUser.email
            } : null,
            deletionReason: payment.deletionReason || null,
            createdAt: payment.createdAt,
            updatedAt: payment.updatedAt
          };
        }),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      };
  }

  async getAllPayments(params?: PaginationParams): Promise<PaginatedResponse<PaymentResponse>> {
    try {
      const page = params?.page || 1;
      const limit = params?.limit || 10;
      const skip = (page - 1) * limit;
      const includeDeleted = params?.includeDeleted || false;

      // Construir el filtro where
      const where: any = {};
      if (!includeDeleted) {
        where.deletedAt = null;
      }

      console.log('Buscando pagos en BD...');
      const [payments, total] = await Promise.all([
        prisma.payment.findMany({
          where,
          include: {
            supplier: {
              select: {
                id: true,
                companyName: true,
                taxId: true,
                phone: true
              }
            },
            createdByUser: {
              select: {
                id: true,
                nombre: true,
                email: true
              }
            },
            deletedByUser: includeDeleted ? {
              select: {
                id: true,
                nombre: true,
                email: true
              }
            } : false
          },
          orderBy: {
            createdAt: 'desc'
          },
          skip,
          take: limit
        }),
        prisma.payment.count({ where })
      ]);
      console.log('Pagos encontrados en BD:', payments.length, 'Total:', total);

      return {
        data: payments.map((payment: any) => {
          const receiptFilesUrls = buildReceiptUrls(payment.id, getReceiptFileNames(payment));
          return {
            id: payment.id,
            debtId: payment.debtId,
            supplierId: payment.supplierId,
            supplier: payment.supplier,
            amount: Number(payment.amount),
            paymentMethod: payment.paymentMethod,
            senderName: payment.senderName,
            senderEmail: payment.senderEmail,
            confirmationNumber: payment.confirmationNumber,
            paymentDate: payment.paymentDate,
            nota: payment.nota || null,
            receiptFiles: receiptFilesUrls,
            verified: payment.verified,
            shared: payment.shared || false,
            sharedAt: payment.sharedAt || null,
            exchangeRate: payment.exchangeRate ? Number(payment.exchangeRate) : null,
            amountInBolivares: payment.amountInBolivares ? Number(payment.amountInBolivares) : null,
            surplusAmount: payment.surplusAmount ? Number(payment.surplusAmount) : null,
            destinationAccount: this.mapDestinationAccount(payment.destinationAccountSnapshot),
            createdBy: payment.createdBy,
            createdByUser: payment.createdByUser || null,
            deletedAt: payment.deletedAt || null,
            deletedBy: payment.deletedBy || null,
            deletedByUser: payment.deletedByUser ? {
              id: payment.deletedByUser.id,
              nombre: payment.deletedByUser.nombre,
              email: payment.deletedByUser.email
            } : null,
            deletionReason: payment.deletionReason || null,
            createdAt: payment.createdAt,
            updatedAt: payment.updatedAt
          };
        }),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      console.error('Error al obtener pagos:', error);
      throw new Error('Error al obtener pagos');
    }
  }

  async verifyZelleByConfirmationNumber(data: VerifyZelleDTO): Promise<PaymentResponse | null> {
    const { confirmationNumber } = data;

    // Buscar pago por los últimos 5 dígitos del número de confirmación
    // IMPORTANTE: Excluir pagos eliminados
    const payments = await prisma.payment.findMany({
      where: {
        paymentMethod: 'ZELLE',
        confirmationNumber: {
          endsWith: confirmationNumber
        },
        deletedAt: null // Excluir pagos eliminados
      },
      include: {
        supplier: {
          select: {
            id: true,
            companyName: true,
            taxId: true,
            phone: true
          }
        },
        createdByUser: {
          select: {
            id: true,
            nombre: true,
            email: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 1
    });

    if (payments.length === 0) {
      return null;
    }

    const payment = payments[0];
    const receiptFilesUrls = buildReceiptUrls(payment.id, getReceiptFileNames(payment));

    return {
      id: payment.id,
      debtId: payment.debtId,
      supplierId: payment.supplierId,
      supplier: payment.supplier,
      amount: Number(payment.amount),
      paymentMethod: payment.paymentMethod,
      senderName: payment.senderName,
      senderEmail: payment.senderEmail,
      confirmationNumber: payment.confirmationNumber,
      paymentDate: payment.paymentDate,
      nota: payment.nota || null,
      receiptFiles: receiptFilesUrls,
      verified: payment.verified,
      shared: payment.shared || false,
      sharedAt: payment.sharedAt || null,
      exchangeRate: payment.exchangeRate ? Number(payment.exchangeRate) : null,
      amountInBolivares: payment.amountInBolivares ? Number(payment.amountInBolivares) : null,
      surplusAmount: payment.surplusAmount ? Number(payment.surplusAmount) : null,
      destinationAccount: this.mapDestinationAccount(payment.destinationAccountSnapshot),
      createdBy: payment.createdBy,
      createdByUser: payment.createdByUser || null,
      deletedAt: payment.deletedAt || null,
      deletedBy: payment.deletedBy || null,
      deletedByUser: null,
      deletionReason: payment.deletionReason || null,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt
    };
  }

  async searchPaymentsByConfirmationNumber(
    query: string,
    limit: number = 10
  ): Promise<PaymentResponse[]> {
    // Validar que el query tenga al menos 3 caracteres
    if (!query || query.length < 3) {
      return [];
    }

    // Buscar pagos por número de confirmación
    // Busca que el número de confirmación contenga los dígitos ingresados (en cualquier parte)
    // Busca en todos los tipos de pago que tengan número de confirmación (ZELLE, TRANSFER)
    // IMPORTANTE: Excluir pagos eliminados
    const payments = await prisma.payment.findMany({
      where: {
        confirmationNumber: {
          not: null, // Solo pagos que tengan número de confirmación
          contains: query // Buscar que contenga los dígitos en cualquier parte del número
        },
        deletedAt: null // Excluir pagos eliminados
      },
      include: {
        supplier: {
          select: {
            id: true,
            companyName: true,
            taxId: true,
            phone: true
          }
        },
        createdByUser: {
          select: {
            id: true,
            nombre: true,
            email: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: limit
    });

    return payments.map((payment: any) => {
      const receiptFilesUrls = buildReceiptUrls(payment.id, getReceiptFileNames(payment));
      return {
        id: payment.id,
        debtId: payment.debtId,
        supplierId: payment.supplierId,
        supplier: payment.supplier,
        amount: Number(payment.amount),
        paymentMethod: payment.paymentMethod,
        senderName: payment.senderName,
        senderEmail: payment.senderEmail,
        confirmationNumber: payment.confirmationNumber,
        paymentDate: payment.paymentDate,
        nota: payment.nota || null,
        receiptFiles: receiptFilesUrls,
        verified: payment.verified,
        shared: payment.shared || false,
        sharedAt: payment.sharedAt || null,
        exchangeRate: payment.exchangeRate ? Number(payment.exchangeRate) : null,
        amountInBolivares: payment.amountInBolivares ? Number(payment.amountInBolivares) : null,
        surplusAmount: payment.surplusAmount ? Number(payment.surplusAmount) : null,
        destinationAccount: this.mapDestinationAccount(payment.destinationAccountSnapshot),
        createdBy: payment.createdBy,
        createdByUser: payment.createdByUser || null,
        deletedAt: payment.deletedAt || null,
        deletedBy: payment.deletedBy || null,
        deletedByUser: null,
        deletionReason: payment.deletionReason || null,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt
      };
    });
  }

  async updatePayment(
    paymentId: number,
    data: {
      debtId?: number;
      supplierId?: number;
      amount?: number;
      paymentMethod?: PaymentMethod;
      senderName?: string;
      senderEmail?: string;
      confirmationNumber?: string;
      paymentDate?: Date;
      receiptFileNames?: string[] | null;
      receiptFilePaths?: string[];
      existingReceiptFileNames?: string[]; // URLs convertidas a nombres por el controller (sin subir archivos nuevos)
      removeReceipt?: boolean;
      exchangeRate?: number | null;
      amountInBolivares?: number | null;
      nota?: string | null;
      destinationAccountId?: number | null;
    }
  ): Promise<PaymentResponse> {
    try {
      console.log(`🔄 PaymentService.updatePayment - Iniciando actualización de pago ${paymentId}...`);
      
      // 1. Obtener el pago original
      const oldPayment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          debt: {
            select: {
              id: true,
              supplierId: true,
              initialAmount: true,
              remainingAmount: true
            }
          }
        }
      });

      if (!oldPayment) {
        throw new Error('Pago no encontrado');
      }

      const oldAmount = Number(oldPayment.amount);
      const oldDebtId = oldPayment.debtId;
      const oldSupplierId = oldPayment.supplierId;
      
      const newDebtId = data.debtId || oldDebtId;
      const newSupplierId = data.supplierId || oldSupplierId;
      const newAmount = data.amount !== undefined ? Number(data.amount) : oldAmount;

      // 2. Validar nuevo monto
      if (data.amount !== undefined) {
        if (newAmount <= 0) {
          throw new Error('El monto del pago debe ser mayor a 0');
        }
      }

      // 3. Validar nueva deuda si cambió
      if (newDebtId !== oldDebtId) {
        console.log(`🔄 Cambiando deuda de ${oldDebtId} a ${newDebtId}`);
        
        const newDebt = await prisma.debt.findUnique({
          where: { id: newDebtId },
          include: { supplier: true }
        });

        if (!newDebt) {
          throw new Error('Nueva deuda no encontrada');
        }

        // Validar que la nueva deuda pertenezca al nuevo proveedor
        if (newDebt.supplierId !== newSupplierId) {
          throw new Error('La deuda seleccionada no pertenece al proveedor seleccionado');
        }

        // Validar que el monto no exceda el remainingAmount de la nueva deuda
        const otherPaymentsNewDebt = await prisma.payment.findMany({
          where: {
            debtId: newDebtId,
            id: { not: paymentId },
            deletedAt: null
          },
          select: { amount: true }
        });

        const totalOtherPaymentsNewDebt = otherPaymentsNewDebt.reduce(
          (sum: number, p: { amount: any }) => sum + Number(p.amount),
          0
        );

        const maxAllowedNewDebt = Number(newDebt.initialAmount) - totalOtherPaymentsNewDebt;

        if (newAmount > maxAllowedNewDebt) {
          throw new Error(
            `El monto ($${newAmount.toFixed(2)}) excede el monto máximo permitido ` +
            `en la nueva deuda ($${maxAllowedNewDebt.toFixed(2)})`
          );
        }
      } else {
        // Si no cambió la deuda, validar monto como antes
        if (data.amount !== undefined) {
          const otherPayments = await prisma.payment.findMany({
            where: {
              debtId: oldDebtId,
              id: { not: paymentId },
              deletedAt: null
            },
            select: { amount: true }
          });

          const totalOtherPayments = otherPayments.reduce(
            (sum: number, p: { amount: any }) => sum + Number(p.amount),
            0
          );

          const initialAmount = Number(oldPayment.debt.initialAmount);
          const maxAllowed = initialAmount - totalOtherPayments;

          /* if (newAmount > maxAllowed) {
            throw new Error(
              `El nuevo monto ($${newAmount.toFixed(2)}) excede el monto máximo permitido ` +
              `($${maxAllowed.toFixed(2)}). Monto ya pagado por otros pagos: $${totalOtherPayments.toFixed(2)}`
            );
          } */
        }
      }

      // 4. Validar confirmationNumber si es Zelle o Transfer
      if (data.paymentMethod && (data.paymentMethod === 'ZELLE' || data.paymentMethod === 'TRANSFER' || data.paymentMethod === 'PAGO_MOVIL')) {
        if (!data.confirmationNumber) {
          // Si no se proporciona, verificar que el pago actual ya tenga uno
          if (!oldPayment.confirmationNumber) {
            throw new Error('Número de confirmación requerido para este método de pago');
          }
        }
      }

      // 4.1 Validar que el número de confirmación no esté duplicado (si se está actualizando)
      if (data.confirmationNumber !== undefined) {
        const confirmationTrimmed = (data.confirmationNumber || '').trim();
        if (confirmationTrimmed) {
          const existingWithSameConfirmation = await prisma.payment.findFirst({
            where: {
              confirmationNumber: confirmationTrimmed,
              id: { not: paymentId },
              deletedAt: null
            }
          });
          if (existingWithSameConfirmation) {
            throw new AppError('Ya existe un pago con este número de confirmación', 400);
          }
        }
      }

      // 5. Preparar datos de actualización
      const updateData: any = {};
      if (data.amount !== undefined) updateData.amount = data.amount;
      if (data.paymentMethod) updateData.paymentMethod = data.paymentMethod;
      if (data.senderName) updateData.senderName = data.senderName;
      if (data.senderEmail !== undefined) updateData.senderEmail = data.senderEmail || null;
      if (data.confirmationNumber !== undefined) {
        updateData.confirmationNumber = data.confirmationNumber || null;
      }
      if (data.paymentDate) updateData.paymentDate = new Date(data.paymentDate);
      if (data.debtId !== undefined) updateData.debtId = data.debtId;
      if (data.supplierId !== undefined) updateData.supplierId = data.supplierId;
      if (data.exchangeRate !== undefined) updateData.exchangeRate = data.exchangeRate || null;
      if (data.amountInBolivares !== undefined) updateData.amountInBolivares = data.amountInBolivares || null;
      if (data.nota !== undefined) updateData.nota = data.nota || null;

      // Cuenta de pago destino (se guarda como snapshot en el pago)
      if (data.destinationAccountId !== undefined) {
        if (data.destinationAccountId === null || data.destinationAccountId === 0) {
          updateData.destinationAccountSnapshot = Prisma.DbNull;
        } else {
          const account = await prisma.supplierPaymentAccount.findUnique({
            where: { id: data.destinationAccountId }
          });
          if (!account || account.supplierId !== newSupplierId) {
            throw new AppError('La cuenta de pago no existe o no pertenece al proveedor', 400);
          }
          updateData.destinationAccountSnapshot = this.buildAccountSnapshot(account);
        }
      }
      
      // Manejar comprobantes: múltiples imágenes nuevas, remover todas, lista existente (URLs) o mantener actual
      if (data.receiptFileNames !== undefined) {
        const fs = await import('fs');
        const path = await import('path');
        const oldNames = getReceiptFileNames(oldPayment);

        if (data.removeReceipt || data.receiptFileNames === null || (Array.isArray(data.receiptFileNames) && data.receiptFileNames.length === 0)) {
          console.log('🗑️ Eliminando comprobantes del pago...');
          for (const name of oldNames) {
            try {
              const filePath = path.resolve(env.UPLOAD_PATH, 'receipt', name);
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log('✅ Archivo físico eliminado:', filePath);
              }
            } catch (fileError: any) {
              console.error('⚠️ Error al eliminar archivo físico:', fileError.message);
            }
          }
          updateData.receiptFile = null;
          updateData.receiptFiles = null;
        } else if (Array.isArray(data.receiptFileNames) && data.receiptFileNames.length > 0) {
          for (const name of oldNames) {
            try {
              const filePath = path.resolve(env.UPLOAD_PATH, 'receipt', name);
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log('✅ Archivo viejo eliminado:', filePath);
              }
            } catch (fileError: any) {
              console.error('⚠️ Error al eliminar archivo viejo:', fileError.message);
            }
          }
          updateData.receiptFile = null;
          updateData.receiptFiles = data.receiptFileNames as unknown as object;
        }
      } else if (Array.isArray(data.existingReceiptFileNames) && data.existingReceiptFileNames.length > 0) {
        // Sin archivos nuevos: el frontend envió existingReceiptFiles (URLs). Sincronizar lista (conservar/reordenar/quitar algunas).
        const fs = await import('fs');
        const path = await import('path');
        const oldNames = getReceiptFileNames(oldPayment);
        const oldSet = new Set(oldNames);
        const toKeep = data.existingReceiptFileNames.filter((name) => oldSet.has(name));
        const toRemove = oldNames.filter((name) => !toKeep.includes(name));
        for (const name of toRemove) {
          try {
            const filePath = path.resolve(env.UPLOAD_PATH, 'receipt', name);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              console.log('✅ Archivo eliminado (ya no en lista):', name);
            }
          } catch (fileError: any) {
            console.error('⚠️ Error al eliminar archivo:', fileError.message);
          }
        }
        updateData.receiptFile = null;
        updateData.receiptFiles = toKeep.length > 0 ? (toKeep as unknown as object) : null;
      }

      const surplusRelevantChange =
        data.amount !== undefined ||
        data.debtId !== undefined ||
        data.supplierId !== undefined;

      const paymentInclude = {
        supplier: {
          select: {
            id: true,
            companyName: true,
            taxId: true,
            phone: true
          }
        },
        createdByUser: {
          select: {
            id: true,
            nombre: true,
            email: true
          }
        }
      } as const;

      let updatedPayment;

      if (surplusRelevantChange) {
        updatedPayment = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await this.revertDirectSurplusApplyToDebt(
            tx,
            oldPayment.surplusTargetDebtId,
            oldPayment.surplusAppliedToDebt
          );
          await creditService.releaseCreditsForPayment(paymentId, oldSupplierId, tx);

          if (newSupplierId !== oldSupplierId) {
            console.log(`🔄 Cambiando proveedor de ${oldSupplierId} a ${newSupplierId}`);
            await supplierService.updateSupplierTotalDebt(oldSupplierId, oldAmount, tx);
            await supplierService.updateSupplierTotalDebt(newSupplierId, -newAmount, tx);
          } else if (data.amount !== undefined && newAmount !== oldAmount) {
            const difference = newAmount - oldAmount;
            await supplierService.updateSupplierTotalDebt(newSupplierId, -difference, tx);
          }

          const up = await tx.payment.update({
            where: { id: paymentId },
            data: updateData,
            include: paymentInclude
          });

          if (newDebtId !== oldDebtId) {
            console.log(`🔄 Recalculando deudas: anterior ${oldDebtId}, nueva ${newDebtId}`);
            await debtService.updateDebtStatus(oldDebtId, tx);
            await debtService.updateDebtStatus(newDebtId, tx);
          } else {
            console.log(`🔄 Recalculando deuda ${up.debtId} tras cambio de pago...`);
            await debtService.updateDebtStatus(up.debtId, tx);
          }

          // Reconciliar créditos del proveedor afectado para evitar inconsistencias
          console.log('🔄 Reconciliando créditos tras editar pago...');
          await creditService.reconcileSupplierCredits(newSupplierId, tx);
          if (oldSupplierId !== newSupplierId) {
            await creditService.reconcileSupplierCredits(oldSupplierId, tx);
          }

          const fresh = await tx.payment.findUnique({
            where: { id: paymentId },
            include: paymentInclude
          });
          if (!fresh) {
            throw new Error('Pago no encontrado tras actualizar');
          }
          return fresh;
        });

        if (data.paymentDate) {
          await supplierService.updateSupplierLastPaymentDate(
            updatedPayment.supplierId,
            new Date(data.paymentDate)
          );
        }
      } else {
        // 6. ACTUALIZAR PROVEEDORES (si cambió)
        if (newSupplierId !== oldSupplierId) {
          console.log(`🔄 Cambiando proveedor de ${oldSupplierId} a ${newSupplierId}`);

          await supplierService.updateSupplierTotalDebt(oldSupplierId, oldAmount);

          await supplierService.updateSupplierTotalDebt(newSupplierId, -newAmount);

          if (data.paymentDate) {
            await supplierService.updateSupplierLastPaymentDate(
              newSupplierId,
              new Date(data.paymentDate)
            );
          }
        } else if (data.amount !== undefined && newAmount !== oldAmount) {
          const difference = newAmount - oldAmount;
          await supplierService.updateSupplierTotalDebt(newSupplierId, -difference);

          if (data.paymentDate) {
            await supplierService.updateSupplierLastPaymentDate(
              newSupplierId,
              new Date(data.paymentDate)
            );
          }
        }

        updatedPayment = await prisma.payment.update({
          where: { id: paymentId },
          data: updateData,
          include: paymentInclude
        });

        if (newDebtId !== oldDebtId) {
          console.log(`🔄 Recalculando deudas: anterior ${oldDebtId}, nueva ${newDebtId}`);

          await debtService.updateDebtStatus(oldDebtId);

          await debtService.updateDebtStatus(newDebtId);
        } else if (data.amount !== undefined && newAmount !== oldAmount) {
          console.log(`🔄 Recalculando deuda ${newDebtId} con nuevo monto...`);
          await debtService.updateDebtStatus(newDebtId);
        }
      }

      console.log('✅ Pago actualizado en BD:', {
        paymentId: updatedPayment.id,
        oldAmount: oldAmount.toFixed(2),
        newAmount: Number(updatedPayment.amount).toFixed(2),
        oldDebtId,
        newDebtId: updatedPayment.debtId,
        oldSupplierId,
        newSupplierId: updatedPayment.supplierId,
        newReceiptFiles: updatedPayment.receiptFiles
      });

      const updatedDebt = await prisma.debt.findUnique({
        where: { id: updatedPayment.debtId },
        select: {
          remainingAmount: true,
          status: true
        }
      });

      console.log('📊 Deuda después de actualizar pago:', {
        debtId: updatedPayment.debtId,
        remainingAmount: updatedDebt?.remainingAmount,
        status: updatedDebt?.status
      });

      const receiptFilesUrls = buildReceiptUrls(updatedPayment.id, getReceiptFileNames(updatedPayment));

      return {
        id: updatedPayment.id,
        debtId: updatedPayment.debtId,
        supplierId: updatedPayment.supplierId,
        supplier: updatedPayment.supplier,
        amount: Number(updatedPayment.amount),
        paymentMethod: updatedPayment.paymentMethod,
        senderName: updatedPayment.senderName,
        senderEmail: updatedPayment.senderEmail,
        confirmationNumber: updatedPayment.confirmationNumber,
        paymentDate: updatedPayment.paymentDate,
        nota: updatedPayment.nota || null,
        receiptFiles: receiptFilesUrls,
        verified: updatedPayment.verified,
        shared: updatedPayment.shared || false,
        sharedAt: updatedPayment.sharedAt || null,
        exchangeRate: updatedPayment.exchangeRate ? Number(updatedPayment.exchangeRate) : null,
        amountInBolivares: updatedPayment.amountInBolivares ? Number(updatedPayment.amountInBolivares) : null,
        surplusAmount: updatedPayment.surplusAmount ? Number(updatedPayment.surplusAmount) : null,
        destinationAccount: this.mapDestinationAccount(updatedPayment.destinationAccountSnapshot),
        createdBy: updatedPayment.createdBy,
        createdByUser: updatedPayment.createdByUser || null,
        createdAt: updatedPayment.createdAt,
        updatedAt: updatedPayment.updatedAt
      };
    } catch (error: any) {
      console.error('❌ Error en PaymentService.updatePayment:', error);
      throw error;
    }
  }

  async deletePayment(
    paymentId: number,
    userId: number,
    reason?: string
  ): Promise<PaymentResponse> {
    try {
      console.log('🗑️ PaymentService.deletePayment - Iniciando...');
      console.log('Datos recibidos:', { paymentId, userId, reason });

      // 1. Obtener el pago original
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          supplier: {
            select: {
              id: true,
              companyName: true,
              taxId: true,
              phone: true
            }
          },
          debt: {
            select: {
              id: true,
              remainingAmount: true,
              status: true,
              supplierId: true
            }
          }
        }
      });

      if (!payment) {
        console.error('❌ Pago no encontrado:', paymentId);
        throw new Error('Pago no encontrado');
      }

      // 2. Validar que el pago no esté ya eliminado
      if (payment.deletedAt) {
        console.error('❌ El pago ya está eliminado:', paymentId);
        throw new Error('Este pago ya ha sido eliminado');
      }

      const paymentAmount = Number(payment.amount);
      const debtId = payment.debtId;
      const supplierId = payment.supplierId;

      console.log('📋 Información del pago a eliminar:', {
        paymentId: payment.id,
        amount: paymentAmount,
        debtId,
        supplierId,
        currentDebtRemaining: Number(payment.debt.remainingAmount),
        currentDebtStatus: payment.debt.status
      });

      // 3. Revertir excedentes del pago, eliminar créditos asociados y marcar eliminación lógica (transacción)
      const deletedPayment = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await this.revertDirectSurplusApplyToDebt(
          tx,
          payment.surplusTargetDebtId,
          payment.surplusAppliedToDebt
        );
        await creditService.releaseCreditsForPayment(paymentId, supplierId, tx);

        return tx.payment.update({
          where: { id: paymentId },
          data: {
            deletedAt: new Date(),
            deletedBy: userId,
            deletionReason: reason || null
          },
          include: {
            supplier: {
              select: {
                id: true,
                companyName: true,
                taxId: true,
                phone: true
              }
            },
            createdByUser: {
              select: {
                id: true,
                nombre: true,
                email: true
              }
            },
            deletedByUser: {
              select: {
                id: true,
                nombre: true,
                email: true
              }
            }
          }
        });
      });

      console.log('✅ Pago marcado como eliminado:', {
        paymentId: deletedPayment.id,
        deletedAt: deletedPayment.deletedAt,
        deletedBy: deletedPayment.deletedBy
      });

      // 4. Recalcular remainingAmount de la deuda (sumar el monto del pago eliminado)
      console.log('🔄 Recalculando remainingAmount de la deuda...');
      await debtService.updateDebtStatus(debtId);
      
      // Obtener la deuda actualizada
      const updatedDebt = await prisma.debt.findUnique({
        where: { id: debtId },
        select: {
          remainingAmount: true,
          status: true
        }
      });

      console.log('📊 Deuda después de eliminar pago:', {
        debtId,
        remainingAmount: updatedDebt?.remainingAmount,
        status: updatedDebt?.status,
        montoAgregado: paymentAmount
      });

      // 5. Actualizar totalDebt del proveedor (sumar el monto del pago eliminado)
      console.log('🔄 Actualizando totalDebt del proveedor...');
      await supplierService.updateSupplierTotalDebt(supplierId, paymentAmount);
      
      // Obtener el proveedor actualizado
      const updatedSupplier = await prisma.supplier.findUnique({
        where: { id: supplierId },
        select: {
          totalDebt: true
        }
      });

      // 6. Reconciliar créditos del proveedor
      console.log('🔄 Reconciliando créditos tras eliminar pago...');
      await creditService.reconcileSupplierCredits(supplierId);
      console.log('✅ Créditos reconciliados');

      console.log('📊 Proveedor después de eliminar pago:', {
        supplierId,
        totalDebt: updatedSupplier?.totalDebt,
        montoAgregado: paymentAmount
      });

      const receiptFilesUrls = buildReceiptUrls(deletedPayment.id, getReceiptFileNames(deletedPayment));

      const response: PaymentResponse = {
        id: deletedPayment.id,
        debtId: deletedPayment.debtId,
        supplierId: deletedPayment.supplierId,
        supplier: deletedPayment.supplier,
        amount: Number(deletedPayment.amount),
        paymentMethod: deletedPayment.paymentMethod,
        senderName: deletedPayment.senderName,
        senderEmail: deletedPayment.senderEmail,
        confirmationNumber: deletedPayment.confirmationNumber,
        paymentDate: deletedPayment.paymentDate,
        nota: deletedPayment.nota || null,
        receiptFiles: receiptFilesUrls,
        verified: deletedPayment.verified,
        shared: deletedPayment.shared || false,
        sharedAt: deletedPayment.sharedAt || null,
        exchangeRate: deletedPayment.exchangeRate ? Number(deletedPayment.exchangeRate) : null,
        amountInBolivares: deletedPayment.amountInBolivares ? Number(deletedPayment.amountInBolivares) : null,
        surplusAmount: deletedPayment.surplusAmount ? Number(deletedPayment.surplusAmount) : null,
        destinationAccount: this.mapDestinationAccount(deletedPayment.destinationAccountSnapshot),
        createdBy: deletedPayment.createdBy,
        createdByUser: deletedPayment.createdByUser || null,
        deletedAt: deletedPayment.deletedAt || null,
        deletedBy: deletedPayment.deletedBy || null,
        deletedByUser: deletedPayment.deletedByUser ? {
          id: deletedPayment.deletedByUser.id,
          nombre: deletedPayment.deletedByUser.nombre,
          email: deletedPayment.deletedByUser.email
        } : null,
        deletionReason: deletedPayment.deletionReason || null,
        createdAt: deletedPayment.createdAt,
        updatedAt: deletedPayment.updatedAt
      };

      console.log('✅ PaymentService.deletePayment - Completado exitosamente');
      console.log('💰 Resumen de eliminación:', {
        pagoId: response.id,
        montoEliminado: response.amount,
        deudaId: response.debtId,
        nuevoMontoRestanteDeuda: updatedDebt?.remainingAmount,
        nuevoEstadoDeuda: updatedDebt?.status,
        nuevoTotalDeudaProveedor: updatedSupplier?.totalDebt,
        eliminadoPor: deletedPayment.deletedByUser?.nombre,
        motivo: reason || 'No especificado'
      });

      return response;
    } catch (error: any) {
      console.error('❌ Error en PaymentService.deletePayment:', error);
      throw error;
    }
  }

  async sharePayment(paymentId: number): Promise<{ payment: PaymentResponse; whatsappUrl: string }> {
    try {
      console.log(`📤 PaymentService.sharePayment - Compartiendo pago ${paymentId}...`);

      // Obtener el pago con toda la información necesaria
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          supplier: {
            select: {
              id: true,
              companyName: true,
              taxId: true,
              phone: true
            }
          },
          debt: {
            select: {
              id: true,
              orderId: true,
              status: true,
              initialAmount: true,
              remainingAmount: true,
              dueDate: true,
              createdAt: true,
              updatedAt: true
            }
          }
        }
      });

      if (!payment) {
        throw new Error('Pago no encontrado');
      }

      // Validar que el proveedor tenga teléfono
      if (!payment.supplier.phone) {
        throw new Error('El proveedor no tiene un número de teléfono registrado');
      }

      // Actualizar los campos shared y sharedAt
      const now = new Date();
      const updatedPayment = await prisma.payment.update({
        where: { id: paymentId },
        data: {
          shared: true,
          sharedAt: now
        },
        include: {
          supplier: {
            select: {
              id: true,
              companyName: true,
              taxId: true,
              phone: true
            }
          },
          createdByUser: {
            select: {
              id: true,
              nombre: true,
              email: true
            }
          }
        }
      });

      const receiptFilesUrls = buildReceiptUrls(updatedPayment.id, getReceiptFileNames(updatedPayment));

      // Construir el mensaje de WhatsApp
      const amount = Number(updatedPayment.amount).toFixed(2);
      const paymentDate = new Date(updatedPayment.paymentDate).toLocaleDateString('es-VE', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      const paymentMethodMap: { [key: string]: string } = {
        'ZELLE': 'Zelle',
        'TRANSFER': 'Transferencia',
        'CASH': 'Efectivo'
      };
      const paymentMethodText = paymentMethodMap[updatedPayment.paymentMethod] || updatedPayment.paymentMethod;

      const branding = await brandingService.getConfig().catch(() => null);
      const companyName = branding?.companyName?.trim();

      let message = '';
      // Incluir primero las URLs directas de las imágenes del recibo para que WhatsApp las muestre como preview/foto en el chat (no como link de página)
      if (receiptFilesUrls.length > 0) {
        message += receiptFilesUrls.join('\n') + '\n\n';
      }

      message += `📄 *Comprobante de Pago*\n\n`;
      message += `*Proveedor:* ${updatedPayment.supplier.companyName}\n`;
      message += `*Monto:* $${amount}\n`;
      if (updatedPayment.exchangeRate != null) {
        const formatVES = (value: number, decimals: number) =>
          new Intl.NumberFormat('es-VE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
        const tasaNum = Number(updatedPayment.exchangeRate);
        const montoBsNum = updatedPayment.amountInBolivares != null
          ? Number(updatedPayment.amountInBolivares)
          : Number(updatedPayment.amount) * tasaNum;
        message += `*Tasa Bs:* ${formatVES(tasaNum, 2)}\n`;
        message += `*Monto en Bs:* ${formatVES(montoBsNum, 2)}\n`;
      }
      message += `*Método de Pago:* ${paymentMethodText}\n`;
      message += `*Fecha de Pago:* ${paymentDate}\n`;
      
      if (updatedPayment.senderName) {
        message += `*Pagado por:* ${updatedPayment.senderName}\n`;
      }
      
      if (updatedPayment.confirmationNumber) {
        message += `*Número de Confirmación:* ${updatedPayment.confirmationNumber}\n`;
      }

      if (companyName) {
        message += `\n_${companyName}_\n`;
      }

      // Si hay comprobante, agregar la URL al mensaje
      // Nota: buildReceiptUrl ya maneja la construcción de la URL completa si API_BASE_URL está configurada
      
      // Limpiar el número de teléfono (remover espacios, guiones, etc.)
      const telefono = updatedPayment.supplier.phone.replace(/[\s\-\(\)]/g, '');
      
      // Construir la URL de WhatsApp siguiendo el formato exacto del ejemplo
      const waLink = `https://wa.me/${telefono}?text=${encodeURIComponent(message)}`;
      
      console.log('📤 URL de WhatsApp generada:', waLink);

      console.log('✅ Pago marcado como compartido:', {
        paymentId: updatedPayment.id,
        sharedAt: now,
        supplierPhone: updatedPayment.supplier.phone
      });

      // Construir la respuesta del pago
      const paymentResponse: PaymentResponse = {
        id: updatedPayment.id,
        debtId: updatedPayment.debtId,
        supplierId: updatedPayment.supplierId,
        supplier: updatedPayment.supplier,
        amount: Number(updatedPayment.amount),
        paymentMethod: updatedPayment.paymentMethod,
        senderName: updatedPayment.senderName,
        senderEmail: updatedPayment.senderEmail,
        confirmationNumber: updatedPayment.confirmationNumber,
        paymentDate: updatedPayment.paymentDate,
        nota: updatedPayment.nota || null,
        receiptFiles: receiptFilesUrls,
        verified: updatedPayment.verified,
        shared: updatedPayment.shared,
        sharedAt: updatedPayment.sharedAt,
        exchangeRate: updatedPayment.exchangeRate ? Number(updatedPayment.exchangeRate) : null,
        amountInBolivares: updatedPayment.amountInBolivares ? Number(updatedPayment.amountInBolivares) : null,
        surplusAmount: updatedPayment.surplusAmount ? Number(updatedPayment.surplusAmount) : null,
        destinationAccount: this.mapDestinationAccount(updatedPayment.destinationAccountSnapshot),
        createdBy: updatedPayment.createdBy,
        createdByUser: updatedPayment.createdByUser || null,
        deletedAt: updatedPayment.deletedAt || null,
        deletedBy: updatedPayment.deletedBy || null,
        deletedByUser: null,
        deletionReason: updatedPayment.deletionReason || null,
        createdAt: updatedPayment.createdAt,
        updatedAt: updatedPayment.updatedAt
      };

      return {
        payment: paymentResponse,
        whatsappUrl: waLink
      };
    } catch (error: any) {
      console.error('❌ Error en PaymentService.sharePayment:', error);
      throw error;
    }
  }

  /**
   * Restaura el remaining de la deuda que recibió excedente vía APPLY_TO_DEBT (sin tocar totalDebt del proveedor:
   * el flujo de alta/baja del pago ya lo refleja).
   */
  private async revertDirectSurplusApplyToDebt(
    tx: Prisma.TransactionClient,
    surplusTargetDebtId: number | null | undefined,
    surplusAppliedToDebt: unknown
  ): Promise<void> {
    if (surplusTargetDebtId == null || surplusAppliedToDebt == null) return;
    const amt = Number(surplusAppliedToDebt);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const debt = await tx.debt.findUnique({
      where: { id: surplusTargetDebtId },
      select: { remainingAmount: true }
    });
    if (!debt) return;
    const newRem = Number(debt.remainingAmount) + amt;
    await tx.debt.update({
      where: { id: surplusTargetDebtId },
      data: {
        remainingAmount: Math.max(0, newRem),
        status: newRem <= 0 ? 'PAID' : 'PENDING'
      }
    });
  }

  /**
   * Tras editar monto/deuda del pago: recalcula excedente y registros Credit (solo saldo a favor CREDIT).
   */
  private async syncSurplusAfterPaymentEdit(
    tx: Prisma.TransactionClient,
    params: { paymentId: number; supplierId: number; debtId: number; paymentAmount: number }
  ): Promise<void> {
    const { debtId, paymentId, supplierId, paymentAmount } = params;
    const agg = await tx.payment.aggregate({
      where: { debtId, deletedAt: null },
      _sum: { amount: true }
    });
    const debtRow = await tx.debt.findUnique({
      where: { id: debtId },
      select: { initialAmount: true, surplusAmountAtCreation: true }
    });
    if (!debtRow) return;
    const totalPaid = Number(agg._sum.amount ?? 0);
    const others = totalPaid - paymentAmount;
    const owedBefore =
      Number(debtRow.initialAmount) -
      Number(debtRow.surplusAmountAtCreation ?? 0) -
      others;
    const newSurplus = Math.max(0, paymentAmount - owedBefore);

    await tx.payment.update({
      where: { id: paymentId },
      data: {
        surplusAmount: newSurplus > 0 ? newSurplus : null,
        surplusTargetDebtId: null,
        surplusAppliedToDebt: null
      }
    });

    if (newSurplus <= 0) return;

    await tx.credit.create({
      data: {
        paymentId,
        originDebtId: debtId,
        supplierId,
        amount: newSurplus,
        remaining: newSurplus,
        status: 'AVAILABLE',
        description: `Excedente pago #${paymentId}`
      }
    });
  }

  /** Copia los datos de una cuenta de pago para guardarlos en el pago (snapshot). */
  private buildAccountSnapshot(account: {
    id: number;
    type: string;
    bank: string | null;
    accountNumber: string | null;
    holderName: string | null;
    holderId: string | null;
    email: string | null;
    phone: string | null;
  }): Record<string, unknown> {
    return {
      id: account.id,
      type: account.type,
      bank: account.bank ?? null,
      accountNumber: account.accountNumber ?? null,
      holderName: account.holderName ?? null,
      holderId: account.holderId ?? null,
      email: account.email ?? null,
      phone: account.phone ?? null
    };
  }

  private mapDestinationAccount(snapshot: unknown): any {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return null;
    }
    const account = snapshot as Record<string, any>;
    if (!account.type) {
      return null;
    }
    return {
      id: account.id,
      type: account.type,
      bank: account.bank ?? null,
      accountNumber: account.accountNumber ?? null,
      holderName: account.holderName ?? null,
      holderId: account.holderId ?? null,
      email: account.email ?? null,
      phone: account.phone ?? null
    };
  }
}


