/**
 * Standard API response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: ApiError;
  meta?: ApiMeta;
}

/**
 * API error object
 */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  field?: string;
}

/**
 * API metadata
 */
export interface ApiMeta {
  requestId?: string;
  timestamp?: string;
  version?: string;
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: Pagination;
}

/**
 * Pagination info
 */
export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext?: boolean;
  hasPrev?: boolean;
}

/**
 * Pagination query params
 */
export interface PaginationParams {
  page?: number;
  limit?: number;
  cursor?: string;
}

/**
 * Sort options
 */
export interface SortParams {
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

/**
 * Search params
 */
export interface SearchParams {
  q?: string;
  fields?: string[];
}

/**
 * Common query params
 */
export interface QueryParams extends PaginationParams, SortParams, SearchParams {
  filters?: Record<string, unknown>;
  includes?: string[];
}

/**
 * Batch operation result
 */
export interface BatchResult<T> {
  succeeded: T[];
  failed: Array<{
    item: T;
    error: ApiError;
  }>;
  total: number;
  successCount: number;
  failCount: number;
}

/**
 * Health check response
 */
export interface HealthCheckResponse {
  status: "ok" | "degraded" | "down";
  timestamp: string;
  version: string;
  services: Record<string, ServiceHealth>;
}

/**
 * Service health status
 */
export interface ServiceHealth {
  status: "ok" | "degraded" | "down";
  latency?: number;
  message?: string;
}

/**
 * Rate limit info
 */
export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

/**
 * Webhook event
 */
export interface WebhookEvent<T = unknown> {
  id: string;
  type: string;
  data: T;
  timestamp: string;
  signature?: string;
}

/**
 * Upload response
 */
export interface UploadResponse {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

/**
 * Export/download response
 */
export interface ExportResponse {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  url?: string;
  expiresAt?: string;
  error?: string;
}
