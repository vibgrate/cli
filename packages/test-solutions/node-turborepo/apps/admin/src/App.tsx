import { Routes, Route, Link, useLocation, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@repo/ui";
import Dashboard from "./pages/Dashboard";
import Products from "./pages/Products";

function Sidebar() {
  const location = useLocation();

  const navItems = [
    { path: "/", label: "Dashboard", icon: "📊" },
    { path: "/products", label: "Products", icon: "📦" },
    { path: "/orders", label: "Orders", icon: "🛒" },
    { path: "/users", label: "Users", icon: "👥" },
    { path: "/analytics", label: "Analytics", icon: "📈" },
    { path: "/settings", label: "Settings", icon: "⚙️" },
  ];

  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-gray-900 text-white">
      <div className="flex h-16 items-center justify-center border-b border-gray-800">
        <h1 className="text-xl font-bold">TurboShop Admin</h1>
      </div>
      <nav className="mt-4 space-y-1 px-3">
        {navItems.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            className={`flex items-center gap-3 rounded-lg px-4 py-3 transition-colors ${
              location.pathname === item.path
                ? "bg-blue-600 text-white"
                : "text-gray-300 hover:bg-gray-800 hover:text-white"
            }`}
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}

function Header() {
  // Mock user data - in production, fetch from API
  const user = {
    name: "Admin User",
    email: "admin@example.com",
    avatar: null,
  };

  return (
    <header className="fixed left-64 right-0 top-0 z-10 flex h-16 items-center justify-between border-b bg-white px-6">
      <div className="flex items-center gap-4">
        <input
          type="search"
          placeholder="Search..."
          className="w-64 rounded-lg border px-4 py-2 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div className="flex items-center gap-4">
        <button className="relative rounded-full p-2 text-gray-600 hover:bg-gray-100">
          <span className="text-xl">🔔</span>
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500"></span>
        </button>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-semibold">
            {user.name.charAt(0)}
          </div>
          <div className="text-sm">
            <p className="font-medium text-gray-900">{user.name}</p>
            <p className="text-gray-500">{user.email}</p>
          </div>
        </div>
      </div>
    </header>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar />
      <Header />
      <main className="ml-64 mt-16 p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/products" element={<Products />} />
          <Route path="/orders" element={<div className="text-xl">Orders Page (Coming Soon)</div>} />
          <Route path="/users" element={<div className="text-xl">Users Page (Coming Soon)</div>} />
          <Route path="/analytics" element={<div className="text-xl">Analytics Page (Coming Soon)</div>} />
          <Route path="/settings" element={<div className="text-xl">Settings Page (Coming Soon)</div>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
