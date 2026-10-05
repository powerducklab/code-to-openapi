using Microsoft.AspNetCore.Mvc;
using WidgetApi.Models;

namespace WidgetApi.Controllers;

[ApiController]
[Route("api/[controller]")]
public class WidgetsController : ControllerBase
{
    private static readonly List<Widget> _db = new()
    {
        new Widget { Id = 1, Name = "alpha", Secret = "hidden" },
    };

    private static WidgetDto ToDto(Widget w) => new() { Id = w.Id, Name = w.Name };

    [HttpGet]
    public async Task<ActionResult<IEnumerable<WidgetDto>>> GetAll()
    {
        await Task.Yield();
        return Ok(_db.Select(ToDto).ToList());
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<WidgetDto>> GetOne(long id)
    {
        await Task.Yield();
        var widget = _db.FirstOrDefault(w => w.Id == id);
        if (widget is null)
        {
            return NotFound();
        }
        return Ok(ToDto(widget));
    }

    [HttpPost]
    public async Task<ActionResult<WidgetDto>> Create([FromBody] WidgetDto dto)
    {
        await Task.Yield();
        var widget = new Widget { Id = _db.Count + 1, Name = dto.Name };
        _db.Add(widget);
        return CreatedAtAction(nameof(GetOne), new { id = widget.Id }, ToDto(widget));
    }

    [HttpPut("{id}")]
    public IActionResult Update(long id, WidgetDto dto)
    {
        if (id != dto.Id)
        {
            return BadRequest();
        }
        var widget = _db.FirstOrDefault(w => w.Id == id);
        if (widget is null)
        {
            return NotFound();
        }
        widget.Name = dto.Name;
        return NoContent();
    }

    [HttpDelete("{id}")]
    public IActionResult Delete(long id)
    {
        var widget = _db.FirstOrDefault(w => w.Id == id);
        if (widget is null)
        {
            return NotFound();
        }
        _db.Remove(widget);
        return NoContent();
    }
}
