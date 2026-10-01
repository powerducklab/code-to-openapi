package com.acme.generic;

import java.time.ZonedDateTime;

public class BaseResult {

    private int code;

    private String msg;

    private ZonedDateTime time;

    public int getCode() {
        return code;
    }

    public String getMsg() {
        return msg;
    }

    public ZonedDateTime getTime() {
        return time;
    }
}
