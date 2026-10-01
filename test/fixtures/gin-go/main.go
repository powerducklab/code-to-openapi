package main

import (
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()
	v1 := r.Group("/api/v1")
	v1.GET("/items", ListItems)
	v1.POST("/items", CreateItem)
	v1.GET("/items/:id", GetItem)
	v1.DELETE("/items/:id", DeleteItem)
	v1.GET("/stream", Stream)
	r.GET("/health", Health)
	r.GET("/ping", func(c *gin.Context) {
		c.JSON(200, gin.H{"ping": "pong"})
	})

	// Decoy: a non-Gin receiver exposing a GET method must never be confirmed.
	decoy := &DecoyClient{}
	decoy.GET("/must-not-be-a-route")

	r.Run(":8080")
}
