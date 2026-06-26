import { PrismaClient } from "@prisma/client";

// Global Prisma client to prevent hot-reload issues in development
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Re-export Prisma types and client
export * from "@prisma/client";
export { Prisma } from "@prisma/client";

// Type-safe DB operations helper
export type TransactionClient = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0];

// Helper to run transactions
export async function withTransaction<T>(
  fn: (tx: TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(fn);
}

// Clean up on process exit
process.on("beforeExit", async () => {
  await prisma.$disconnect();
});
