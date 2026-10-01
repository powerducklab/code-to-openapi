package com.acme.generic;

public class CommonDataResp<T> {

    private T list;

    public CommonDataResp(T list) {
        this.list = list;
    }

    public T getList() {
        return list;
    }
}
