import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";

import { productsRouter } from "./routes/products";
import { usersRouter } from "./routes/users";
import type { ApiResponse } from "@repo/types";

// Load environment variables
dotenv.config();

const app: Express = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  credentials: true,
}));
app.use(morgan("combined"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API Routes
app.use("/api/products", productsRouter);
app.use("/api/users", usersRouter);

// 404 handler
app.use((_req: Request, res: Response) => {
  const response: ApiResponse<null> = {
    success: false,
    data: null,
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
    },
  };
  res.status(404).json(response);
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  
  const response: ApiResponse<null> = {
    success: false,
    data: null,
    error: {
      code: "INTERNAL_ERROR",
      message: process.env.NODE_ENV === "production" 
        ? "Internal server error" 
        : err.message,
    },
  };
  
  res.status(500).json(response);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 API server running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});

export default app;
