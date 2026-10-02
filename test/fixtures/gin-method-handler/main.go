package main

import "github.com/gin-gonic/gin"

// ItemController groups handlers as receiver methods, registered as method
// values (r.GET("/items", c.Get)) rather than package-level functions.
type ItemController struct{}

func (ct *ItemController) Get(c *gin.Context) {
	c.JSON(200, ItemResponse{Message: "list"})
}

func (ct *ItemController) Create(c *gin.Context) {
	c.JSON(201, ItemResponse{Message: "created"})
}

type ItemResponse struct {
	Message string `json:"message"`
}

func main() {
	r := gin.Default()
	c := &ItemController{}
	r.GET("/items", c.Get)
	r.POST("/items", c.Create)
	_ = r
}
