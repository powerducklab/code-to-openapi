package com.example;

import java.net.URI;
import java.util.List;

import com.example.dto.CreateBookRequest;
import com.example.model.Book;
import com.example.service.BookService;

import io.micronaut.http.HttpResponse;
import io.micronaut.http.annotation.Body;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Delete;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.Header;
import io.micronaut.http.annotation.PathVariable;
import io.micronaut.http.annotation.Post;
import io.micronaut.http.annotation.Put;
import io.micronaut.http.annotation.QueryValue;

@Controller("/api/books")
public class BookController {

    private final BookService service;

    public BookController(BookService service) {
        this.service = service;
    }

    @Get
    public List<Book> list(
        @QueryValue("q") String q,
        @QueryValue("page") int page
    ) {
        return service.list(q, page);
    }

    @Get("/{id}")
    public HttpResponse<Book> get(
        @PathVariable("id") long id,
        @Header("X-Trace") String trace
    ) {
        Book book = service.find(id);
        if (book == null) {
            return HttpResponse.notFound();
        }
        return HttpResponse.ok(book);
    }

    @Post
    public HttpResponse<Book> create(@Body CreateBookRequest req) {
        Book book = service.create(req);
        URI location = URI.create("/api/books/" + book.id());
        return HttpResponse.created(location).body(book);
    }

    @Put("/{id}")
    public Book update(@PathVariable("id") long id, @Body CreateBookRequest req) {
        return service.update(id, req);
    }

    @Delete("/{id}")
    public HttpResponse<?> delete(@PathVariable("id") long id) {
        service.delete(id);
        return HttpResponse.noContent();
    }
}
