"""Authentication API endpoint tests."""

from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_password_hash
from app.models.user import User

pytestmark = pytest.mark.asyncio


async def test_register_user(
    client: AsyncClient,
    user_data: dict[str, Any],
) -> None:
    """Test user registration."""
    response = await client.post("/api/v1/auth/register", json=user_data)
    assert response.status_code == 201
    data = response.json()
    assert data["email"] == user_data["email"]
    assert data["full_name"] == user_data["full_name"]
    assert "id" in data
    assert "hashed_password" not in data


async def test_register_user_duplicate_email(
    client: AsyncClient,
    db_session: AsyncSession,
    user_data: dict[str, Any],
) -> None:
    """Test registration with existing email."""
    # Create existing user
    existing = User(
        email=user_data["email"],
        hashed_password=get_password_hash("password123"),
    )
    db_session.add(existing)
    await db_session.commit()

    response = await client.post("/api/v1/auth/register", json=user_data)
    assert response.status_code == 400
    assert "already registered" in response.json()["detail"]


async def test_register_user_invalid_email(client: AsyncClient) -> None:
    """Test registration with invalid email."""
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "invalid-email",
            "password": "password123",
        },
    )
    assert response.status_code == 422


async def test_register_user_short_password(client: AsyncClient) -> None:
    """Test registration with too short password."""
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "test@example.com",
            "password": "short",
        },
    )
    assert response.status_code == 422


async def test_login_success(
    client: AsyncClient,
    test_user: User,
) -> None:
    """Test successful login."""
    response = await client.post(
        "/api/v1/auth/login",
        data={
            "username": test_user.email,
            "password": "testpassword123",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert "refresh_token" in data
    assert data["token_type"] == "bearer"


async def test_login_wrong_password(
    client: AsyncClient,
    test_user: User,
) -> None:
    """Test login with wrong password."""
    response = await client.post(
        "/api/v1/auth/login",
        data={
            "username": test_user.email,
            "password": "wrongpassword",
        },
    )
    assert response.status_code == 401
    assert "Incorrect email or password" in response.json()["detail"]


async def test_login_nonexistent_user(client: AsyncClient) -> None:
    """Test login with non-existent user."""
    response = await client.post(
        "/api/v1/auth/login",
        data={
            "username": "nonexistent@example.com",
            "password": "password123",
        },
    )
    assert response.status_code == 401


async def test_login_inactive_user(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Test login with inactive user."""
    user = User(
        email="inactive@example.com",
        hashed_password=get_password_hash("password123"),
        is_active=False,
    )
    db_session.add(user)
    await db_session.commit()

    response = await client.post(
        "/api/v1/auth/login",
        data={
            "username": "inactive@example.com",
            "password": "password123",
        },
    )
    assert response.status_code == 401
    assert "inactive" in response.json()["detail"].lower()


async def test_login_json_endpoint(
    client: AsyncClient,
    test_user: User,
) -> None:
    """Test JSON login endpoint."""
    response = await client.post(
        "/api/v1/auth/login/access-token",
        json={
            "email": test_user.email,
            "password": "testpassword123",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data


async def test_refresh_token(
    client: AsyncClient,
    test_user: User,
) -> None:
    """Test token refresh."""
    # First, login to get tokens
    login_response = await client.post(
        "/api/v1/auth/login",
        data={
            "username": test_user.email,
            "password": "testpassword123",
        },
    )
    refresh_token = login_response.json()["refresh_token"]

    # Refresh the token
    response = await client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": refresh_token},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert "refresh_token" in data


async def test_refresh_token_invalid(client: AsyncClient) -> None:
    """Test refresh with invalid token."""
    response = await client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": "invalid-token"},
    )
    assert response.status_code == 401


async def test_get_current_user(
    client: AsyncClient,
    test_user: User,
    user_token_headers: dict[str, str],
) -> None:
    """Test getting current user info."""
    response = await client.get(
        "/api/v1/users/me",
        headers=user_token_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert data["email"] == test_user.email
    assert data["id"] == test_user.id


async def test_get_current_user_unauthorized(client: AsyncClient) -> None:
    """Test getting current user without token."""
    response = await client.get("/api/v1/users/me")
    assert response.status_code == 401


async def test_get_current_user_invalid_token(client: AsyncClient) -> None:
    """Test getting current user with invalid token."""
    response = await client.get(
        "/api/v1/users/me",
        headers={"Authorization": "Bearer invalid-token"},
    )
    assert response.status_code == 401


async def test_update_current_user(
    client: AsyncClient,
    test_user: User,
    user_token_headers: dict[str, str],
) -> None:
    """Test updating current user."""
    response = await client.patch(
        "/api/v1/users/me",
        json={"full_name": "Updated Name"},
        headers=user_token_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert data["full_name"] == "Updated Name"
