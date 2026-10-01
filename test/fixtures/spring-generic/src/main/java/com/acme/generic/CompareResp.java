package com.acme.generic;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;

import java.util.List;

@JsonNaming(value = PropertyNamingStrategies.SnakeCaseStrategy.class)
public class CompareResp {

    private VersionResp changeHistory;

    private VersionResp standardHistory;

    private List<CompareApiResp> add;

    @JsonIgnore
    private String internalNote;

    public VersionResp getChangeHistory() {
        return changeHistory;
    }

    public VersionResp getStandardHistory() {
        return standardHistory;
    }

    public List<CompareApiResp> getAdd() {
        return add;
    }

    public String getInternalNote() {
        return internalNote;
    }
}
