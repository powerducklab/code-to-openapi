package com.acme.xsvc;

import com.acme.xsvc.dto.PageResult;
import com.acme.xsvc.dto.UserVo;
import org.springframework.stereotype.Service;

@Service
public class UserServiceImpl implements UserService {
  public UserVo findById(Long id) {
    return new UserVo();
  }

  public PageResult<UserVo> pageUsers() {
    return new PageResult<>();
  }
}
