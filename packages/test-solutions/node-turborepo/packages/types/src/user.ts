/**
 * User entity
 */
export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  avatar?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * User role
 */
export type UserRole = "admin" | "customer" | "vendor";

/**
 * User registration input
 */
export interface RegisterInput {
  email: string;
  password: string;
  name: string;
}

/**
 * User login input
 */
export interface LoginInput {
  email: string;
  password: string;
}

/**
 * Update user profile input
 */
export interface UpdateProfileInput {
  name?: string;
  email?: string;
  avatar?: string;
}

/**
 * User address
 */
export interface Address {
  id: string;
  userId: string;
  name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create address input
 */
export interface CreateAddressInput {
  name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  isDefault?: boolean;
}

/**
 * Auth tokens
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Auth response
 */
export interface AuthResponse {
  user: User;
  tokens: AuthTokens;
}

/**
 * Session info
 */
export interface Session {
  user: User;
  accessToken: string;
  expiresAt: string;
}
