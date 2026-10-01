package main

import "github.com/gin-gonic/gin"

func main() {
	r := gin.Default()
	api := r.Group("/api")
	registerProductRoutes(api)
	_ = r.Run(":3000")
}
