import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@repo/database";
import type { Product, ApiResponse, PaginatedResponse } from "@repo/types";
import { validateBody, validateQuery } from "../middleware/validation";
import { authenticate, optionalAuth } from "../middleware/auth";
import {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
} from "../controllers/productController";

export const productsRouter = Router();

// Query validation schema
const productQuerySchema = z.object({
  category: z.string().optional(),
  minPrice: z.coerce.number().positive().optional(),
  maxPrice: z.coerce.number().positive().optional(),
  sort: z.enum(["price_asc", "price_desc", "newest", "rating"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  q: z.string().optional(),
  featured: z.coerce.boolean().optional(),
});

// Create product validation schema
const createProductSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  price: z.number().positive(),
  originalPrice: z.number().positive().optional(),
  category: z.string().min(1),
  imageUrl: z.string().url(),
  images: z.array(z.string().url()).optional(),
  stock: z.number().int().nonnegative(),
  specifications: z.record(z.string()).optional(),
});

// Update product validation schema
const updateProductSchema = createProductSchema.partial();

// GET /api/products - List all products with filters
productsRouter.get(
  "/",
  validateQuery(productQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const result = await getProducts(req.query);
      
      const response: PaginatedResponse<Product> = {
        success: true,
        data: result.products,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages,
        },
      };
      
      res.json(response);
    } catch (error) {
      console.error("Error fetching products:", error);
      res.status(500).json({
        success: false,
        data: null,
        error: { code: "FETCH_ERROR", message: "Failed to fetch products" },
      });
    }
  }
);

// GET /api/products/:id - Get single product
productsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const product = await getProductById(req.params.id!);
    
    if (!product) {
      const response: ApiResponse<null> = {
        success: false,
        data: null,
        error: { code: "NOT_FOUND", message: "Product not found" },
      };
      return res.status(404).json(response);
    }
    
    const response: ApiResponse<Product> = {
      success: true,
      data: product,
    };
    
    res.json(response);
  } catch (error) {
    console.error("Error fetching product:", error);
    res.status(500).json({
      success: false,
      data: null,
      error: { code: "FETCH_ERROR", message: "Failed to fetch product" },
    });
  }
});

// POST /api/products - Create new product (admin only)
productsRouter.post(
  "/",
  authenticate,
  validateBody(createProductSchema),
  async (req: Request, res: Response) => {
    try {
      const product = await createProduct(req.body);
      
      const response: ApiResponse<Product> = {
        success: true,
        data: product,
      };
      
      res.status(201).json(response);
    } catch (error) {
      console.error("Error creating product:", error);
      res.status(500).json({
        success: false,
        data: null,
        error: { code: "CREATE_ERROR", message: "Failed to create product" },
      });
    }
  }
);

// PATCH /api/products/:id - Update product (admin only)
productsRouter.patch(
  "/:id",
  authenticate,
  validateBody(updateProductSchema),
  async (req: Request, res: Response) => {
    try {
      const product = await updateProduct(req.params.id!, req.body);
      
      if (!product) {
        const response: ApiResponse<null> = {
          success: false,
          data: null,
          error: { code: "NOT_FOUND", message: "Product not found" },
        };
        return res.status(404).json(response);
      }
      
      const response: ApiResponse<Product> = {
        success: true,
        data: product,
      };
      
      res.json(response);
    } catch (error) {
      console.error("Error updating product:", error);
      res.status(500).json({
        success: false,
        data: null,
        error: { code: "UPDATE_ERROR", message: "Failed to update product" },
      });
    }
  }
);

// DELETE /api/products/:id - Delete product (admin only)
productsRouter.delete(
  "/:id",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const deleted = await deleteProduct(req.params.id!);
      
      if (!deleted) {
        const response: ApiResponse<null> = {
          success: false,
          data: null,
          error: { code: "NOT_FOUND", message: "Product not found" },
        };
        return res.status(404).json(response);
      }
      
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting product:", error);
      res.status(500).json({
        success: false,
        data: null,
        error: { code: "DELETE_ERROR", message: "Failed to delete product" },
      });
    }
  }
);
