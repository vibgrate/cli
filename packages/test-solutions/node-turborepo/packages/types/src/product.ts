/**
 * Product entity
 */
export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  originalPrice?: number;
  category: string;
  imageUrl: string;
  images?: string[];
  stock: number;
  rating: number;
  reviewCount: number;
  featured?: boolean;
  discount?: number;
  specifications?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Product creation input
 */
export interface CreateProductInput {
  name: string;
  description: string;
  price: number;
  originalPrice?: number;
  category: string;
  imageUrl: string;
  images?: string[];
  stock: number;
  specifications?: Record<string, string>;
}

/**
 * Product update input
 */
export interface UpdateProductInput extends Partial<CreateProductInput> {
  featured?: boolean;
}

/**
 * Product filter options
 */
export interface ProductFilters {
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  featured?: boolean;
  search?: string;
  sort?: ProductSortOption;
}

/**
 * Product sort options
 */
export type ProductSortOption =
  | "price_asc"
  | "price_desc"
  | "name_asc"
  | "name_desc"
  | "newest"
  | "oldest"
  | "rating"
  | "popularity";

/**
 * Product review
 */
export interface ProductReview {
  id: string;
  productId: string;
  userId: string;
  rating: number;
  title?: string;
  comment?: string;
  verified: boolean;
  helpful: number;
  createdAt: string;
  updatedAt: string;
  user?: {
    id: string;
    name: string;
    avatar?: string;
  };
}

/**
 * Create review input
 */
export interface CreateReviewInput {
  productId: string;
  rating: number;
  title?: string;
  comment?: string;
}

/**
 * Product category
 */
export interface Category {
  id: string;
  name: string;
  slug: string;
  description?: string;
  imageUrl?: string;
  parentId?: string;
  sortOrder: number;
  isActive: boolean;
  children?: Category[];
  productCount?: number;
}
