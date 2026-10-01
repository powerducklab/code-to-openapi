package com.acme.shop;

import org.springframework.core.io.Resource;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import reactor.core.publisher.Flux;

import java.util.List;

@RestController
@RequestMapping("/api/shops")
public class ShopController {

    @GetMapping
    public List<Shop> list(
            @RequestParam(name = "q", required = false) String query,
            @RequestParam(defaultValue = "20") int limit,
            @RequestParam ShopSort sort,
            @RequestHeader(value = "X-Trace", required = false) String trace,
            @CookieValue(value = "session", required = false) String session) {
        return List.of();
    }

    @PostMapping
    @ResponseStatus(org.springframework.http.HttpStatus.CREATED)
    public Shop create(@RequestBody ShopInput input) {
        return new Shop("1", input.name(), List.of(), true);
    }

    @GetMapping("/{id:[0-9]+}")
    public Shop get(@PathVariable("id") Long id) {
        return new Shop(String.valueOf(id), "demo", List.of(), true);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {}

    @PostMapping(value = "/{id}/logo", consumes = "multipart/form-data")
    @ResponseStatus(org.springframework.http.HttpStatus.ACCEPTED)
    public void uploadLogo(@PathVariable String id, @RequestPart("file") MultipartFile file) {}

    @GetMapping(value = "/events", produces = "text/event-stream")
    public Flux<ServerSentEvent<Shop>> events() {
        return Flux.empty();
    }

    @GetMapping("/{id}/logo")
    public Resource downloadLogo(@PathVariable String id) {
        return null;
    }
}
