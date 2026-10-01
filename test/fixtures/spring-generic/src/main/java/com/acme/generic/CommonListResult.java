package com.acme.generic;

public class CommonListResult<T> {

    private T list;

    public CommonListResult(T list) {
        this.list = list;
    }

    public T getList() {
        return list;
    }
}
