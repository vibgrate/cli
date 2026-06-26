import { Router, type Request, type Response } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { prisma } from "@repo/database";
import type { User, ApiResponse } from "@repo/types";
import { validateBody } from "../middleware/validation";
import { authenticate } from "../middleware/auth";

export const usersRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

// Registration schema
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  name: z.string().min(1).max(100),
});

// Login schema
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// Update profile schema
const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  avatar: z.string().url().optional(),
});

// Helper to generate JWT
function generateToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "7d" });
}

// Helper to sanitize user (remove password)
function sanitizeUser(user: any): Omit<User, "password"> {
  const { password, ...sanitized } = user;
  return sanitized;
}

// POST /api/users/register - Create new account
usersRouter.post(
  "/register",
  validateBody(registerSchema),
  async (req: Request, res: Response) => {
    try {
      const { email, password, name } = req.body;

      // Check if user exists
      const existing = await prisma.user.findUnique({
        where: { email },
      });

      if (existing) {
        const response: ApiResponse<null> = {
          success: false,
          data: null,
          error: { code: "EMAIL_EXISTS", message: "Email already registered" },
        };
        return res.status(400).json(response);
      }

      // Hash password (in production, use bcrypt)
      const hashedPassword = Buffer.from(password).toString("base64");

      // Create user
      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          role: "customer",
        },
      });

      const token = generateToken(user.id);

      const response: ApiResponse<{ user: Omit<User, "password">; token: string }> = {
        success: true,
        data: {
          user: sanitizeUser(user),
          token,
        },
      };

      res.status(201).json(response);
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({
        success: false,
        data: null,
        error: { code: "REGISTER_ERROR", message: "Failed to register" },
      });
    }
  }
);

// POST /api/users/login - Authenticate user
usersRouter.post(
  "/login",
  validateBody(loginSchema),
  async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      // Find user
      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        const response: ApiResponse<null> = {
          success: false,
          data: null,
          error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
        };
        return res.status(401).json(response);
      }

      // Verify password (in production, use bcrypt.compare)
      const hashedPassword = Buffer.from(password).toString("base64");
      if (user.password !== hashedPassword) {
        const response: ApiResponse<null> = {
          success: false,
          data: null,
          error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
        };
        return res.status(401).json(response);
      }

      const token = generateToken(user.id);

      const response: ApiResponse<{ user: Omit<User, "password">; token: string }> = {
        success: true,
        data: {
          user: sanitizeUser(user),
          token,
        },
      };

      res.json(response);
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({
        success: false,
        data: null,
        error: { code: "LOGIN_ERROR", message: "Failed to login" },
      });
    }
  }
);

// GET /api/users/me - Get current user profile
usersRouter.get("/me", authenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        orders: {
          take: 5,
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!user) {
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: { code: "NOT_FOUND", message: "User not found" },
      };
      return res.status(404).json(response);
    }

    const response: ApiResponse<Omit<User, "password">> = {
      success: true,
      data: sanitizeUser(user),
    };

    res.json(response);
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({
      success: false,
      data: null,
      error: { code: "FETCH_ERROR", message: "Failed to fetch profile" },
    });
  }
});

// PATCH /api/users/me - Update current user profile
usersRouter.patch(
  "/me",
  authenticate,
  validateBody(updateProfileSchema),
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;

      // Check if email is being changed and already exists
      if (req.body.email) {
        const existing = await prisma.user.findFirst({
          where: {
            email: req.body.email,
            NOT: { id: userId },
          },
        });

        if (existing) {
          const response: ApiResponse<null> = {
            success: false,
            data: null,
            error: { code: "EMAIL_EXISTS", message: "Email already in use" },
          };
          return res.status(400).json(response);
        }
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data: req.body,
      });

      const response: ApiResponse<Omit<User, "password">> = {
        success: true,
        data: sanitizeUser(user),
      };

      res.json(response);
    } catch (error) {
      console.error("Update profile error:", error);
      res.status(500).json({
        success: false,
        data: null,
        error: { code: "UPDATE_ERROR", message: "Failed to update profile" },
      });
    }
  }
);

// GET /api/users - List all users (admin only)
usersRouter.get("/", authenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    // Check if user is admin
    const requestingUser = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!requestingUser || requestingUser.role !== "admin") {
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: { code: "FORBIDDEN", message: "Admin access required" },
      };
      return res.status(403).json(response);
    }

    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatar: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const response: ApiResponse<Omit<User, "password">[]> = {
      success: true,
      data: users as any,
    };

    res.json(response);
  } catch (error) {
    console.error("List users error:", error);
    res.status(500).json({
      success: false,
      data: null,
      error: { code: "FETCH_ERROR", message: "Failed to fetch users" },
    });
  }
});
