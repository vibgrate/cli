# Test Solutions

This directory contains realistic sample projects in multiple languages for testing the vibgrate CLI scanner.

## Projects

| Project | Language | Files | Status | Description |
|---------|----------|-------|--------|-------------|
| `dotnet-clean-arch` | C# (.NET 8) | ~65 | ✅ Active | Clean Architecture pattern with API, Application, Domain, Infrastructure layers |
| `node-turborepo` | TypeScript/JS | ~55 | ✅ Active | Turborepo monorepo with Next.js web, Express API, React admin, shared packages |
| `java-spring` | Java | ~32 | ✅ Active | Spring Boot 3.2 REST API with JPA, security, MapStruct |
| `python-fastapi` | Python | ~43 | ✅ Active | FastAPI application with SQLAlchemy, Alembic, Pydantic |

## Running Tests

```bash
# Run all tests
pnpm test

# Run with verbose output
pnpm test:verbose

# Update baselines after scanner changes
pnpm test:update-baselines
```

## Project Structure

### dotnet-clean-arch (~50 files)
```
├── CleanArchitecture.sln
├── src/
│   ├── Api/           # ASP.NET Core Web API
│   ├── Application/   # MediatR handlers, validators
│   ├── Domain/        # Entities, interfaces
│   └── Infrastructure/ # EF Core, repositories
└── tests/
    ├── Api.Tests/
    └── Application.Tests/
```

### node-turborepo (~55 files)
```
├── turbo.json
├── pnpm-workspace.yaml
├── apps/
│   ├── web/     # Next.js 14
│   ├── api/     # Express API
│   └── admin/   # React/Vite
└── packages/
    ├── ui/       # Shared components
    ├── config/   # Shared configs
    ├── utils/    # Shared utilities
    ├── database/ # Prisma
    └── types/    # TypeScript types
```

### java-spring (~32 files)
```
├── pom.xml
└── src/
    ├── main/java/com/example/demo/
    │   ├── controller/
    │   ├── service/
    │   ├── repository/
    │   ├── model/
    │   ├── dto/
    │   └── config/
    └── test/java/com/example/demo/
```

### python-fastapi (~43 files)
```
├── pyproject.toml
├── alembic/
├── app/
│   ├── api/routes/
│   ├── core/
│   ├── models/
│   ├── schemas/
│   ├── services/
│   └── db/
└── tests/
```

## Expected Scan Results

Each project should be detected by the CLI scanner with:

- **dotnet-clean-arch**: C# language, NuGet packages (MediatR, FluentValidation, EF Core), 4+ projects
- **node-turborepo**: TypeScript/JavaScript, npm packages, 8+ packages (3 apps + 5 packages)
- **java-spring**: Java language, Maven dependencies, 1 project with 15+ dependencies
- **python-fastapi**: Python language, Poetry/PyPI packages, 1 project with 10+ dependencies
