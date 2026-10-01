package com.acme.generic;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;

@JsonNaming(value = PropertyNamingStrategies.SnakeCaseStrategy.class)
public class VersionResp {

    private String versionId;

    private Long createdAt;

    public String getVersionId() {
        return versionId;
    }

    public Long getCreatedAt() {
        return createdAt;
    }
}
