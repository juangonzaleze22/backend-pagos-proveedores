import prisma from '../config/database';
import { comparePassword } from '../utils/hashPassword';
import { generateToken } from '../utils/jwt';
import { LoginDTO, AuthResponse } from '../types';
import { AppError } from '../middleware/error.middleware';

export class AuthService {
  async login(data: LoginDTO): Promise<AuthResponse> {
    const { email, password } = data;

    // Buscar usuario con su rol
    const usuario = await prisma.usuario.findUnique({
      where: { email },
      include: { rol: true }
    });

    if (!usuario) {
      throw new AppError('Credenciales inválidas', 401);
    }

    // Verificar contraseña
    const isValidPassword = await comparePassword(password, usuario.password);
    if (!isValidPassword) {
      throw new AppError('Credenciales inválidas', 401);
    }

    // Generar token
    const token = generateToken({
      userId: usuario.id,
      email: usuario.email,
      nombre: usuario.nombre,
      rolId: usuario.rolId,
      rolNombre: usuario.rol.nombre
    });

    return {
      token,
      user: {
        id: usuario.id,
        email: usuario.email,
        nombre: usuario.nombre,
        rol: {
          id: usuario.rol.id,
          nombre: usuario.rol.nombre
        }
      }
    };
  }

  async getCurrentUser(userId: number) {
    const usuario = await prisma.usuario.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        nombre: true,
        rol: {
          select: {
            id: true,
            nombre: true
          }
        }
      }
    });

    if (!usuario) {
      throw new Error('Usuario no encontrado');
    }

    return usuario;
  }
}

