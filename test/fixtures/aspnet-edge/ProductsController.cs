using Microsoft.AspNetCore.Mvc;

namespace ShopEdge;

public record Product(string Sku, string Name, decimal Price, string[] Tags);

public record ProductInput(string Name, decimal Price);

public enum ProductSort { Newest, PriceAsc, PriceDesc }

[ApiController]
[Route("api/[controller]")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(Product[]), 200)]
    public IActionResult List(
        [FromQuery] string? q,
        [FromQuery] ProductSort sort = ProductSort.Newest,
        [FromHeader(Name = "X-Trace")] string? trace)
    {
        return Ok(Array.Empty<Product>());
    }

    [HttpPost]
    [ProducesResponseType(typeof(Product), 201)]
    [ProducesResponseType(400)]
    public IActionResult Create([FromBody] ProductInput input)
    {
        return CreatedAtAction(nameof(Get), new { sku = "p1" }, new Product("p1", input.Name, input.Price, Array.Empty<string>()));
    }

    [HttpGet("{sku:alpha}")]
    [ProducesResponseType(typeof(Product), 200)]
    [ProducesResponseType(404)]
    public IActionResult Get([FromRoute] string sku)
    {
        return Ok(new Product(sku, "demo", 1.5m, Array.Empty<string>()));
    }

    [HttpDelete("{sku}")]
    [ProducesResponseType(204)]
    public IActionResult Remove(string sku)
    {
        return NoContent();
    }

    [HttpPost("{sku}/logo")]
    [ProducesResponseType(202)]
    public async Task<IActionResult> UploadLogo(string sku, IFormFile file)
    {
        await Task.CompletedTask;
        return Accepted();
    }

    [HttpGet("{sku}/logo")]
    [Produces("application/octet-stream")]
    [ProducesResponseType(typeof(FileResult), 200)]
    public IActionResult DownloadLogo(string sku)
    {
        return File(Array.Empty<byte>(), "application/octet-stream", "logo.png");
    }

    [HttpGet("events")]
    [Produces("text/event-stream")]
    [ProducesResponseType(typeof(Product), 200)]
    public IActionResult Events()
    {
        return Ok();
    }
}
