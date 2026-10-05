namespace WidgetApi.Models;

public class Widget
{
    public long Id { get; set; }
    public string? Name { get; set; }
    public string? Secret { get; set; }
}

public class WidgetDto
{
    public long Id { get; set; }
    public string? Name { get; set; }
}

public class Forecast
{
    public DateOnly Date { get; set; }
    public int TemperatureC { get; set; }
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
    public string? Summary { get; set; }
}
