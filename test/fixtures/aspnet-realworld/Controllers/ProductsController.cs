using Demo.Models;
using Microsoft.AspNetCore.Mvc;

namespace Demo.Controllers;

[ApiController]
[Route("api/products")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<PagedResult<ProductDto>>), StatusCodes.Status200OK)]
    public Task<ActionResult<ApiResponse<PagedResult<ProductDto>>>> List([FromQuery] ListProductsQuery query)
    {
        throw new NotImplementedException();
    }

    [HttpGet("{id:guid}")]
    [ProducesResponseType(typeof(ApiResponse<ProductDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public Task<ActionResult<ApiResponse<ProductDto>>> GetById([FromRoute] Guid id)
    {
        throw new NotImplementedException();
    }

    [HttpPost]
    [ProducesResponseType(typeof(ApiResponse<ProductDto>), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public IActionResult Create([FromBody] CreateProductRequest request)
    {
        return CreatedAtAction(nameof(GetById), new { id = Guid.NewGuid() }, null);
    }

    [HttpPut("{id:guid}")]
    [ProducesResponseType(typeof(ApiResponse<ProductDto>), StatusCodes.Status200OK)]
    public ActionResult<ApiResponse<ProductDto>> Update(
        [FromRoute] Guid id,
        [FromBody] CreateProductRequest request)
    {
        throw new NotImplementedException();
    }

    [HttpDelete("{id:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public IActionResult Delete([FromRoute] Guid id) => NoContent();
}
