import { Button, Card } from "@repo/ui";
import { formatCurrency } from "@repo/utils";
import type { Product } from "@repo/types";
import { getProducts } from "@/lib/api";
import { ProductCard } from "@/components/ProductCard";

export default async function HomePage() {
  const featuredProducts = await getProducts({ featured: true, limit: 4 });

  return (
    <div className="mx-auto max-w-7xl px-4 py-12">
      {/* Hero Section */}
      <section className="mb-16 text-center">
        <h1 className="mb-4 text-5xl font-bold text-gray-900">
          Welcome to TurboShop
        </h1>
        <p className="mb-8 text-xl text-gray-600">
          Discover amazing products at unbeatable prices
        </p>
        <div className="flex justify-center gap-4">
          <Button variant="primary" size="lg">
            <a href="/products">Shop Now</a>
          </Button>
          <Button variant="outline" size="lg">
            <a href="/categories">Browse Categories</a>
          </Button>
        </div>
      </section>

      {/* Featured Products */}
      <section className="mb-16">
        <div className="mb-8 flex items-center justify-between">
          <h2 className="text-3xl font-bold text-gray-900">Featured Products</h2>
          <a href="/products" className="text-blue-600 hover:underline">
            View All →
          </a>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {featuredProducts.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      </section>

      {/* Categories */}
      <section className="mb-16">
        <h2 className="mb-8 text-3xl font-bold text-gray-900">Shop by Category</h2>
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          {["Electronics", "Clothing", "Home & Garden", "Sports"].map((category) => (
            <Card key={category} className="group cursor-pointer p-6 text-center transition-shadow hover:shadow-lg">
              <h3 className="text-lg font-semibold text-gray-900 group-hover:text-blue-600">
                {category}
              </h3>
            </Card>
          ))}
        </div>
      </section>

      {/* Newsletter */}
      <section className="rounded-lg bg-blue-600 p-8 text-center text-white">
        <h2 className="mb-4 text-2xl font-bold">Stay Updated</h2>
        <p className="mb-6">Subscribe to get special offers and updates.</p>
        <form className="mx-auto flex max-w-md gap-2">
          <input
            type="email"
            placeholder="Enter your email"
            className="flex-1 rounded-lg px-4 py-2 text-gray-900"
          />
          <Button variant="secondary">Subscribe</Button>
        </form>
      </section>
    </div>
  );
}
