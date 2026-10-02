package com.acme.enter;

/** Security principal injected by Spring Security; never an HTTP input. */
public class User {
  private String id;
  private String email;
  private String username;

  public String getId() { return id; }
  public String getEmail() { return email; }
  public String getUsername() { return username; }
}
