import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/database';
import { loginSchema } from '../validations/zodSchemas';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
// 1h, not 15m: the refresh cookie is SameSite=strict on the API's domain while
// the app is served from another domain, so the browser never sends it and the
// silent refresh in src/api/client.js cannot succeed. Until that is fixed, this
// lifetime IS the session length -- 15m logged everyone out mid-use.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error('JWT secrets not configured');
}

export const login = async (req: Request, res: Response) => {
  try {
    // Validate input
    const validatedData = loginSchema.parse(req.body);

    // Find user
    const user = await prisma.user.findUnique({
      where: { email: validatedData.email },
      select: { id: true, email: true, passwordHash: true, role: true, active: true },
    });

    if (!user || !user.active) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS',
      });
    }

    // Verify password
    const validPassword = await bcrypt.compare(validatedData.password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS',
      });
    }

    // Generate JWT access token
    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET as string,
      { expiresIn: JWT_EXPIRES_IN as any }
    );

    // Generate refresh token
    const refreshToken = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_REFRESH_SECRET as string,
      { expiresIn: JWT_REFRESH_EXPIRES_IN as any }
    );

    // Store refresh token in database
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt,
      },
    });

    // Set refresh token in HTTP-only cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // Return access token in response body
    return res.status(200).json({
      success: true,
      data: {
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: error,
      });
    }
    throw error;
  }
};

export const refresh = async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'No refresh token provided',
        code: 'NO_REFRESH_TOKEN',
      });
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as any;

    // Check if refresh token exists in database
    const storedToken = await prisma.refreshToken.findFirst({
      where: { token: refreshToken, userId: decoded.userId },
    });

    if (!storedToken) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token',
        code: 'INVALID_REFRESH_TOKEN',
      });
    }

    // Check expiration
    if (storedToken.expiresAt < new Date()) {
      await prisma.refreshToken.delete({ where: { id: storedToken.id } });
      return res.status(401).json({
        success: false,
        message: 'Refresh token expired',
        code: 'REFRESH_TOKEN_EXPIRED',
      });
    }

    // Get user
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, role: true, active: true },
    });

    if (!user || !user.active) {
      return res.status(401).json({
        success: false,
        message: 'User not found or deactivated',
        code: 'USER_INVALID',
      });
    }

    // Generate new access token
    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET as string,
      { expiresIn: JWT_EXPIRES_IN as any }
    );

    return res.status(200).json({
      success: true,
      data: {
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
      },
    });
  } catch (error) {
    if (error instanceof Error && 'name' in error && error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token',
        code: 'INVALID_REFRESH_TOKEN',
      });
    }
    if (error instanceof Error && 'name' in error && error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Refresh token expired',
        code: 'REFRESH_TOKEN_EXPIRED',
      });
    }
    throw error;
  }
};

export const logout = async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (refreshToken) {
      await prisma.refreshToken.deleteMany({
        where: { token: refreshToken },
      });
    }

    // Clear cookie
    res.clearCookie('refreshToken');

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    throw error;
  }
};

export const me = async (req: Request, res: Response) => {
  // This assumes authenticate middleware has set req.user
  const user = req.user;

  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'Not authenticated',
      code: 'NOT_AUTHENTICATED',
    });
  }

  return res.status(200).json({
    success: true,
    data: {
      user,
    },
  });
};
