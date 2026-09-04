import prisma from '../config/database';
import { Prisma } from '@prisma/client';
import { CreditResponse, ApplyCreditDTO, PaginationParams } from '../types';
import { AppError } from '../middleware/error.middleware';
import { SupplierService } from './supplier.service';
import { DebtService } from './debt.service';

const supplierService = new SupplierService();
const debtService = new DebtService();

export class CreditService {
  /**
   * Obtiene el saldo excedente total disponible (suma de remaining de créditos AVAILABLE/PARTIALLY_USED) del proveedor.
   */
  async getTotalAvailableCredit(supplierId: number): Promise<number> {
    const credits = await prisma.credit.findMany({
      where: {
        supplierId,
        status: { in: ['AVAILABLE', 'PARTIALLY_USED'] },
        remaining: { gt: 0 }
      },
      select: { remaining: true }
    });
    return credits.reduce((sum: number, c: { remaining: unknown }) => sum + Number(c.remaining), 0);
  }

  /**
   * Consume un monto del saldo excedente del proveedor (FIFO). Actualiza los créditos reduciendo remaining.
   * Usar dentro de una transacción pasando tx para mantener consistencia.
   */
  async consumeCreditFromSupplier(
    supplierId: number,
    amount: number,
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    if (amount <= 0) return;
    const client = tx ?? prisma;

    const credits = await client.credit.findMany({
      where: {
        supplierId,
        status: { in: ['AVAILABLE', 'PARTIALLY_USED'] },
        remaining: { gt: 0 }
      },
      orderBy: { id: 'asc' }
    });

    let remainingToConsume = amount;
    for (const credit of credits) {
      if (remainingToConsume <= 0) break;
      const creditRemaining = Number(credit.remaining);
      const consumeFromThis = Math.min(remainingToConsume, creditRemaining);
      const newRemaining = creditRemaining - consumeFromThis;
      remainingToConsume -= consumeFromThis;

      await client.credit.update({
        where: { id: credit.id },
        data: {
          remaining: newRemaining,
          status: newRemaining <= 0 ? 'USED' : 'PARTIALLY_USED'
        }
      });
    }
  }

  /**
   * Devuelve monto al pool de créditos del proveedor repartiendo sobre líneas con consumo previo
   * (prioriza las actualizadas más recientemente). Usar dentro de una transacción.
   */
  async restoreCreditToSupplier(
    supplierId: number,
    amount: number,
    tx: Prisma.TransactionClient
  ): Promise<void> {
    if (amount <= 0) return;
    let left = amount;
    const credits = await tx.credit.findMany({
      where: { supplierId },
      orderBy: { updatedAt: 'desc' }
    });
    for (const credit of credits) {
      if (left <= 1e-9) break;
      const cAmount = Number(credit.amount);
      const cRem = Number(credit.remaining);
      const consumed = cAmount - cRem;
      if (consumed <= 1e-9) continue;
      const giveBack = Math.min(left, consumed);
      const newRem = cRem + giveBack;
      left -= giveBack;
      let status: string = credit.status;
      if (newRem >= cAmount - 1e-9) status = 'AVAILABLE';
      else if (newRem > 1e-9) status = 'PARTIALLY_USED';
      else status = 'USED';
      await tx.credit.update({
        where: { id: credit.id },
        data: { remaining: newRem, status }
      });
    }
    if (left > 1e-6) {
      throw new AppError(
        `No fue posible devolver $${left.toFixed(2)} USD al saldo excedente del proveedor (no hay líneas de crédito con consumo recuperable).`,
        409
      );
    }
  }

  async listCredits(
    params?: PaginationParams & { status?: string; supplierId?: number }
  ): Promise<{ data: CreditResponse[]; summary: { totalAvailable: number }; pagination: any }> {
    const page = params?.page || 1;
    const limit = params?.limit || 50;
    const skip = (page - 1) * limit;

    const where: any = params?.status
      ? { status: params.status }
      : { status: { in: ['AVAILABLE', 'PARTIALLY_USED'] } };

    if (params?.supplierId) {
      where.supplierId = params.supplierId;
    }

    const [credits, total] = await Promise.all([
      prisma.credit.findMany({
        where,
        include: {
          supplier: {
            select: { id: true, companyName: true }
          },
          payment: {
            select: {
              id: true,
              senderName: true,
              paymentDate: true,
              amount: true
            }
          },
          originDebt: {
            select: {
              id: true,
              title: true,
              supplier: {
                select: { id: true, companyName: true }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.credit.count({ where })
    ]);

    const totalAvailable = credits.reduce(
      (sum: number, c: any) => sum + Number(c.remaining),
      0
    );

    return {
      data: credits.map((c: any) => ({
        id: c.id,
        paymentId: c.paymentId,
        originDebtId: c.originDebtId,
        supplierId: c.supplierId,
        amount: Number(c.amount),
        remaining: Number(c.remaining),
        status: c.status,
        description: c.description,
        supplier: c.supplier,
        payment: {
          id: c.payment.id,
          senderName: c.payment.senderName,
          paymentDate: c.payment.paymentDate,
          amount: Number(c.payment.amount)
        },
        originDebt: {
          id: c.originDebt.id,
          title: c.originDebt.title,
          supplier: c.originDebt.supplier
        },
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      })),
      summary: { totalAvailable },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  async getCreditById(id: number): Promise<CreditResponse | null> {
    const credit = await prisma.credit.findUnique({
      where: { id },
      include: {
        supplier: {
          select: { id: true, companyName: true }
        },
        payment: {
          select: {
            id: true,
            senderName: true,
            paymentDate: true,
            amount: true
          }
        },
        originDebt: {
          select: {
            id: true,
            title: true,
            supplier: {
              select: { id: true, companyName: true }
            }
          }
        }
      }
    });

    if (!credit) return null;

    return {
      id: credit.id,
      paymentId: credit.paymentId,
      originDebtId: credit.originDebtId,
      supplierId: credit.supplierId,
      amount: Number(credit.amount),
      remaining: Number(credit.remaining),
      status: credit.status as any,
      description: credit.description,
      supplier: credit.supplier,
      payment: {
        id: credit.payment.id,
        senderName: credit.payment.senderName,
        paymentDate: credit.payment.paymentDate,
        amount: Number(credit.payment.amount)
      },
      originDebt: {
        id: credit.originDebt.id,
        title: credit.originDebt.title,
        supplier: credit.originDebt.supplier
      },
      createdAt: credit.createdAt,
      updatedAt: credit.updatedAt
    };
  }

  async applyCredit(
    creditId: number,
    data: ApplyCreditDTO
  ): Promise<{ credit: CreditResponse; debt: any; appliedAmount: number }> {
    const credit = await prisma.credit.findUnique({ where: { id: creditId } });

    if (!credit) {
      throw new AppError('Crédito no encontrado', 404);
    }

    if (credit.status === 'USED' || Number(credit.remaining) <= 0) {
      throw new AppError('Este crédito ya fue utilizado completamente', 400);
    }

    const debt = await prisma.debt.findUnique({
      where: { id: data.debtId },
      include: {
        supplier: {
          select: { id: true, companyName: true, taxId: true, phone: true }
        }
      }
    });

    if (!debt) {
      throw new AppError('Deuda no encontrada', 404);
    }

    if (debt.status === 'PAID' || Number(debt.remainingAmount) <= 0) {
      throw new AppError('La deuda ya está completamente pagada', 400);
    }

    const requestedAmount = Number(data.amount);
    if (requestedAmount <= 0) {
      throw new AppError('El monto a aplicar debe ser mayor a 0', 400);
    }

    const applyAmount = Math.min(
      requestedAmount,
      Number(credit.remaining),
      Number(debt.remainingAmount)
    );

    const newCreditRemaining = Number(credit.remaining) - applyAmount;
    const newDebtRemaining = Number(debt.remainingAmount) - applyAmount;

    const updatedCredit = await prisma.credit.update({
      where: { id: creditId },
      data: {
        remaining: Math.max(0, newCreditRemaining),
        status: newCreditRemaining <= 0 ? 'USED' : 'PARTIALLY_USED'
      },
      include: {
        supplier: {
          select: { id: true, companyName: true }
        },
        payment: {
          select: { id: true, senderName: true, paymentDate: true, amount: true }
        },
        originDebt: {
          select: {
            id: true,
            title: true,
            supplier: { select: { id: true, companyName: true } }
          }
        }
      }
    });

    const updatedDebt = await prisma.debt.update({
      where: { id: data.debtId },
      data: {
        remainingAmount: Math.max(0, newDebtRemaining),
        status: newDebtRemaining <= 0 ? 'PAID' : 'PENDING'
      },
      include: {
        supplier: {
          select: { id: true, companyName: true, taxId: true, phone: true }
        }
      }
    });

    await supplierService.updateSupplierTotalDebt(debt.supplierId, -applyAmount);

    console.log(`✅ Crédito #${creditId} aplicado a deuda #${data.debtId}: $${applyAmount.toFixed(2)}`);

    return {
      credit: {
        id: updatedCredit.id,
        paymentId: updatedCredit.paymentId,
        originDebtId: updatedCredit.originDebtId,
        supplierId: updatedCredit.supplierId,
        amount: Number(updatedCredit.amount),
        remaining: Number(updatedCredit.remaining),
        status: updatedCredit.status as any,
        description: updatedCredit.description,
        supplier: updatedCredit.supplier,
        payment: {
          id: updatedCredit.payment.id,
          senderName: updatedCredit.payment.senderName,
          paymentDate: updatedCredit.payment.paymentDate,
          amount: Number(updatedCredit.payment.amount)
        },
        originDebt: {
          id: updatedCredit.originDebt.id,
          title: updatedCredit.originDebt.title,
          supplier: updatedCredit.originDebt.supplier
        },
        createdAt: updatedCredit.createdAt,
        updatedAt: updatedCredit.updatedAt
      },
      debt: {
        id: updatedDebt.id,
        supplierId: updatedDebt.supplierId,
        supplier: updatedDebt.supplier,
        initialAmount: Number(updatedDebt.initialAmount),
        remainingAmount: Number(updatedDebt.remainingAmount),
        status: updatedDebt.status
      },
      appliedAmount: applyAmount
    };
  }

  /**
   * Revierte saldo excedente reflejado en surplusAmountAtCreation (pedidos que consumieron crédito),
   * desde las deudas más recientes, y actualiza totalDebt del proveedor.
   */
  async revertConsumedCreditIntoDebts(
    supplierId: number,
    amountToRevert: number,
    tx: Prisma.TransactionClient
  ): Promise<void> {
    if (amountToRevert <= 0) return;
    let left = amountToRevert;
    const debts = await tx.debt.findMany({
      where: { supplierId, surplusAmountAtCreation: { gt: 0 } },
      orderBy: { id: 'desc' }
    });
    for (const d of debts) {
      if (left <= 1e-9) break;
      const applied = Number(d.surplusAmountAtCreation || 0);
      if (applied <= 0) continue;
      const take = Math.min(applied, left);
      const newApplied = applied - take;
      await tx.debt.update({
        where: { id: d.id },
        data: {
          surplusAmountAtCreation: newApplied > 0 ? newApplied : null
        }
      });
      await debtService.updateDebtStatus(d.id, tx);
      await supplierService.updateSupplierTotalDebt(supplierId, take, tx);
      left -= take;
    }
    if (left > 1e-6) {
      throw new AppError(
        `No fue posible revertir $${left.toFixed(2)} del saldo excedente ya aplicado en pedidos. Revise las deudas con excedente al crearlas.`,
        409
      );
    }
  }

  /**
   * Elimina créditos ligados al pago y revierte el monto ya consumido en deudas (surplusAmountAtCreation).
   */
  async releaseCreditsForPayment(
    paymentId: number,
    supplierId: number,
    tx: Prisma.TransactionClient
  ): Promise<void> {
    const credits = await tx.credit.findMany({ where: { paymentId } });
    for (const c of credits) {
      const consumed = Number(c.amount) - Number(c.remaining);
      if (consumed > 0) {
        await this.revertConsumedCreditIntoDebts(supplierId, consumed, tx);
      }
    }
    await tx.credit.deleteMany({ where: { paymentId } });
  }

  /**
   * Recalcula el crédito de una sola deuda basado en sus pagos activos y surplusAmountAtCreation.
   * Crea un único crédito con el exceso real (si existe).
   */
  async recalculateCreditsForDebt(
    debtId: number,
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const client = tx ?? prisma;

    const debt = await client.debt.findUnique({
      where: { id: debtId },
      include: {
        payments: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!debt) return;

    const totalPaid = debt.payments.reduce((sum: number, p: any) => sum + Number(p.amount), 0);
    const surplus = Number(debt.surplusAmountAtCreation ?? 0);
    const effectiveDebt = Number(debt.initialAmount) - surplus;
    const realExcess = Math.max(0, totalPaid - effectiveDebt);

    await client.credit.deleteMany({ where: { originDebtId: debtId } });

    if (realExcess > 0 && debt.payments.length > 0) {
      await client.credit.create({
        data: {
          supplierId: debt.supplierId,
          originDebtId: debtId,
          paymentId: debt.payments[0].id,
          amount: realExcess,
          remaining: realExcess,
          status: 'AVAILABLE',
          description: `Excedente de deuda #${debtId}`
        }
      });
    }
  }

  /**
   * Reconciliación completa de créditos para un proveedor.
   * 1. Borra todos los créditos existentes.
   * 2. Crea un crédito por cada deuda con exceso real > 0.
   * 3. Consume los créditos en orden FIFO para cubrir los surplusAmountAtCreation.
   *
   * No modifica Debt.remainingAmount ni Debt.status; solo corrige la tabla Credit.
   */
  async reconcileSupplierCredits(
    supplierId: number,
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const client = tx ?? prisma;

    const debts = await client.debt.findMany({
      where: { supplierId },
      include: {
        payments: {
          where: { deletedAt: null },
          select: { id: true, amount: true },
          orderBy: { createdAt: 'desc' }
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    // Calcular exceso real por deuda
    interface DebtCredit {
      debtId: number;
      amount: number;
      paymentId: number;
    }

    const creditsToCreate: DebtCredit[] = [];
    for (const debt of debts) {
      const totalPaid = debt.payments.reduce((sum: number, p: any) => sum + Number(p.amount), 0);
      const surplus = Number(debt.surplusAmountAtCreation ?? 0);
      const effectiveDebt = Number(debt.initialAmount) - surplus;
      const realExcess = Math.max(0, totalPaid - effectiveDebt);

      if (realExcess > 0 && debt.payments.length > 0) {
        creditsToCreate.push({
          debtId: debt.id,
          amount: Number(realExcess.toFixed(2)),
          paymentId: debt.payments[0].id
        });
      }
    }

    // Borrar créditos existentes
    await client.credit.deleteMany({ where: { supplierId } });

    // Crear nuevos créditos
    const createdCredits: { id: number; amount: number; remaining: number }[] = [];
    for (const c of creditsToCreate) {
      const created = await client.credit.create({
        data: {
          supplierId,
          originDebtId: c.debtId,
          paymentId: c.paymentId,
          amount: c.amount,
          remaining: c.amount,
          status: 'AVAILABLE',
          description: `Excedente reconciliado de deuda #${c.debtId}`
        }
      });
      createdCredits.push({ id: created.id, amount: c.amount, remaining: c.amount });
    }

    // Consumir créditos FIFO para cubrir surplusAmountAtCreation
    for (const debt of debts) {
      if (debt.surplusAmountAtCreation === null || Number(debt.surplusAmountAtCreation) <= 0) {
        continue;
      }

      let stillNeeded = Number(debt.surplusAmountAtCreation);
      for (const credit of createdCredits) {
        if (stillNeeded <= 0.001) break;
        if (credit.remaining <= 0.001) continue;

        const consume = Math.min(stillNeeded, credit.remaining);
        credit.remaining -= consume;
        stillNeeded -= consume;

        await client.credit.update({
          where: { id: credit.id },
          data: {
            remaining: credit.remaining,
            status: credit.remaining <= 0.001 ? 'USED' : 'PARTIALLY_USED'
          }
        });
      }

      if (stillNeeded > 0.01) {
        console.warn(
          `⚠️ No hay créditos suficientes para cubrir el surplusAmountAtCreation ` +
            `de la deuda #${debt.id}. Faltante: ${stillNeeded.toFixed(2)}. ` +
            `Esta deuda fue creada con saldo excedente que ya no existe. ` +
            `Revisa manualmente los pagos y los saldos excedentes del proveedor #${supplierId}.`
        );
      }
    }
  }
}
