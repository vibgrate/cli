import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { ApiResponse } from "@repo/types";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

interface JwtPayload {
  userId: string;
  iat: number;
  exp: number;
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: string;
    }
  }
}

/**
 * Authentication middleware - requires valid JWT token
 */
export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: { code: "UNAUTHORIZED", message: "Authorization header required" },
      };
      res.status(401).json(response);
      return;
    }

    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: { code: "UNAUTHORIZED", message: "Invalid authorization format" },
      };
      res.status(401).json(response);
      return;
    }

    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;

    // Attach user ID to request for downstream use
    req.userId = payload.userId;

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: { code: "TOKEN_EXPIRED", message: "Token has expired" },
      };
      res.status(401).json(response);
      return;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: { code: "INVALID_TOKEN", message: "Invalid token" },
      };
      res.status(401).json(response);
      return;
    }

    console.error("Authentication error:", error);
    const response: ApiResponse<null> = {
      success: false,
      data: null,
      error: { code: "AUTH_ERROR", message: "Authentication failed" },
    };
    res.status(500).json(response);
  }
}

/**
 * Optional authentication - attaches user info if token present, but doesn't require it
 */
export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    next();
    return;
  }

  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    next();
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.userId = payload.userId;
  } catch {
    // Ignore invalid tokens for optional auth
  }

  next();
}

/**
 * Role-based authorization middleware
 */
export function requireRole(...roles: string[]) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (!req.userId) {
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      };
      res.status(401).json(response);
      return;
    }

    // In a real app, you'd fetch the user role from the database
    // For this example, we'll check if the role was attached to the request
    if (!req.userRole || !roles.includes(req.userRole)) {
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: {
          code: "FORBIDDEN",
          message: `Required role: ${roles.join(" or ")}`,
        },
      };
      res.status(403).json(response);
      return;
    }

    next();
  };
}

/**
 * API key authentication for service-to-service calls
 */
export function apiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const apiKey = req.headers["x-api-key"];
  const validApiKey = process.env.API_KEY;

  if (!validApiKey) {
    console.warn("API_KEY not configured - skipping API key auth");
    next();
    return;
  }

  if (!apiKey || apiKey !== validApiKey) {
    const response: ApiResponse<null> = {
      success: false,
      data: null,
      error: { code: "INVALID_API_KEY", message: "Invalid or missing API key" },
    };
    res.status(401).json(response);
    return;
  }

  next();
}
