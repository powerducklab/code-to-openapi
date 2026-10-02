public class CreateRequest
{
    public string Name { get; set; } = "";
}

public class CreateResponse
{
    public int Id { get; set; }
}

public class ItemResponse
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
}

// Verbs()+Routes() configuration style with a custom 201 send.
public class CreateEndpoint : Endpoint<CreateRequest, CreateResponse>
{
    public override void Configure()
    {
        Verbs(Http.POST);
        Routes("/api/creates");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CreateRequest req, CancellationToken ct)
    {
        await SendAsync(new CreateResponse { Id = 1 }, 201);
    }
}

// Get(x)/Post(x) expression-bodied configuration, EndpointWithoutRequest body.
public class ListEndpoint : EndpointWithoutRequest<ItemResponse>
{
    public override void Configure() => Get("/api/items/{id}");

    public override async Task HandleAsync(CancellationToken ct)
    {
        await SendOkAsync(new ItemResponse { Id = 42, Title = "a" });
    }
}

// NoContent response.
public class DeleteEndpoint : EndpointWithoutRequest
{
    public override void Configure() => Delete("/api/items/{id}");

    public override async Task HandleAsync(CancellationToken ct)
    {
        await SendNoContentAsync();
    }
}
