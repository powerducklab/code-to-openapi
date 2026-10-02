package com.example.api.dto;

import java.math.BigDecimal;

import jakarta.ws.rs.QueryParam;

/**
 * A bean-param carrier: its own fields carry the JAX-RS binding annotations,
 * which the @BeanParam parameter unfolds into individual query parameters.
 */
public class ProductFilter {
    @QueryParam("category")
    public String category;

    @QueryParam("minPrice")
    public BigDecimal minPrice;
}
