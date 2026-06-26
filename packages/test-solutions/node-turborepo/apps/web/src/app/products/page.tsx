import { Suspense } from "react";
import { getProducts, type ProductFilters } from "@/lib/api";
import { ProductCard } from "@/components/ProductCard";
import { Card, Button, Input } from "@repo/ui";
import type { Product } from "@repo/types";

interface ProductsPageProps {
  searchParams: {
    category?: string;
    minPrice?: string;
    maxPrice?: string;
    sort?: string;
    page?: string;
    q?: string;
  };
}

async function ProductList({ filters }: { filters: ProductFilters }) {
  const products = await getProducts(filters);

  if (products.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 text-lg">No products found matching your criteria.</p>
        <Button variant="outline" className="mt-4">
          <a href="/products">Clear Filters</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}

function ProductListSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {Array.from({ length: 9 }).map((_, i) => (
        <Card key={i} className="animate-pulse">
          <div className="h-48 bg-gray-200 rounded-t-lg" />
          <div className="p-4 space-y-3">
            <div className="h-4 bg-gray-200 rounded w-3/4" />
            <div className="h-4 bg-gray-200 rounded w-1/2" />
            <div className="h-6 bg-gray-200 rounded w-1/4" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export default async function ProductsPage({ searchParams }: ProductsPageProps) {
  const filters: ProductFilters = {
    category: searchParams.category,
    minPrice: searchParams.minPrice ? parseFloat(searchParams.minPrice) : undefined,
    maxPrice: searchParams.maxPrice ? parseFloat(searchParams.maxPrice) : undefined,
    sort: searchParams.sort as ProductFilters["sort"],
    page: searchParams.page ? parseInt(searchParams.page, 10) : 1,
    search: searchParams.q,
    limit: 12,
  };

  const categories = ["Electronics", "Clothing", "Home & Garden", "Sports", "Books", "Toys"];

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex flex-col lg:flex-row gap-8">
        {/* Sidebar Filters */}
        <aside className="lg:w-64 flex-shrink-0">
          <Card className="p-6">
            <h2 className="font-bold text-lg mb-4">Filters</h2>
            
            {/* Search */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Search
              </label>
              <form>
                <Input
                  type="text"
                  name="q"
                  placeholder="Search products..."
                  defaultValue={searchParams.q}
                />
              </form>
            </div>

            {/* Categories */}
            <div className="mb-6">
              <h3 className="font-medium text-gray-900 mb-3">Categories</h3>
              <div className="space-y-2">
                {categories.map((category) => (
                  <a
                    key={category}
                    href={`/products?category=${encodeURIComponent(category)}`}
                    className={`block text-sm ${
                      searchParams.category === category
                        ? "text-blue-600 font-medium"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    {category}
                  </a>
                ))}
              </div>
            </div>

            {/* Price Range */}
            <div className="mb-6">
              <h3 className="font-medium text-gray-900 mb-3">Price Range</h3>
              <div className="flex gap-2 items-center">
                <Input
                  type="number"
                  placeholder="Min"
                  name="minPrice"
                  defaultValue={searchParams.minPrice}
                  className="w-20"
                />
                <span className="text-gray-400">-</span>
                <Input
                  type="number"
                  placeholder="Max"
                  name="maxPrice"
                  defaultValue={searchParams.maxPrice}
                  className="w-20"
                />
              </div>
            </div>

            <Button variant="primary" className="w-full">
              Apply Filters
            </Button>
          </Card>
        </aside>

        {/* Product Grid */}
        <main className="flex-1">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-bold text-gray-900">
              {searchParams.category || "All Products"}
            </h1>
            <select
              className="border rounded-lg px-3 py-2 text-sm"
              defaultValue={searchParams.sort}
            >
              <option value="">Sort by</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
              <option value="newest">Newest First</option>
              <option value="rating">Highest Rated</option>
            </select>
          </div>

          <Suspense fallback={<ProductListSkeleton />}>
            <ProductList filters={filters} />
          </Suspense>

          {/* Pagination */}
          <div className="mt-8 flex justify-center gap-2">
            {filters.page && filters.page > 1 && (
              <Button variant="outline">
                <a href={`/products?page=${filters.page - 1}`}>Previous</a>
              </Button>
            )}
            <Button variant="outline">
              <a href={`/products?page=${(filters.page || 1) + 1}`}>Next</a>
            </Button>
          </div>
        </main>
      </div>
    </div>
  );
}
