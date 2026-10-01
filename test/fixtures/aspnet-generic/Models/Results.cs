using Demo.Models;

namespace Demo.Models;

public enum ProductCategory
{
    Electronics,
    Books,
    Tools
}

public class ProductDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public decimal Price { get; set; }
    public ProductCategory? Category { get; set; }
    public List<string> Tags { get; set; } = new();
}

public class Result<T>
{
    public int Code { get; set; }
    public string Message { get; set; } = string.Empty;
    public T? Data { get; set; }
}

public class PagedResult<T> : Result<List<T>>
{
    public int Page { get; set; }
    public int PerPage { get; set; }
    public long Total { get; set; }
}
