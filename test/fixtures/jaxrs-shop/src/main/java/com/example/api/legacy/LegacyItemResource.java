package com.example.api.legacy;

import javax.ws.rs.GET;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;
import javax.ws.rs.Produces;
import javax.ws.rs.QueryParam;
import javax.ws.rs.core.MediaType;

/**
 * Legacy javax.ws.rs (Dropwizard 1.x style) resource. The shared "jaxrs" pack
 * must recognise both jakarta.ws.rs and javax.ws.rs through the same code path.
 */
@Path("/legacy/items")
@Produces(MediaType.APPLICATION_JSON)
public class LegacyItemResource {

    @GET
    @Path("/{itemId}")
    public LegacyItem get(@PathParam("itemId") String itemId,
                          @QueryParam("detail") boolean detail) {
        return new LegacyItem(itemId, detail);
    }
}
