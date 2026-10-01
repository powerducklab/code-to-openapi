package com.acme.rw.ws.api;

import com.acme.rw.model.FooResp;
import com.acme.rw.ws.result.CommonResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/ws")
public class WsController {

    @GetMapping("/foo")
    public CommonResult<FooResp> wsFoo() {
        return null;
    }
}
