import type { Product, User, ApiResponse, PaginatedResponse } from "@repo/types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

export interface ProductFilters {
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: "price_asc" | "price_desc" | "newest" | "rating";
  page?: number;
  limit?: number;
  search?: string;
  featured?: boolean;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    next: {
      revalidate: 60, // Cache for 60 seconds
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Request failed" }));
    throw new ApiError(response.status, error.message);
  }

  return response.json();
}

// Products API
export async function getProducts(filters: ProductFilters = {}): Promise<Product[]> {
  const params = new URLSearchParams();
  
  if (filters.category) params.set("category", filters.category);
  if (filters.minPrice) params.set("minPrice", filters.minPrice.toString());
  if (filters.maxPrice) params.set("maxPrice", filters.maxPrice.toString());
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.page) params.set("page", filters.page.toString());
  if (filters.limit) params.set("limit", filters.limit.toString());
  if (filters.search) params.set("q", filters.search);
  if (filters.featured) params.set("featured", "true");

  const queryString = params.toString();
  const endpoint = `/products${queryString ? `?${queryString}` : ""}`;
  
  try {
    const response = await fetchApi<ApiResponse<Product[]>>(endpoint);
    return response.data;
  } catch (error) {
    console.error("Failed to fetch products:", error);
    return [];
  }
}

export async function getProduct(id: string): Promise<Product | null> {
  try {
    const response = await fetchApi<ApiResponse<Product>>(`/products/${id}`);
    return response.data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function createProduct(
  product: Omit<Product, "id" | "createdAt" | "updatedAt">
): Promise<Product> {
  const response = await fetchApi<ApiResponse<Product>>("/products", {
    method: "POST",
    body: JSON.stringify(product),
  });
  return response.data;
}

export async function updateProduct(
  id: string,
  product: Partial<Product>
): Promise<Product> {
  const response = await fetchApi<ApiResponse<Product>>(`/products/${id}`, {
    method: "PATCH",
    body: JSON.stringify(product),
  });
  return response.data;
}

export async function deleteProduct(id: string): Promise<void> {
  await fetchApi(`/products/${id}`, {
    method: "DELETE",
  });
}

// Users API
export async function getCurrentUser(): Promise<User | null> {
  try {
    const response = await fetchApi<ApiResponse<User>>("/users/me");
    return response.data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function loginUser(
  email: string,
  password: string
): Promise<{ user: User; token: string }> {
  const response = await fetchApi<ApiResponse<{ user: User; token: string }>>(
    "/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }
  );
  return response.data;
}

export async function registerUser(data: {
  email: string;
  password: string;
  name: string;
}): Promise<{ user: User; token: string }> {
  const response = await fetchApi<ApiResponse<{ user: User; token: string }>>(
    "/auth/register",
    {
      method: "POST",
      body: JSON.stringify(data),
    }
  );
  return response.data;
}

// Cart API
export interface CartItem {
  productId: string;
  quantity: number;
}

export async function getCart(): Promise<CartItem[]> {
  try {
    const response = await fetchApi<ApiResponse<CartItem[]>>("/cart");
    return response.data;
  } catch {
    return [];
  }
}

export async function addToCart(productId: string, quantity: number = 1): Promise<void> {
  await fetchApi("/cart", {
    method: "POST",
    body: JSON.stringify({ productId, quantity }),
  });
}

export async function updateCartItem(productId: string, quantity: number): Promise<void> {
  await fetchApi(`/cart/${productId}`, {
    method: "PATCH",
    body: JSON.stringify({ quantity }),
  });
}

export async function removeFromCart(productId: string): Promise<void> {
  await fetchApi(`/cart/${productId}`, {
    method: "DELETE",
  });
}

// Orders API
export interface Order {
  id: string;
  items: Array<{
    product: Product;
    quantity: number;
    price: number;
  }>;
  total: number;
  status: "pending" | "processing" | "shipped" | "delivered" | "cancelled";
  createdAt: string;
}

export async function getOrders(): Promise<Order[]> {
  const response = await fetchApi<ApiResponse<Order[]>>("/orders");
  return response.data;
}

export async function createOrder(
  items: CartItem[],
  shippingAddress: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  }
): Promise<Order> {
  const response = await fetchApi<ApiResponse<Order>>("/orders", {
    method: "POST",
    body: JSON.stringify({ items, shippingAddress }),
  });
  return response.data;
}
