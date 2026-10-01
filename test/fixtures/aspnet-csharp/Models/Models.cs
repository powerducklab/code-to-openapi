namespace Demo.Models;

public class User
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public List<string> Roles { get; set; } = new();
}

public record CreateUserRequest(string Name, int? Age, string[] Tags);

public record UserEvent(string Type, User Data);

public record HealthStatus(string Status);

public record CreateProduct(string Sku, decimal Price);
