// Los enums se importan del cliente generado de Prisma
// Si hay error, ejecutar: npm run prisma:generate
export type SupplierStatus = 'PENDING' | 'COMPLETED';
export type DebtStatus = 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE';
export type PaymentMethod = 'ZELLE' | 'TRANSFER' | 'PAGO_MOVIL' | 'CASH';
export type SupplierPaymentMethodType = 'PAGO_MOVIL' | 'ZELLE' | 'TRANSFER';

/** Datos de una cuenta de pago del proveedor (entrada y salida). */
export interface SupplierPaymentAccountInput {
  type: SupplierPaymentMethodType;
  bank?: string | null;
  accountNumber?: string | null;
  holderName?: string | null;
  holderId?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface SupplierPaymentAccountResponse extends SupplierPaymentAccountInput {
  id: number;
}

// Auth Types
export interface LoginDTO {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: {
    id: number;
    email: string;
    nombre: string;
    rol: {
      id: number;
      nombre: string;
    };
  };
}

export interface UserResponse {
  id: number;
  email: string;
  nombre: string;
  rol: {
    id: number;
    nombre: string;
  };
}

// Supplier Types
export interface CreateSupplierDTO {
  companyName: string;
  taxId?: string;
  email?: string;
  phone?: string;
  status?: SupplierStatus;
  initialDebtAmount?: number;
  debtDate?: Date;
  creditDays?: number;
  title?: string; // Título de la deuda inicial (opcional)
  paymentAccounts?: SupplierPaymentAccountInput[];
}

export interface UpdateSupplierDTO {
  companyName?: string;
  taxId?: string;
  email?: string;
  phone?: string;
  status?: SupplierStatus;
  paymentAccounts?: SupplierPaymentAccountInput[];
}

export interface SupplierResponse {
  id: number;
  companyName: string;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  status: SupplierStatus;
  totalDebt: number;
  lastPaymentDate: Date | null;
  paymentAccounts: SupplierPaymentAccountResponse[];
  createdAt: Date;
  updatedAt: Date;
}

// Order Types
export interface CreateOrderDTO {
  supplierId: number;
  amount: number;
  dispatchDate: Date;
  creditDays: number;
  title?: string; // Título de la deuda asociada (opcional)
  /** Monto de saldo excedente (créditos) a aplicar a esta nueva deuda. No puede superar el monto de la deuda ni el saldo disponible del proveedor. */
  surplusAmountToApply?: number;
}

export interface UpdateOrderDTO {
  dispatchDate?: Date | string;
  creditDays?: number;
  amount?: number;
  title?: string | null;
  /**
   * Nuevo monto total de saldo excedente (créditos del proveedor) aplicado a la deuda del pedido.
   * Equivale al valor que quedará en `debt.surplusAmountAtCreation`. No puede superar el monto del pedido
   * ni el saldo disponible al aumentar respecto al valor anterior.
   */
  surplusAmountToApply?: number;
}

export interface OrderResponse {
  id: number;
  supplierId: number;
  supplier: {
    id: number;
    companyName: string;
    taxId: string | null;
    phone: string | null;
  };
  amount: number;
  dispatchDate: Date;
  creditDays: number;
  dueDate: Date;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
  title?: string | null;
  /** URLs de las facturas adjuntas al pedido (máx. 2). */
  invoiceFiles: string[];
  debt?: {
    id: number;
    status: DebtStatus;
    remainingAmount: number;
    initialAmount: number;
    surplusAmountAtCreation?: number | null;
    dueDate: Date;
    title?: string | null;
    createdAt: Date;
    updatedAt: Date;
    invoiceFiles?: string[];
    payments?: PaymentResponse[];
  };
}

// Debt Types
export interface UpdateDebtDTO {
  initialAmount?: number;
  dueDate?: Date | string;
  title?: string | null;
}

export interface DebtResponse {
  id: number;
  orderId: number;
  supplierId: number;
  supplier: {
    id: number;
    companyName: string;
    taxId: string | null;
    phone: string | null;
  };
  title?: string | null;
  initialAmount: number;
  remainingAmount: number;
  /** Monto de saldo excedente (créditos) aplicado al registrar esta deuda. null si no se aplicó. */
  surplusAmountAtCreation?: number | null;
  status: DebtStatus;
  dueDate: Date;
  createdAt: Date;
  updatedAt: Date;
  debtNumber?: number; // Número secuencial de deuda para este proveedor (1, 2, 3...)
  /** URLs de las facturas adjuntas al pedido asociado a la deuda (máx. 2). */
  invoiceFiles?: string[];
  payments?: PaymentResponse[];
}

// Payment Types
export interface CreatePaymentDTO {
  debtId: number;
  supplierId: number;
  amount: number;
  paymentMethod: PaymentMethod;
  senderName: string;
  senderEmail?: string;
  confirmationNumber?: string;
  paymentDate: Date;
  nota?: string;
  exchangeRate?: number;
  amountInBolivares?: number;
  cashierId?: number;
  surplusAction?: 'CREDIT' | 'APPLY_TO_DEBT';
  surplusTargetDebtId?: number;
  /** Cuenta del proveedor a la que se realizó el pago (se guarda como snapshot). */
  destinationAccountId?: number | null;
}

export interface PaymentResponse {
  id: number;
  debtId: number;
  supplierId: number;
  supplier: {
    id: number;
    companyName: string;
    taxId: string | null;
    phone: string | null;
  };
  amount: number;
  paymentMethod: PaymentMethod;
  senderName: string;
  senderEmail: string | null;
  confirmationNumber: string | null;
  paymentDate: Date;
  nota: string | null;
  receiptFiles: string[];
  verified: boolean;
  shared: boolean;
  sharedAt: Date | null;
  exchangeRate: number | null;
  amountInBolivares: number | null;
  surplusAmount: number | null;
  /** Datos de la cuenta del proveedor usada para el pago. */
  destinationAccount: (SupplierPaymentAccountResponse & { id?: number }) | null;
  createdBy: number;
  createdByUser?: {
    id: number;
    nombre: string;
    email: string;
  } | null;
  deletedAt?: Date | null;
  deletedBy?: number | null;
  deletedByUser?: {
    id: number;
    nombre: string;
    email: string;
  } | null;
  deletionReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
  debt?: {
    id: number;
    orderId: number;
    status: DebtStatus;
    initialAmount: number;
    remainingAmount: number;
    dueDate: Date;
    title?: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  credit?: CreditResponse | null;
}

export interface VerifyZelleDTO {
  confirmationNumber: string;
}

export interface DeletePaymentDTO {
  reason?: string;
}

// Report Types
export interface DashboardStats {
  pendingPayments: number;
  processedPayments: number;
  totalSuppliers: number;
  totalDebt: number;
}

export interface SupplierDetailedReport {
  supplier: SupplierResponse;
  totalPaid: number;
  paymentCount: number;
  averagePayment: number;
  debts: DebtResponse[];
  payments: PaymentResponse[];
  credits?: CreditResponse[];
  totalCreditAvailable?: number;
  paymentsPagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Query Types
export interface PaginationParams {
  page?: number;
  limit?: number;
  includeDeleted?: boolean;
}

export interface SearchParams {
  search?: string;
  status?: SupplierStatus | DebtStatus;
  startDate?: Date;
  endDate?: Date;
  includeDeleted?: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Totales del listado de pagos por cajero (mismos filtros que la página). */
export interface CashierPaymentMethodTotals {
  count: number;
  totalUsd: number;
}

export interface CashierPaymentsSummary {
  totalPayments: number;
  totalAmountUsd: number;
  totalAmountBs: number;
  providersServed: number;
  byPaymentMethod: Record<PaymentMethod, CashierPaymentMethodTotals>;
}

export type CashierPaymentsResponse = PaginatedResponse<PaymentResponse> & {
  summary: CashierPaymentsSummary;
};

// Credit Types
export type CreditStatus = 'AVAILABLE' | 'PARTIALLY_USED' | 'USED';

export interface CreditResponse {
  id: number;
  paymentId: number;
  originDebtId: number;
  supplierId: number;
  amount: number;
  remaining: number;
  status: CreditStatus;
  description: string | null;
  supplier?: {
    id: number;
    companyName: string;
  };
  payment?: {
    id: number;
    senderName: string;
    paymentDate: Date;
    amount: number;
  };
  originDebt?: {
    id: number;
    title: string | null;
    supplier: {
      id: number;
      companyName: string;
    };
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface ApplyCreditDTO {
  debtId: number;
  amount: number;
}

