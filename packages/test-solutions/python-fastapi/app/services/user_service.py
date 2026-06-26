"""User service for business logic."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_password_hash, verify_password
from app.models.user import User
from app.schemas.user import UserCreate, UserUpdate


class UserService:
    """Service class for user-related operations."""

    def __init__(self, db: AsyncSession) -> None:
        """Initialize service with database session."""
        self.db = db

    async def get_by_id(self, user_id: int) -> User | None:
        """
        Get user by ID.

        Args:
            user_id: The user ID to look up

        Returns:
            User if found, None otherwise
        """
        query = select(User).where(User.id == user_id)
        result = await self.db.execute(query)
        return result.scalar_one_or_none()

    async def get_by_email(self, email: str) -> User | None:
        """
        Get user by email.

        Args:
            email: The email to look up

        Returns:
            User if found, None otherwise
        """
        query = select(User).where(User.email == email)
        result = await self.db.execute(query)
        return result.scalar_one_or_none()

    async def get_users(
        self,
        *,
        skip: int = 0,
        limit: int = 100,
    ) -> list[User]:
        """
        Get list of users.

        Args:
            skip: Number of records to skip
            limit: Maximum number of records to return

        Returns:
            List of users
        """
        query = select(User).offset(skip).limit(limit).order_by(User.id)
        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def create(self, user_in: UserCreate) -> User:
        """
        Create a new user.

        Args:
            user_in: User creation data

        Returns:
            Created user
        """
        user = User(
            email=user_in.email,
            hashed_password=get_password_hash(user_in.password),
            full_name=user_in.full_name,
        )
        self.db.add(user)
        await self.db.flush()
        await self.db.refresh(user)
        return user

    async def update(
        self,
        user_id: int,
        user_in: UserUpdate,
    ) -> User | None:
        """
        Update an existing user.

        Args:
            user_id: ID of user to update
            user_in: User update data

        Returns:
            Updated user if found, None otherwise
        """
        user = await self.get_by_id(user_id)
        if not user:
            return None

        update_data = user_in.model_dump(exclude_unset=True)

        # Handle password hashing separately
        if "password" in update_data:
            update_data["hashed_password"] = get_password_hash(update_data.pop("password"))

        for field, value in update_data.items():
            setattr(user, field, value)

        await self.db.flush()
        await self.db.refresh(user)
        return user

    async def delete(self, user_id: int) -> bool:
        """
        Delete a user.

        Args:
            user_id: ID of user to delete

        Returns:
            True if deleted, False if not found
        """
        user = await self.get_by_id(user_id)
        if not user:
            return False

        await self.db.delete(user)
        await self.db.flush()
        return True

    async def authenticate(self, email: str, password: str) -> User | None:
        """
        Authenticate user by email and password.

        Args:
            email: User email
            password: Plain text password

        Returns:
            User if authentication successful, None otherwise
        """
        user = await self.get_by_email(email)
        if not user:
            return None

        if not verify_password(password, user.hashed_password):
            return None

        return user

    async def set_superuser(self, user_id: int, is_superuser: bool) -> User | None:
        """
        Set superuser status for a user.

        Args:
            user_id: ID of user to update
            is_superuser: Superuser status

        Returns:
            Updated user if found, None otherwise
        """
        user = await self.get_by_id(user_id)
        if not user:
            return None

        user.is_superuser = is_superuser
        await self.db.flush()
        await self.db.refresh(user)
        return user

    async def verify_user(self, user_id: int) -> User | None:
        """
        Mark user as verified.

        Args:
            user_id: ID of user to verify

        Returns:
            Updated user if found, None otherwise
        """
        user = await self.get_by_id(user_id)
        if not user:
            return None

        user.is_verified = True
        await self.db.flush()
        await self.db.refresh(user)
        return user
