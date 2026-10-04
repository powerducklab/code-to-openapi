using Microsoft.AspNetCore.Mvc;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();
app.MapControllers();
app.Run("http://127.0.0.1:18769");
[ApiController][Route("uploads")]
public class UploadsController : ControllerBase {
 [HttpPost] public object Upload([FromForm(Name="avatar")] IFormFile photo, IFormFile? preview, IFormFileCollection attachments) => new {photo=photo.Name,preview=preview?.Name,attachments=attachments.Select(f=>f.Name).ToArray()};
 [HttpPost("optional")] public object Optional(IFormFile? photo) => new {present=photo is not null};
}
