using CleanArchitecture.Application.Common.Interfaces;
using FluentValidation;
using MediatR;
using Microsoft.EntityFrameworkCore;

namespace CleanArchitecture.Application.Products.Commands;

public record DeleteProductCommand(int Id) : IRequest<Unit>;

public class DeleteProductCommandValidator : AbstractValidator<DeleteProductCommand>
{
    private readonly IApplicationDbContext _context;

    public DeleteProductCommandValidator(IApplicationDbContext context)
    {
        _context = context;

        RuleFor(v => v.Id)
            .GreaterThan(0).WithMessage("Invalid product ID.")
            .MustAsync(ProductExists).WithMessage("Product not found.")
            .MustAsync(ProductNotInActiveOrders).WithMessage("Cannot delete product that is in active orders.");
    }

    private async Task<bool> ProductExists(int id, CancellationToken cancellationToken)
    {
        return await _context.Products.AnyAsync(p => p.Id == id, cancellationToken);
    }

    private async Task<bool> ProductNotInActiveOrders(int id, CancellationToken cancellationToken)
    {
        var hasActiveOrders = await _context.OrderItems
            .Include(oi => oi.Order)
            .AnyAsync(oi => oi.ProductId == id && 
                          (oi.Order.Status == Domain.Entities.OrderStatus.Pending || 
                           oi.Order.Status == Domain.Entities.OrderStatus.Processing ||
                           oi.Order.Status == Domain.Entities.OrderStatus.Shipped), 
                     cancellationToken);

        return !hasActiveOrders;
    }
}

public class DeleteProductCommandHandler : IRequestHandler<DeleteProductCommand, Unit>
{
    private readonly IApplicationDbContext _context;

    public DeleteProductCommandHandler(IApplicationDbContext context)
    {
        _context = context;
    }

    public async Task<Unit> Handle(DeleteProductCommand request, CancellationToken cancellationToken)
    {
        var product = await _context.Products
            .FirstOrDefaultAsync(p => p.Id == request.Id, cancellationToken);

        if (product == null)
        {
            throw new NotFoundException(nameof(Product), request.Id);
        }

        // Soft delete by marking as inactive, or hard delete
        // For this implementation, we'll do a soft delete
        product.IsActive = false;
        product.UpdatedAt = DateTime.UtcNow;

        await _context.SaveChangesAsync(cancellationToken);

        return Unit.Value;
    }
}
