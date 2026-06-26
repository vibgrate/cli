using Application.Products.Commands;
using Application.Common.Interfaces;
using Domain.Entities;
using FluentAssertions;
using Moq;
using Microsoft.EntityFrameworkCore;

namespace Application.Tests.Products.Commands;

public class CreateProductCommandTests
{
    [Fact]
    public async Task Handle_WithValidCommand_CreatesProduct()
    {
        // Arrange
        var mockContext = new Mock<IApplicationDbContext>();
        var mockDbSet = new Mock<DbSet<Product>>();
        
        mockContext.Setup(c => c.Products).Returns(mockDbSet.Object);
        mockContext.Setup(c => c.SaveChangesAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(1);

        var command = new CreateProductCommand
        {
            Name = "Test Product",
            Description = "Test Description",
            Price = 29.99m,
            StockQuantity = 100,
            Category = "Electronics"
        };

        var handler = new CreateProductCommandHandler(mockContext.Object);

        // Act
        var result = await handler.Handle(command, CancellationToken.None);

        // Assert
        result.Should().NotBeNull();
        result.Name.Should().Be(command.Name);
        result.Price.Should().Be(command.Price);
        mockDbSet.Verify(m => m.Add(It.IsAny<Product>()), Times.Once);
        mockContext.Verify(m => m.SaveChangesAsync(It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public void Validator_WithEmptyName_ShouldHaveError()
    {
        // Arrange
        var validator = new CreateProductCommandValidator();
        var command = new CreateProductCommand
        {
            Name = "",
            Price = 10.00m
        };

        // Act
        var result = validator.Validate(command);

        // Assert
        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.PropertyName == "Name");
    }

    [Fact]
    public void Validator_WithNegativePrice_ShouldHaveError()
    {
        // Arrange
        var validator = new CreateProductCommandValidator();
        var command = new CreateProductCommand
        {
            Name = "Valid Name",
            Price = -10.00m
        };

        // Act
        var result = validator.Validate(command);

        // Assert
        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.PropertyName == "Price");
    }

    [Fact]
    public void Validator_WithValidCommand_ShouldNotHaveErrors()
    {
        // Arrange
        var validator = new CreateProductCommandValidator();
        var command = new CreateProductCommand
        {
            Name = "Valid Product",
            Price = 25.00m,
            StockQuantity = 10
        };

        // Act
        var result = validator.Validate(command);

        // Assert
        result.IsValid.Should().BeTrue();
    }
}
