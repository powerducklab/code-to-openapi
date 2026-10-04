package main
import (
 "encoding/json"
 "fmt"
 "net/http/httptest"
 "os"
 "strings"
 "github.com/labstack/echo/v4"
)
type Item struct {Name string `json:"name" validate:"required,min=2"`; Count int `json:"count"`}
func main(){
 e:=echo.New();e.HideBanner=true
 e.POST("/items",func(c echo.Context)error{var item Item;if err:=c.Bind(&item);err!=nil{return err};return c.JSON(200,item)})
 results:=[]map[string]interface{}{}
 for _,body:=range []string{"{}",`{"name":"x"}`,`{"name":null}`,`{"name":"ok"}`} {
  req:=httptest.NewRequest("POST","/items",strings.NewReader(body));req.Header.Set("Content-Type","application/json")
  res:=httptest.NewRecorder();e.ServeHTTP(res,req)
  if res.Code!=200{panic(fmt.Sprintf("%s: %d",body,res.Code))}
  var actual map[string]interface{};if err:=json.Unmarshal(res.Body.Bytes(),&actual);err!=nil{panic(err)}
  if actual["count"]!=float64(0){panic("missing zero-valued output")}
  results=append(results,map[string]interface{}{"input":body,"status":res.Code,"body":actual})
 }
 if err:=json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"framework":"Echo 4.1.16","passed":len(results),"probes":results});err!=nil{panic(err)}
}
