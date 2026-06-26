"""Unit tests for ProductService."""

from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.product import Product
from app.schemas.product import ProductCreate, ProductUpdate
from app.services.product_service import ProductService

pytestmark = pytest.mark.asyncio


async def test_create_product(db_session: AsyncSession) -> None:
    """Test creating a product through service."""
    service = ProductService(db_session)

    product_in = ProductCreate(
        name="Test Product",
        description="A test product",
        price=Decimal("29.99"),
        sku="TEST-SVC-001",
        stock_quantity=100,
    )

    product = await service.create(product_in)
    await db_session.commit()

    assert product.id is not None
    assert product.name == "Test Product"
    assert product.price == Decimal("29.99")
    assert product.sku == "TEST-SVC-001"


async def test_get_product_by_id(db_session: AsyncSession) -> None:
    """Test getting product by ID."""
    service = ProductService(db_session)

    # Create product directly
    product = Product(
        name="Get By ID",
        price=Decimal("19.99"),
        sku="GET-ID-001",
        stock_quantity=50,
    )
    db_session.add(product)
    await db_session.commit()
    await db_session.refresh(product)

    # Get by ID
    found = await service.get_by_id(product.id)
    assert found is not None
    assert found.id == product.id
    assert found.name == "Get By ID"


async def test_get_product_by_id_not_found(db_session: AsyncSession) -> None:
    """Test getting non-existent product by ID."""
    service = ProductService(db_session)
    found = await service.get_by_id(9999)
    assert found is None


async def test_get_product_by_sku(db_session: AsyncSession) -> None:
    """Test getting product by SKU."""
    service = ProductService(db_session)

    product = Product(
        name="Get By SKU",
        price=Decimal("39.99"),
        sku="GET-SKU-001",
        stock_quantity=25,
    )
    db_session.add(product)
    await db_session.commit()

    found = await service.get_by_sku("GET-SKU-001")
    assert found is not None
    assert found.sku == "GET-SKU-001"


async def test_get_products_pagination(db_session: AsyncSession) -> None:
    """Test getting products with pagination."""
    service = ProductService(db_session)

    # Create 15 products
    for i in range(15):
        product = Product(
            name=f"Product {i}",
            price=Decimal("10.00"),
            sku=f"PAG-{i:03d}",
            stock_quantity=10,
        )
        db_session.add(product)
    await db_session.commit()

    # Test first page
    products, total = await service.get_products(page=1, page_size=10)
    assert len(products) == 10
    assert total == 15

    # Test second page
    products, total = await service.get_products(page=2, page_size=10)
    assert len(products) == 5
    assert total == 15


async def test_get_products_filter_active(db_session: AsyncSession) -> None:
    """Test filtering products by active status."""
    service = ProductService(db_session)

    # Create active and inactive products
    for i in range(5):
        product = Product(
            name=f"Active {i}",
            price=Decimal("10.00"),
            sku=f"ACT-{i:03d}",
            stock_quantity=10,
            is_active=True,
        )
        db_session.add(product)

    for i in range(3):
        product = Product(
            name=f"Inactive {i}",
            price=Decimal("10.00"),
            sku=f"INA-{i:03d}",
            stock_quantity=10,
            is_active=False,
        )
        db_session.add(product)
    await db_session.commit()

    # Get only active
    products, total = await service.get_products(is_active=True)
    assert total == 5
    assert all(p.is_active for p in products)

    # Get only inactive
    products, total = await service.get_products(is_active=False)
    assert total == 3
    assert all(not p.is_active for p in products)


async def test_get_products_search(db_session: AsyncSession) -> None:
    """Test searching products by name."""
    service = ProductService(db_session)

    products_data = [
        ("Apple iPhone", "IPHONE-001"),
        ("Samsung Galaxy", "GALAXY-001"),
        ("Apple MacBook", "MACBOOK-001"),
        ("Google Pixel", "PIXEL-001"),
    ]

    for name, sku in products_data:
        product = Product(
            name=name,
            price=Decimal("100.00"),
            sku=sku,
            stock_quantity=10,
        )
        db_session.add(product)
    await db_session.commit()

    products, total = await service.get_products(search="Apple")
    assert total == 2
    assert all("Apple" in p.name for p in products)


async def test_update_product(db_session: AsyncSession) -> None:
    """Test updating a product."""
    service = ProductService(db_session)

    product = Product(
        name="Original",
        price=Decimal("29.99"),
        sku="UPD-001",
        stock_quantity=100,
    )
    db_session.add(product)
    await db_session.commit()
    await db_session.refresh(product)

    update_data = ProductUpdate(
        name="Updated",
        price=Decimal("39.99"),
    )

    updated = await service.update(product.id, update_data)
    await db_session.commit()

    assert updated is not None
    assert updated.name == "Updated"
    assert updated.price == Decimal("39.99")
    assert updated.sku == "UPD-001"  # Unchanged


async def test_update_product_not_found(db_session: AsyncSession) -> None:
    """Test updating non-existent product."""
    service = ProductService(db_session)

    update_data = ProductUpdate(name="Updated")
    updated = await service.update(9999, update_data)
    assert updated is None


async def test_delete_product(db_session: AsyncSession) -> None:
    """Test deleting a product."""
    service = ProductService(db_session)

    product = Product(
        name="To Delete",
        price=Decimal("10.00"),
        sku="DEL-001",
        stock_quantity=10,
    )
    db_session.add(product)
    await db_session.commit()
    await db_session.refresh(product)

    result = await service.delete(product.id)
    await db_session.commit()
    assert result is True

    # Verify deleted
    found = await service.get_by_id(product.id)
    assert found is None


async def test_delete_product_not_found(db_session: AsyncSession) -> None:
    """Test deleting non-existent product."""
    service = ProductService(db_session)
    result = await service.delete(9999)
    assert result is False


async def test_update_stock(db_session: AsyncSession) -> None:
    """Test updating product stock."""
    service = ProductService(db_session)

    product = Product(
        name="Stock Test",
        price=Decimal("10.00"),
        sku="STK-001",
        stock_quantity=100,
    )
    db_session.add(product)
    await db_session.commit()
    await db_session.refresh(product)

    # Decrease stock
    await service.update_stock(product.id, -10)
    await db_session.commit()
    await db_session.refresh(product)
    assert product.stock_quantity == 90

    # Increase stock
    await service.update_stock(product.id, 25)
    await db_session.commit()
    await db_session.refresh(product)
    assert product.stock_quantity == 115
