using Demo.Models;
using Microsoft.AspNetCore.Mvc;

namespace Demo.Controllers;

[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    [HttpGet]
    public ActionResult<List<User>> List()
    {
        return Ok(new List<User>());
    }

    [HttpGet("search")]
    public ActionResult<List<User>> Search(
        [FromQuery(Name = "q")] string q,
        [FromQuery] int? page,
        [FromHeader(Name = "X-Trace")] string? trace)
    {
        return Ok(new List<User>());
    }

    [HttpGet("{id:guid}")]
    public ActionResult<User> GetById([FromRoute(Name = "id")] string id)
    {
        return Ok(new User());
    }

    [HttpPost]
    [ProducesResponseType(typeof(User), StatusCodes.Status201Created)]
    public IActionResult Create([FromBody] CreateUserRequest body)
    {
        return CreatedAtAction(nameof(GetById), new User());
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public IActionResult Delete(string id)
    {
        return NoContent();
    }

    [HttpGet("events")]
    [Produces("text/event-stream", Type = typeof(UserEvent))]
    public ActionResult<IAsyncEnumerable<UserEvent>> Events()
    {
        return Ok();
    }
}
