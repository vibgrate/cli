namespace CleanArchitecture.Domain.Entities;

public class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public DateTime OrderDate { get; set; }
    public decimal TotalAmount { get; set; }
    public OrderStatus Status { get; set; }
    
    // Navigation properties
    public Customer Customer { get; set; } = null!;
    public ICollection<OrderItem> OrderItems { get; set; } = new List<OrderItem>();
    
    public void CalculateTotalAmount()
    {
        TotalAmount = OrderItems.Sum(item => item.Quantity * item.UnitPrice);
    }
    
    public void AddItem(OrderItem item)
    {
        item.OrderId = Id;
        OrderItems.Add(item);
        CalculateTotalAmount();
    }
    
    public void RemoveItem(int orderItemId)
    {
        var item = OrderItems.FirstOrDefault(x => x.Id == orderItemId);
        if (item != null)
        {
            OrderItems.Remove(item);
            CalculateTotalAmount();
        }
    }
    
    public void UpdateStatus(OrderStatus newStatus)
    {
        if (!IsValidStatusTransition(Status, newStatus))
        {
            throw new InvalidOperationException($"Cannot transition from {Status} to {newStatus}");
        }
        Status = newStatus;
    }
    
    private static bool IsValidStatusTransition(OrderStatus current, OrderStatus next)
    {
        return (current, next) switch
        {
            (OrderStatus.Pending, OrderStatus.Processing) => true,
            (OrderStatus.Pending, OrderStatus.Cancelled) => true,
            (OrderStatus.Processing, OrderStatus.Shipped) => true,
            (OrderStatus.Processing, OrderStatus.Cancelled) => true,
            (OrderStatus.Shipped, OrderStatus.Delivered) => true,
            _ => false
        };
    }
}

public enum OrderStatus
{
    Pending = 0,
    Processing = 1,
    Shipped = 2,
    Delivered = 3,
    Cancelled = 4
}
