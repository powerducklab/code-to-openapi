package com.acme.rw.ws.result;

public class CommonResult<T> {
    private int code;
    private String message;
    private T data;
}
