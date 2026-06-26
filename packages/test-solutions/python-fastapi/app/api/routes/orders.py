"""Order API endpoints."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps.auth import get_current_active_user
from app.core.deps import get_db
from app.models.order import Order, OrderItem, OrderStatus
from app.models.user import User
from app.schemas.order import OrderCreate, OrderList, OrderResponse, OrderUpdate
from app.services.product_service import ProductService
from sqlalchemy import func, select

router = APIRouter()


@router.get("", response_model=OrderList)
async def get_orders(
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_active_user)],
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status_filter: OrderStatus | None = Query(None, alias="status"),
) -> OrderList:
    """
    Get paginated list of orders for current user.

    - **page**: Page number (default: 1)
    - **page_size**: Number of items per page (default: 20)
    - **status**: Optional status filter
    """
    query = select(Order).where(Order.user_id == current_user.id)

    if status_filter:
        query = query.where(Order.status == status_filter.value)

    # Count total
    count_query = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    # Get paginated results
    query = query.offset((page - 1) * page_size).limit(page_size)
    query = query.order_by(Order.created_at.desc())
    result = await db.execute(query)
    orders = result.scalars().all()

    pages = (total + page_size - 1) // page_size

    return OrderList(
        items=orders,
        total=total,
        page=page,
        page_size=page_size,
        pages=pages,
    )


@router.get("/{order_id}", response_model=OrderResponse)
async def get_order(
    order_id: int,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_active_user)],
) -> OrderResponse:
    """
    Get order by ID.

    - **order_id**: The ID of the order to retrieve
    """
    query = select(Order).where(
        Order.id == order_id,
        Order.user_id == current_user.id,
    )
    result = await db.execute(query)
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Order not found",
        )

    return order


@router.post("", response_model=OrderResponse, status_code=status.HTTP_201_CREATED)
async def create_order(
    order_in: OrderCreate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_active_user)],
) -> OrderResponse:
    """
    Create a new order.

    - **items**: List of products and quantities
    - **shipping_address**: Optional shipping address
    - **notes**: Optional order notes
    """
    product_service = ProductService(db)

    # Validate products and calculate totals
    order_items: list[OrderItem] = []
    total_amount = 0

    for item in order_in.items:
        product = await product_service.get_by_id(item.product_id)
        if not product:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Product {item.product_id} not found",
            )

        if not product.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Product {product.name} is not available",
            )

        if product.stock_quantity < item.quantity:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Insufficient stock for {product.name}",
            )

        subtotal = product.price * item.quantity
        total_amount += subtotal

        order_item = OrderItem(
            product_id=product.id,
            quantity=item.quantity,
            unit_price=product.price,
            subtotal=subtotal,
        )
        order_items.append(order_item)

    # Create order
    order = Order(
        order_number=f"ORD-{uuid4().hex[:8].upper()}",
        user_id=current_user.id,
        total_amount=total_amount,
        shipping_address=order_in.shipping_address,
        notes=order_in.notes,
        ordered_at=datetime.now(UTC),
        items=order_items,
    )

    db.add(order)
    await db.flush()
    await db.refresh(order)

    # Update stock quantities
    for item in order_in.items:
        await product_service.update_stock(item.product_id, -item.quantity)

    return order


@router.patch("/{order_id}", response_model=OrderResponse)
async def update_order(
    order_id: int,
    order_in: OrderUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_active_user)],
) -> OrderResponse:
    """
    Update an order.

    - **order_id**: The ID of the order to update
    - **status**: New order status
    - **shipping_address**: Updated shipping address
    - **notes**: Updated notes
    """
    query = select(Order).where(
        Order.id == order_id,
        Order.user_id == current_user.id,
    )
    result = await db.execute(query)
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Order not found",
        )

    # Validate status transition
    if order_in.status:
        if order.status == OrderStatus.CANCELLED.value:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot update cancelled order",
            )

        if order.status == OrderStatus.DELIVERED.value:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot update delivered order",
            )

    # Update fields
    update_data = order_in.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if field == "status" and value:
            setattr(order, field, value.value)
        else:
            setattr(order, field, value)

    await db.flush()
    await db.refresh(order)

    return order


@router.post("/{order_id}/cancel", response_model=OrderResponse)
async def cancel_order(
    order_id: int,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_active_user)],
) -> OrderResponse:
    """
    Cancel an order and restore stock.

    - **order_id**: The ID of the order to cancel
    """
    query = select(Order).where(
        Order.id == order_id,
        Order.user_id == current_user.id,
    )
    result = await db.execute(query)
    order = result.scalar_one_or_none()

    if not order:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Order not found",
        )

    if order.status == OrderStatus.CANCELLED.value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Order is already cancelled",
        )

    if order.status in [OrderStatus.SHIPPED.value, OrderStatus.DELIVERED.value]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot cancel shipped or delivered order",
        )

    # Restore stock
    product_service = ProductService(db)
    for item in order.items:
        await product_service.update_stock(item.product_id, item.quantity)

    order.status = OrderStatus.CANCELLED.value
    await db.flush()
    await db.refresh(order)

    return order
