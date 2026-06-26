"""Product service for business logic."""

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.product import Product
from app.schemas.product import ProductCreate, ProductUpdate


class ProductService:
    """Service class for product-related operations."""

    def __init__(self, db: AsyncSession) -> None:
        """Initialize service with database session."""
        self.db = db

    async def get_by_id(self, product_id: int) -> Product | None:
        """
        Get product by ID.

        Args:
            product_id: The product ID to look up

        Returns:
            Product if found, None otherwise
        """
        query = select(Product).where(Product.id == product_id)
        result = await self.db.execute(query)
        return result.scalar_one_or_none()

    async def get_by_sku(self, sku: str) -> Product | None:
        """
        Get product by SKU.

        Args:
            sku: The product SKU to look up

        Returns:
            Product if found, None otherwise
        """
        query = select(Product).where(Product.sku == sku)
        result = await self.db.execute(query)
        return result.scalar_one_or_none()

    async def get_products(
        self,
        *,
        page: int = 1,
        page_size: int = 20,
        category_id: int | None = None,
        is_active: bool | None = None,
        search: str | None = None,
    ) -> tuple[list[Product], int]:
        """
        Get paginated list of products with optional filters.

        Args:
            page: Page number (1-indexed)
            page_size: Number of items per page
            category_id: Optional category filter
            is_active: Optional active status filter
            search: Optional search term for name

        Returns:
            Tuple of (products list, total count)
        """
        query = select(Product)

        # Apply filters
        if category_id is not None:
            query = query.where(Product.category_id == category_id)

        if is_active is not None:
            query = query.where(Product.is_active == is_active)

        if search:
            query = query.where(Product.name.ilike(f"%{search}%"))

        # Count total
        count_query = select(func.count()).select_from(query.subquery())
        total_result = await self.db.execute(count_query)
        total = total_result.scalar() or 0

        # Get paginated results
        query = query.offset((page - 1) * page_size).limit(page_size)
        query = query.order_by(Product.created_at.desc())
        result = await self.db.execute(query)
        products = list(result.scalars().all())

        return products, total

    async def create(self, product_in: ProductCreate) -> Product:
        """
        Create a new product.

        Args:
            product_in: Product creation data

        Returns:
            Created product
        """
        product = Product(**product_in.model_dump())
        self.db.add(product)
        await self.db.flush()
        await self.db.refresh(product)
        return product

    async def update(
        self,
        product_id: int,
        product_in: ProductUpdate,
    ) -> Product | None:
        """
        Update an existing product.

        Args:
            product_id: ID of product to update
            product_in: Product update data

        Returns:
            Updated product if found, None otherwise
        """
        product = await self.get_by_id(product_id)
        if not product:
            return None

        update_data = product_in.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            setattr(product, field, value)

        await self.db.flush()
        await self.db.refresh(product)
        return product

    async def delete(self, product_id: int) -> bool:
        """
        Delete a product.

        Args:
            product_id: ID of product to delete

        Returns:
            True if deleted, False if not found
        """
        product = await self.get_by_id(product_id)
        if not product:
            return False

        await self.db.delete(product)
        await self.db.flush()
        return True

    async def update_stock(self, product_id: int, quantity_change: int) -> bool:
        """
        Update product stock quantity.

        Args:
            product_id: ID of product to update
            quantity_change: Amount to add (positive) or subtract (negative)

        Returns:
            True if updated successfully
        """
        stmt = (
            update(Product)
            .where(Product.id == product_id)
            .values(stock_quantity=Product.stock_quantity + quantity_change)
        )
        await self.db.execute(stmt)
        return True
