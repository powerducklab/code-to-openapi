using Microsoft.AspNetCore.Mvc;
using WidgetApi.Models;

namespace WidgetApi.Controllers;

[ApiController]
[Route("[controller]")]
public class WeatherController : ControllerBase
{
    // Name sets the route name for link generation; it must not extend the path.
    [HttpGet(Name = "GetWeather")]
    public IEnumerable<Forecast> Get()
    {
        return new List<Forecast>
        {
            new() { Date = DateOnly.FromDateTime(DateTime.Today), TemperatureC = 5, Summary = "Mild" },
        };
    }
}
