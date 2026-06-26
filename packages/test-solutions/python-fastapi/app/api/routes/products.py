"""Product API endpoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps.auth import get_current_active_user
from app.core.deps import get_db
from app.models.user import User
from app.schemas.product import (
    ProductCreate,
    ProductList,
    ProductResponse,
    ProductUpdate,
)
from app.services.product_service import ProductService

router = APIRouter()


@router.get("", response_model=ProductList)
async def get_products(
    db: Annotated[AsyncSession, Depends(get_db)],
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    category_id: int | None = Query(None, description="Filter by category"),
    is_active: bool | None = Query(None, description="Filter by active status"),
    search: str | None = Query(None, max_length=100, description="Search by name"),
) -> ProductList:
    """
    Get paginated list of products.

    - **page**: Page number (default: 1)
    - **page_size**: Number of items per page (default: 20, max: 100)
    - **category_id**: Optional category filter
    - **is_active**: Optional active status filter
    - **search**: Optional search term for product name
    """
    service = ProductService(db)
    products, total = await service.get_products(
        page=page,
        page_size=page_size,
        category_id=category_id,
        is_active=is_active,
        search=search,
    )

    pages = (total + page_size - 1) // page_size

    return ProductList(
        items=products,
        total=total,
        page=page,
        page_size=page_size,
        pages=pages,
    )


@router.get("/{product_id}", response_model=ProductResponse)
async def get_product(
    product_id: int,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ProductResponse:
    """
    Get a product by ID.

    - **product_id**: The ID of the product to retrieve
    """
    service = ProductService(db)
    product = await service.get_by_id(product_id)

    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Product not found",
        )

    return product


@router.post("", response_model=ProductResponse, status_code=status.HTTP_201_CREATED)
async def create_product(
    product_in: ProductCreate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_active_user)],
) -> ProductResponse:
    """
    Create a new product. Requires authentication.

    - **product_in**: Product data to create
    """
    service = ProductService(db)

    # Check if SKU already exists
    existing = await service.get_by_sku(product_in.sku)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Product with this SKU already exists",
        )

    product = await service.create(product_in)
    return product


@router.patch("/{product_id}", response_model=ProductResponse)
async def update_product(
    product_id: int,
    product_in: ProductUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_active_user)],
) -> ProductResponse:
    """
    Update a product. Requires authentication.

    - **product_id**: The ID of the product to update
    - **product_in**: Product data to update
    """
    service = ProductService(db)
    product = await service.get_by_id(product_id)

    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Product not found",
        )

    # Check SKU uniqueness if being updated
    if product_in.sku and product_in.sku != product.sku:
        existing = await service.get_by_sku(product_in.sku)
        if existing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Product with this SKU already exists",
            )

    updated_product = await service.update(product_id, product_in)
    return updated_product


@router.delete("/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_product(
    product_id: int,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_active_user)],
) -> None:
    """
    Delete a product. Requires authentication.

    - **product_id**: The ID of the product to delete
    """
    service = ProductService(db)
    product = await service.get_by_id(product_id)

    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Product not found",
        )

    await service.delete(product_id)
