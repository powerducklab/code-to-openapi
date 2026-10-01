using Demo.Models;
using Microsoft.AspNetCore.Mvc;

namespace Demo.Controllers;

[ApiController]
[Route("api/products")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public ActionResult<PagedResult<ProductDto>> List([FromQuery] int page = 1)
    {
        return Ok(new PagedResult<ProductDto>());
    }

    [HttpGet("{id:guid}")]
    public ActionResult<Result<ProductDto>> GetById([FromRoute] string id)
    {
        return Ok(new Result<ProductDto>());
    }
}
