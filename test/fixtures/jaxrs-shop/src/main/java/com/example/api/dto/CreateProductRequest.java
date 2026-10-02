package com.example.api.dto;

import java.math.BigDecimal;
import java.util.List;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;

public record CreateProductRequest(
    @NotBlank String name,
    @Min(0) BigDecimal price,
    List<String> tags
) {}
