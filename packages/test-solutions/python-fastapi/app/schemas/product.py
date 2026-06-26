"""Product schemas for request/response validation."""

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class ProductBase(BaseModel):
    """Base product schema with common fields."""

    name: str = Field(..., min_length=1, max_length=255, examples=["Widget Pro"])
    description: str | None = Field(
        None,
        max_length=5000,
        examples=["A high-quality widget for all your needs"],
    )
    price: Decimal = Field(
        ...,
        gt=0,
        decimal_places=2,
        examples=[29.99],
    )
    sku: str = Field(..., min_length=1, max_length=100, examples=["WIDGET-001"])
    stock_quantity: int = Field(default=0, ge=0, examples=[100])
    is_active: bool = Field(default=True)
    category_id: int | None = Field(default=None, examples=[1])


class ProductCreate(ProductBase):
    """Schema for creating a new product."""

    pass


class ProductUpdate(BaseModel):
    """Schema for updating an existing product."""

    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = Field(None, max_length=5000)
    price: Decimal | None = Field(None, gt=0, decimal_places=2)
    sku: str | None = Field(None, min_length=1, max_length=100)
    stock_quantity: int | None = Field(None, ge=0)
    is_active: bool | None = None
    category_id: int | None = None


class ProductResponse(ProductBase):
    """Schema for product response."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    updated_at: datetime


class ProductList(BaseModel):
    """Schema for paginated product list response."""

    items: list[ProductResponse]
    total: int
    page: int
    page_size: int
    pages: int
