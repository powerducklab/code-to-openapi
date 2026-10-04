package main
import("encoding/json";"fmt")
func main(){var u user;if err:=json.Unmarshal([]byte(`{}`),&u);err!=nil{panic(err)};output,err:=json.Marshal(u);if err!=nil{panic(err)};if string(output)!=`{"id":0,"name":"","age":0}`{panic(string(output))};fmt.Println(string(output))}
