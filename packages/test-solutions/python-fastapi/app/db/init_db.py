"""Database initialization utilities."""

import logging

from sqlalchemy import text

from app.db.session import engine
from app.models import Base

logger = logging.getLogger(__name__)


async def init_db() -> None:
    """
    Initialize the database.

    Creates all tables if they don't exist.
    In production, use Alembic migrations instead.
    """
    async with engine.begin() as conn:
        # Check database connection
        await conn.execute(text("SELECT 1"))
        logger.info("Database connection successful")

        # Create tables (for development only - use Alembic in production)
        # await conn.run_sync(Base.metadata.create_all)
        # logger.info("Database tables created")


async def create_tables() -> None:
    """Create all database tables."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        logger.info("All database tables created")


async def drop_tables() -> None:
    """Drop all database tables."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        logger.info("All database tables dropped")
