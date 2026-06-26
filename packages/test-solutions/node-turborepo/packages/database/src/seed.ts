import { prisma } from "./index";

const users = [
  {
    email: "admin@example.com",
    password: Buffer.from("admin123").toString("base64"),
    name: "Admin User",
    role: "admin",
  },
  {
    email: "john@example.com",
    password: Buffer.from("password123").toString("base64"),
    name: "John Doe",
    role: "customer",
  },
  {
    email: "jane@example.com",
    password: Buffer.from("password123").toString("base64"),
    name: "Jane Smith",
    role: "customer",
  },
];

const categories = [
  { name: "Electronics", slug: "electronics", description: "Electronic devices and gadgets" },
  { name: "Clothing", slug: "clothing", description: "Fashion and apparel" },
  { name: "Home & Garden", slug: "home-garden", description: "Home improvement and garden supplies" },
  { name: "Sports", slug: "sports", description: "Sports equipment and accessories" },
  { name: "Books", slug: "books", description: "Books and media" },
];

const products = [
  {
    name: "Wireless Bluetooth Headphones",
    description: "Premium wireless headphones with noise cancellation and 30-hour battery life. Perfect for music lovers and professionals.",
    price: 149.99,
    originalPrice: 199.99,
    category: "Electronics",
    imageUrl: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500",
    stock: 150,
    rating: 4.5,
    reviewCount: 234,
    featured: true,
    specifications: {
      "Battery Life": "30 hours",
      "Driver Size": "40mm",
      "Connectivity": "Bluetooth 5.0",
      "Weight": "250g",
    },
  },
  {
    name: "Smart Watch Pro",
    description: "Advanced smartwatch with health monitoring, GPS, and 7-day battery life. Track your fitness goals effortlessly.",
    price: 299.99,
    category: "Electronics",
    imageUrl: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=500",
    stock: 75,
    rating: 4.7,
    reviewCount: 189,
    featured: true,
    specifications: {
      "Display": "1.4\" AMOLED",
      "Battery": "7 days",
      "Water Resistance": "5ATM",
      "Sensors": "Heart rate, SpO2, GPS",
    },
  },
  {
    name: "Ergonomic Laptop Stand",
    description: "Adjustable aluminum laptop stand for better posture and cooling. Compatible with all laptops up to 17 inches.",
    price: 59.99,
    originalPrice: 79.99,
    category: "Electronics",
    imageUrl: "https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=500",
    stock: 200,
    rating: 4.3,
    reviewCount: 156,
    featured: false,
    specifications: {
      "Material": "Aluminum alloy",
      "Compatibility": "11-17\" laptops",
      "Adjustable Height": "6 levels",
      "Weight Capacity": "10kg",
    },
  },
  {
    name: "Cotton Crew Neck T-Shirt",
    description: "Premium 100% organic cotton t-shirt. Comfortable, breathable, and perfect for everyday wear.",
    price: 29.99,
    category: "Clothing",
    imageUrl: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=500",
    stock: 500,
    rating: 4.2,
    reviewCount: 312,
    featured: false,
    specifications: {
      "Material": "100% Organic Cotton",
      "Fit": "Regular",
      "Care": "Machine washable",
    },
  },
  {
    name: "Running Shoes Ultra",
    description: "Lightweight running shoes with responsive cushioning and breathable mesh upper. Ideal for daily training.",
    price: 129.99,
    originalPrice: 159.99,
    category: "Sports",
    imageUrl: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=500",
    stock: 120,
    rating: 4.6,
    reviewCount: 278,
    featured: true,
    specifications: {
      "Weight": "280g",
      "Drop": "8mm",
      "Cushioning": "Responsive foam",
      "Upper": "Breathable mesh",
    },
  },
  {
    name: "Mechanical Keyboard RGB",
    description: "Compact mechanical keyboard with RGB backlighting and hot-swappable switches. Perfect for gaming and typing.",
    price: 99.99,
    category: "Electronics",
    imageUrl: "https://images.unsplash.com/photo-1511467687858-23d96c32e4ae?w=500",
    stock: 85,
    rating: 4.8,
    reviewCount: 445,
    featured: true,
    specifications: {
      "Switches": "Hot-swappable",
      "Layout": "TKL (87 keys)",
      "Backlighting": "RGB per-key",
      "Connection": "USB-C, Wireless",
    },
  },
  {
    name: "Indoor Plant Set",
    description: "Set of 3 low-maintenance indoor plants in decorative ceramic pots. Perfect for home or office decoration.",
    price: 45.99,
    category: "Home & Garden",
    imageUrl: "https://images.unsplash.com/photo-1459411552884-841db9b3cc2a?w=500",
    stock: 60,
    rating: 4.4,
    reviewCount: 167,
    featured: false,
  },
  {
    name: "Programming with TypeScript",
    description: "Comprehensive guide to TypeScript development. Learn modern TypeScript patterns and best practices.",
    price: 39.99,
    originalPrice: 49.99,
    category: "Books",
    imageUrl: "https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=500",
    stock: 250,
    rating: 4.9,
    reviewCount: 89,
    featured: false,
  },
];

async function main() {
  console.log("🌱 Starting database seed...\n");

  // Clear existing data
  console.log("Clearing existing data...");
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.review.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.address.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();

  // Seed users
  console.log("Creating users...");
  for (const user of users) {
    await prisma.user.create({ data: user });
  }
  console.log(`✓ Created ${users.length} users`);

  // Seed categories
  console.log("Creating categories...");
  for (const category of categories) {
    await prisma.category.create({ data: category });
  }
  console.log(`✓ Created ${categories.length} categories`);

  // Seed products
  console.log("Creating products...");
  for (const product of products) {
    await prisma.product.create({ data: product });
  }
  console.log(`✓ Created ${products.length} products`);

  // Create sample orders
  console.log("Creating sample orders...");
  const customer = await prisma.user.findFirst({
    where: { email: "john@example.com" },
  });
  const sampleProducts = await prisma.product.findMany({ take: 3 });

  if (customer && sampleProducts.length > 0) {
    const order = await prisma.order.create({
      data: {
        userId: customer.id,
        status: "DELIVERED",
        subtotal: 249.97,
        tax: 24.99,
        shipping: 0,
        total: 274.96,
        shippingAddress: {
          name: "John Doe",
          street: "123 Main St",
          city: "New York",
          state: "NY",
          zip: "10001",
          country: "US",
        },
        items: {
          create: sampleProducts.map((product, i) => ({
            productId: product.id,
            quantity: i + 1,
            price: product.price,
          })),
        },
      },
    });
    console.log(`✓ Created sample order ${order.id}`);
  }

  // Create sample reviews
  console.log("Creating sample reviews...");
  const reviewUser = await prisma.user.findFirst({
    where: { email: "jane@example.com" },
  });
  const reviewProducts = await prisma.product.findMany({ take: 5 });

  if (reviewUser && reviewProducts.length > 0) {
    for (const product of reviewProducts) {
      await prisma.review.create({
        data: {
          productId: product.id,
          userId: reviewUser.id,
          rating: Math.floor(Math.random() * 2) + 4, // 4 or 5
          title: "Great product!",
          comment: "Really happy with this purchase. Would definitely recommend.",
          verified: true,
        },
      });
    }
    console.log(`✓ Created ${reviewProducts.length} reviews`);
  }

  console.log("\n✅ Database seeding completed!");
}

main()
  .catch((e) => {
    console.error("❌ Error seeding database:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
