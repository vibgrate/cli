# Python FastAPI Project

A modern FastAPI application with SQLAlchemy, Alembic, and Pydantic.

## Features

- **FastAPI** - Modern, fast web framework for building APIs
- **SQLAlchemy 2.0** - Async ORM with type hints
- **Pydantic v2** - Data validation using Python type annotations
- **Alembic** - Database migrations
- **JWT Authentication** - Secure token-based auth
- **Poetry** - Dependency management

## Project Structure

```
python-fastapi/
├── app/
│   ├── api/
│   │   ├── deps/          # Dependency injection
│   │   └── routes/        # API endpoints
│   ├── core/              # Configuration and security
│   ├── db/                # Database session and init
│   ├── models/            # SQLAlchemy models
│   ├── schemas/           # Pydantic schemas
│   └── services/          # Business logic
├── alembic/               # Database migrations
├── tests/                 # Test suite
│   ├── api/               # API integration tests
│   └── unit/              # Unit tests
├── pyproject.toml         # Poetry configuration
└── alembic.ini            # Alembic configuration
```

## Getting Started

### Prerequisites

- Python 3.11+
- Poetry
- PostgreSQL

### Installation

```bash
# Install dependencies
poetry install

# Copy environment variables
cp .env.example .env

# Run database migrations
poetry run alembic upgrade head

# Start development server
poetry run uvicorn app.main:app --reload
```

### Running Tests

```bash
# Run all tests
poetry run pytest

# Run with coverage
poetry run pytest --cov=app --cov-report=html

# Run specific test file
poetry run pytest tests/api/test_products.py -v
```

## API Documentation

Once the server is running, visit:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | - |
| `SECRET_KEY` | JWT signing key | - |
| `ALGORITHM` | JWT algorithm | `HS256` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Token expiration | `30` |

## License

MIT
