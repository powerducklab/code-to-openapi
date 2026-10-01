package com.example.api.dto;

import jakarta.validation.constraints.NotBlank;
import java.util.List;

public record CreateUserRequest(
    @NotBlank String name,
    Integer age,
    List<String> tags
) {}
