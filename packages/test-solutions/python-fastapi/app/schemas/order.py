"""Order schemas for request/response validation."""

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.models.order import OrderStatus


class OrderItemBase(BaseModel):
    """Base order item schema."""

    product_id: int = Field(..., examples=[1])
    quantity: int = Field(..., gt=0, examples=[2])


class OrderItemCreate(OrderItemBase):
    """Schema for creating an order item."""

    pass


class OrderItemResponse(OrderItemBase):
    """Schema for order item response."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    unit_price: Decimal
    subtotal: Decimal


class OrderBase(BaseModel):
    """Base order schema with common fields."""

    shipping_address: str | None = Field(
        None,
        max_length=500,
        examples=["123 Main St, City, Country"],
    )
    notes: str | None = Field(None, max_length=1000, examples=["Leave at door"])


class OrderCreate(OrderBase):
    """Schema for creating a new order."""

    items: list[OrderItemCreate] = Field(..., min_length=1)


class OrderUpdate(BaseModel):
    """Schema for updating an existing order."""

    status: OrderStatus | None = None
    shipping_address: str | None = Field(None, max_length=500)
    notes: str | None = Field(None, max_length=1000)


class OrderResponse(OrderBase):
    """Schema for order response."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    order_number: str
    status: str
    total_amount: Decimal
    user_id: int
    ordered_at: datetime
    created_at: datetime
    updated_at: datetime
    items: list[OrderItemResponse]


class OrderList(BaseModel):
    """Schema for paginated order list response."""

    items: list[OrderResponse]
    total: int
    page: int
    page_size: int
    pages: int
