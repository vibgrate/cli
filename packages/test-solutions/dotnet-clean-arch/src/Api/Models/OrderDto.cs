using System.ComponentModel.DataAnnotations;
using CleanArchitecture.Domain.Entities;

namespace CleanArchitecture.Api.Models;

/// <summary>
/// Order DTO for list responses
/// </summary>
public record OrderDto
{
    public int Id { get; init; }
    public int CustomerId { get; init; }
    public DateTime OrderDate { get; init; }
    public decimal TotalAmount { get; init; }
    public string Status { get; init; } = string.Empty;
    public int ItemCount { get; init; }
}

/// <summary>
/// Order detail DTO with items and customer info
/// </summary>
public record OrderDetailDto
{
    public int Id { get; init; }
    public int CustomerId { get; init; }
    public string? CustomerName { get; init; }
    public DateTime OrderDate { get; init; }
    public decimal TotalAmount { get; init; }
    public string Status { get; init; } = string.Empty;
    public ICollection<OrderItemDto> Items { get; init; } = new List<OrderItemDto>();
}

/// <summary>
/// Order item DTO
/// </summary>
public record OrderItemDto
{
    public int Id { get; init; }
    public int ProductId { get; init; }
    public string? ProductName { get; init; }
    public int Quantity { get; init; }
    public decimal UnitPrice { get; init; }
    public decimal LineTotal { get; init; }
}

/// <summary>
/// Request model for creating an order
/// </summary>
public record CreateOrderRequest
{
    [Required]
    [Range(1, int.MaxValue, ErrorMessage = "A valid customer must be specified")]
    public int CustomerId { get; init; }

    [Required]
    [MinLength(1, ErrorMessage = "At least one order item is required")]
    public ICollection<CreateOrderItemRequest> Items { get; init; } = new List<CreateOrderItemRequest>();
}

/// <summary>
/// Request model for creating an order item
/// </summary>
public record CreateOrderItemRequest
{
    [Required]
    [Range(1, int.MaxValue, ErrorMessage = "A valid product must be specified")]
    public int ProductId { get; init; }

    [Required]
    [Range(1, int.MaxValue, ErrorMessage = "Quantity must be at least 1")]
    public int Quantity { get; init; }

    [Required]
    [Range(0.01, double.MaxValue, ErrorMessage = "Unit price must be greater than zero")]
    public decimal UnitPrice { get; init; }
}

/// <summary>
/// Request model for updating order status
/// </summary>
public record UpdateOrderStatusRequest
{
    [Required]
    public OrderStatus Status { get; init; }
}

/// <summary>
/// Order statistics DTO
/// </summary>
public record OrderStatsDto
{
    public int TotalOrders { get; init; }
    public decimal TotalRevenue { get; init; }
    public DateTime? StartDate { get; init; }
    public DateTime? EndDate { get; init; }
}

/// <summary>
/// Customer DTO
/// </summary>
public record CustomerDto
{
    public int Id { get; init; }
    public string Name { get; init; } = string.Empty;
    public string Email { get; init; } = string.Empty;
    public string? Phone { get; init; }
    public AddressDto Address { get; init; } = new();
    public int TotalOrderCount { get; init; }
    public decimal TotalSpent { get; init; }
}

/// <summary>
/// Address DTO
/// </summary>
public record AddressDto
{
    public string Street { get; init; } = string.Empty;
    public string City { get; init; } = string.Empty;
    public string State { get; init; } = string.Empty;
    public string PostalCode { get; init; } = string.Empty;
    public string Country { get; init; } = string.Empty;
    public string FullAddress => $"{Street}, {City}, {State} {PostalCode}, {Country}";
}

/// <summary>
/// Request model for creating a customer
/// </summary>
public record CreateCustomerRequest
{
    [Required]
    [StringLength(200, MinimumLength = 1)]
    public string Name { get; init; } = string.Empty;

    [Required]
    [EmailAddress]
    [StringLength(256)]
    public string Email { get; init; } = string.Empty;

    [Phone]
    [StringLength(20)]
    public string? Phone { get; init; }

    public CreateAddressRequest? Address { get; init; }
}

/// <summary>
/// Request model for address
/// </summary>
public record CreateAddressRequest
{
    [StringLength(200)]
    public string Street { get; init; } = string.Empty;

    [StringLength(100)]
    public string City { get; init; } = string.Empty;

    [StringLength(100)]
    public string State { get; init; } = string.Empty;

    [StringLength(20)]
    public string PostalCode { get; init; } = string.Empty;

    [StringLength(100)]
    public string Country { get; init; } = string.Empty;
}
