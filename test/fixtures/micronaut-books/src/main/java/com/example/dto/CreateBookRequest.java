package com.example.dto;

import io.micronaut.core.annotation.Nullable;

public record CreateBookRequest(String title, @Nullable String author) {}
