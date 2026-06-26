using CleanArchitecture.Api.Models;
using CleanArchitecture.Domain.Entities;
using CleanArchitecture.Domain.Interfaces;
using MediatR;
using Microsoft.AspNetCore.Mvc;

namespace CleanArchitecture.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
[Produces("application/json")]
public class OrdersController : ControllerBase
{
    private readonly IOrderRepository _orderRepository;
    private readonly ILogger<OrdersController> _logger;

    public OrdersController(
        IOrderRepository orderRepository,
        ILogger<OrdersController> logger)
    {
        _orderRepository = orderRepository ?? throw new ArgumentNullException(nameof(orderRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Gets all orders with optional filtering
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(IEnumerable<OrderDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IEnumerable<OrderDto>>> GetAll(
        [FromQuery] int? customerId,
        [FromQuery] OrderStatus? status,
        [FromQuery] DateTime? startDate,
        [FromQuery] DateTime? endDate,
        [FromQuery] int pageNumber = 1,
        [FromQuery] int pageSize = 10,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Getting orders with filters: CustomerId={CustomerId}, Status={Status}",
            customerId, status);

        IEnumerable<Order> orders;

        if (customerId.HasValue)
        {
            orders = await _orderRepository.GetByCustomerIdAsync(customerId.Value, cancellationToken);
        }
        else if (status.HasValue)
        {
            orders = await _orderRepository.GetByStatusAsync(status.Value, cancellationToken);
        }
        else if (startDate.HasValue && endDate.HasValue)
        {
            orders = await _orderRepository.GetByDateRangeAsync(startDate.Value, endDate.Value, cancellationToken);
        }
        else
        {
            orders = await _orderRepository.GetPagedAsync(pageNumber, pageSize, cancellationToken);
        }

        var orderDtos = orders.Select(MapToDto);
        return Ok(orderDtos);
    }

    /// <summary>
    /// Gets an order by ID with order items
    /// </summary>
    [HttpGet("{id:int}")]
    [ProducesResponseType(typeof(OrderDetailDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<OrderDetailDto>> GetById(
        int id,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Getting order with ID {OrderId}", id);

        var order = await _orderRepository.GetByIdWithItemsAsync(id, cancellationToken);

        if (order == null)
        {
            _logger.LogWarning("Order with ID {OrderId} not found", id);
            return NotFound(new { Message = $"Order with ID {id} not found" });
        }

        return Ok(MapToDetailDto(order));
    }

    /// <summary>
    /// Creates a new order
    /// </summary>
    [HttpPost]
    [ProducesResponseType(typeof(int), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<int>> Create(
        [FromBody] CreateOrderRequest request,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Creating new order for customer {CustomerId}", request.CustomerId);

        var order = new Order
        {
            CustomerId = request.CustomerId,
            OrderDate = DateTime.UtcNow,
            Status = OrderStatus.Pending,
            TotalAmount = 0
        };

        foreach (var item in request.Items)
        {
            order.OrderItems.Add(new OrderItem
            {
                ProductId = item.ProductId,
                Quantity = item.Quantity,
                UnitPrice = item.UnitPrice
            });
        }

        order.CalculateTotalAmount();

        var createdOrder = await _orderRepository.AddAsync(order, cancellationToken);

        _logger.LogInformation("Created order with ID {OrderId}", createdOrder.Id);

        return CreatedAtAction(nameof(GetById), new { id = createdOrder.Id }, createdOrder.Id);
    }

    /// <summary>
    /// Updates order status
    /// </summary>
    [HttpPatch("{id:int}/status")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> UpdateStatus(
        int id,
        [FromBody] UpdateOrderStatusRequest request,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Updating status for order {OrderId} to {NewStatus}", id, request.Status);

        var order = await _orderRepository.GetByIdAsync(id, cancellationToken);

        if (order == null)
        {
            return NotFound(new { Message = $"Order with ID {id} not found" });
        }

        try
        {
            order.UpdateStatus(request.Status);
            await _orderRepository.UpdateAsync(order, cancellationToken);
            
            _logger.LogInformation("Updated order {OrderId} status to {NewStatus}", id, request.Status);
            return NoContent();
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Invalid status transition for order {OrderId}", id);
            return BadRequest(new { Message = ex.Message });
        }
    }

    /// <summary>
    /// Cancels an order
    /// </summary>
    [HttpPost("{id:int}/cancel")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Cancel(
        int id,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Cancelling order {OrderId}", id);

        var order = await _orderRepository.GetByIdAsync(id, cancellationToken);

        if (order == null)
        {
            return NotFound(new { Message = $"Order with ID {id} not found" });
        }

        if (order.Status == OrderStatus.Shipped || order.Status == OrderStatus.Delivered)
        {
            return BadRequest(new { Message = "Cannot cancel shipped or delivered orders" });
        }

        try
        {
            order.UpdateStatus(OrderStatus.Cancelled);
            await _orderRepository.UpdateAsync(order, cancellationToken);
            
            _logger.LogInformation("Cancelled order {OrderId}", id);
            return NoContent();
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { Message = ex.Message });
        }
    }

    /// <summary>
    /// Gets order statistics
    /// </summary>
    [HttpGet("stats")]
    [ProducesResponseType(typeof(OrderStatsDto), StatusCodes.Status200OK)]
    public async Task<ActionResult<OrderStatsDto>> GetStats(
        [FromQuery] DateTime? startDate,
        [FromQuery] DateTime? endDate,
        CancellationToken cancellationToken = default)
    {
        var totalOrders = await _orderRepository.GetCountAsync(cancellationToken);
        var totalRevenue = await _orderRepository.GetTotalRevenueAsync(startDate, endDate, cancellationToken);

        return Ok(new OrderStatsDto
        {
            TotalOrders = totalOrders,
            TotalRevenue = totalRevenue,
            StartDate = startDate,
            EndDate = endDate
        });
    }

    private static OrderDto MapToDto(Order order)
    {
        return new OrderDto
        {
            Id = order.Id,
            CustomerId = order.CustomerId,
            OrderDate = order.OrderDate,
            TotalAmount = order.TotalAmount,
            Status = order.Status.ToString(),
            ItemCount = order.OrderItems.Count
        };
    }

    private static OrderDetailDto MapToDetailDto(Order order)
    {
        return new OrderDetailDto
        {
            Id = order.Id,
            CustomerId = order.CustomerId,
            CustomerName = order.Customer?.Name,
            OrderDate = order.OrderDate,
            TotalAmount = order.TotalAmount,
            Status = order.Status.ToString(),
            Items = order.OrderItems.Select(item => new OrderItemDto
            {
                Id = item.Id,
                ProductId = item.ProductId,
                ProductName = item.Product?.Name,
                Quantity = item.Quantity,
                UnitPrice = item.UnitPrice,
                LineTotal = item.LineTotal
            }).ToList()
        };
    }
}
