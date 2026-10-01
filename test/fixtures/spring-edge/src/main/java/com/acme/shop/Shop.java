package com.acme.shop;

import java.util.List;

public record Shop(
    String id,
    String name,
    List<String> tags,
    boolean active
) {}
