package com.acme.rw.model;

/** Interface-backed DTO: properties are exposed only through getters. */
public interface AccountView {
    Long getAccountId();

    String getDisplayName();

    boolean isActive();
}
