package com.example.api.model;

import java.util.List;

public class User {
  private String id;
  private String name;
  private List<String> roles;

  public User(String id, String name) {
    this.id = id;
    this.name = name;
  }

  public String getId() {
    return id;
  }

  public String getName() {
    return name;
  }

  public List<String> getRoles() {
    return roles;
  }
}
