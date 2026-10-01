package com.acme.generic;

import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/generic")
public class GenericController {

    @GetMapping("/compare")
    public CommonResult<CompareResp> compare() {
        return CommonResult.buildData(new CompareResp());
    }

    @GetMapping("/page")
    public CommonResult<PageResp<List<FooPO>>> page() {
        return CommonResult.buildData(new PageResp<>(List.of(), 0, 1, 0));
    }

    @GetMapping("/list")
    public CommonResult<List<FooPO>> list() {
        return CommonResult.buildData(List.of());
    }

    @PostMapping("/details")
    public CommonResult<CommonListResult<List<FooPO>>> details() {
        return CommonResult.buildData(new CommonListResult<>(List.of()));
    }

    @PostMapping("/ping")
    public BaseResult ping() {
        return new BaseResult();
    }

    @GetMapping("/events")
    public CommonResult<List<EventResp>> events() {
        return CommonResult.buildData(List.of());
    }
}
