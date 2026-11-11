import prisma from '../config/database';
import { Prisma } from '@prisma/client';
import { DebtResponse, SearchParams, PaginationParams, PaginatedResponse } from '../types';
import { AppError } from '../middleware/error.middleware';
import { getReceiptFileNames, buildReceiptUrls } from '../utils/receiptUrls';
import { getInvoiceFileNames, buildInvoiceUrls } from '../utils/invoiceUrls';

export class DebtService {
  async updateDebtStatus(debtId: number, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? prisma;
    try {
      console.log(`🔄 Actualizando estado de deuda ${debtId}...`);
      
      // Forzar una consulta fresca sin caché para asegurar que incluya el último pago
      // IMPORTANTE: Excluir pagos eliminados del cálculo
      const debt = await client.debt.findUnique({
        where: { id: debtId },
        include: {
          payments: {
            where: {
              deletedAt: null // Excluir pagos eliminados
            },
            orderBy: {
              createdAt: 'desc' // Ordenar por fecha de creación para ver los más recientes primero
            }
          }
        }
      });

      if (!debt) {
        console.error(`❌ Deuda ${debtId} no encontrada`);
        throw new Error('Deuda no encontrada');
      }

      console.log(`📋 Pagos activos encontrados para deuda ${debtId}:`, debt.payments.length);
      
      if (debt.payments.length === 0) {
        console.warn(`⚠️ No se encontraron pagos activos para la deuda ${debtId}. Esto puede indicar un problema.`);
      }
      
      const totalPaid = debt.payments.reduce((sum: number, payment: any) => {
        const paymentAmount = Number(payment.amount);
        console.log(`  - Pago ID ${payment.id}: $${paymentAmount.toFixed(2)}`);
        return sum + paymentAmount;
      }, 0);

      const initialAmount = Number(debt.initialAmount);
      const surplusAmountAtCreation = Number(debt.surplusAmountAtCreation ?? 0);
      // El saldo excedente aplicado al crear la deuda también reduce el monto pendiente.
      const remainingAmount = initialAmount - surplusAmountAtCreation - totalPaid;

      console.log(`💰 Cálculo de montos para deuda ${debtId}:`, {
        initialAmount: initialAmount.toFixed(2),
        surplusAmountAtCreation: surplusAmountAtCreation.toFixed(2),
        totalPaid: totalPaid.toFixed(2),
        remainingAmount: remainingAmount.toFixed(2),
        numPayments: debt.payments.length
      });
      const today = new Date();
      const dueDate = new Date(debt.dueDate);

      let newStatus: 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' = 'PENDING';

      // Si está completamente pagada
      if (remainingAmount <= 0) {
        newStatus = 'PAID';
      } else {
        // Si tiene monto pendiente, siempre queda en PENDING
        // (incluso si tiene abonos parciales o está vencida)
        // Las deudas permanecen en PENDING hasta que se paguen completamente
        newStatus = 'PENDING';
      }

      console.log(`📊 Estado calculado para deuda ${debtId}:`, {
        totalPaid,
        remainingAmount,
        newStatus,
        previousStatus: debt.status
      });

      // Asegurar que remainingAmount no sea negativo
      const finalRemainingAmount = Math.max(0, remainingAmount);
      
      await client.debt.update({
        where: { id: debtId },
        data: {
          remainingAmount: finalRemainingAmount,
          status: newStatus
        }
      });

      console.log(`💾 Deuda ${debtId} actualizada en BD:`, {
        remainingAmount: finalRemainingAmount.toFixed(2),
        status: newStatus
      });

      console.log(`✅ Estado de deuda ${debtId} actualizado a: ${newStatus}`);
    } catch (error: any) {
      console.error(`❌ Error al actualizar estado de deuda ${debtId}:`, error);
      throw error;
    }
  }

  async getDebtById(id: number): Promise<DebtResponse | null> {
    const debt = await prisma.debt.findUnique({
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
        order: {
          select: {
            invoiceFiles: true
          }
        },
        payments: {
          where: {
            deletedAt: null // Excluir pagos eliminados por defecto
          },
          include: {
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
          },
          orderBy: {
            createdAt: 'desc'
          }
        }
      }
    });

    if (!debt) {
      return null;
    }

    // Obtener el número secuencial de esta deuda para el proveedor
    const allDebtsForSupplier = await prisma.debt.findMany({
      where: { supplierId: debt.supplierId },
      orderBy: { createdAt: 'asc' },
      select: { id: true }
    });
    const debtNumber = allDebtsForSupplier.findIndex((d: any) => d.id === debt.id) + 1;

    return {
      id: debt.id,
      orderId: debt.orderId,
      supplierId: debt.supplierId,
      supplier: debt.supplier,
      title: debt.title ?? undefined,
      initialAmount: Number(debt.initialAmount),
      remainingAmount: Number(debt.remainingAmount),
      surplusAmountAtCreation: debt.surplusAmountAtCreation != null ? Number(debt.surplusAmountAtCreation) : null,
      status: debt.status,
      dueDate: debt.dueDate,
      createdAt: debt.createdAt,
      updatedAt: debt.updatedAt,
      debtNumber,
      invoiceFiles: buildInvoiceUrls(debt.orderId, getInvoiceFileNames((debt as any).order)),
      payments: debt.payments.map((p: any) => ({
        id: p.id,
        debtId: p.debtId,
        supplierId: p.supplierId,
        supplier: debt.supplier,
        amount: Number(p.amount),
        paymentMethod: p.paymentMethod,
        senderName: p.senderName,
        senderEmail: p.senderEmail,
        confirmationNumber: p.confirmationNumber,
        paymentDate: p.paymentDate,
        receiptFiles: buildReceiptUrls(p.id, getReceiptFileNames(p)),
        verified: p.verified,
        createdBy: p.createdBy,
        deletedAt: p.deletedAt || null,
        deletedBy: p.deletedBy || null,
        deletedByUser: p.deletedByUser ? {
          id: p.deletedByUser.id,
          nombre: p.deletedByUser.nombre,
          email: p.deletedByUser.email
        } : null,
        deletionReason: p.deletionReason || null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      }))
    };
  }

  async getDebtsBySupplier(
    supplierId: number,
    params?: SearchParams & PaginationParams & { includeDeletedPayments?: boolean }
  ): Promise<PaginatedResponse<DebtResponse>> {
    const page = params?.page || 1;
    const limit = params?.limit || 10;
    const skip = (page - 1) * limit;

    console.log(`🔍 Buscando deudas para proveedor ${supplierId} con filtros:`, {
      status: params?.status,
      startDate: params?.startDate,
      endDate: params?.endDate,
      page,
      limit
    });

    const where: any = {
      supplierId
    };

    if (params?.status) {
      where.status = params.status;
      console.log(`📋 Filtrando por estado: ${params.status}`);
    }

    if (params?.startDate || params?.endDate) {
      where.dueDate = {};
      if (params.startDate) {
        where.dueDate.gte = new Date(params.startDate);
      }
      if (params.endDate) {
        where.dueDate.lte = new Date(params.endDate);
      }
    }

    const [debts, total] = await Promise.all([
      prisma.debt.findMany({
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
          order: {
            select: {
              invoiceFiles: true
            }
          },
          payments: {
            where: params?.includeDeletedPayments ? {} : {
              deletedAt: null // Excluir pagos eliminados por defecto
            },
            include: {
              deletedByUser: {
                select: {
                  id: true,
                  nombre: true,
                  email: true
                }
              }
            },
            orderBy: {
              createdAt: 'desc'
            }
          }
        },
        orderBy: {
          dueDate: 'asc'
        },
        skip,
        take: limit
      }),
      prisma.debt.count({ where })
    ]);

    console.log(`📊 Deudas encontradas para proveedor ${supplierId}:`, {
      total: debts.length,
      totalCount: total,
      estados: debts.map((d: any) => ({ 
        id: d.id, 
        status: d.status, 
        remainingAmount: Number(d.remainingAmount).toFixed(2),
        numPayments: d.payments.length
      }))
    });

    // Calcular el número de deuda para cada una
    // Solo hacer esta consulta si realmente necesitamos el debtNumber
    // Para reportes grandes, podemos optimizar esto
    let allDebtsForSupplier: any[] = [];
    try {
      allDebtsForSupplier = await prisma.debt.findMany({
        where: { supplierId },
        orderBy: { createdAt: 'asc' },
        select: { id: true }
      });
      console.log(`📋 Total de deudas del proveedor para calcular números: ${allDebtsForSupplier.length}`);
    } catch (error: any) {
      console.error('⚠️ Error al obtener todas las deudas para calcular números:', error);
      // Continuar sin el debtNumber si hay error
    }

    return {
      data: debts.map((debt: any) => {
        const debtNumber = allDebtsForSupplier.findIndex((d: any) => d.id === debt.id) + 1;
        return {
          id: debt.id,
          orderId: debt.orderId,
          supplierId: debt.supplierId,
          supplier: debt.supplier,
          title: debt.title ?? undefined,
          initialAmount: Number(debt.initialAmount),
          remainingAmount: Number(debt.remainingAmount),
          surplusAmountAtCreation: debt.surplusAmountAtCreation != null ? Number(debt.surplusAmountAtCreation) : null,
          status: debt.status,
          dueDate: debt.dueDate,
          createdAt: debt.createdAt,
          updatedAt: debt.updatedAt,
          debtNumber,
          invoiceFiles: buildInvoiceUrls(debt.orderId, getInvoiceFileNames(debt.order)),
          payments: debt.payments.map((p: any) => ({
            id: p.id,
            debtId: p.debtId,
            supplierId: p.supplierId,
            supplier: debt.supplier,
            amount: Number(p.amount),
            paymentMethod: p.paymentMethod,
            senderName: p.senderName,
            senderEmail: p.senderEmail,
            confirmationNumber: p.confirmationNumber,
            paymentDate: p.paymentDate,
            receiptFiles: buildReceiptUrls(p.id, getReceiptFileNames(p)),
            verified: p.verified,
            createdBy: p.createdBy,
            deletedAt: p.deletedAt || null,
            deletedBy: p.deletedBy || null,
            deletedByUser: p.deletedByUser ? {
              id: p.deletedByUser.id,
              nombre: p.deletedByUser.nombre,
              email: p.deletedByUser.email
            } : null,
            deletionReason: p.deletionReason || null,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt
          }))
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

  async getAllDebts(
    params?: SearchParams & PaginationParams
  ): Promise<PaginatedResponse<DebtResponse>> {
    const page = params?.page || 1;
    const limit = params?.limit || 10;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (params?.status) {
      where.status = params.status;
    }

    if (params?.startDate || params?.endDate) {
      where.dueDate = {};
      if (params.startDate) {
        where.dueDate.gte = new Date(params.startDate);
      }
      if (params.endDate) {
        where.dueDate.lte = new Date(params.endDate);
      }
    }

    const [debts, total] = await Promise.all([
      prisma.debt.findMany({
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
          payments: {
            where: {
              deletedAt: null // Excluir pagos eliminados por defecto
            },
            include: {
              deletedByUser: {
                select: {
                  id: true,
                  nombre: true,
                  email: true
                }
              }
            },
            orderBy: {
              createdAt: 'desc'
            }
          }
        },
        orderBy: {
          dueDate: 'asc'
        },
        skip,
        take: limit
      }),
      prisma.debt.count({ where })
    ]);

    // Para cada deuda, calcular su número secuencial dentro de su proveedor
    const debtNumberMap = new Map<number, Map<number, number>>();
    
    // Agrupar deudas por proveedor y calcular números secuenciales
    const supplierIds = [...new Set(debts.map((d: any) => d.supplierId))];
    for (const supplierId of supplierIds) {
      const supplierDebts = await prisma.debt.findMany({
        where: { supplierId },
        orderBy: { createdAt: 'asc' },
        select: { id: true }
      });
      const supplierMap = new Map<number, number>();
      supplierDebts.forEach((debt: any, index: number) => {
        supplierMap.set(debt.id, index + 1);
      });
      debtNumberMap.set(supplierId as number, supplierMap);
    }

    return {
      data: debts.map((debt: any) => ({
        id: debt.id,
        orderId: debt.orderId,
        supplierId: debt.supplierId,
        supplier: debt.supplier,
        title: debt.title ?? undefined,
        initialAmount: Number(debt.initialAmount),
        remainingAmount: Number(debt.remainingAmount),
        surplusAmountAtCreation: debt.surplusAmountAtCreation != null ? Number(debt.surplusAmountAtCreation) : null,
        status: debt.status,
        dueDate: debt.dueDate,
        createdAt: debt.createdAt,
        updatedAt: debt.updatedAt,
        debtNumber: debtNumberMap.get(debt.supplierId)?.get(debt.id) || 1,
        payments: debt.payments.map((p: any) => ({
          id: p.id,
          debtId: p.debtId,
          supplierId: p.supplierId,
          supplier: debt.supplier,
          amount: Number(p.amount),
          paymentMethod: p.paymentMethod,
          senderName: p.senderName,
          confirmationNumber: p.confirmationNumber,
          paymentDate: p.paymentDate,
          receiptFiles: buildReceiptUrls(p.id, getReceiptFileNames(p)),
          verified: p.verified,
          createdBy: p.createdBy,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt
        }))
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Actualizar una deuda
   * Permite actualizar initialAmount y dueDate
   * Recalcula automáticamente remainingAmount, status de la deuda y totalDebt del proveedor
   */
  async updateDebt(
    debtId: number,
    data: {
      initialAmount?: number;
      dueDate?: Date;
      title?: string | null;
    }
  ): Promise<DebtResponse> {
    try {
      console.log(`🔄 Actualizando deuda ${debtId} con datos:`, data);

      // 1. Obtener la deuda actual con sus pagos
      const currentDebt = await prisma.debt.findUnique({
        where: { id: debtId },
        include: {
          supplier: {
            select: {
              id: true,
              companyName: true,
              taxId: true,
              phone: true,
              totalDebt: true,
              status: true
            }
          },
          payments: {
            where: {
              deletedAt: null // Solo pagos activos
            }
          }
        }
      });

      if (!currentDebt) {
        throw new AppError('Deuda no encontrada', 404);
      }

      // 2. Validar que al menos un campo se esté actualizando
      const titleChanged = data.title !== undefined && data.title !== (currentDebt.title ?? null);
      const hasChanges =
        (data.initialAmount !== undefined && data.initialAmount !== Number(currentDebt.initialAmount)) ||
        (data.dueDate !== undefined && new Date(data.dueDate).getTime() !== new Date(currentDebt.dueDate).getTime()) ||
        titleChanged;

      if (!hasChanges) {
        throw new AppError('No se han realizado cambios en la deuda', 400);
      }

      // 3. Validar initialAmount si se está actualizando
      if (data.initialAmount !== undefined) {
        if (data.initialAmount <= 0) {
          throw new AppError('El monto inicial debe ser mayor a 0', 400);
        }
        if (data.initialAmount > 999999.99) {
          throw new AppError('El monto inicial es demasiado grande (máximo $999,999.99)', 400);
        }
      }

      // 4. Calcular el total pagado (suma de todos los pagos activos)
      const totalPaid = currentDebt.payments.reduce((sum: number, payment: any) => {
        return sum + Number(payment.amount);
      }, 0);

      // 5. Preparar datos para actualizar
      const updateData: any = {};
      let oldRemainingAmount = Number(currentDebt.remainingAmount);
      let newRemainingAmount = oldRemainingAmount;

      if (data.initialAmount !== undefined) {
        const oldInitialAmount = Number(currentDebt.initialAmount);
        const newInitialAmount = data.initialAmount;
        
        // Calcular la diferencia en el monto inicial
        const difference = newInitialAmount - oldInitialAmount;
        
        // El remainingAmount debe ajustarse por la diferencia
        // Si aumentamos initialAmount en $100, remainingAmount también aumenta en $100
        newRemainingAmount = oldRemainingAmount + difference;
        
        // Asegurar que remainingAmount no sea negativo
        newRemainingAmount = Math.max(0, newRemainingAmount);
        
        updateData.initialAmount = newInitialAmount;
        updateData.remainingAmount = newRemainingAmount;

        console.log(`💰 Actualizando monto inicial:`, {
          oldInitialAmount: oldInitialAmount.toFixed(2),
          newInitialAmount: newInitialAmount.toFixed(2),
          difference: difference.toFixed(2),
          oldRemainingAmount: oldRemainingAmount.toFixed(2),
          newRemainingAmount: newRemainingAmount.toFixed(2),
          totalPaid: totalPaid.toFixed(2)
        });
      }

      if (data.dueDate !== undefined) {
        updateData.dueDate = new Date(data.dueDate);
        console.log(`📅 Actualizando fecha de vencimiento:`, {
          oldDueDate: currentDebt.dueDate,
          newDueDate: updateData.dueDate
        });
      }

      if (data.title !== undefined) {
        updateData.title = data.title;
        console.log(`📝 Actualizando título:`, { title: data.title });
      }

      // 6. Recalcular el status de la deuda basado en el nuevo remainingAmount
      const finalRemainingAmount = data.initialAmount !== undefined 
        ? newRemainingAmount 
        : Number(currentDebt.remainingAmount);
      
      const today = new Date();
      const dueDate = data.dueDate ? new Date(data.dueDate) : new Date(currentDebt.dueDate);
      
      let newStatus: 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' = 'PENDING';
      
      if (finalRemainingAmount <= 0) {
        newStatus = 'PAID';
      } else {
        newStatus = 'PENDING';
      }

      updateData.status = newStatus;

      console.log(`📊 Nuevo estado calculado para deuda ${debtId}:`, {
        remainingAmount: finalRemainingAmount.toFixed(2),
        status: newStatus
      });

      // 7. Actualizar la deuda en la base de datos
      const updatedDebt = await prisma.debt.update({
        where: { id: debtId },
        data: updateData,
        include: {
          supplier: {
            select: {
              id: true,
              companyName: true,
              taxId: true,
              phone: true
            }
          },
          payments: {
            where: {
              deletedAt: null
            },
            orderBy: {
              createdAt: 'desc'
            }
          }
        }
      });

      console.log(`✅ Deuda ${debtId} actualizada en BD`);

      // 8. RECALCULAR TOTAL DE DEUDA DEL PROVEEDOR
      // Sumar todas las deudas restantes del proveedor para obtener el totalDebt correcto
      const allDebtsForSupplier = await prisma.debt.findMany({
        where: {
          supplierId: currentDebt.supplierId,
          // Solo contar deudas con remainingAmount > 0
        },
        select: {
          remainingAmount: true
        }
      });

      const newTotalDebt = allDebtsForSupplier.reduce((sum: number, debt: any) => {
        return sum + Math.max(0, Number(debt.remainingAmount));
      }, 0);

      console.log(`💰 Recalculando totalDebt del proveedor ${currentDebt.supplierId}:`, {
        oldTotalDebt: Number(currentDebt.supplier.totalDebt).toFixed(2),
        newTotalDebt: newTotalDebt.toFixed(2),
        numDebts: allDebtsForSupplier.length
      });

      // 9. ACTUALIZAR PROVEEDOR: totalDebt y status
      // El status del proveedor se calcula automáticamente: PENDING si totalDebt > 0, COMPLETED si totalDebt === 0
      const supplierStatus: 'PENDING' | 'COMPLETED' = newTotalDebt > 0 ? 'PENDING' : 'COMPLETED';

      await prisma.supplier.update({
        where: { id: currentDebt.supplierId },
        data: {
          totalDebt: newTotalDebt,
          status: supplierStatus
        }
      });

      console.log(`✅ Proveedor ${currentDebt.supplierId} actualizado:`, {
        totalDebt: newTotalDebt.toFixed(2),
        status: supplierStatus,
        previousStatus: currentDebt.supplier.status
      });

      // 10. Construir respuesta
      const allDebtsForSupplierNumber = await prisma.debt.findMany({
        where: { supplierId: currentDebt.supplierId },
        orderBy: { createdAt: 'asc' },
        select: { id: true }
      });
      const debtNumber = allDebtsForSupplierNumber.findIndex((d: any) => d.id === updatedDebt.id) + 1;

      return {
        id: updatedDebt.id,
        orderId: updatedDebt.orderId,
        supplierId: updatedDebt.supplierId,
        supplier: updatedDebt.supplier,
        title: updatedDebt.title ?? undefined,
        initialAmount: Number(updatedDebt.initialAmount),
        remainingAmount: Number(updatedDebt.remainingAmount),
        surplusAmountAtCreation: updatedDebt.surplusAmountAtCreation != null ? Number(updatedDebt.surplusAmountAtCreation) : null,
        status: updatedDebt.status,
        dueDate: updatedDebt.dueDate,
        createdAt: updatedDebt.createdAt,
        updatedAt: updatedDebt.updatedAt,
        debtNumber,
        payments: updatedDebt.payments.map((p: any) => ({
          id: p.id,
          debtId: p.debtId,
          supplierId: p.supplierId,
          supplier: updatedDebt.supplier,
          amount: Number(p.amount),
          paymentMethod: p.paymentMethod,
          senderName: p.senderName,
          senderEmail: p.senderEmail,
          confirmationNumber: p.confirmationNumber,
          paymentDate: p.paymentDate,
          receiptFiles: buildReceiptUrls(p.id, getReceiptFileNames(p)),
          verified: p.verified,
          createdBy: p.createdBy,
          deletedAt: p.deletedAt || null,
          deletedBy: p.deletedBy || null,
          deletedByUser: null,
          deletionReason: p.deletionReason || null,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt
        }))
      };
    } catch (error: any) {
      console.error(`❌ Error al actualizar deuda ${debtId}:`, error);
      throw error;
    }
  }

  /**
   * Elimina una deuda y todos sus pagos asociados.
   * Recalcula el totalDebt del proveedor después de eliminar.
   * Todo se ejecuta en una transacción para evitar estados inconsistentes.
   */
  async deleteDebt(debtId: number): Promise<void> {
    await prisma.$transaction(async (tx: any) => {
      const debt = await tx.debt.findUnique({
        where: { id: debtId },
        select: { id: true, supplierId: true }
      });

      if (!debt) {
        throw new AppError('Deuda no encontrada', 404);
      }

      // 1. Eliminar todos los pagos asociados a la deuda (evitar pagos huérfanos)
      const deletedPayments = await tx.payment.deleteMany({
        where: { debtId }
      });
      console.log(`🗑️ Eliminados ${deletedPayments.count} pago(s) de la deuda ${debtId}`);

      // 2. Eliminar la deuda
      await tx.debt.delete({
        where: { id: debtId }
      });
      console.log(`✅ Deuda ${debtId} eliminada`);

      // 3. Recalcular totalDebt del proveedor (suma de remainingAmount de sus deudas restantes)
      const remainingDebts = await tx.debt.findMany({
        where: { supplierId: debt.supplierId },
        select: { remainingAmount: true }
      });

      const newTotalDebt = remainingDebts.reduce((sum: number, d: any) => sum + Math.max(0, Number(d.remainingAmount)), 0);
      const supplierStatus: 'PENDING' | 'COMPLETED' = newTotalDebt > 0 ? 'PENDING' : 'COMPLETED';

      await tx.supplier.update({
        where: { id: debt.supplierId },
        data: {
          totalDebt: newTotalDebt,
          status: supplierStatus
        }
      });
      console.log(`💰 Proveedor ${debt.supplierId} actualizado: totalDebt=${newTotalDebt}, status=${supplierStatus}`);
    });
  }
}

