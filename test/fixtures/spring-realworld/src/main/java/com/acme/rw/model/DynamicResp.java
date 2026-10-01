package com.acme.rw.model;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;

public class DynamicResp {
    private Object info;
    private JSONObject config;
    private JSONArray headers;
    private JsonNode settings;
    private ArrayNode tags;
}
