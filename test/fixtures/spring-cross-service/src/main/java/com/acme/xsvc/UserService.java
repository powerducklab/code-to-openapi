package com.acme.xsvc;

import com.acme.xsvc.dto.PageResult;
import com.acme.xsvc.dto.UserVo;

public interface UserService {
  UserVo findById(Long id);

  PageResult<UserVo> pageUsers();
}
