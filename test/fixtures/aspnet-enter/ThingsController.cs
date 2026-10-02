using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Http;

public class ThingsController : BaseApiController
{
    [HttpGet]
    public IEnumerable<Thing> GetAll() => Array.Empty<Thing>();

    [HttpGet("{id}")]
    public Thing Get(int id) => new();

    [HttpPost]
    public IActionResult Create([FromBody] ThingCommand command) => Ok();

    [HttpGet]
    public FileResult Download() => new FileStreamResult(Stream.Null, "application/octet-stream");
}

public class Thing
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public class ThingCommand
{
    public string Name { get; set; } = "";
}
