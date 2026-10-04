package main

import (
 "encoding/json"
 "fmt"
)

type Nested struct { Name string `json:"name"` }
type Left struct { Value string }
type Right struct { Value int }
type Tagged struct { Choice string `json:"Value"` }
type Deep struct { Left }
type Conflict struct { Left; Right }
type TaggedWinner struct { Tagged; Right }
type DepthWinner struct { Deep; Right }
type NamedEmbedded struct { Nested `json:"nested"` }
type HiddenEmbedded struct { Nested `json:"-"` }
type Contract struct {
 Pointer *string `json:"pointer"`
 Optional *string `json:"optional,omitempty"`
 Slice []string `json:"slice"`
 OptionalSlice []string `json:"optionalSlice,omitempty"`
 Bytes []byte `json:"bytes"`
 Map map[string]int `json:"map"`
 Fixed [2]string `json:"fixed"`
 Quoted int `json:"quoted,string"`
 Object Nested `json:"object,omitempty"`
 Conflict Conflict `json:"conflict"`
 Tagged TaggedWinner `json:"tagged"`
 Depth DepthWinner `json:"depth"`
 Named NamedEmbedded `json:"named"`
 Hidden HiddenEmbedded `json:"hidden"`
 Hyphen string `json:"-,omitempty"`
}
func main() {
 zero,_:=json.Marshal(Contract{})
 value:="value"
 populated,_:=json.Marshal(Contract{Pointer:&value,Optional:&value,Slice:[]string{},Bytes:[]byte{1,2,3},Map:map[string]int{},Fixed:[2]string{"a","b"},Quoted:12,Hyphen:"literal hyphen"})
 fmt.Printf("{\"zero\":%s,\"populated\":%s}\n",zero,populated)
}
