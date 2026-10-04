package main

import (
 "bytes"
 "encoding/json"
 "fmt"
 "mime/multipart"
 "net/http/httptest"
 "os"
 "strings"
 "github.com/gin-gonic/gin"
)

type Item struct {Name string `json:"name" binding:"required,min=2"`; Count int `json:"count"`}

func main() {
 gin.SetMode(gin.ReleaseMode)
 r:=gin.New()
 r.POST("/form",func(c *gin.Context){c.JSON(200,gin.H{"q":c.PostForm("q"),"page":c.DefaultPostForm("page","1")})})
 r.POST("/items",func(c *gin.Context){var item Item;if err:=c.ShouldBindJSON(&item);err!=nil{c.Status(400);return};c.JSON(200,item)})
 results:=[]map[string]interface{}{}
 probe:=func(name,contentType,body,expected string){
  request:=httptest.NewRequest("POST","/form?q=query-only&page=99",strings.NewReader(body));request.Header.Set("Content-Type",contentType)
  w:=httptest.NewRecorder();r.ServeHTTP(w,request)
  var actual map[string]interface{};if err:=json.Unmarshal(w.Body.Bytes(),&actual);err!=nil{panic(err)}
  if actual["q"]!=expected||actual["page"]!="1"{panic(fmt.Sprintf("%s: %s",name,w.Body.String()))}
  results=append(results,map[string]interface{}{"name":name,"status":w.Code,"body":actual})
 }
 probe("URL query is not PostForm","application/x-www-form-urlencoded","","")
 probe("urlencoded body","application/x-www-form-urlencoded","q=body-value","body-value")
 var b bytes.Buffer;writer:=multipart.NewWriter(&b);if err:=writer.WriteField("q","multipart-value");err!=nil{panic(err)};if err:=writer.Close();err!=nil{panic(err)}
 probe("multipart body",writer.FormDataContentType(),b.String(),"multipart-value")
 for _,test:=range []struct{body string;status int}{{"{}",400},{`{"name":"x"}`,400},{`{"name":"ok"}`,200},{`{"name":null}`,400}} {
  request:=httptest.NewRequest("POST","/items",strings.NewReader(test.body));request.Header.Set("Content-Type","application/json")
  w:=httptest.NewRecorder();r.ServeHTTP(w,request);if w.Code!=test.status{panic(fmt.Sprintf("binding %s: %d",test.body,w.Code))}
  results=append(results,map[string]interface{}{"name":"binding input "+test.body,"status":w.Code,"body":w.Body.String()})
 }
 if err:=json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"framework":"Gin 1.4.0","passed":len(results),"probes":results});err!=nil{panic(err)}
}
