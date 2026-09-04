/**
 * Script de reconciliación de saldos excedentes (créditos).
 *
 * PROBLEMA QUE RESUELVE:
 * Los créditos del proveedor pueden quedar inconsistentes cuando:
 * - Se crean pagos que generan excedentes.
 * - Se editan pagos (syncSurplusAfterPaymentEdit solo recalcula el crédito de ESE pago).
 * - Se crean/actualizan pedidos con saldo excedente (surplusAmountAtCreation).
 *
 * ESTE SCRIPT:
 * 1. Borra todos los créditos del proveedor.
 * 2. Calcula el exceso REAL de cada deuda:
 *    excess = max(0, totalPaid - (initialAmount - surplusAmountAtCreation))
 * 3. Crea un crédito por cada deuda con exceso > 0.
 * 4. Consume esos créditos en orden FIFO para cubrir los surplusAmountAtCreation
 *    de las deudas que usaron saldo excedente al crearse.
 *
 * MODO SIMULACIÓN (recomendado primero):
 *   npx ts-node src/scripts/reconcile-credits.ts --dry-run --supplier-id 71
 *
 * EJECUCIÓN REAL:
 *   npx ts-node src/scripts/reconcile-credits.ts --supplier-id 71
 *
 * PARA TODOS LOS PROVEEDORES:
 *   npx ts-node src/scripts/reconcile-credits.ts --dry-run
 */

import '../config/env'; // Asegura que dotenv se cargue antes que cualquier otra cosa
import prisma from '../config/database';
import { Prisma } from '@prisma/client';

interface ReconcileOptions {
  dryRun: boolean;
  supplierId?: number;
}

interface DebtSummary {
  id: number;
  supplierId: number;
  title: string | null;
  initialAmount: number;
  surplusAmountAtCreation: number;
  totalPaid: number;
  realExcess: number;
  status: string;
  lastPaymentId: number | null;
}

interface PlannedCredit {
  originDebtId: number;
  paymentId: number | null;
  amount: number;
  description: string;
}

interface ConsumptionPlan {
  creditIndex: number;
  creditAmount: number;
  consume: number;
  debtId: number;
  surplusAmountAtCreation: number;
}

function parseArgs(): ReconcileOptions {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const supplierIdArg = args.find((_, i) => args[i - 1] === '--supplier-id');
  const supplierId = supplierIdArg ? parseInt(supplierIdArg, 10) : undefined;

  if (supplierIdArg && (isNaN(supplierId as number) || (supplierId as number) <= 0)) {
    throw new Error('--supplier-id debe ser un número positivo');
  }

  return { dryRun, supplierId };
}

async function getDebtsForSupplier(supplierId: number): Promise<DebtSummary[]> {
  const debts = await prisma.debt.findMany({
    where: { supplierId },
    include: {
      payments: {
        where: { deletedAt: null },
        select: { id: true, amount: true },
        orderBy: { createdAt: 'desc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return debts.map((debt: any) => {
    const totalPaid = debt.payments.reduce((sum: number, p: any) => sum + Number(p.amount), 0);
    const surplus = Number(debt.surplusAmountAtCreation ?? 0);
    const effectiveDebt = Number(debt.initialAmount) - surplus;
    const realExcess = Math.max(0, totalPaid - effectiveDebt);
    const lastPaymentId = debt.payments.length > 0 ? debt.payments[0].id : null;

    return {
      id: debt.id,
      supplierId: debt.supplierId,
      title: debt.title,
      initialAmount: Number(debt.initialAmount),
      surplusAmountAtCreation: surplus,
      totalPaid,
      realExcess,
      status: debt.status,
      lastPaymentId,
    };
  });
}

function planReconciliation(debts: DebtSummary[]) {
  // 1. Créditos a crear: un crédito por cada deuda con exceso real > 0
  const creditsToCreate: PlannedCredit[] = debts
    .filter((d) => d.realExcess > 0)
    .map((d) => {
      if (!d.lastPaymentId) {
        throw new Error(
          `La deuda #${d.id} tiene exceso real de ${d.realExcess.toFixed(2)} ` +
            `pero no tiene pagos activos. Esto es inconsistente.`
        );
      }
      return {
        originDebtId: d.id,
        paymentId: d.lastPaymentId,
        amount: Number(d.realExcess.toFixed(2)),
        description: `Excedente reconciliado de deuda #${d.id}${d.title ? ` (${d.title})` : ''}`,
      };
    });

  // 2. Consumos planificados: cubrir los surplusAmountAtCreation de cada deuda
  //    en orden FIFO de creación de créditos.
  const consumptionPlans: ConsumptionPlan[] = [];
  const uncoveredSurplus: { debtId: number; surplus: number; uncovered: number }[] = [];
  let creditPool = creditsToCreate.map((c, idx) => ({ index: idx, remaining: c.amount }));

  for (const debt of debts) {
    if (debt.surplusAmountAtCreation <= 0) continue;

    let stillNeeded = debt.surplusAmountAtCreation;
    for (const credit of creditPool) {
      if (stillNeeded <= 0.001) break;
      if (credit.remaining <= 0.001) continue;

      const consume = Math.min(stillNeeded, credit.remaining);
      consumptionPlans.push({
        creditIndex: credit.index,
        creditAmount: creditsToCreate[credit.index].amount,
        consume: Number(consume.toFixed(2)),
        debtId: debt.id,
        surplusAmountAtCreation: debt.surplusAmountAtCreation,
      });

      credit.remaining -= consume;
      stillNeeded -= consume;
    }

    if (stillNeeded > 0.01) {
      uncoveredSurplus.push({
        debtId: debt.id,
        surplus: debt.surplusAmountAtCreation,
        uncovered: stillNeeded
      });
    }
  }

  const finalRemainingByCredit = creditPool.map((c) => ({
    creditIndex: c.index,
    originDebtId: creditsToCreate[c.index].originDebtId,
    amount: creditsToCreate[c.index].amount,
    remaining: Number(c.remaining.toFixed(2)),
  }));

  const totalAvailableAfter = finalRemainingByCredit.reduce((sum, c) => sum + c.remaining, 0);

  return {
    creditsToCreate,
    consumptionPlans,
    finalRemainingByCredit,
    totalAvailableAfter,
    uncoveredSurplus,
  };
}

async function getCurrentCredits(supplierId: number) {
  return prisma.credit.findMany({
    where: { supplierId },
    include: {
      originDebt: { select: { id: true, title: true } },
      payment: { select: { id: true, amount: true } },
    },
    orderBy: { id: 'asc' },
  });
}

async function reconcileSupplier(supplierId: number, options: ReconcileOptions) {
  const supplier = await prisma.supplier.findUnique({
    where: { id: supplierId },
    select: { id: true, companyName: true, totalDebt: true },
  });

  if (!supplier) {
    console.warn(`⚠️ Proveedor #${supplierId} no encontrado. Se omite.`);
    return;
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`🏢 PROVEEDOR #${supplierId} - ${supplier.companyName}`);
  console.log(`${'='.repeat(70)}`);

  const debts = await getDebtsForSupplier(supplierId);
  const currentCredits = await getCurrentCredits(supplierId);

  console.log(`\n📋 DEUDAS ANALIZADAS (${debts.length}):`);
  console.log(
    ['ID', 'Título', 'Inicial', 'Surplus al crear', 'Pagado', 'Exceso real', 'Estado']
      .map((h) => h.padEnd(16))
      .join('')
  );
  for (const d of debts) {
    console.log(
      [
        String(d.id).padEnd(16),
        (d.title ?? '-').padEnd(16),
        d.initialAmount.toFixed(2).padEnd(16),
        d.surplusAmountAtCreation.toFixed(2).padEnd(16),
        d.totalPaid.toFixed(2).padEnd(16),
        d.realExcess.toFixed(2).padEnd(16),
        d.status.padEnd(16),
      ].join('')
    );
  }

  const totalRealExcess = debts.reduce((sum, d) => sum + d.realExcess, 0);
  const totalSurplusAtCreation = debts.reduce((sum, d) => sum + d.surplusAmountAtCreation, 0);
  const currentTotalCreditAmount = currentCredits.reduce((sum: number, c: any) => sum + Number(c.amount), 0);
  const currentTotalRemaining = currentCredits.reduce((sum: number, c: any) => sum + Number(c.remaining), 0);

  console.log(`\n💳 CRÉDITOS ACTUALES (${currentCredits.length}):`);
  if (currentCredits.length === 0) {
    console.log('   No hay créditos.');
  } else {
    console.log(
      ['ID', 'Origen (Deuda)', 'Pago #', 'Monto', 'Remanente', 'Estado']
        .map((h) => h.padEnd(16))
        .join('')
    );
    for (const c of currentCredits) {
      console.log(
        [
          String(c.id).padEnd(16),
          `#${c.originDebt.id}${c.originDebt.title ? ` (${c.originDebt.title})` : ''}`.padEnd(16),
          (c.payment ? `#${c.payment.id}` : '-').padEnd(16),
          Number(c.amount).toFixed(2).padEnd(16),
          Number(c.remaining).toFixed(2).padEnd(16),
          c.status.padEnd(16),
        ].join('')
      );
    }
  }

  console.log(`\n📊 RESUMEN ACTUAL:`);
  console.log(`   Total exceso real de deudas:     ${totalRealExcess.toFixed(2)}`);
  console.log(`   Total surplusAmountAtCreation:   ${totalSurplusAtCreation.toFixed(2)}`);
  console.log(`   Suma de montos de créditos:      ${currentTotalCreditAmount.toFixed(2)}`);
  console.log(`   Suma de remanentes (disponible): ${currentTotalRemaining.toFixed(2)}`);

  const plan = planReconciliation(debts);

  console.log(`\n📝 PLAN DE RECONCILIACIÓN:`);
  console.log(`   Créditos a crear:                ${plan.creditsToCreate.length}`);
  for (const c of plan.creditsToCreate) {
    console.log(
      `     - Deuda #${c.originDebtId}: monto ${c.amount.toFixed(2)} - ${c.description}`
    );
  }

  console.log(`\n   Consumos planificados (para cubrir surplus al crear):`);
  if (plan.consumptionPlans.length === 0) {
    console.log('     Ninguno.');
  } else {
    for (const cp of plan.consumptionPlans) {
      console.log(
        `     - Crédito[${cp.creditIndex}] de ${cp.creditAmount.toFixed(2)} ` +
          `→ consume ${cp.consume.toFixed(2)} para deuda #${cp.debtId} ` +
          `(surplus ${cp.surplusAmountAtCreation.toFixed(2)})`
      );
    }
  }

  console.log(`\n📈 ESTADO FINAL ESPERADO:`);
  for (const c of plan.finalRemainingByCredit) {
    console.log(
      `   Crédito[${c.creditIndex}] de deuda #${c.originDebtId}: ` +
        `monto ${c.amount.toFixed(2)}, remanente ${c.remaining.toFixed(2)}`
    );
  }
  console.log(`   Crédito disponible total:        ${plan.totalAvailableAfter.toFixed(2)}`);
  console.log(`   Diferencia con el actual:        ${(plan.totalAvailableAfter - currentTotalRemaining).toFixed(2)}`);

  if (plan.uncoveredSurplus.length > 0) {
    console.log(`\n⚠️  SURPLUS SIN CUBRIR (requieren revisión manual):`);
    for (const u of plan.uncoveredSurplus) {
      console.log(
        `   Deuda #${u.debtId}: surplus=${u.surplus.toFixed(2)}, sin cubrir=${u.uncovered.toFixed(2)}`
      );
    }
    console.log(`   Total sin cubrir: ${plan.uncoveredSurplus.reduce((s, u) => s + u.uncovered, 0).toFixed(2)}`);
  }

  if (options.dryRun) {
    console.log(`\n🔍 MODO SIMULACIÓN: no se realizaron cambios.`);
    return;
  }

  // Ejecución real dentro de una transacción
  console.log(`\n🚀 EJECUTANDO CAMBIOS...`);
  await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // 1. Borrar créditos existentes
      const deleted = await tx.credit.deleteMany({ where: { supplierId } });
      console.log(`   ✅ ${deleted.count} crédito(s) eliminado(s).`);

      // 2. Crear nuevos créditos
      const createdCredits: { id: number; index: number; remaining: number }[] = [];
      for (let i = 0; i < plan.creditsToCreate.length; i++) {
        const c = plan.creditsToCreate[i];
        const created = await tx.credit.create({
          data: {
            supplierId,
            originDebtId: c.originDebtId,
            paymentId: c.paymentId as number,
            amount: c.amount,
            remaining: c.amount,
            status: 'AVAILABLE',
            description: c.description,
          },
        });
        createdCredits.push({ id: created.id, index: i, remaining: c.amount });
        console.log(`   ✅ Crédito creado #${created.id}: deuda #${c.originDebtId}, monto ${c.amount.toFixed(2)}`);
      }

      // 3. Consumir créditos según el plan
      for (const cp of plan.consumptionPlans) {
        const creditRecord = createdCredits.find((c) => c.index === cp.creditIndex);
        if (!creditRecord) {
          throw new Error(`Crédito índice ${cp.creditIndex} no encontrado al consumir.`);
        }

        const consume = Math.min(cp.consume, creditRecord.remaining);
        const newRemaining = creditRecord.remaining - consume;
        creditRecord.remaining = newRemaining;

        await tx.credit.update({
          where: { id: creditRecord.id },
          data: {
            remaining: newRemaining,
            status: newRemaining <= 0.001 ? 'USED' : 'PARTIALLY_USED',
          },
        });

        console.log(
          `   ✅ Consumidos ${consume.toFixed(2)} del crédito #${creditRecord.id} ` +
            `(deuda #${cp.debtId}), remanente ${newRemaining.toFixed(2)}`
        );
      }
    },
    { timeout: 60000 } // 60 segundos para proveedores con muchos datos
  );

  if (plan.uncoveredSurplus.length > 0) {
    console.log(`\n⚠️  ADVERTENCIA: Hay ${plan.uncoveredSurplus.length} deuda(s) con surplusAmountAtCreation sin cubrir:`);
    for (const u of plan.uncoveredSurplus) {
      console.log(`     Deuda #${u.debtId}: ${u.uncovered.toFixed(2)} sin cubrir`);
    }
    console.log(`   Estas deudas fueron creadas con saldo excedente que ya no existe.`);
    console.log(`   Revisa manualmente si necesitas ajustar sus montos o agregar pagos.`);
  }

  console.log(`\n✅ Reconciliación completada para proveedor #${supplierId}.`);
}

async function main() {
  const options = parseArgs();

  console.log(`🔧 Script de reconciliación de créditos`);
  console.log(`   Modo simulación: ${options.dryRun ? 'SÍ' : 'NO'}`);
  console.log(
    `   Proveedor: ${options.supplierId ? `#${options.supplierId}` : 'TODOS'}`
  );

  try {
    if (options.supplierId) {
      await reconcileSupplier(options.supplierId, options);
    } else {
      const suppliers = await prisma.supplier.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      console.log(`\nSe procesarán ${suppliers.length} proveedor(es).`);
      for (const s of suppliers) {
        await reconcileSupplier(s.id, options);
      }
    }

    console.log(`\n🏁 Proceso finalizado.`);
  } catch (error: any) {
    console.error(`\n❌ ERROR: ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
