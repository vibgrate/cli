"""Product API endpoint tests."""

from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.product import Product
from app.models.user import User

pytestmark = pytest.mark.asyncio


async def test_get_products_empty(client: AsyncClient) -> None:
    """Test getting products when none exist."""
    response = await client.get("/api/v1/products")
    assert response.status_code == 200
    data = response.json()
    assert data["items"] == []
    assert data["total"] == 0


async def test_get_products(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Test getting list of products."""
    # Create test products
    products = [
        Product(
            name=f"Product {i}",
            description=f"Description {i}",
            price=10.00 + i,
            sku=f"SKU-{i:03d}",
            stock_quantity=100,
        )
        for i in range(5)
    ]
    for product in products:
        db_session.add(product)
    await db_session.commit()

    response = await client.get("/api/v1/products")
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 5
    assert len(data["items"]) == 5


async def test_get_products_with_pagination(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Test product pagination."""
    # Create 25 products
    products = [
        Product(
            name=f"Product {i}",
            price=10.00,
            sku=f"SKU-{i:03d}",
            stock_quantity=100,
        )
        for i in range(25)
    ]
    for product in products:
        db_session.add(product)
    await db_session.commit()

    # Get first page
    response = await client.get("/api/v1/products?page=1&page_size=10")
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 25
    assert len(data["items"]) == 10
    assert data["page"] == 1
    assert data["pages"] == 3

    # Get second page
    response = await client.get("/api/v1/products?page=2&page_size=10")
    assert response.status_code == 200
    data = response.json()
    assert len(data["items"]) == 10
    assert data["page"] == 2


async def test_get_products_with_search(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Test product search by name."""
    products = [
        Product(name="Apple iPhone", price=999.00, sku="IPHONE-001", stock_quantity=10),
        Product(name="Samsung Galaxy", price=899.00, sku="SAMSUNG-001", stock_quantity=10),
        Product(name="Apple MacBook", price=1299.00, sku="MACBOOK-001", stock_quantity=5),
    ]
    for product in products:
        db_session.add(product)
    await db_session.commit()

    response = await client.get("/api/v1/products?search=Apple")
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 2
    assert all("Apple" in item["name"] for item in data["items"])


async def test_get_product_by_id(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Test getting a single product by ID."""
    product = Product(
        name="Test Product",
        description="Test description",
        price=29.99,
        sku="TEST-001",
        stock_quantity=50,
    )
    db_session.add(product)
    await db_session.commit()
    await db_session.refresh(product)

    response = await client.get(f"/api/v1/products/{product.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Test Product"
    assert data["sku"] == "TEST-001"
    assert float(data["price"]) == 29.99


async def test_get_product_not_found(client: AsyncClient) -> None:
    """Test getting a non-existent product."""
    response = await client.get("/api/v1/products/9999")
    assert response.status_code == 404
    assert response.json()["detail"] == "Product not found"


async def test_create_product(
    client: AsyncClient,
    test_user: User,
    user_token_headers: dict[str, str],
    product_data: dict[str, Any],
) -> None:
    """Test creating a new product."""
    response = await client.post(
        "/api/v1/products",
        json=product_data,
        headers=user_token_headers,
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == product_data["name"]
    assert data["sku"] == product_data["sku"]
    assert "id" in data


async def test_create_product_unauthorized(
    client: AsyncClient,
    product_data: dict[str, Any],
) -> None:
    """Test creating product without authentication."""
    response = await client.post("/api/v1/products", json=product_data)
    assert response.status_code == 401


async def test_create_product_duplicate_sku(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    user_token_headers: dict[str, str],
    product_data: dict[str, Any],
) -> None:
    """Test creating product with duplicate SKU."""
    # Create existing product
    existing = Product(
        name="Existing",
        price=10.00,
        sku=product_data["sku"],
        stock_quantity=10,
    )
    db_session.add(existing)
    await db_session.commit()

    response = await client.post(
        "/api/v1/products",
        json=product_data,
        headers=user_token_headers,
    )
    assert response.status_code == 400
    assert "SKU already exists" in response.json()["detail"]


async def test_update_product(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    user_token_headers: dict[str, str],
) -> None:
    """Test updating a product."""
    product = Product(
        name="Original Name",
        price=29.99,
        sku="UPDATE-001",
        stock_quantity=50,
    )
    db_session.add(product)
    await db_session.commit()
    await db_session.refresh(product)

    response = await client.patch(
        f"/api/v1/products/{product.id}",
        json={"name": "Updated Name", "price": "39.99"},
        headers=user_token_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Updated Name"
    assert float(data["price"]) == 39.99


async def test_delete_product(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    user_token_headers: dict[str, str],
) -> None:
    """Test deleting a product."""
    product = Product(
        name="To Delete",
        price=10.00,
        sku="DELETE-001",
        stock_quantity=10,
    )
    db_session.add(product)
    await db_session.commit()
    await db_session.refresh(product)

    response = await client.delete(
        f"/api/v1/products/{product.id}",
        headers=user_token_headers,
    )
    assert response.status_code == 204

    # Verify deleted
    response = await client.get(f"/api/v1/products/{product.id}")
    assert response.status_code == 404
