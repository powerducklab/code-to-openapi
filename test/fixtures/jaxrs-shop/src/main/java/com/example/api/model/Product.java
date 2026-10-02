package com.example.api.model;

import java.math.BigDecimal;
import java.util.List;

public record Product(long id, String name, BigDecimal price, List<String> tags) {}
