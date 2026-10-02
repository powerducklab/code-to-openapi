package main

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"example.com/app/handlers"
)

func main() {
	r := gin.Default()
	v1 := r.Group("/api/v1")

	// Handler referenced through a package selector expression.
	v1.GET("/tags", handlers.GetTags)
	v1.POST("/upload", uploadFile)
	v1.GET("/search", search)

	_ = r.Run(":3000")
}

func uploadFile(c *gin.Context) {
	f, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	_ = f
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func search(c *gin.Context) {
	q := c.PostForm("q")
	page := c.DefaultPostForm("page", "1")
	_ = q
	_ = page
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
