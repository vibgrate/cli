import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Turborepo E-Commerce",
  description: "A modern e-commerce platform built with Turborepo",
  keywords: ["e-commerce", "next.js", "turborepo", "typescript"],
  authors: [{ name: "Team" }],
  openGraph: {
    title: "Turborepo E-Commerce",
    description: "A modern e-commerce platform built with Turborepo",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <header className="border-b bg-white shadow-sm">
          <nav className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
            <a href="/" className="text-xl font-bold text-gray-900">
              TurboShop
            </a>
            <div className="flex items-center gap-6">
              <a href="/products" className="text-gray-600 hover:text-gray-900">
                Products
              </a>
              <a href="/cart" className="text-gray-600 hover:text-gray-900">
                Cart
              </a>
              <a href="/account" className="text-gray-600 hover:text-gray-900">
                Account
              </a>
            </div>
          </nav>
        </header>
        <main className="min-h-screen bg-gray-50">{children}</main>
        <footer className="border-t bg-white py-8">
          <div className="mx-auto max-w-7xl px-4 text-center text-gray-600">
            <p>© 2024 TurboShop. Built with Turborepo.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
