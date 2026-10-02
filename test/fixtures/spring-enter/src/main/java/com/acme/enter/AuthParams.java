package com.acme.enter;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Request body DTO exercising Bean Validation -> JSON Schema mapping. */
public class AuthParams {
  @NotBlank
  @Email
  private String email;

  @NotBlank
  @Size(min = 8, max = 72)
  private String password;

  public String getEmail() { return email; }
  public String getPassword() { return password; }
}
