package com.example.api;

import java.math.BigDecimal;
import java.util.List;

import com.example.api.dto.CreateProductRequest;
import com.example.api.dto.ProductFilter;
import com.example.api.model.Product;
import com.example.api.model.ProductEvent;
import com.example.api.service.ProductService;

import io.smallrye.mutiny.Multi;
import jakarta.ws.rs.BeanParam;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.DELETE;
import jakarta.ws.rs.DefaultValue;
import jakarta.ws.rs.FormParam;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.HEAD;
import jakarta.ws.rs.HeaderParam;
import jakarta.ws.rs.OPTIONS;
import jakarta.ws.rs.PATCH;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.PUT;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

@Path("/products")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class ProductResource {

    private final ProductService service;

    public ProductResource(ProductService service) {
        this.service = service;
    }

    @GET
    public List<Product> list(
        @QueryParam("q") String q,
        @QueryParam("page") @DefaultValue("0") int page
    ) {
        return service.search(q, page);
    }

    @GET
    @Path("/{id}")
    public Response get(
        @PathParam("id") long id,
        @HeaderParam("X-Trace") String trace
    ) {
        Product product = service.find(id);
        if (product == null) {
            return Response.status(Response.Status.NOT_FOUND).build();
        }
        return Response.ok(product).build();
    }

    @POST
    public Response create(CreateProductRequest req) {
        Product product = service.create(req);
        return Response.status(Response.Status.CREATED).entity(product).build();
    }

    @PUT
    @Path("/{id}")
    public Product update(@PathParam("id") long id, CreateProductRequest req) {
        return service.update(id, req);
    }

    @DELETE
    @Path("/{id}")
    public Response delete(@PathParam("id") long id) {
        service.delete(id);
        return Response.noContent().build();
    }

    @PATCH
    @Path("/{id}")
    public Product patch(@PathParam("id") long id, CreateProductRequest req) {
        return service.patch(id, req);
    }

    @HEAD
    public Response head() {
        return Response.ok().build();
    }

    @OPTIONS
    public Response options() {
        return Response.ok().build();
    }

    @POST
    @Path("/search")
    @Consumes(MediaType.APPLICATION_FORM_URLENCODED)
    public Response formSearch(
        @FormParam("term") String term,
        @FormParam("limit") @DefaultValue("10") int limit
    ) {
        return Response.ok(service.search(term, limit)).build();
    }

    @GET
    @Path("/filter")
    public List<Product> filter(@BeanParam ProductFilter filter) {
        return service.filter(filter.category, filter.minPrice);
    }

    @GET
    @Path("/events")
    @Produces(MediaType.SERVER_SENT_EVENTS)
    public Multi<ProductEvent> events() {
        return service.events();
    }
}
