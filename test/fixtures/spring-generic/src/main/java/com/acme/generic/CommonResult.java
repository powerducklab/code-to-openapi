package com.acme.generic;

public class CommonResult<T> extends BaseResult {

    private T data;

    public T getData() {
        return data;
    }

    public void setData(T data) {
        this.data = data;
    }

    public static <T> CommonResult<T> buildData(T data) {
        CommonResult<T> result = new CommonResult<>();
        result.setData(data);
        return result;
    }
}
