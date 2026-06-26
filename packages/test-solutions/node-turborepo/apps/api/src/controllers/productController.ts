import { prisma, type Prisma } from "@repo/database";
import type { Product } from "@repo/types";

interface ProductFilters {
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: "price_asc" | "price_desc" | "newest" | "rating";
  page?: number;
  limit?: number;
  q?: string;
  featured?: boolean;
}

interface ProductsResult {
  products: Product[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Get products with filtering, sorting, and pagination
 */
export async function getProducts(filters: ProductFilters): Promise<ProductsResult> {
  const {
    category,
    minPrice,
    maxPrice,
    sort,
    page = 1,
    limit = 20,
    q,
    featured,
  } = filters;

  // Build where clause
  const where: Prisma.ProductWhereInput = {};

  if (category) {
    where.category = category;
  }

  if (minPrice !== undefined || maxPrice !== undefined) {
    where.price = {};
    if (minPrice !== undefined) {
      where.price.gte = minPrice;
    }
    if (maxPrice !== undefined) {
      where.price.lte = maxPrice;
    }
  }

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
    ];
  }

  if (featured) {
    where.featured = true;
  }

  // Build orderBy
  let orderBy: Prisma.ProductOrderByWithRelationInput = { createdAt: "desc" };
  
  switch (sort) {
    case "price_asc":
      orderBy = { price: "asc" };
      break;
    case "price_desc":
      orderBy = { price: "desc" };
      break;
    case "newest":
      orderBy = { createdAt: "desc" };
      break;
    case "rating":
      orderBy = { rating: "desc" };
      break;
  }

  // Execute queries
  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.product.count({ where }),
  ]);

  return {
    products: products as Product[],
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get a single product by ID
 */
export async function getProductById(id: string): Promise<Product | null> {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      reviews: {
        take: 10,
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              avatar: true,
            },
          },
        },
      },
    },
  });

  return product as Product | null;
}

/**
 * Create a new product
 */
export async function createProduct(
  data: Omit<Product, "id" | "createdAt" | "updatedAt" | "rating" | "reviewCount">
): Promise<Product> {
  const product = await prisma.product.create({
    data: {
      ...data,
      rating: 0,
      reviewCount: 0,
    },
  });

  return product as Product;
}

/**
 * Update an existing product
 */
export async function updateProduct(
  id: string,
  data: Partial<Omit<Product, "id" | "createdAt" | "updatedAt">>
): Promise<Product | null> {
  try {
    const product = await prisma.product.update({
      where: { id },
      data,
    });

    return product as Product;
  } catch (error) {
    // Handle not found
    if ((error as any).code === "P2025") {
      return null;
    }
    throw error;
  }
}

/**
 * Delete a product
 */
export async function deleteProduct(id: string): Promise<boolean> {
  try {
    await prisma.product.delete({
      where: { id },
    });
    return true;
  } catch (error) {
    // Handle not found
    if ((error as any).code === "P2025") {
      return false;
    }
    throw error;
  }
}

/**
 * Update product rating based on reviews
 */
export async function updateProductRating(productId: string): Promise<void> {
  const result = await prisma.review.aggregate({
    where: { productId },
    _avg: { rating: true },
    _count: { rating: true },
  });

  await prisma.product.update({
    where: { id: productId },
    data: {
      rating: result._avg.rating || 0,
      reviewCount: result._count.rating,
    },
  });
}

/**
 * Check and update product stock
 */
export async function checkAndUpdateStock(
  productId: string,
  quantity: number
): Promise<{ success: boolean; availableStock: number }> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { stock: true },
  });

  if (!product) {
    return { success: false, availableStock: 0 };
  }

  if (product.stock < quantity) {
    return { success: false, availableStock: product.stock };
  }

  await prisma.product.update({
    where: { id: productId },
    data: { stock: { decrement: quantity } },
  });

  return { success: true, availableStock: product.stock - quantity };
}
