package com.acme.xsvc.dto;

import java.util.List;

public class PageResult<T> {
  public List<T> list;
  public long total;
}
