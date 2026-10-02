package com.example.service;

import java.util.List;

import com.example.dto.CreateBookRequest;
import com.example.model.Book;

import jakarta.inject.Singleton;

@Singleton
public class BookService {
    public List<Book> list(String q, int page) {
        return List.of();
    }

    public Book find(long id) {
        return null;
    }

    public Book create(CreateBookRequest req) {
        return null;
    }

    public Book update(long id, CreateBookRequest req) {
        return null;
    }

    public void delete(long id) {
    }
}
