package com.acme.rw.env;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.util.LinkedHashMap;
import java.util.List;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class ProjectEnvResp {
    private Long envId;
    private String name;
    @JsonProperty("env_type")
    private Integer type;
    @JsonProperty("server_list")
    private List<EnvServerResp> servers;
    @JsonProperty("env_var_list")
    private LinkedHashMap<String, EnvParamResp> params;
}
