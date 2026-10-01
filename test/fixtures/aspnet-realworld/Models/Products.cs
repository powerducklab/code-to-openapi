using System.ComponentModel.DataAnnotations;

namespace Demo.Models;

public record ApiResponse<T>(bool Success, T? Data, string? Error);

public record PagedResult<T>(IReadOnlyList<T> Items, int Page, int PageSize, int Total);

public enum ProductStatus
{
    Draft = 0,
    Published = 1,
    Archived = 2
}

public record CategoryDto(Guid Id, string Name, string? Slug);

public record ProductDto(
    Guid Id,
    string Name,
    string? Description,
    decimal Price,
    string[] Tags,
    ProductStatus Status,
    CategoryDto? Category,
    DateTimeOffset CreatedAt);

public record CreateProductRequest
{
    [Required]
    [StringLength(120, MinimumLength = 1)]
    public string Name { get; init; } = string.Empty;

    public string? Description { get; init; }

    [Required]
    [Range(0.01, 100000)]
    public decimal Price { get; init; }

    public string[] Tags { get; init; } = Array.Empty<string>();

    public Guid? CategoryId { get; init; }
}

public record ListProductsQuery
{
    public int Page { get; init; } = 1;
    public int PageSize { get; init; } = 20;
    public ProductStatus? Status { get; init; }
    public string? Search { get; init; }
}
