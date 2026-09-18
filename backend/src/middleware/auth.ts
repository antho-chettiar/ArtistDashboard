import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/database';

export interface JwtPayload {
  userId: string;
  email: string;
  role: 'ADMIN' | 'VIEWER';
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export const authenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const error: any = new Error('No token provided');
      error.statusCode = 401;
      throw error;
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      const error: any = new Error('Invalid token format');
      error.statusCode = 401;
      throw error;
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET not set');
    }

    const decoded = jwt.verify(token, secret) as JwtPayload;

    // Check if user still exists and is active
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, role: true, active: true },
    });

    if (!user || !user.active) {
      const error: any = new Error('User not found or deactivated');
      error.statusCode = 401;
      throw error;
    }

    req.user = {
      userId: user.id,
      email: user.email,
      role: user.role,
    };

    next();
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'JsonWebTokenError') {
      const err: any = error;
      err.statusCode = 401;
    }
    next(error);
  }
};

export const authorize = (...roles: ('ADMIN' | 'VIEWER')[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      const error: any = new Error('Not authenticated');
      error.statusCode = 401;
      return next(error);
    }

    if (!roles.includes(req.user.role)) {
      const error: any = new Error('Insufficient permissions');
      error.statusCode = 403;
      return next(error);
    }

    next();
  };
};

export const isAdmin = authorize('ADMIN');
