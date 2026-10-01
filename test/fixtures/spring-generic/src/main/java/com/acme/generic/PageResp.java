package com.acme.generic;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;

@JsonNaming(value = PropertyNamingStrategies.SnakeCaseStrategy.class)
public class PageResp<T> extends CommonDataResp<T> {

    @JsonProperty("per_page")
    private Integer pageSize;

    @JsonProperty("page")
    private Integer pageNum;

    private final Integer total;

    public PageResp(T list, Integer pageSize, Integer pageNum, Integer total) {
        super(list);
        this.pageSize = pageSize;
        this.pageNum = pageNum;
        this.total = total;
    }
}
