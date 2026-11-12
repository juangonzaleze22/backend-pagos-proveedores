import prisma from '../config/database';
import type { Prisma } from '@prisma/client';
import {
  CreateSupplierDTO,
  UpdateSupplierDTO,
  SupplierResponse,
  SearchParams,
  PaginationParams,
  PaginatedResponse,
  SupplierPaymentAccountInput,
  SupplierPaymentAccountResponse
} from '../types';
import type { SupplierStatus } from '../types';
import { AppError } from '../middleware/error.middleware';

export class SupplierService {
  async createSupplier(
    data: CreateSupplierDTO,
    userId: number,
    invoiceFileNames: string[] = [],
    invoiceFilePaths?: string[]
  ): Promise<SupplierResponse> {
    const { companyName, taxId, email, phone, status, initialDebtAmount, debtDate, creditDays, title } = data;
    const invoiceNames = (invoiceFileNames || []).slice(0, 2);

    // Validar que el taxId sea único solo si se proporciona
    if (taxId != null && taxId !== '') {
      const existingSupplier = await prisma.supplier.findUnique({
        where: { taxId: taxId.trim() }
      });
      if (existingSupplier) {
        throw new Error('Ya existe un proveedor con este RIF/Identificación Fiscal');
      }
    }

    // Convertir initialDebtAmount a número si viene como string
    const debtAmount = typeof initialDebtAmount === 'string' 
      ? parseFloat(initialDebtAmount) 
      : (initialDebtAmount || 0);

    const paymentAccounts = this.normalizePaymentAccounts(data.paymentAccounts);

    // Crear proveedor
    // El status se calculará dinámicamente basado en totalDebt
    // Si tiene deuda inicial, será PENDING, si no, COMPLETED
    const initialStatus: SupplierStatus = debtAmount > 0 ? 'PENDING' : 'COMPLETED';
    const supplier = await prisma.supplier.create({
      data: {
        companyName,
        taxId: taxId != null && taxId !== '' ? taxId.trim() : null,
        email: email?.trim() || null,
        phone,
        status: (status as SupplierStatus) || initialStatus,
        totalDebt: debtAmount,
        ...(paymentAccounts.length > 0 && {
          paymentAccounts: { create: paymentAccounts }
        })
      },
      include: { paymentAccounts: true }
    });

    // Si hay deuda inicial, crear pedido y deuda
    if (debtAmount > 0 && debtDate && creditDays) {
      const dispatchDate = new Date(debtDate);
      const dueDate = new Date(dispatchDate);
      dueDate.setDate(dueDate.getDate() + creditDays);

      const creditDaysNum = typeof creditDays === 'string' ? parseInt(creditDays) : creditDays;

      const order = await prisma.order.create({
        data: {
          supplierId: supplier.id,
          amount: debtAmount,
          dispatchDate,
          creditDays: creditDaysNum,
          dueDate,
          createdBy: userId,
          ...(invoiceNames.length > 0 && {
            invoiceFiles: invoiceNames as unknown as Prisma.InputJsonValue
          })
        }
      });

      await prisma.debt.create({
        data: {
          orderId: order.id,
          supplierId: supplier.id,
          title: title ?? null,
          initialAmount: debtAmount,
          remainingAmount: debtAmount,
          dueDate,
          status: 'PENDING'
        }
      });
    }

    return this.mapToResponse(supplier);
  }

  async getSupplierById(id: number): Promise<SupplierResponse | null> {
    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: { paymentAccounts: true }
    });

    if (!supplier) {
      return null;
    }

    return this.mapToResponse(supplier);
  }

  async searchSuppliers(
    search?: string,
    params?: SearchParams & PaginationParams
  ): Promise<PaginatedResponse<SupplierResponse>> {
    const where: any = {};

    if (search) {
      // MySQL no soporta mode: 'insensitive'; la búsqueda es case-sensitive
      where.OR = [
        { companyName: { contains: search } },
        { taxId: { contains: search } }
      ];
    }

    // Filtro por status - temporalmente deshabilitado hasta regenerar cliente de Prisma
    // TODO: Habilitar después de ejecutar: npx prisma generate
    // if (params?.status) {
    //   where.status = params.status;
    // }
    
    // Filtro temporal: usar totalDebt en lugar de status hasta regenerar Prisma
    // Verificar que el status sea de tipo SupplierStatus (PENDING o COMPLETED)
    if (params?.status) {
      const supplierStatus = params.status as SupplierStatus;
      if (supplierStatus === 'PENDING') {
        where.totalDebt = { gt: 0 };
      } else if (supplierStatus === 'COMPLETED') {
        where.totalDebt = { equals: 0 };
      }
    }

    const suppliers = await prisma.supplier.findMany({
      where,
      include: { paymentAccounts: true },
      orderBy: {
        companyName: 'asc'
      }
    });

    const data = suppliers.map((s: any) => this.mapToResponse(s));
    return {
      data,
      pagination: {
        page: 1,
        limit: data.length,
        total: data.length,
        totalPages: 1
      }
    };
  }

  async updateSupplier(id: number, data: UpdateSupplierDTO): Promise<SupplierResponse> {
    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: { paymentAccounts: true }
    });

    if (!supplier) {
      throw new AppError('Proveedor no encontrado', 404);
    }

    const normalizedAccounts = data.paymentAccounts !== undefined
      ? this.normalizePaymentAccounts(data.paymentAccounts)
      : undefined;
    const accountsChanged = normalizedAccounts !== undefined &&
      !this.arePaymentAccountsEqual(normalizedAccounts, supplier.paymentAccounts);

    // Validar que al menos un campo se esté actualizando
    const hasChanges = 
      (data.companyName !== undefined && data.companyName !== supplier.companyName) ||
      (data.taxId !== undefined && data.taxId !== supplier.taxId) ||
      (data.email !== undefined && (data.email?.trim() ?? null) !== (supplier.email ?? null)) ||
      (data.phone !== undefined && data.phone !== supplier.phone) ||
      (data.status !== undefined && data.status !== supplier.status) ||
      accountsChanged;

    if (!hasChanges) {
      throw new AppError('No se han realizado cambios en el proveedor', 400);
    }

    // Si se actualiza el taxId, verificar que sea único cuando tiene valor
    if (data.taxId !== undefined && data.taxId !== supplier.taxId) {
      const newTaxId = data.taxId === null || data.taxId === '' ? null : data.taxId.trim();
      if (newTaxId !== null) {
        const existingSupplier = await prisma.supplier.findUnique({
          where: { taxId: newTaxId }
        });
        if (existingSupplier) {
          throw new AppError('Ya existe un proveedor con este RIF/Identificación Fiscal', 400);
        }
      }
    }

    // Preparar datos para actualizar
    const updateData: any = {};

    if (data.companyName !== undefined) {
      if (!data.companyName || data.companyName.trim().length < 3) {
        throw new AppError('El nombre de la empresa debe tener al menos 3 caracteres', 400);
      }
      updateData.companyName = data.companyName.trim();
    }

    if (data.taxId !== undefined) {
      updateData.taxId = data.taxId === null || data.taxId === '' ? null : data.taxId.trim();
    }

    if (data.phone !== undefined) {
      // Permitir null o string vacío para limpiar el teléfono
      updateData.phone = data.phone === null || data.phone === '' ? null : data.phone.trim();
    }

    if (data.email !== undefined) {
      updateData.email = data.email === null || data.email === '' ? null : data.email.trim();
    }

    if (data.status !== undefined) {
      // Validar que el status sea válido
      if (data.status !== 'PENDING' && data.status !== 'COMPLETED') {
        throw new AppError('El estado debe ser PENDING o COMPLETED', 400);
      }
      updateData.status = data.status;
    }

    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (normalizedAccounts !== undefined) {
        await tx.supplierPaymentAccount.deleteMany({ where: { supplierId: id } });
        if (normalizedAccounts.length > 0) {
          await tx.supplierPaymentAccount.createMany({
            data: normalizedAccounts.map((account) => ({ ...account, supplierId: id }))
          });
        }
      }

      return tx.supplier.update({
        where: { id },
        data: updateData,
        include: { paymentAccounts: true }
      });
    });

    return this.mapToResponse(updated);
  }

  async deleteSupplier(id: number): Promise<void> {
    const supplier = await prisma.supplier.findUnique({
      where: { id }
    });

    if (!supplier) {
      throw new AppError('Proveedor no encontrado', 404);
    }

    await prisma.supplier.delete({
      where: { id }
    });
  }

  async updateSupplierTotalDebt(
    supplierId: number,
    amount: number,
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const client = tx ?? prisma;
    try {
      console.log(`🔄 Actualizando total de deuda del proveedor ${supplierId} con incremento: ${amount}`);
      
      // Primero obtener el proveedor para calcular el nuevo totalDebt
      const supplier = await client.supplier.findUnique({
        where: { id: supplierId },
        select: { totalDebt: true }
      });

      if (!supplier) {
        throw new Error('Proveedor no encontrado');
      }

      const newTotalDebt = Number(supplier.totalDebt) + amount;
      
      // Calcular el nuevo status basado en el totalDebt actualizado
      const newStatus: SupplierStatus = newTotalDebt > 0 ? 'PENDING' : 'COMPLETED';
      
      await client.supplier.update({
        where: { id: supplierId },
        data: {
          totalDebt: {
            increment: amount
          },
          status: newStatus // Actualizar status automáticamente
        }
      });
      console.log(`✅ Total de deuda actualizado para proveedor ${supplierId}. Nuevo status: ${newStatus}`);
    } catch (error: any) {
      console.error(`❌ Error al actualizar total de deuda del proveedor ${supplierId}:`, error);
      throw error;
    }
  }

  async updateSupplierLastPaymentDate(supplierId: number, date: Date): Promise<void> {
    try {
      console.log(`🔄 Actualizando última fecha de pago del proveedor ${supplierId} a: ${date}`);
      await prisma.supplier.update({
        where: { id: supplierId },
        data: {
          lastPaymentDate: date
        }
      });
      console.log(`✅ Última fecha de pago actualizada para proveedor ${supplierId}`);
    } catch (error: any) {
      console.error(`❌ Error al actualizar última fecha de pago del proveedor ${supplierId}:`, error);
      throw error;
    }
  }

  private normalizePaymentAccounts(
    accounts?: SupplierPaymentAccountInput[]
  ): SupplierPaymentAccountInput[] {
    if (!accounts || !Array.isArray(accounts)) {
      return [];
    }

    const validTypes = new Set(['PAGO_MOVIL', 'ZELLE', 'TRANSFER']);
    return accounts
      .filter((account) => account && validTypes.has(account.type))
      .map((account) => ({
        type: account.type,
        bank: this.cleanOptional(account.bank),
        accountNumber: this.cleanOptional(account.accountNumber),
        holderName: this.cleanOptional(account.holderName),
        holderId: this.cleanOptional(account.holderId),
        email: this.cleanOptional(account.email),
        phone: this.cleanOptional(account.phone)
      }))
      .filter((account) =>
        account.bank ||
        account.accountNumber ||
        account.holderName ||
        account.holderId ||
        account.email ||
        account.phone
      );
  }

  private cleanOptional(value?: string | null): string | null {
    const trimmed = (value ?? '').toString().trim();
    return trimmed === '' ? null : trimmed;
  }

  private arePaymentAccountsEqual(
    inputAccounts: SupplierPaymentAccountInput[],
    existingAccounts: any[]
  ): boolean {
    const sortFn = (a: any, b: any) => {
      const typeCompare = String(a.type).localeCompare(String(b.type));
      if (typeCompare !== 0) return typeCompare;
      return String(a.accountNumber ?? a.email ?? a.phone ?? '').localeCompare(
        String(b.accountNumber ?? b.email ?? b.phone ?? '')
      );
    };

    const a = [...inputAccounts].sort(sortFn);
    const b = (existingAccounts || []).map((account) => ({
      type: account.type,
      bank: account.bank ?? null,
      accountNumber: account.accountNumber ?? null,
      holderName: account.holderName ?? null,
      holderId: account.holderId ?? null,
      email: account.email ?? null,
      phone: account.phone ?? null
    })).sort(sortFn);

    return JSON.stringify(a) === JSON.stringify(b);
  }

  private mapPaymentAccount(account: any): SupplierPaymentAccountResponse {
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

  private mapToResponse(supplier: any): SupplierResponse {
    return {
      id: supplier.id,
      companyName: supplier.companyName,
      taxId: supplier.taxId ?? null,
      email: supplier.email ?? null,
      phone: supplier.phone,
      status: supplier.status,
      totalDebt: Number(supplier.totalDebt),
      lastPaymentDate: supplier.lastPaymentDate,
      paymentAccounts: (supplier.paymentAccounts || []).map((account: any) =>
        this.mapPaymentAccount(account)
      ),
      createdAt: supplier.createdAt,
      updatedAt: supplier.updatedAt
    };
  }
}

