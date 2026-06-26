using System.ComponentModel.DataAnnotations;

namespace CleanArchitecture.Api.Models;

/// <summary>
/// Product DTO for list responses
/// </summary>
public record ProductDto
{
    public int Id { get; init; }
    public string Name { get; init; } = string.Empty;
    public string? Description { get; init; }
    public decimal Price { get; init; }
    public int StockQuantity { get; init; }
    public int CategoryId { get; init; }
    public string? CategoryName { get; init; }
    public string? Sku { get; init; }
    public bool IsActive { get; init; }
    public DateTime CreatedAt { get; init; }
    public DateTime UpdatedAt { get; init; }
}

/// <summary>
/// Product detail DTO with additional information
/// </summary>
public record ProductDetailDto : ProductDto
{
    public string? CategoryDescription { get; init; }
    public bool IsInStock => StockQuantity > 0;
    public string StockLevel => StockQuantity switch
    {
        0 => "OutOfStock",
        <= 10 => "Low",
        <= 50 => "Medium",
        _ => "High"
    };
}

/// <summary>
/// Request model for creating a product
/// </summary>
public record CreateProductRequest
{
    [Required]
    [StringLength(200, MinimumLength = 1)]
    public string Name { get; init; } = string.Empty;

    [StringLength(2000)]
    public string? Description { get; init; }

    [Required]
    [Range(0.01, double.MaxValue, ErrorMessage = "Price must be greater than zero")]
    public decimal Price { get; init; }

    [Required]
    [Range(0, int.MaxValue, ErrorMessage = "Stock quantity cannot be negative")]
    public int StockQuantity { get; init; }

    [Required]
    [Range(1, int.MaxValue, ErrorMessage = "A valid category must be selected")]
    public int CategoryId { get; init; }

    [StringLength(50)]
    public string? Sku { get; init; }

    public bool IsActive { get; init; } = true;
}

/// <summary>
/// Request model for updating a product
/// </summary>
public record UpdateProductRequest
{
    [Required]
    [StringLength(200, MinimumLength = 1)]
    public string Name { get; init; } = string.Empty;

    [StringLength(2000)]
    public string? Description { get; init; }

    [Required]
    [Range(0.01, double.MaxValue, ErrorMessage = "Price must be greater than zero")]
    public decimal Price { get; init; }

    [Required]
    [Range(0, int.MaxValue, ErrorMessage = "Stock quantity cannot be negative")]
    public int StockQuantity { get; init; }

    [Required]
    [Range(1, int.MaxValue, ErrorMessage = "A valid category must be selected")]
    public int CategoryId { get; init; }

    [StringLength(50)]
    public string? Sku { get; init; }

    public bool IsActive { get; init; }
}

/// <summary>
/// Response wrapper for paginated results
/// </summary>
public record PaginatedResponse<T>
{
    public IEnumerable<T> Items { get; init; } = Enumerable.Empty<T>();
    public int PageNumber { get; init; }
    public int PageSize { get; init; }
    public int TotalCount { get; init; }
    public int TotalPages => (int)Math.Ceiling(TotalCount / (double)PageSize);
    public bool HasPreviousPage => PageNumber > 1;
    public bool HasNextPage => PageNumber < TotalPages;
}
