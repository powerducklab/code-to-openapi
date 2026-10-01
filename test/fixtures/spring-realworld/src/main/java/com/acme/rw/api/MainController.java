package com.acme.rw.api;

import com.acme.rw.env.ProjectEnvReq;
import com.acme.rw.env.ProjectEnvResp;
import com.acme.rw.model.AccountView;
import com.acme.rw.model.BarResp;
import com.acme.rw.model.DynamicResp;
import com.acme.rw.model.FooResp;
import com.acme.rw.model.WidgetRecord;
import com.acme.rw.result.CommonResult;
import org.springframework.data.domain.Page;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.concurrent.CompletableFuture;

@RestController
@RequestMapping("/api")
public class MainController {

    @GetMapping("/envs")
    public CommonResult<List<ProjectEnvResp>> envs(@Validated(GetGroup.class) ProjectEnvReq req) {
        return null;
    }

    @GetMapping("/foos/wild")
    public CommonResult<List<? extends FooResp>> wildcardFoos() {
        return null;
    }

    @GetMapping("/foos/page")
    public CommonResult<Page<FooResp>> pagedFoos() {
        return null;
    }

    @GetMapping("/foos/async")
    public CompletableFuture<CommonResult<FooResp>> asyncFoo() {
        return null;
    }

    @GetMapping("/bars/{id}")
    public ResponseEntity<BarResp> bar(@PathVariable Long id) {
        return null;
    }

    @GetMapping("/accounts/{id}")
    public CommonResult<AccountView> account(@PathVariable Long id) {
        return null;
    }

    @PostMapping("/widgets")
    public CommonResult<WidgetRecord> createWidget(@RequestBody WidgetRecord record) {
        return null;
    }

    @GetMapping("/dynamic")
    public CommonResult<DynamicResp> dynamic() {
        return null;
    }

    public interface GetGroup {}
}
