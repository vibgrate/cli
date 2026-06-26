import { type Request, type Response, type NextFunction } from "express";
import { z, type ZodSchema, type ZodError } from "zod";
import type { ApiResponse } from "@repo/types";

/**
 * Format Zod validation errors into a readable format
 */
function formatZodErrors(error: ZodError): string {
  return error.errors
    .map((err) => {
      const path = err.path.join(".");
      return path ? `${path}: ${err.message}` : err.message;
    })
    .join(", ");
}

/**
 * Middleware factory for validating request body against a Zod schema
 */
export function validateBody<T extends ZodSchema>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = schema.safeParse(req.body);

      if (!result.success) {
        const response: ApiResponse<null> = {
          success: false,
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: formatZodErrors(result.error),
            details: result.error.errors,
          },
        };
        res.status(400).json(response);
        return;
      }

      // Replace body with parsed/transformed data
      req.body = result.data;
      next();
    } catch (error) {
      console.error("Body validation error:", error);
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request body",
        },
      };
      res.status(400).json(response);
    }
  };
}

/**
 * Middleware factory for validating query parameters against a Zod schema
 */
export function validateQuery<T extends ZodSchema>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = schema.safeParse(req.query);

      if (!result.success) {
        const response: ApiResponse<null> = {
          success: false,
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: formatZodErrors(result.error),
            details: result.error.errors,
          },
        };
        res.status(400).json(response);
        return;
      }

      // Replace query with parsed/transformed data
      req.query = result.data;
      next();
    } catch (error) {
      console.error("Query validation error:", error);
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid query parameters",
        },
      };
      res.status(400).json(response);
    }
  };
}

/**
 * Middleware factory for validating URL parameters against a Zod schema
 */
export function validateParams<T extends ZodSchema>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = schema.safeParse(req.params);

      if (!result.success) {
        const response: ApiResponse<null> = {
          success: false,
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: formatZodErrors(result.error),
            details: result.error.errors,
          },
        };
        res.status(400).json(response);
        return;
      }

      // Replace params with parsed/transformed data
      req.params = result.data;
      next();
    } catch (error) {
      console.error("Params validation error:", error);
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid URL parameters",
        },
      };
      res.status(400).json(response);
    }
  };
}

/**
 * Common validation schemas that can be reused across routes
 */
export const commonSchemas = {
  // UUID validation
  uuid: z.string().uuid(),

  // Pagination query params
  pagination: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),

  // Sort query params
  sortable: z.object({
    sortBy: z.string().optional(),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
  }),

  // ID param
  idParam: z.object({
    id: z.string().uuid(),
  }),

  // Search query
  searchable: z.object({
    q: z.string().min(1).max(200).optional(),
  }),
};
