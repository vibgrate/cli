namespace CleanArchitecture.Domain.Entities;

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public string? Phone { get; set; }
    public Address Address { get; set; } = new();
    
    // Navigation properties
    public ICollection<Order> Orders { get; set; } = new List<Order>();
    
    public int TotalOrderCount => Orders.Count;
    public decimal TotalSpent => Orders.Where(o => o.Status == OrderStatus.Delivered).Sum(o => o.TotalAmount);
    
    public void UpdateContactInfo(string email, string? phone)
    {
        if (string.IsNullOrWhiteSpace(email))
        {
            throw new ArgumentException("Email cannot be empty", nameof(email));
        }
        
        if (!IsValidEmail(email))
        {
            throw new ArgumentException("Invalid email format", nameof(email));
        }
        
        Email = email;
        Phone = phone;
    }
    
    public void UpdateAddress(Address newAddress)
    {
        Address = newAddress ?? throw new ArgumentNullException(nameof(newAddress));
    }
    
    public Order CreateOrder()
    {
        var order = new Order
        {
            CustomerId = Id,
            OrderDate = DateTime.UtcNow,
            Status = OrderStatus.Pending,
            Customer = this
        };
        Orders.Add(order);
        return order;
    }
    
    public IEnumerable<Order> GetActiveOrders()
    {
        return Orders.Where(o => o.Status != OrderStatus.Delivered && o.Status != OrderStatus.Cancelled);
    }
    
    private static bool IsValidEmail(string email)
    {
        try
        {
            var addr = new System.Net.Mail.MailAddress(email);
            return addr.Address == email;
        }
        catch
        {
            return false;
        }
    }
}

public class Address
{
    public string Street { get; set; } = string.Empty;
    public string City { get; set; } = string.Empty;
    public string State { get; set; } = string.Empty;
    public string PostalCode { get; set; } = string.Empty;
    public string Country { get; set; } = string.Empty;
    
    public string FullAddress => $"{Street}, {City}, {State} {PostalCode}, {Country}";
    
    public bool IsComplete()
    {
        return !string.IsNullOrWhiteSpace(Street) &&
               !string.IsNullOrWhiteSpace(City) &&
               !string.IsNullOrWhiteSpace(State) &&
               !string.IsNullOrWhiteSpace(PostalCode) &&
               !string.IsNullOrWhiteSpace(Country);
    }
}
