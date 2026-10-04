// Extract original type declarations using Go's parser, then marshal them in an
// isolated harness. This is a DTO serialization oracle, not a backend test.
package main
import("bytes";"crypto/sha256";"encoding/json";"fmt";"go/ast";"go/format";"go/parser";"go/token";"os";"os/exec";"path/filepath";"strings")
func main(){
 root:=os.Args[1]
 sources:=map[string][]string{"models/models.go":{"Model"},"models/tag.go":{"Tag"},"models/article.go":{"Article"},"pkg/app/response.go":{"Response"}}
 var declarations bytes.Buffer
 hashes:=map[string]string{}
 for path,names:=range sources{
  raw,err:=os.ReadFile(filepath.Join(root,path));if err!=nil{panic(err)}
  hashes[path]=fmt.Sprintf("%x",sha256.Sum256(raw))
  set:=token.NewFileSet();file,err:=parser.ParseFile(set,path,raw,0);if err!=nil{panic(err)}
  found:=map[string]bool{}
  for _,decl:=range file.Decls{
   general,ok:=decl.(*ast.GenDecl);if !ok||general.Tok!=token.TYPE{continue}
   for _,spec:=range general.Specs{definition,ok:=spec.(*ast.TypeSpec);if !ok{continue};for _,name:=range names{if definition.Name.Name==name{declarations.WriteString("type ");if err:=format.Node(&declarations,set,definition);err!=nil{panic(err)};declarations.WriteString("\n");found[name]=true}}}
  }
  for _,name:=range names{if !found[name]{panic("missing "+name)}}
 }
 // Refuse to omit any custom JSON/text serializer defined in these packages.
 for _,dir:=range []string{"models","pkg/app"}{
  files,err:=filepath.Glob(filepath.Join(root,dir,"*.go"));if err!=nil{panic(err)}
  for _,path:=range files{file,err:=parser.ParseFile(token.NewFileSet(),path,nil,0);if err!=nil{panic(err)};for _,decl:=range file.Decls{fn,ok:=decl.(*ast.FuncDecl);if ok&&fn.Recv!=nil&&(fn.Name.Name=="MarshalJSON"||fn.Name.Name=="MarshalText"){panic("custom serializer requires full package oracle: "+path)}}}
 }
 tmp,err:=os.MkdirTemp("","gin-original-dto-");if err!=nil{panic(err)};defer os.RemoveAll(tmp)
 source:="package main\nimport(\"encoding/json\";\"fmt\")\n"+declarations.String()+`func main(){b,err:=json.Marshal(map[string]interface{}{"Model":Model{},"Tag":Tag{},"Article":Article{},"Response":Response{},"NilArticles":([]*Article)(nil),"EmptyArticles":[]*Article{}});if err!=nil{panic(err)};fmt.Println(string(b))}`
 path:=filepath.Join(tmp,"main.go");if err:=os.WriteFile(path,[]byte(source),0600);err!=nil{panic(err)}
 cmd:=exec.Command("go","run",path);cmd.Env=append(os.Environ(),"GO111MODULE=off");raw,err:=cmd.CombinedOutput();if err!=nil{panic(string(raw))}
 var values interface{};if err:=json.Unmarshal(raw,&values);err!=nil{panic(err)}
 commit,err:=exec.Command("git","-C",root,"rev-parse","HEAD").Output();if err!=nil{panic(err)}
 if strings.TrimSpace(string(commit))!="4f5174ca325b37f23edadad7c88d49586816a69c"{panic("unexpected source commit")}
 output:=map[string]interface{}{"commit":strings.TrimSpace(string(commit)),"sourceHashes":hashes,"values":values,"scope":"original type declarations only; database handlers not executed"}
 encoded,err:=json.MarshalIndent(output,"","  ");if err!=nil{panic(err)};fmt.Println(string(encoded))
}
