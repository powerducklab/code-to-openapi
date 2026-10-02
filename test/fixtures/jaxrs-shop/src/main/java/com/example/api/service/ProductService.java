package com.example.api.service;

import java.math.BigDecimal;
import java.util.List;

import com.example.api.dto.CreateProductRequest;
import com.example.api.model.Product;
import com.example.api.model.ProductEvent;

import io.smallrye.mutiny.Multi;

public class ProductService {
    public List<Product> search(String q, int page) {
        return List.of();
    }

    public Product find(long id) {
        return null;
    }

    public Product create(CreateProductRequest req) {
        return null;
    }

    public Product update(long id, CreateProductRequest req) {
        return null;
    }

    public void delete(long id) {
    }

    public Product patch(long id, CreateProductRequest req) {
        return null;
    }

    public List<Product> filter(String category, BigDecimal minPrice) {
        return List.of();
    }

    public Multi<ProductEvent> events() {
        return Multi.createFrom().empty();
    }
}
