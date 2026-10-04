package main
import("encoding/json";"fmt")
type Book struct {Title string `json:"title"`; Author string `json:"author"`; Publisher string `json:"publisher"`}
func main(){var input Book;if err:=json.Unmarshal([]byte(`{}`),&input);err!=nil{panic(err)};output,err:=json.Marshal(input);if err!=nil{panic(err)};fmt.Println(string(output));if string(output)!=`{"title":"","author":"","publisher":""}`{panic("unexpected encoding/json behavior")}}
