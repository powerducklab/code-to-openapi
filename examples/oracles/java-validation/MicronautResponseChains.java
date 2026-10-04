import io.micronaut.http.HttpResponse;
import io.micronaut.http.HttpStatus;
import java.net.URI;
public class MicronautResponseChains {
  public static void main(String[] args) {
    var changed = HttpResponse.ok("first").status(HttpStatus.CREATED).body("last");
    if (changed.code() != 201 || !changed.body().equals("last")) throw new AssertionError("chain order");
    var createdBody = HttpResponse.created("payload");
    if (createdBody.code() != 201 || !createdBody.body().equals("payload")) throw new AssertionError("created body");
    var createdLocation = HttpResponse.created(URI.create("/items/1"));
    if (createdLocation.code() != 201 || createdLocation.getBody().isPresent()) throw new AssertionError("created location");
    System.out.println("{\"probes\":[{\"chain\":\"ok-status-body\",\"status\":201,\"body\":\"last\"},{\"chain\":\"created-string\",\"status\":201,\"body\":\"payload\"},{\"chain\":\"created-uri\",\"status\":201,\"bodyPresent\":false}]}");
  }
}
