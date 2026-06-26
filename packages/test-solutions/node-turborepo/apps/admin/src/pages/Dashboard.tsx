import { useQuery } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { Card } from "@repo/ui";
import { formatCurrency, formatNumber } from "@repo/utils";

// Mock data for dashboard
const revenueData = [
  { month: "Jan", revenue: 45000, orders: 120 },
  { month: "Feb", revenue: 52000, orders: 145 },
  { month: "Mar", revenue: 48000, orders: 130 },
  { month: "Apr", revenue: 61000, orders: 165 },
  { month: "May", revenue: 55000, orders: 150 },
  { month: "Jun", revenue: 67000, orders: 180 },
  { month: "Jul", revenue: 72000, orders: 195 },
];

const categoryData = [
  { name: "Electronics", value: 35 },
  { name: "Clothing", value: 25 },
  { name: "Home & Garden", value: 20 },
  { name: "Sports", value: 12 },
  { name: "Other", value: 8 },
];

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

interface StatCardProps {
  title: string;
  value: string | number;
  change: number;
  icon: string;
}

function StatCard({ title, value, change, icon }: StatCardProps) {
  const isPositive = change >= 0;

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="mt-1 text-3xl font-bold text-gray-900">{value}</p>
          <p className={`mt-2 text-sm ${isPositive ? "text-green-600" : "text-red-600"}`}>
            {isPositive ? "↑" : "↓"} {Math.abs(change)}% from last month
          </p>
        </div>
        <div className="rounded-full bg-blue-100 p-3 text-2xl">{icon}</div>
      </div>
    </Card>
  );
}

function RecentOrders() {
  const orders = [
    { id: "ORD-001", customer: "John Doe", amount: 125.99, status: "completed", date: "2024-01-15" },
    { id: "ORD-002", customer: "Jane Smith", amount: 89.50, status: "processing", date: "2024-01-15" },
    { id: "ORD-003", customer: "Bob Wilson", amount: 250.00, status: "pending", date: "2024-01-14" },
    { id: "ORD-004", customer: "Alice Brown", amount: 175.25, status: "completed", date: "2024-01-14" },
    { id: "ORD-005", customer: "Charlie Davis", amount: 45.00, status: "shipped", date: "2024-01-13" },
  ];

  const statusColors: Record<string, string> = {
    completed: "bg-green-100 text-green-800",
    processing: "bg-blue-100 text-blue-800",
    pending: "bg-yellow-100 text-yellow-800",
    shipped: "bg-purple-100 text-purple-800",
  };

  return (
    <Card className="p-6">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">Recent Orders</h3>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b text-left text-sm text-gray-500">
              <th className="pb-3">Order ID</th>
              <th className="pb-3">Customer</th>
              <th className="pb-3">Amount</th>
              <th className="pb-3">Status</th>
              <th className="pb-3">Date</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id} className="border-b last:border-0">
                <td className="py-3 font-medium text-gray-900">{order.id}</td>
                <td className="py-3 text-gray-600">{order.customer}</td>
                <td className="py-3 text-gray-900">{formatCurrency(order.amount)}</td>
                <td className="py-3">
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-medium capitalize ${
                      statusColors[order.status]
                    }`}
                  >
                    {order.status}
                  </span>
                </td>
                <td className="py-3 text-gray-500">{order.date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TopProducts() {
  const products = [
    { name: "Wireless Headphones", sales: 245, revenue: 12250 },
    { name: "Smart Watch", sales: 189, revenue: 37800 },
    { name: "Laptop Stand", sales: 156, revenue: 4680 },
    { name: "USB-C Hub", sales: 134, revenue: 5360 },
    { name: "Mechanical Keyboard", sales: 98, revenue: 9800 },
  ];

  return (
    <Card className="p-6">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">Top Products</h3>
      <div className="space-y-4">
        {products.map((product, index) => (
          <div key={product.name} className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-sm font-medium text-gray-600">
                {index + 1}
              </span>
              <div>
                <p className="font-medium text-gray-900">{product.name}</p>
                <p className="text-sm text-gray-500">{product.sales} sales</p>
              </div>
            </div>
            <p className="font-semibold text-gray-900">{formatCurrency(product.revenue)}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function Dashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-gray-500">Welcome back! Here's what's happening with your store.</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Revenue" value={formatCurrency(72000)} change={12.5} icon="💰" />
        <StatCard title="Orders" value={formatNumber(195)} change={8.2} icon="📦" />
        <StatCard title="Customers" value={formatNumber(1250)} change={5.7} icon="👥" />
        <StatCard title="Conversion Rate" value="3.2%" change={-2.1} icon="📈" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Revenue Chart */}
        <Card className="p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Revenue Overview</h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="month" stroke="#6b7280" fontSize={12} />
                <YAxis stroke="#6b7280" fontSize={12} tickFormatter={(value) => `$${value / 1000}k`} />
                <Tooltip
                  formatter={(value: number) => formatCurrency(value)}
                  contentStyle={{ borderRadius: "8px", border: "1px solid #e5e7eb" }}
                />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={{ fill: "#3b82f6", strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Orders Chart */}
        <Card className="p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Orders by Month</h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="month" stroke="#6b7280" fontSize={12} />
                <YAxis stroke="#6b7280" fontSize={12} />
                <Tooltip
                  contentStyle={{ borderRadius: "8px", border: "1px solid #e5e7eb" }}
                />
                <Bar dataKey="orders" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Category Distribution */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Sales by Category</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={categoryData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {categoryData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => `${value}%`} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {categoryData.map((item, index) => (
              <div key={item.name} className="flex items-center gap-2">
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: COLORS[index] }}
                />
                <span className="text-sm text-gray-600">{item.name}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Recent Orders */}
        <div className="lg:col-span-2">
          <RecentOrders />
        </div>
      </div>

      {/* Top Products */}
      <TopProducts />
    </div>
  );
}
