package com.example.api;

import com.example.api.model.User;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class UserService {

  // Not a controller method: must never become a route.
  public User getUser(String id) {
    return new User(id, "Ada Lovelace");
  }

  public List<User> list() {
    return List.of();
  }
}
