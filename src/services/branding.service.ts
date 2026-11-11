import prisma from '../config/database';

export interface BrandingConfigData {
  id: number;
  appName: string;
  companyName: string;
  loginTitle: string;
  loginSubtitle: string;
  footerText: string | null;
  reportTitle: string;
  logoPath: string | null;
  faviconPath: string | null;
  primaryColor: string;
  accentColor: string;
  updatedBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateBrandingInput {
  appName?: string;
  companyName?: string;
  loginTitle?: string;
  loginSubtitle?: string;
  footerText?: string | null;
  reportTitle?: string;
  logoPath?: string | null;
  faviconPath?: string | null;
  primaryColor?: string;
  accentColor?: string;
  updatedBy?: number | null;
}

const DEFAULTS = {
  appName: 'Vencedora Pagos Proveedores',
  companyName: 'Ferretería La Vencedora',
  loginTitle: 'Gestión de Pagos',
  loginSubtitle: 'Bienvenido al portal corporativo',
  footerText: '© 2026 Sistema de Gestión de pagos de proveedores. Ferretería La Vencedora.',
  reportTitle: 'Reporte de Pagos a Proveedor',
  primaryColor: '#3b82f6',
  accentColor: '#2563eb',
};

/**
 * Servicio de configuración de marca.
 * Se mantiene una única fila (singleton) en la base de datos.
 */
export class BrandingService {
  async getConfig(): Promise<BrandingConfigData> {
    let config = await prisma.brandingConfig.findFirst({ orderBy: { id: 'asc' } });

    if (!config) {
      config = await prisma.brandingConfig.create({ data: DEFAULTS });
    }

    return config as BrandingConfigData;
  }

  async updateConfig(data: UpdateBrandingInput): Promise<BrandingConfigData> {
    const current = await this.getConfig();

    const updated = await prisma.brandingConfig.update({
      where: { id: current.id },
      data,
    });

    return updated as BrandingConfigData;
  }
}

export const brandingService = new BrandingService();
