using Microsoft.AspNetCore.Http.HttpResults;

public record CreateTodoItemCommand(string Title);
public record UpdateTodoItemCommand(int Id, string Title);

// IEndpointGroup convention: class name becomes /api/{ClassName} prefix.
public class TodoItems
{
    public static void Map(RouteGroupBuilder groupBuilder)
    {
        groupBuilder.MapPost(CreateTodoItem);
        groupBuilder.MapPut(UpdateTodoItem, "{id}");
        groupBuilder.MapDelete(DeleteTodoItem, "{id}");
    }

    public static async Task<Created<int>> CreateTodoItem(CreateTodoItemCommand command)
        => Results.Created($"/api/TodoItems/{command.Title}", 1);

    public static async Task<Results<NoContent, BadRequest>> UpdateTodoItem(
        int id, UpdateTodoItemCommand command)
        => Results.NoContent();

    public static async Task<NoContent> DeleteTodoItem(int id)
        => Results.NoContent();
}
